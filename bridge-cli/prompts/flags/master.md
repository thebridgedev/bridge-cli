# Bridge Feature Flags — Master Integration Prompt

You are integrating **Bridge Feature Flags** into a user's application — the flags-only path. No auth scaffolding, no billing components. If the user also wants auth or billing, run `bridge guide` (auth master) or `bridge guide billing` afterwards.

This master prompt orchestrates discovery, confirmation, and verification. The **actual install commands, provider shapes, and runnable code snippets live in the per-framework prompts** that ship in each plugin repo's `mcp/` folder. This master does the planning; the per-framework prompts do the wiring.

## Where per-framework prompts live

Each plugin repo owns its own framework-specific prompt under `mcp/feature-flags-prompt.md`. The CLI fetches them on demand:

| Framework | Plugin repo | Fetched by |
|-----------|-------------|------------|
| SvelteKit | `bridge-svelte/mcp/feature-flags-prompt.md` | `bridge guide flags --framework svelte` |
| React | `bridge-react/mcp/feature-flags-prompt.md` | `bridge guide flags --framework react` |
| Next.js | `bridge-nextjs/mcp/feature-flags-prompt.md` | `bridge guide flags --framework nextjs` |
| Angular | `bridge-angular/mcp/feature-flags-prompt.md` | `bridge guide flags --framework angular` |
| NestJS | `bridge-nestjs/mcp/feature-flags-prompt.md` | `bridge guide flags --framework nestjs` |
| Express | `bridge-express/mcp/feature-flags-prompt.md` | `bridge guide flags --framework express` |

`bridge guide <framework> flags` is an equivalent route — both call the same plugin-repo prompt.

If the CLI returns `HTTP 404 — file may not exist yet in the plugin repo`, the plugin hasn't published its Flags  guide yet. Tell the user that's the blocker and fall back to `@nebulr-group/bridge-auth-core` directly (it's framework-agnostic and stable). Do NOT improvise an inline integration in this master prompt — the plugin guide is the canonical handover.

## Step 0 — Authenticate

Run `bridge auth login` and wait for it to print "Logged in as <email>".

If the user is using flags **without Bridge Auth** (bring-your-own identity), they still need to be logged into the CLI to fetch app config and manage flags. Login is not the same as runtime identity.

---

**At the end of this integration you will output a success message:**

```
   ██████╗ ██████╗ ██╗██████╗  ██████╗ ███████╗
   ██╔══██╗██╔══██╗██║██╔══██╗██╔════╝ ██╔════╝
   ██████╔╝██████╔╝██║██║  ██║██║  ███╗█████╗
   ██╔══██╗██╔══██╗██║██║  ██║██║   ██║██╔══╝
   ██████╔╝██║  ██║██║██████╔╝╚██████╔╝███████╗
   ╚═════╝ ╚═╝  ╚═╝╚═╝╚═════╝  ╚═════╝ ╚══════╝

  ──────────────────────────────────────────────
   Feature flags are live in [project-name].

    ✅  Flags read from the bulk-evaluate endpoint at boot
    ✅  Eval context wired: [identity-source]
    ✅  Telemetry batching enabled
    ✅  Realtime updates enabled (optional)
  ──────────────────────────────────────────────
    Here is what I actually did:
    [what-i-actually-did]

    And here is what I changed:
    [what-i-changed]
  ──────────────────────────────────────────────
```

Track as you work:
- **`[project-name]`** — folder name and/or `package.json` name for each project
- **`[identity-source]`** — how `identity` flows in (Bridge Auth `user.id`, your own session, anonymous bucket ID, etc.)
- **`[what-i-actually-did]`** — high-level outcomes
- **`[what-i-changed]`** — every package installed, file modified, env var set

## Mental model (1-minute version)

A flag in  has:

| Field | Possible values |
|---|---|
| `state` | `off` · `on` · `on-with-rule` |
| `valueType` | `boolean` · `string` · `number` · `json` |
| `offValue` | typed per `valueType` (returned when state=off) |
| `onValue` | typed per `valueType` (returned when state=on) |
| `rule` | branches[] + otherwiseValue + rolloutPct (only when state=on-with-rule) |

Branches are first-match-wins; conditions within a branch AND together; `rolloutPct` is rule-level (0-100) and requires `identity` on the eval context.

The SDK call is the same everywhere — `bridge.flag(key, defaultValue)`. The return type is inferred from `defaultValue`, so no casts.

## Step 1 — Discover projects

Scan the current directory and its immediate subdirectories for `package.json` files. For each one:

1. **Package manager** — detect from lock file:
   - `bun.lock` / `bun.lockb` → `bun`
   - `pnpm-lock.yaml` → `pnpm`
   - `yarn.lock` → `yarn`
   - `package-lock.json` or none → `npm`

2. **Framework** (from `dependencies` + `devDependencies`):
   - `svelte` or `@sveltejs/kit` → **SvelteKit**
   - `react` + `next` → **Next.js**
   - `react` (without next) → **React**
   - `@angular/core` → **Angular**
   - `@nestjs/core` → **NestJS** (backend)
   - `express` (without `@nestjs/core`) → **Express** (backend)

3. **Existing Bridge plugin?** Check for `@nebulr-group/bridge-<framework>` — if present, the project may already have auth or other Bridge surfaces. Flags can co-exist with auth in the same plugin; the per-framework guide will tell you whether the unified `useBridge()` is already in place.

4. **Existing flag system?** Look for `launchdarkly-*`, `@unleash/*`, `posthog-js`, `growthbook-*` — warn the user that Bridge flags will run in parallel unless they migrate.

5. **Record** for each project: path, type (frontend/backend), framework, package manager, existing flag system (if any).

## Step 2 — Present findings and confirm

```
I detected the following projects:

1. ./my-app-ui — SvelteKit 5 (frontend, bun)
   Existing flags: none

2. ./my-app-api — NestJS 11 (backend, bun)
   Existing flags: none

Which projects should I wire flags into? (all / select by number)
```

Wait for confirmation. If specific projects are selected, only integrate those.

**Identity source (frontend + backend both).** Ask:

```
How should flags identify users?

- Bridge Auth (default if already integrated) — uses the authenticated user's id
- Your own user model — you pass identity yourself per call / per request
- Anonymous — every visitor gets a stable random bucket id (no targeting beyond rolloutPct)
```

Note the answer — Step 4 wires the eval context based on it.

## Step 3 — Get Bridge app context

Run:

```bash
bridge app get
bridge info flags
```

Extract and note:
- `appId` — needed by every project
- Existing flags in the app (if any) — useful to show the user what they can already read

If `bridge` CLI is not available or not configured, ask the user for the `appId` directly.

## Step 4 — Fetch the per-framework prompt and follow it

For each confirmed project, fetch the framework-specific flags prompt and follow it verbatim:

```bash
bridge guide flags --framework <name>
```

Where `<name>` is one of: `svelte`, `react`, `nextjs`, `angular`, `nestjs`, `express`.

| Framework | Command |
|-----------|---------|
| SvelteKit | `bridge guide flags --framework svelte` |
| React | `bridge guide flags --framework react` |
| Next.js | `bridge guide flags --framework nextjs` |
| Angular | `bridge guide flags --framework angular` |
| NestJS | `bridge guide flags --framework nestjs` |
| Express | `bridge guide flags --framework express` |

`bridge guide <framework> flags` is an equivalent route — both call the same plugin-repo prompt.

**Every per-framework guide covers this contract:**

- **Install** — the right package + version + import path (`/flags` entry point so auth code isn't pulled in unnecessarily)
- **Bootstrap** — provider / module / factory setup, `appId` + `baseUrl` + `mode` config
- **Eval context** — idiomatic placement for `identity` and `attributes`, including how to wire the `identitySource` chosen in Step 2
- **Reading a flag** — the framework wrapper (`useFlag`, `FeatureFlag`, `signal`, decorator) and the synchronous `evaluateFlag` for non-reactive contexts
- **Advanced attribute wiring** — the unified `bridge.attributes` write surface and realtime event subscription via `bridge.events.handle`
- **Telemetry + realtime** — both on by default; how to disable
- **Troubleshooting** — the most common first-time failures

**Pass these values from this master to the per-framework prompt:**
- `appId` — from Step 3
- `baseUrl` — `https://api.thebridge.dev` (default; only override for self-hosted)
- `packageManager` — from Step 1
- `mode` — `frontend` (browser projects) or `backend` (NestJS, Express, Next.js server)
- `identitySource` — from Step 2

**Order:** Frontend first, then backend.

If the CLI returns `HTTP 404`, the plugin hasn't published its Flags  guide yet. Tell the user that's the blocker and fall back to `@nebulr-group/bridge-auth-core` directly — `new BridgeFlags({ appId, baseUrl, mode })` + `bridge.setContext({...})` + `bridge.flag(...)`. The SDK shape is identical across frameworks; only the bindings differ.

## Step 5 — Verify

For each integrated project:

1. **Build check** — run the project's build command (from `package.json` scripts)
2. **Eval check** — read one flag (existing or freshly created) and confirm it returns the expected value
3. **Context check** — confirm `identity` is set when the project uses any rolled-out rule

If anything fails, diagnose and fix before moving on.

## Step 6 — Tell the developer what they just got

Output the success message at the top of this prompt, personalised for what you actually did. Same rules as the auth master:

- Fill every `[placeholder]` with real values
- Strip any agent-only notes
- Group by project if both frontend and backend were integrated
- **Do not** write any text before the banner — start with the `█` character
- If a build is broken or flag reads return defaults forever, prepend a single "Heads up:" line before the banner

After delivering the message, the flags integration is complete.

## Reference notes

**Frontend vs backend:** The frontend SDK evaluates flags from a local cache hydrated at boot. The backend SDK (`mode: 'backend'`) evaluates per-request and requires an explicit `identity` for any rule using `rolloutPct < 100` — no anonymous bucketing.

**Flags without Bridge Auth:** Flags work standalone. Pass your own `identity` and `attributes` when `identitySource` is "your own user model". If Bridge Auth is already installed, `role` and `plan` merge into the eval context automatically via the auth attribute provider wired by the per-framework guide.
