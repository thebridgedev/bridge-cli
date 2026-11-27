# How Bridge works — the mechanisms and the levels (1.0)

One page for the rules every Bridge guide builds on. Read it before you write code against a limit, an upgrade prompt or a restyled sign-in page. The per-framework guides (`bridge guide svelte`, `bridge guide nestjs`, `bridge guide javascript`) say *which file*; this page says *why it works* and *which level to pick*.

Who gets which feature, and how plans, roles, limits and flags divide the work, is on its own page: `bridge guide fit-together` (MCP: resource `bridge://guides/fit-together`).

The examples use the 1.0 plugins: the SvelteKit frontend (`@nebulr-group/bridge-svelte@alpha`) and the NestJS backend (`@nebulr-group/bridge-nestjs@alpha`). Any other JavaScript app uses `@nebulr-group/bridge-auth-core@alpha` directly: `createBridge({ issuer })` in the browser, `createBridgeServer({ issuer, appKey })` on a server. React, Next.js, Angular and Express have no 1.0 plugin yet.

## The whole integration

What a developer's repo holds once Bridge is in. Nothing else is required; every other page Bridge needs, the plugin serves.

**Frontend (SvelteKit): one setting and four short files.**

```env
# .env (`bridge app setup` writes it)
PUBLIC_BRIDGE_ISSUER=https://…/identity-access/apps/<your app id>
```

On SvelteKit 3, declare it in `src/env.ts` (`defineEnvVars({ PUBLIC_BRIDGE_ISSUER: { public: true } })`); SvelteKit 2 reads `.env` as it is.

```ts
// src/routes/+layout.ts
import { bridgeBootstrap } from '@nebulr-group/bridge-svelte';
export const ssr = false;
export const load = bridgeBootstrap({ rules: [{ match: '/', public: true }] });
```

```svelte
<!-- src/routes/+layout.svelte -->
<script lang="ts">
  import '@nebulr-group/bridge-svelte/styles';
  import { BridgeBootstrap } from '@nebulr-group/bridge-svelte';
  let { children } = $props();
</script>
<BridgeBootstrap>{@render children()}</BridgeBootstrap>
```

```svelte
<!-- src/routes/auth/[...bridge]/+page.svelte: every sign-in page -->
<script lang="ts">
  import { BridgeAuthRoutes } from '@nebulr-group/bridge-svelte';
</script>
<BridgeAuthRoutes />
```

With plans, one more file serves the subscription page, the paywall and the checkout returns:

```svelte
<!-- src/routes/subscription/[...bridge]/+page.svelte -->
<script lang="ts">
  import { BridgeBillingRoutes } from '@nebulr-group/bridge-svelte';
</script>
<BridgeBillingRoutes />
```

**Backend (NestJS): one module line and one decorator per limited handler.** The lines marked `// +` are Bridge's:

```env
BRIDGE_ISSUER=https://…/identity-access/apps/<your app id>
BRIDGE_APP_KEY=…            # counting usage and plan limits; server only
```

```ts
// src/app.module.ts
import { Module } from '@nestjs/common';
import { BridgeModule } from '@nebulr-group/bridge-nestjs';                  // +
import { ExportsController } from './exports.controller';

@Module({
  imports: [BridgeModule.forRoot({ guard: { global: true } })],            // + every route needs a valid credential
  controllers: [ExportsController],
})
export class AppModule {}
```

```ts
// src/exports.controller.ts
import { Controller, Post } from '@nestjs/common';
import { RequireQuota } from '@nebulr-group/bridge-nestjs';                  // +

@Controller('exports')
export class ExportsController {
  @Post()
  @RequireQuota('exports')                                                  // + the plan limit
  create() {
    return { exported: true };
  }
}
```

NestJS does not read `.env` by itself: start with `node --env-file=.env dist/main.js`, or set the variables in your container or process manager.

**Settings.** One for every plugin, the issuer; everything else (keys, revocation list, API addresses) is read from the issuer's published metadata.

| Frontend | Backend | When to set it |
|---|---|---|
| `PUBLIC_BRIDGE_ISSUER` (or `bridgeBootstrap({ issuer })`) | `BRIDGE_ISSUER` | Always. The same issuer for the frontend and the backend of one app |
| — | `BRIDGE_APP_KEY` | When the server counts usage or uses the management client. Made with `bridge key create`; never in a browser bundle |
| — | `BRIDGE_WEBHOOK_SECRETS` | When the server receives Bridge's webhooks |

## 1. Count once, on the server

Usage is counted where the action happens, on the server. The browser shows the numbers and explains a refusal; it never reports usage, so a metric is never counted twice. An app whose action has no server of its own gives it one endpoint (a SvelteKit `+server.ts` with `@nebulr-group/bridge-svelte/server`).

## 2. A request holds, then counts

The backend decorator **is** the count. There is nothing else to wire: no "report usage" call after the insert, no counter in your database.

```ts
@Post()
@RequireQuota('exports')
create() { /* your code */ }
```

- **Before the handler:** one unit of the plan's limit is held for this request. At the limit the request is refused with `402` and a body the frontend understands (`{ code: 'QUOTA_EXCEEDED', metric, used, limit, fix }`). Your handler never runs. Two requests never get the last unit.
- **After the handler:** a **2xx** answer counts the held unit; a handler that throws or answers 4xx/5xx gives it back.
- **Fail-closed:** if Bridge cannot answer, the request is refused with `503`, never let through unchecked.
- **A workspace locked for payment:** writes get `402 BILLING_GATE_ENGAGED`.
- A metric with a usage price never refuses: past its included amount it bills per unit.

Outside NestJS, the auth-core server client does the same by hand:

```ts
const hold = await bridge.usage.hold(actor, 'projects', { decision: requestId });
try { await createProject(); await hold.confirm(); } catch (error) { await hold.giveBack(); throw error; }
// at the limit `hold` throws: isLimitReached(error) → Response.json(quotaExceededBody(error), { status: 402 })
```

`@Meter('tickets.created')` (NestJS) and `meter(event, 'tickets.created')` (SvelteKit server) only count, with no limit: for usage that is billed or shown but never refused.

## 3. Counter or gauge

**If deleting it frees room, it's a gauge; if it happened, it's a counter.**

| | Counter | Gauge |
|---|---|---|
| Examples | exports, API calls, AI completions, emails sent | tickets, projects, stored files |
| Who counts | the server, one per successful request | the server sets how many exist, from its own database |
| Resets | every billing period ("40 of 100 this month") | never ("8 of 10 projects") |
| Set up | `bridge metric set exports --kind counter`, then `bridge plan limit set <plan> exports=100` | `bridge metric set tickets --kind gauge`, then `bridge plan limit set <plan> tickets=10` |
| Backend | `@RequireQuota('exports')` | `@RequireQuota('tickets', { current })` on create, `@SyncQuota('tickets', { current })` on delete |

```ts
@Post()
@RequireQuota('tickets', { current: (t, self: TicketsController) => self.tickets.countFor(t.id) })
create() { /* … */ }

@Delete(':id')
@SyncQuota('tickets', { current: (t, self: TicketsController) => self.tickets.countFor(t.id) })
remove() { /* … */ }
```

`current` returns your own count, and the gauge is set to it after a 2xx, so Bridge's copy heals itself if it ever missed an update.

**Seats** are built in: `bridge plan limit set <plan> seats=10`. Bridge counts the workspace's members itself and refuses an invite past the limit, from the team panel or anywhere else; the app never reports a seat. Never gate seats with a flag or an entitlement.

`bridge metric list` shows every metric the app counts, with its kind.

**A plan feature goes in the plan's features list.** `bridge plan feature add pro analytics=Analytics` makes `bridge:billing.entitlement.analytics` true on `pro`, and false on every other plan. The plan page and the upgrade dialog name it from the same list. Control the feature with a flag whose rule is `bridge:billing.entitlement.analytics eq true`, so changing what Pro sells is one edit on the plan and no flag rule has to follow. `@RequireQuota` is for a *limit*; checking a plan *feature* without a flag (`@RequireEntitlement`) is the exception (at the end).

## 4. Three ways to handle a limit in the UI

Pick the lowest level that does the job. The server refuses in every case; these only decide what the person sees before and after.

| Level | What the page writes | What the person sees |
|---|---|---|
| **0 — nothing** | a plain button calling your API with `bridgeFetch` | Your server refuses at the limit (`402`), and the plugin opens an **upgrade dialog** naming the metric, linking to the subscription page. Someone the flag `bridge-billing-manage` is off for is told who to ask |
| **1 — one component** | `<QuotaGate metric="tickets">…</QuotaGate>` around the button; `<FeatureFlag key="analytics" upgrade>…</FeatureFlag>` around a paid feature | The button is disabled at a known hard limit with an upgrade line beside it; the paid feature shows on a plan that includes it, and elsewhere an upgrade prompt that opens the dialog |
| **2 — your own UI** | `useQuota('tickets')`, and `<FeatureFlag key="analytics">` around what the plan sells | Whatever you build from the live numbers |

```svelte
<script lang="ts">
  import { QuotaGate, FeatureFlag, useQuota, bridgeFetch } from '@nebulr-group/bridge-svelte';
  const tickets = useQuota('tickets');
  const createTicket = () => bridgeFetch('/api/tickets', { method: 'POST' });
</script>

<!-- level 1 -->
<QuotaGate metric="tickets">
  <button onclick={createTicket}>New ticket</button>
</QuotaGate>

<!-- the flag's rule: bridge:billing.entitlement.analytics eq true -->
<FeatureFlag key="analytics" upgrade>
  <a href="/analytics">Analytics</a>
</FeatureFlag>

<!-- level 2 -->
{#if tickets.loading}
  Loading…
{:else if tickets.unlimited}
  Unlimited tickets
{:else}
  {tickets.used} of {tickets.limit} tickets
{/if}
```

- No upgrade dialog opens by itself: it opens on a `402` from your server through `bridgeFetch`, when someone opens a route whose flag is off because of the plan, or when they click an upgrade prompt.
- "Not loaded yet" is never "zero" and never "not allowed": `useQuota` numbers stay `null` while `loading`, and `<QuotaGate>` stays enabled while loading.
- `bridgeFetch` sends the person's token only to the page's own origin, Bridge, and the origins in `bridgeBootstrap({ tokenOrigins: [...] })`; list a backend on another origin there. `billing: { upgradeDialog: false }` turns the dialog off, `billing: { upgradeDialog: MyDialog }` replaces it.
- Do not write a quota `if`, a "limit reached" toast or a `/quota` endpoint of your own: level 0 already covers the refusal, and the numbers come from Bridge, live.

## 5. Four levels of customising Bridge's pages

The same ladder holds for the sign-in pages (`<BridgeAuthRoutes>`) and the subscription pages (`<BridgeBillingRoutes>`). The pages must end up looking like the app they sit in: rung 1, with the tokens taken from the app's own styles, is always applied, and rung 2 too when the app frames its pages in a card or shell. Climb further only as far as you need. `bridge guide svelte branding` has the steps.

| Rung | What you do | What you own |
|---|---|---|
| **0 — nothing** | Bridge's pages render inside your own `+layout.svelte`, in your font, text size and text colour | Your navigation, header and shell already surround them |
| **1 — tokens** | Set `--bridge-*` CSS variables in your CSS, and plain CSS for anything else | Colours, corners, spacing, weights, shadows |
| **2 — frame and heading** | Pass the `frame` and `heading` snippets to `<BridgeAuthRoutes>` / `<BridgeBillingRoutes>` | Everything around the form on every page, and each page's heading |
| **3 — your own page** | Build the page from the pieces (`SignInForm`, `SignUpForm`, `PlanPicker`, …) in your own route file | That one page |
| **4 — headless** | Leave out `import '@nebulr-group/bridge-svelte/styles'`, or build on the client (`getBridge()`) | Everything |

**The token contract (rung 1).** These `--bridge-*` variables are the supported way to restyle the components; each has a built-in default. Set them on `:root` or on any wrapper, and set only what the app does not already give: Bridge inherits the app's font and text colour.

| Token | Styles |
|---|---|
| `--bridge-primary`, `--bridge-primary-hover`, `--bridge-primary-fg`, `--bridge-primary-light` | Primary buttons and their hover, text on them, the tint behind an active item |
| `--bridge-input-focus` | Input focus ring |
| `--bridge-bg`, `--bridge-foreground` | Dialogs, menus, panels, and their text |
| `--bridge-muted`, `--bridge-muted-bg` | Secondary text; subtle fills |
| `--bridge-border`, `--bridge-border-radius` | Borders and corners of inputs, buttons, cards and dialogs |
| `--bridge-card-bg`, `--bridge-card-shadow`, `--bridge-button-shadow` | Plan cards and panels; their shadow; every button's shadow |
| `--bridge-font-family`, `--bridge-font-size`, `--bridge-text-base` | Bridge's font, and the base its text sizes scale from |
| `--bridge-font-weight-heading`, `--bridge-font-weight-button`, `--bridge-font-weight-label` | Titles and prices; buttons; labels and badges |
| `--bridge-overlay` | Backdrop behind dialogs |
| `--bridge-alert-error-bg` / `-fg` / `-border` (and `info`, `success`, `warning`) | Notices and badges |
| `--bridge-auth-page-padding`, `--bridge-billing-page-width`, `--bridge-billing-page-padding` | The sign-in and subscription pages' layout |
| `--bridge-paywall-bg`, `--bridge-paywall-panel-bg` | The paywall and the billing lock screen |

The derived tokens (hover, light, focus) follow `--bridge-primary` unless you set them too. All Bridge styles sit in a CSS cascade layer named `bridge`, so plain CSS the app writes outside a layer wins over them, whatever the load order and with no `!important`: for anything the tokens don't cover, target Bridge's classes and `[data-bridge-*]` attributes. Tailwind utility classes on Bridge's elements lose where Bridge sets the same property; use plain CSS there.

## 6. Pages Bridge serves

- **Sign-in:** `src/routes/auth/[...bridge]/+page.svelte` serves `/auth/sign-in`, `/auth/sign-up`, `/auth/verify-email` (where the sign-up link lands), `/auth/forgot-password`, `/auth/set-password` (where the reset link lands), `/auth/invite`, `/auth/workspaces`, `/auth/magic-link` and `/auth/passkey-setup`. Which methods appear comes from the app's settings at runtime, so turning sign-in links on needs no code. Bridge's emails link to the app's email-links address (`<app>/auth`).
- **Subscription:** `src/routes/subscription/[...bridge]/+page.svelte` serves `/subscription`, the paywall `/subscription/plan`, and `/subscription/error`; a checkout returns to `/subscription`.
- **The paywall** sends a signed-in workspace to `/subscription/plan` while the flag `bridge-app-active` is off for it (its rule reads whether the subscription allows using the app). `billing: { paywall: false }` in `bridgeBootstrap()` turns it off.
- **A `/welcome` onboarding page is offered, never created unasked.** It is a product decision: ask the developer. Only if they say yes, point `billing: { paywall: '/welcome' }` at it.
- Any other address under a catch-all gets the app's own 404.

## Where the details live

| Topic | Command |
|---|---|
| Sign-in and the sign-in pages | `bridge guide svelte` · `bridge guide svelte sdk-auth` |
| Plans, the subscription pages, the UI levels | `bridge guide svelte billing` |
| Server limits and plan features | `bridge guide nestjs billing` · `bridge guide javascript server` |
| Server sign-in and route protection | `bridge guide nestjs` · `bridge guide nestjs auth` |
| Feature flags | `bridge guide flags` |
| The look | `bridge guide svelte branding` |
| Proving sign-in works | The developer signs up and signs in in the app; `bridge event auth-attempts --user <email>` explains a failure |

## Exceptions

Every gate in app code is a flag (`bridge guide fit-together`). Checking a plan feature without a flag (`@RequireEntitlement` on the backend, `$entitlements.can` in the UI) exists for the rare case where the developer explicitly asks for no flag. Mark the line `// bridge-gate-exception: <reason>` so `check gates` leaves it.
