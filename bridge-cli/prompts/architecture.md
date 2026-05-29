# Bridge Live Channel — Architecture sketch

*Design doc. Not implementation. Goal: align on the dev-facing model before we open code.*

## The mental model — one sentence

A dev integrates Bridge once, gets a **single live channel** to Bridge for everything that changes (user, billing, flags, anything Bridge owns), and a **single read surface** with the current state of all of it. They can also **push their own state through the same surface** so flag rules and other Bridge primitives can target it. No polling. No "where do I fetch this". No three-different-paths-to-the-same-thing.

```
                           Bridge (server)
                                 │
                                 │  one channel — pushes scoped events 
                                 ▼
   ┌──────────────────────────────────────────────────────────────┐
   │                  bridge  (single SDK surface)                │
   │                                                              │
   │   bridge.app        ← branding · flags · plans (catalog)    │
   │   bridge.tenant     ← subscription · quotas · entitlements  │
   │   bridge.user       ← identity · role · preferences         │
   │                                                              │
   │   bridge.attributes ← read + write store (push your own)    │
   │   bridge.events     ← lifecycle stream (handle reactions)   │
   │                                                              │
   └──────────────────────────────────────────────────────────────┘
                                 ▲
                                 │  push my own keys / domain state
                                 │
                            my app code
```

Three **scopes** (`app`, `tenant`, `user`) split the read surface by *what changes* and *who's affected*. Two **cross-cutting** slices (`attributes`, `events`) sit alongside.

| Scope | Carries | Changes when | Affects |
|---|---|---|---|
| **`bridge.app`** | Branding, flag definitions, plans catalog | Admin changes app config | All users of the app |
| **`bridge.tenant`** | Subscription, quotas, entitlements, members, settings | Billing events, team changes | All users in that tenant |
| **`bridge.user`** | Identity (JWT-derived), role, preferences | User-specific events | Only this user |

## Server end — the channel

### Transport

One WebSocket per session, subscribed to two underlying channels (a third may be added later):

- **App channel** — `workspace:<appId>` today; cleanup target is `app:<appId>` — broadcast to anyone connected to the app.
- **Per-user channel** — `user:<userId>` — events scoped to one user; tenant-level events also fan out here per member for v1.
- **Tenant channel** — `tenant:<tenantId>` — *deferred*. When tenants grow large, this cuts the per-user fan-out for tenant events. Adding it later does not change the SDK surface.

Already in place (Centrifugo) for the first two; tenant channel is a future optimization.

### Event taxonomy — grouped by scope

Every message is a discriminated union with a `kind` string prefixed by its scope. The SDK demultiplexes by prefix and updates the matching slice.

| Scope | `kind` examples | Meaning |
|---|---|---|
| **`app.*`** | `app.config_changed`, `app.branding_changed`, `flag.upsert`, `flag.remove`, `flag.bulk_invalidate`, `plan.catalog_changed` | App definitions changed; affects everyone connected to the app |
| **`tenant.*`** | `subscription.created`, `subscription.changed`, `subscription.cancelled`, `payment.failed`, `payment.succeeded`, `cancel.scheduled`, `cancel.effective`, `dunning.advanced`, `dunning.exhausted`, `quota.updated`, `entitlements.changed`, `tenant.members_changed`, `tenant.settings_changed` | Tenant state changed; affects all members of that tenant |
| **`user.*`** | `user.state_changed`, `user.role_changed`, `user.preferences_changed` | This specific user's state changed |
| **`system.*`** | `connection.open`, `connection.closed`, `connection.reauthorize`, `session.snapshot` | Channel lifecycle and initial state delivery |

Naming convention: `<scope>.<verb>`. The `flag.*` and `subscription.*` / `payment.*` etc. kinds keep their natural domain-verb names but are categorized as `app.*` and `tenant.*` respectively by the SDK demux — i.e. `kind` strings stay readable; the scope grouping is a routing concern.

### What the server guarantees

- **At-least-once delivery** while connected. Recovery on reconnect is best-effort today (Centrifugo recovery client-side is deferred; SDK re-hydrates on reconnect).
- **Causal ordering within a session** (Centrifugo per-channel).
- **No cross-tenant leakage** — every event is scoped to a workspace or a userId; server enforces.

## SDK end — the read surface

One root object, **`bridge`**, returned by a single bootstrap call. Every reactive slice hangs off it. Devs never instantiate sub-clients, never juggle multiple singletons.

### Top-level shape

```ts
const bridge = await initBridge({
  apiBaseUrl: 'https://api.thebridge.dev',
  appId: import.meta.env.VITE_BRIDGE_APP_ID,
  // optional: route guards, hosted-vs-SDK auth, etc.
});
```

`initBridge()` returns a `Bridge` object structured by scope. Slices marked **snapshot** are pre-populated on connect and immediately reactive. Slices marked **lazy** start `null` and are populated by `.load()` (or `await bridge.X`), then stay reactive from that point on.

| Slice | Shape | Snapshot? | Source |
|---|---|---|---|
| **`bridge.app`** | | | |
| `bridge.app.branding` | Subscribable `{ logo, colors, name, … }` | **snapshot** | `app.branding_changed` |
| `bridge.app.flags` | `bridge.app.flags.flag<T>(key, default)` + reactive accessors | n/a — evaluated, not state | `flag.*` events |
| `bridge.app.plans` | Subscribable plan catalog | **lazy** | REST + `plan.catalog_changed` |
| `bridge.app.flags.definitions` | Flag definition catalog (debug tooling) | **lazy** | REST + `flag.*` |
| **`bridge.tenant`** | | | |
| `bridge.tenant.subscription` | Subscribable `{ plan, status, trial, … }` | **snapshot** | `subscription.*` |
| `bridge.tenant.entitlements` | Subscribable `{ can(key) → boolean, snapshot }` | **snapshot** | `entitlements.changed` |
| `bridge.tenant.quotas` | Subscribable `Map<metric, QuotaSnapshot>` | **lazy** | `quota.updated` |
| `bridge.tenant.members` | Subscribable member list | **lazy** | REST + `tenant.members_changed` |
| `bridge.tenant.settings` | Subscribable tenant settings | **lazy** | REST + `tenant.settings_changed` |
| **`bridge.user`** | | | |
| `bridge.user` (root) | Subscribable `{ id, email, role, tenantId, isAuthenticated }` | **snapshot** | JWT + `user.state_changed` |
| `bridge.user.preferences` | Subscribable preferences map | **lazy** | REST + `user.preferences_changed` |
| **Cross-cutting** | | | |
| `bridge.attributes` | **Read + Write** map of all attributes in eval context | n/a | Internal providers + dev pushes |
| `bridge.events` | Multiplexed stream of every `kind` for lifecycle handlers | n/a | Raw channel |

Every slice exposes the **same** subscribe shape (Svelte store contract, framework's idiomatic reactive primitive — picked per-plugin), so the dev never has to learn slice-specific conventions.

### Snapshot vs lazy — the dev pattern

Snapshot slices: read them. They're never null.

```ts
const sub  = $bridge.tenant.subscription;  // { plan, status, … }
const can  = $bridge.tenant.entitlements.can('ai_completions');
const role = $bridge.user.role;
```

Lazy slices: load once, react forever.

```ts
// First touch — fetch via REST + start tracking channel deltas
await bridge.tenant.quotas.load();

// Or: awaiting the slice itself triggers load-if-needed
const quotas = await bridge.tenant.quotas;

// Once loaded, no more awaits needed — it's a regular reactive slice
$bridge.tenant.quotas.get('ai_completions')?.percent_used;
```

**Important rule:** once loaded, channel updates keep a lazy slice fresh. No re-fetching, no polling. The `.load()` call is one-shot priming.

**Why this composition:** cold connect carries only what's needed for a clean first paint (a few KB). Pages that need more — billing dashboard, team page — pay the load cost when navigated to, not at session start. Snapshot composition is **fixed** (no per-app configuration knob) — keeps the contract simple and lets Bridge tune the defaults if usage data demands it.

### Single write surface — pushing your own state

`bridge.attributes` is the *only* place dev code pushes keys into the eval context. Internally Bridge's own providers (auth, billing) also write here — so dev keys and Bridge-managed keys live in one place, with explicit namespace separation:

```
bridge.attributes.get()
  // {
  //   "user.role": "owner",                    ← Bridge-managed
  //   "tenant.plan": "pro",                    ← Bridge-managed
  //   "bridge:billing.entitlement.ai": true,   ← Bridge-managed
  //   "app.cohort": "beta",                    ← dev-pushed
  //   "app.theme": "dark",                     ← dev-pushed
  // }
```

Devs use one of three write styles depending on the shape of their source:

```ts
// 1. Static one-shot value
bridge.attributes.set('app.cohort', 'beta');

// 2. Bound to a reactive source — Bridge re-reads on every flag eval
bridge.attributes.bind('app.theme', () => themeStore.value);

// 3. Bulk source — register a function that returns multiple keys
bridge.attributes.bindMany(() => ({
  'app.cohort': currentCohort(),
  'app.workspace_id': activeWorkspace.id,
  'app.onboarding_step': onboarding.step,
}));
```

There is no `AttributeProvider` class to implement, no registry to know about. The SDK exposes the simplest possible verbs (`set` / `bind` / `bindMany`) and handles the provider plumbing internally.

Per-call attribute overrides for transient values stay on the component (`<FeatureFlag context={...}>` or `bridge.flags.flag('key', default, { attributes: {…} })`) — they're the "just this once" path and don't conflict with the global store.

### Single lifecycle handler — reacting to events

If a dev wants to react to specific server-pushed events (show a toast on `payment.failed`, force-refresh some local state on `subscription.changed`), they subscribe through `bridge.events`:

```ts
const unsubscribe = bridge.events.handle({
  'payment.failed': (e) => showToast('Card declined — update billing'),
  'subscription.changed': (e) => analytics.track('plan_changed', e),
  'flag.upsert':         (e) => console.debug('flag updated', e.key),
});
```

Returns a single unsubscribe. One stream, one subscribe API, no per-domain emitter.

## What the Svelte dev sees

Everything below uses Svelte 5 runes + stores. Other plugins (`bridge-react`, `bridge-nextjs`, etc.) mirror the same surface using their idiomatic primitives.

### Wire-up — once in `+layout.svelte`

```svelte
<script lang="ts">
  import { initBridge, BridgeProvider } from '@nebulr-group/bridge-svelte';

  const bridge = initBridge({
    apiBaseUrl: import.meta.env.VITE_BRIDGE_API_BASE_URL,
    appId: import.meta.env.VITE_BRIDGE_APP_ID,
    routeGuard: { /* … */ },
  });

  let { children } = $props();
</script>

<BridgeProvider {bridge}>
  {@render children()}
</BridgeProvider>
```

That's the whole bootstrap. No separate `bridgeBootstrap` + `createBridgeFlags` + `useBridge` + `getBridgeAuth` calls. One.

### Reading user state (snapshot — always available)

```svelte
<script lang="ts">
  import { useBridge } from '@nebulr-group/bridge-svelte';
  const { user } = useBridge();
</script>

{#if $user.isAuthenticated}
  <p>Hi {$user.email} — you're a {$user.role}.</p>
{:else}
  <a href="/auth/login">Sign in</a>
{/if}
```

`$user` re-renders the moment `user.state_changed` fires; the JWT refreshes underneath, the slice updates, no manual work.

### Reading tenant subscription + entitlements (snapshot)

```svelte
<script lang="ts">
  import { useBridge } from '@nebulr-group/bridge-svelte';
  const { tenant } = useBridge();
</script>

<p>Plan: {$tenant.subscription.plan}</p>

{#if $tenant.entitlements.can('ai_completions')}
  <AICompose />
{:else}
  <UpgradePrompt />
{/if}
```

Both are in the snapshot — available on first paint. Updates apply live as `subscription.*` and `entitlements.changed` arrive.

### Reading quotas (lazy — explicit load on the page that needs it)

```svelte
<script lang="ts">
  import { useBridge } from '@nebulr-group/bridge-svelte';
  import { onMount } from 'svelte';
  const { tenant } = useBridge();

  onMount(() => tenant.quotas.load());  // priming fetch
</script>

{#if $tenant.quotas}
  <p>AI quota: {$tenant.quotas.get('ai_completions')?.percent_used}% used</p>
{:else}
  <SkeletonRow />
{/if}
```

Quota counter ticks live as `quota.updated` events arrive — once loaded.

### Using a feature flag

```svelte
<script lang="ts">
  import { FeatureFlag } from '@nebulr-group/bridge-svelte';
</script>

<FeatureFlag key="new-dashboard" defaultValue={false}>
  {#snippet children()}<NewDashboard />{/snippet}
  {#snippet fallback()}<OldDashboard />{/snippet}
</FeatureFlag>
```

If the flag's rule references **any** attribute — `user.role`, `tenant.plan`, `bridge:billing.entitlement.ai`, `app.cohort`, anything — the SDK pulls the live value from `bridge.attributes` and re-evaluates on every relevant push. No dev wiring per rule, ever. The component is sugar over `bridge.app.flags.flag(key, default)`.

### Pushing your own attributes

```svelte
<script lang="ts">
  import { useBridge } from '@nebulr-group/bridge-svelte';
  import { themeStore, onboardingStep } from '$lib/state';

  const bridge = useBridge();

  // Static — set once when you know it
  bridge.attributes.set('app.cohort', getCohort());

  // Live-bound — Bridge re-reads on every flag eval
  bridge.attributes.bind('app.theme',           () => $themeStore);
  bridge.attributes.bind('app.onboarding_step', () => $onboardingStep);
</script>
```

The admin's rule builder auto-discovers these keys the first time a flag is evaluated with them in context — no manual schema declaration. Now an admin can write a flag rule like `app.cohort == "beta" AND bridge:billing.plan == "pro"` and it works.

### Reacting to lifecycle events

```svelte
<script lang="ts">
  import { useBridge } from '@nebulr-group/bridge-svelte';
  import { toast } from '$lib/ui/toast';
  import { onDestroy } from 'svelte';

  const { events } = useBridge();

  const stop = events.handle({
    'payment.failed':       (e) => toast.error(`Card declined — update billing`),
    'subscription.changed': (e) => toast.info(`Plan changed to ${e.plan}`),
    'flag.upsert':          (e) => console.debug('[bridge] flag updated', e.key),
  });

  onDestroy(stop);
</script>
```

### What the dev never has to think about

- Token refresh — happens automatically when `user.state_changed` arrives.
- Cache hydration / invalidation — handled internally per slice.
- Channel reconnect — automatic; `bridge.events` exposes `connection.open` / `connection.closed` for UI status pills if wanted.
- Which slice owns which event — slices update themselves.
- Provider classes, registries, attribute-provider registration — none of those concepts exist at the dev surface.

## What this replaces (and why)

| Today | Target |
|---|---|
| `bridgeBootstrap()` + `<BridgeBootstrap>` + `getBridgeAuth()` + `useBridge()` + `createBridgeFlags()` + `loadSubscription()` + tokenStore subscribe | One `initBridge()` + `<BridgeProvider>` + `useBridge()` |
| Per-domain stores reached through different APIs (`subscriptionStore`, `featureFlags.flags`, `useBridge().quotas`, etc.) | Scoped slices off the same root (`bridge.app.*` / `bridge.tenant.*` / `bridge.user.*`), same subscribe shape |
| Multiple REST hydrate calls on bootstrap (`/subscription`, `/quotas`, `/entitlements`, …) | One `session.snapshot` over the channel + `.load()` per lazy slice on demand |
| Three ways to push attributes (`tokenStore→setContext`, `AttributeProvider`, per-call `context`) | One write surface: `bridge.attributes.set / bind / bindMany`. Per-call `context` survives for transient overrides only. |
| Per-domain event subscriptions (handle billing on `useBridge().handle`, react to flag changes via the flag store, etc.) | One `bridge.events.handle({...})` for everything, dispatched by `kind` |
| Backend SDKs are a separate world from frontend SDKs | Same `bridge.*` surface; `mode: 'channel' \| 'pull'` knob picks how state stays fresh |

## Settled design decisions

All open questions from the design pass have been resolved:

1. ✅ **Bridge instance access pattern** — Context provider + `useBridge()` hook is canonical across every plugin (Svelte / React / NextJS / Angular / NestJS / Express). One name, one provider component (`<BridgeProvider>`).
2. ✅ **Attribute collision semantics** — Dev-set keys override Bridge-managed keys on the same key (preserves locked decision #20). Namespace prefixes (`bridge:*`, `app.*`, `user.*`, `tenant.*`) discourage accidental clobber. `bridge:*` is **reserved** — dev writes into it are rejected.
3. ✅ **Per-call `context` on `<FeatureFlag>` / `useFlag()`** — kept as a power-user / transient override path. Not the standard. The standard is `bridge.attributes.bind()`. The per-call path exists for "value of this `<select>` right now" without polluting the global store.
4. ✅ **Event handler shape** — `bridge.events.handle({...})` — discriminated-union dispatcher, one call, one unsubscribe, matches the existing billing handle ergonomics.
5. ✅ **Future domains** — Channel is universal; new domains are new slices off `bridge` with new `kind` prefixes. No new transport, no new mental model.
6. ✅ **Backend SDKs** — Same `bridge.*` surface as frontend. Backend devs pick a `mode` at init time: `channel` (long-running, keeps WebSocket, gets live updates) or `pull` (ephemeral / serverless, REST per read, no WebSocket). See "Backend SDK modes" below.
7. ✅ **Channel-on-connect snapshot** — Minimal snapshot of first-paint essentials (`app.branding`, `tenant.subscription`, `tenant.entitlements`, `user.*`). Everything else lazy-loaded via `.load()`. Snapshot composition is fixed; no per-app or per-init configurability.
8. ✅ **Three scopes** — `bridge.app` / `bridge.tenant` / `bridge.user` mirrors both the snapshot structure and the event-kind prefixes. Naming is consistent across server-side topology, SDK surface, and admin tooling.

## Backend SDK modes

A single `mode` knob picks how state stays fresh; everything else (the `bridge.app/tenant/user` slices, `events.handle`, `attributes`) is identical across frontend and backend.

```ts
// Long-running backend (default) — opens a channel, gets live updates.
// Use for: NestJS / Express servers, anything running 24/7.
const bridge = await initBridge({
  appId:  process.env.BRIDGE_APP_ID,
  apiKey: process.env.BRIDGE_API_KEY,
  mode: 'channel',
});

// Ephemeral backend — no channel, every read = REST.
// Use for: cron jobs, serverless / edge functions, webhook handlers, CLI scripts.
const bridge = await initBridge({
  appId:  process.env.BRIDGE_APP_ID,
  apiKey: process.env.BRIDGE_API_KEY,
  mode: 'pull',
});

// Pull-mode: read fresh on demand
await bridge.refresh();                            // re-pull session snapshot
await bridge.tenant(tenantId).subscription;        // REST, fresh every call
await bridge.users(userId).entitlements;           // REST, fresh every call
```

What pull-mode gives up:
- No live updates — state is only known at fetch time.
- No `bridge.events.handle()` — nothing pushes to you. Use **Bridge webhooks** (separate, persistent) for server-side event-driven reactions in pull mode.
- No automatic cache invalidation — the SDK caches briefly (configurable, ~30 s default) to spare the hot path; `bridge.refresh()` forces a fresh read.

What pull-mode gains:
- Cold start cost = zero (no WebSocket handshake).
- Works in any runtime, including serverless cold paths and edge functions where long-lived sockets are awkward.
- Predictable RPC-shaped traffic, easy to reason about and bill.

Backends also get **multi-tenant / multi-user accessors** that frontends don't need: `bridge.tenant(id)`, `bridge.users(id)`. A backend serves many tenants and many users; it doesn't subscribe to one user's channel like a frontend does.

## REST endpoints — separate, supported surface

The channel-snapshot model handles **live SDK consumers** — apps that want to stay in sync with Bridge. REST endpoints handle a different class of need and must remain (and grow as needed):

- **Backend / server-to-server reads** — a developer's API server fetching subscription state for an authenticated user, sending Bridge data into their analytics warehouse, syncing user records into a CRM, etc.
- **One-shot reads** — anywhere a long-lived channel doesn't make sense (cron jobs, webhook handlers, mobile background tasks, scripts).
- **Devs building their own integrations** — anyone exporting Bridge data into other systems for any reason. Bridge has to be a good citizen here; REST is the universal interface.
- **The unified SDK uses REST internally** for paths that aren't channel-correlated (browsing plans, fetching tenant member lists on demand, etc.).

The rule: **every domain that has channel events also has REST equivalents.** Adding a new slice to the channel implies the corresponding REST endpoint exists (or gets added in the same change). The SDK chooses channel-first; the dev chooses whichever fits their use case.

## Initial state delivery — channel-on-connect snapshot

On connect to the per-user channel, the server emits a single `session.snapshot` message. It carries **only the first-paint essentials** — small, predictable, scoped:

```json
{
  "kind": "session.snapshot",
  "data": {
    "app": {
      "branding": { "logo": "...", "colors": {...}, "name": "..." }
    },
    "tenant": {
      "id": "...",
      "name": "...",
      "subscription": { "plan": "pro", "status": "active", "trial": false },
      "entitlements": { "ai_completions": true, "app_active": true, … }
    },
    "user": {
      "id": "...",
      "email": "...",
      "role": "owner",
      "tenantId": "..."
    }
  }
}
```

What's deliberately **not** in the snapshot — populated via `.load()` when the dev's UI asks for it:

- `tenant.quotas` (full per-metric counters)
- `tenant.members` (team list)
- `tenant.settings` (admin settings)
- `app.plans` (full plan catalog)
- `app.flags.definitions` (flag-definitions catalog — debug tooling)
- `user.preferences` (full preferences set)

SDK behavior:
- Snapshot slices are immediately reactive on connect. First paint reflects real state, no flicker.
- Lazy slices remain `null` until `bridge.X.load()` (or `await bridge.X`) is called. After load, channel updates keep them fresh.
- Subsequent channel events (`subscription.changed`, `quota.updated`, `entitlements.changed`, etc.) apply as deltas to whichever slices are populated.
- Reconnect after offline re-emits the snapshot. Any lazy slices the dev had loaded get re-hydrated by their own REST fetches automatically.

Snapshot composition is **fixed** — no per-app, no per-init configuration knob. Bridge picks the defaults; if real usage shows another slice belongs in the snapshot, we promote it without anyone changing code (their explicit `.load()` calls keep working as no-ops once the slice is pre-populated).

The snapshot is **also fetchable via REST** at `GET /session/init` so non-channel consumers (server-side, cron, serverless) can get the same shape in one call. Same endpoint, different transport.

## What changes for us (cleanup scope, no code yet)

If we settle on this, the engineering work that follows is roughly:

1. **auth-core**
   - One internal attribute store (replaces the three current paths).
   - `BridgeFlags.flag()` reads attributes from that store every eval.
   - Channel demultiplexer routes events to the right internal slice subscribers.
2. **bridge-svelte**
   - One `initBridge()` + `BridgeProvider` + `useBridge()` (consolidates `bridgeBootstrap`, `createBridgeFlags`, `getBridgeAuth`, current `useBridge`).
   - `bridge.attributes.set / bind / bindMany` as the only public write API.
   - Deprecate (then remove) `getBridgeAuth()`, `loadFeatureFlags()`, `subscriptionStore` etc. as direct exports — kept internally; surfaced through slices.
3. **bridge-nextjs / bridge-react / others** — port the same surface; identical mental model, framework-idiomatic primitives.
4. **bridge-api**
   - Confirm the channel event kinds match the taxonomy above (rename / consolidate where they drifted).
   - Auto-discover dev-pushed attribute keys from observed flag evals (already done for the FF 2.0 path; verify it still works after consolidation).
5. **Docs + prompts**
   - Rewrite `mcp/feature-flags-prompt.md`, `mcp/payments-prompt.md`, `mcp/billing-prompt.md`, `mcp/integration-prompt.md` against the unified surface.
   - Single `mcp/integration-prompt.md` is enough for the basics — feature-flags / payments / billing become incremental additions, not separate worlds.

This is the order we'd ship in. Not now — only after we agree on the architecture above.

## Security model

The live-channel design inherits its trust model from the JWT. This section pins down the rules so we don't drift.

### What the JWT carries vs what the channel carries

The JWT stays **exactly as it is today** — identity + sensitive claims (sub, email, role, tenant.id, tenant.plan, privileges). We deliberately do **not** bloat it with billing state, quotas, entitlements, or app data — those are non-sensitive enough to ride the channel and high-frequency enough that a token refresh per change would be wasteful.

| Data | Source | Rationale |
|---|---|---|
| User identity (`sub`, email, role, tenant.id, tenant.plan, privileges) | JWT | Sensitive, signed, slow-changing |
| Subscription status, entitlement booleans, quota counters | Channel push | Not PII, high-frequency, no reason to gate behind a token refresh |
| Flag values and rules | Channel push | Not sensitive on their own |
| Custom `app.*` attributes the dev pushes | Local SDK store (never serialized back) | Dev-owned; namespaced; observed-value telemetry is opt-out per key |

The channel is authorized **by the JWT**. There is no second auth mechanism. Same trust boundary, single rotation.

### Blast-radius bound = JWT TTL

A leaked or stolen JWT enables hijack of the per-user channel **only until the JWT expires**. On expiry:
- The hijacker cannot open a new connection (authorize rejects the expired JWT).
- The legitimate client refreshes its JWT and the SDK re-authorizes its channel connection with the fresh token.
- The hijacker's connection (if still open on the old JWT) must be terminated — see "Renewal cleanup" below.

This means JWT TTL is also the live-channel exposure window. If we ever shorten the JWT TTL for API security reasons, the channel benefits automatically.

### Renewal cleanup — two follow-up items to address before the unified surface ships

1. **Force channel re-authorize on every JWT refresh.** Today, the bridge-svelte bootstrap subscribes to `tokenStore`, but only triggers a channel reconnect when the userId changes. On a pure expiry-driven refresh (same user, new token), the existing connection rides on the *old* JWT until Centrifugo's own connection-token TTL terminates it. Tighten this so every `tokenStore` update forces a re-authorize — the moment the new JWT is in hand, the old one can no longer carry the channel.
2. **Server-side forced disconnect on revocation.** Logout, suspected-compromise flagging, or admin-initiated session kills should force-drop the user's active channel connection. Bridge today has a token-revocation concept but no path that publishes a disconnect signal to Centrifugo for that user. Add the publish path.

### Per-user channel auth is the load-bearing check

The unified surface's whole privacy model rests on one server-side assertion: a client trying to subscribe to `user:<userId>` must present a JWT whose `sub == userId`. Channel authorize **must not** accept the workspace API key alone (which every logged-in user of the app possesses).

This is the current behavior — the bootstrap deliberately passes the user JWT to `realtime.authorize` (`bridge-svelte/src/lib/flags/bootstrap.ts`). Locking it in:

- **e2e regression test** — subscribe to `user:<otherUserId>` with my own JWT; assert reject.
- **unit test** at the auth-core authorize layer asserting the same.

### App channel is for non-sensitive app-wide events only

The app channel (`workspace:<appId>` today, target rename `app:<appId>`) is broadcast to anyone connected to the app. It carries:
- Flag mutations (`flag.upsert`, `flag.remove`, `flag.bulk_invalidate`) — visible-to-all is acceptable; flag existence is already probe-able.
- App config / branding changes.
- Connection lifecycle.

It must **not** carry anything user-correlated or tenant-correlated. Discipline: when adding a new event kind, default it to the per-user (or future tenant) channel; promote to the app channel only if it's genuinely app-wide and non-sensitive.

### Client-side eval is UI, not access

The SDK's flag and entitlement evaluations are **client-side** for UX. A dev who writes `if (bridge.flags.flag('x', false)) { allowDangerousAction(); }` has shipped a vulnerability — any user can flip their local SDK state to override the result. This is not new and not unique to Bridge; it applies to every client-side feature flag system.

The fix is **documentation discipline**, not architectural defense. The integration prompt and the feature-flags prompt both state:
- Client-side flag results gate **UI rendering**.
- Any server endpoint that does work must re-check the entitlement/flag independently.

We are not designing around devs sabotaging their own apps.

### Custom-attribute namespace + observation

`bridge:` is reserved for Bridge-managed attributes. Dev pushes must use a different prefix (recommended: `app.*`). The SDK should reject (or log-warn-and-ignore) writes into `bridge:`.

The attribute-observation telemetry (sample-value catalog for admin autocomplete, TBP-178) is **on by default but opt-out per key**:

```ts
bridge.attributes.set('app.email', user.email, { observed: false });
```

Documentation must spell out: don't push PII into observed attributes. The prompt should call this out with an example.

### Token storage on the client

Out of scope for this doc, but worth mentioning: where the JWT lives determines the XSS blast radius. Frameworks that support HttpOnly cookies should default to them; localStorage fallback is acceptable with CSP. The channel inherits whatever trust model the token storage gives.

### Things we are NOT designing for

- **MITM during transit** — WSS (TLS) handles this. Not novel.
- **Compromised admin / Bridge insiders** — out of scope for the live-channel design.
- **Side-channel timing attacks via flag-eval latency** — not a meaningful attack surface for typical applications.

### Summary

- Sensitive data stays in the JWT.
- Channel carries everything else, authorized by the same JWT.
- JWT TTL = blast-radius bound.
- Two cleanup follow-ups before the unified surface ships: force re-auth on every refresh, and server-side forced disconnect.
- Per-user channel auth is the one assertion that must never regress — locked in via test.
- Client-side eval discipline is a docs problem, not an architecture problem.
