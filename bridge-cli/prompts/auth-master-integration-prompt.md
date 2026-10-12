# Bridge Auth — Master Integration Prompt

You are integrating **Bridge Authentication** (auth, tenant management, RBAC) into a user's application. Your job is to detect the project structure, identify the technologies, and apply the right per-framework integration for each.

> **The one rule for app code: every gate is a flag.** A link, a page, a button, an endpoint: if some people get it and others do not, the code asks a flag, and the flag's rule says why (a privilege, a plan feature, a rollout). App code never reads a role, a privilege list, the plan or a plan feature to decide what someone may see or do. Numbers are plan limits, and permission on one specific record stays in app code. `bridge guide fit-together` has the whole rule; the last verification step runs `npx @nebulr-group/bridge-cli check gates`.

This prompt is framework-agnostic. It orchestrates discovery, confirmation, and verification — the actual install commands, file shapes, and code snippets live in the per-framework guides fetched in Step 4.

> **Related master prompts** — if the user asked for flags or billing specifically (not auth), stop here and route them:
> - Feature Flags 2.0 only → `bridge guide flags`
> - Billing 2.0 only → `bridge guide billing`
>
> If they want auth + flags + billing wired together, run this prompt first, then chain `bridge guide flags` and `bridge guide billing` at the end (or whichever subset they want).

## Step 0 — Authenticate

Run `bridge auth login` and wait for it to print "Logged in as <email>". Once it exits, proceed to Step 1.

**Connected through the Bridge MCP server instead?** Skip the login: the connection is already signed in to one app. Every CLI step below has a tool; use the tool and do not translate by hand.

| Operation | MCP | CLI |
|---|---|---|
| What Bridge does, to relay to the developer | `get_started` | `bridge guide orientation` |
| Read the app: id, URLs, redirect URIs (Step 3) | `get_app` | `bridge app get` |
| Read the login methods (Step 3) | `get_auth_config` | `bridge info auth-config` |
| Set the frontend URL, callback and allowed origins (Step 3b) | `update_app` (`uiUrl`, `defaultCallbackUri`, `allowedOrigins`); `allowedOrigins` replaces the whole list, so send every origin | `bridge app update --ui-url … --default-callback-uri … --allowed-origins …` |
| Add one redirect URI, keeping the others (Step 3b) | `add_redirect_uri` | `bridge app redirect-uris add <url>` |
| This prompt | `get_integration_guide` (topic `master`) | `bridge guide` |
| A per-framework guide (Step 4) | `get_integration_guide` (topic `integration`, then `auth`) with the framework | `bridge guide <framework>`, then `bridge guide <framework> sdk-auth` |
| Check the project's env vars against the app (Step 6) | `diagnose_integration` | `bridge diagnose` |
| Why the developer's own sign-in failed (Step 6) | `debug_auth_issue` with their email | `bridge event auth-attempts --user <email>` |
| Roles and flags for route protection (Step 5) | `list_roles`, `list_feature_flags` | `bridge role list`, `bridge flag list` |

---

**At the end of this integration you will output a success message that looks like this:**

```
   ██████╗ ██████╗ ██╗██████╗  ██████╗ ███████╗
   ██╔══██╗██╔══██╗██║██╔══██╗██╔════╝ ██╔════╝
   ██████╔╝██████╔╝██║██║  ██║██║  ███╗█████╗
   ██╔══██╗██╔══██╗██║██║  ██║██║   ██║██╔══╝
   ██████╔╝██║  ██║██║██████╔╝╚██████╔╝███████╗
   ╚═════╝ ╚═╝  ╚═╝╚═╝╚═════╝  ╚═════╝ ╚══════╝

  ──────────────────────────────────────────────
   Congratulations — [project-name] now has superpowers.
   ...
    ✅  You know who's calling
        [token-description]
   ...
  ──────────────────────────────────────────────
    Here is what I actually did:
    [what-i-actually-did]

    And here is what I changed:
    [what-i-changed]
  ──────────────────────────────────────────────
```

As you work through the steps below, track the following so you have it ready:
- **`[project-name]`** — folder name and/or `package.json` name for each project integrated
- **`[token-description]`** — the identifiers the developer uses to access the authenticated user in their framework (e.g. stores for Svelte, hooks for React, decorators for NestJS)
- **`[what-i-actually-did]`** — high-level outcomes: what works now that didn't before
- **`[what-i-changed]`** — every package installed, file created or modified, and URL configured, with exact values

## Step 1 — Discover projects

Scan the current directory and its immediate subdirectories for `package.json` files. For each one:

1. **Detect the package manager** — check for lock files in this order:
   - `bun.lock` or `bun.lockb` → use `bun`
   - `pnpm-lock.yaml` → use `pnpm`
   - `yarn.lock` → use `yarn`
   - `package-lock.json` or none → use `npm`

2. **Detect frontend framework** (from `dependencies` + `devDependencies`):
   - `svelte` or `@sveltejs/kit` → **SvelteKit**
   - `react` + `next` → **Next.js**
   - `react` (without next) → **React**
   - `@angular/core` → **Angular**

3. **Detect backend framework** (from `dependencies`):
   - `@nestjs/core` → **NestJS**
   - `express` (without @nestjs/core) → **Express**

4. **Detect existing auth** (from `dependencies` + `devDependencies`):
   - `@nebulr/nblocks-svelte`, `@nebulr/nblocks-react`, etc. → **nblocks (predecessor to Bridge — migration needed)**
   - `@nebulr-group/bridge-svelte`, `@nebulr-group/bridge-react`, `@nebulr-group/bridge-nestjs`, etc. → **Bridge already installed — check if wiring is complete (see Step 1b)**
   - `next-auth`, `@auth0/*`, `@clerk/*`, `lucia`, `passport` → **third-party auth present — warn user**

5. **Record for each project:**
   - Path (relative to working directory)
   - Type: `frontend` or `backend`
   - Framework + version
   - Package manager
   - Existing auth (if any)

## Step 1b — Check if Bridge is already integrated

If Step 1 detected a Bridge plugin (`@nebulr-group/bridge-<framework>`) in `dependencies`, the integration may already be partially or fully complete. Don't guess from the dependency alone — audit the wiring.

**Delegate the audit to the per-framework guide.** Each plugin's guide ships an "Integration audit" section that lists the exact files / providers / route shapes the framework requires. Run:

```
bridge guide <framework>              # integration audit checklist
bridge guide <framework> sdk-auth     # the sign-in pages and their design
```

The framework guide tells you precisely what must exist (bootstrap call, provider wrapping, the auth pages, environment variables). Apply that checklist to the project on disk.

**General decision matrix** (independent of framework):

- **Wiring complete AND the auth pages are served** → Bridge is fully integrated. Skip to **Step 6b** and output the success message.
- **Bootstrap wiring complete BUT the auth pages are missing** → Bridge is partially integrated. Without them signup verification, password reset and the SSO callback land on a 404. On SvelteKit the fix is one file, `src/routes/auth/[...bridge]/+page.svelte` rendering `<BridgeAuthRoutes />`; hand-written pages that only render a Bridge component can then be deleted. React: one `/auth/*` route rendering `<BridgeAuthRoutes />`. Next.js: `app/auth/[...bridge]/page.tsx` rendering `<BridgeAuthRoutes />`. Angular: `...bridgeAuthRoutes()` spread into `app.routes.ts`. Add only what's missing.
- **Bootstrap wiring incomplete** (regardless of route state) → Offer to complete the initial setup (proceed to Step 4).
- **Bridge is NOT installed** → Continue with Steps 2–6 for fresh setup.

When you find missing pieces, list each one explicitly to the user — they need to know what's broken and why (e.g., "the signup verification email route is missing — every new signup is currently hitting a 404 after clicking the verification link").

## Step 2 — Tell the developer the plan, ask only what you cannot detect

**Talk to the developer in plain words, once, briefly.** Say what you are about to do. Ask only questions whose answer you could not find in the project. Do not recite what you detected (framework versions, package manager, the Bridge app's settings, enabled sign-in methods), show commands, or name configuration fields. That detail is for you; the developer did not ask for it.

- **One project:** integrate it. Do not ask which.
- **Several projects:** ask once which to integrate ("I found a SvelteKit app in `./web` and a NestJS API in `./api` — set up both?").
- **Existing auth** (nblocks or a third-party library): say so in one line and what will happen to it. This is the one thing about the current state worth mentioning.

**Sign-in (frontend projects only).** Sign-in happens inside the app (SDK mode): the plugin serves the login, signup and password pages on the app's own routes, inside its own layout, styled to match the app's existing design (Step 4). There is nothing to choose. (If the developer explicitly asks for Bridge's hosted sign-in page, or the app already uses it, respect that.)

Example — the whole message:

```
I'll add sign-in to QR Studio: sign-in and sign-up pages inside the app, styled to
match it. Every page will need sign-in except those. I'll connect your Bridge app to
http://localhost:5180.

One question: should sign-in also work when you open the app over Tailscale? If so,
paste the full https://….ts.net:8445 address.
```

With no question left to ask, say what you are doing and carry on; do not wait for a "yes".

## Step 3 — Read the Bridge app (for you, not the developer)

```bash
bridge app get
bridge info auth-config
```

Note the `appId` (frontend and backend both need it), the enabled sign-in methods and the app's URLs. Use them to decide what to change; do not report them. If the CLI is not available or not configured, ask the developer for the `appId`; it is in the Bridge dashboard.

## Step 3b — Point the Bridge app at the frontend

Take the frontend URL from the project: a port fixed in `vite.config.*`, `--port` in a dev script, the framework default otherwise. Ask only when it is genuinely unclear, or when the project also serves the app on another address (a tunnel, a LAN or Tailscale host, a second dev script) — then ask whether sign-in should work there too, and add each address they confirm.

Then update the app. Change only what is missing; read the current values first, and pass the full list back for `--allowed-origins`, which replaces it:

```bash
bridge app update \
  --ui-url <frontend-url> \
  --default-callback-uri <frontend-url>/auth/oauth-callback \
  --redirect-uris <frontend-url>/auth/oauth-callback \
  --allowed-origins <frontend-url>
```

Why each matters (for you): without the callback in the redirect URIs Bridge rejects the sign-in redirect; without the origin it blocks the browser's requests. `--ui-url` is where links in Bridge's emails point when your backend sends them; unset, people land on a Bridge page instead of your app, and it must also be one of the allowed origins.

Tell the developer at most one line about this ("Connected your Bridge app to http://localhost:5180"), never the field names.

## Step 4 — Fetch and apply per-framework guides

For each confirmed project, fetch the framework-specific integration prompt.

**Frontend projects** — the setup, then the sign-in pages:

| Framework | Setup | Sign-in pages and their design |
|-----------|-------|--------------------------------|
| SvelteKit | `bridge guide svelte` | `bridge guide svelte sdk-auth` |
| React | `bridge guide react` | `bridge guide react sdk-auth` |
| Next.js | `bridge guide nextjs` | `bridge guide nextjs sdk-auth` |
| Angular | `bridge guide angular` | `bridge guide angular sdk-auth` |

**Match the app's design.** The sign-in pages render inside the app, so they must look like the rest of it, not like Bridge's defaults. Before you finish, read the app's existing styles (global CSS, CSS variables, Tailwind or theme config, the font it loads, an existing button and input) and set the `--bridge-*` design tokens from them; if the app wraps its pages in a card or shell, give the sign-in pages the same frame. The per-framework guide's *Match the app's design* section has the mapping. Ask for colours only when the project has no styles of its own.

**Backend projects:**

| Framework | Command |
|-----------|---------|
| NestJS | `bridge guide nestjs` |
| Express | `bridge guide express` |

Follow the per-framework guide instructions verbatim. Pass these values from Step 3:
- `appId` — same for all projects; it goes in the project's `.env` (`VITE_BRIDGE_APP_ID` on SvelteKit and React, `NEXT_PUBLIC_BRIDGE_APP_ID` on Next.js, `BRIDGE_APP_ID` on NestJS and Express), which the plugin reads itself. Angular has no env convention: `appId` goes in `provideBridge({ appId })` from `environment.ts`. On every plugin an option passed explicitly wins over the environment
- `packageManager` — detected in Step 1 (use it for all install commands)

**What the handover looks like.** The guides are short because the plugins serve their own pages. On SvelteKit the whole frontend integration is the `.env` line, `src/routes/+layout.ts` (`export const load = bridgeBootstrap({ rules })`), `src/routes/+layout.svelte` (`<BridgeBootstrap>`) and one auth file, `src/routes/auth/[...bridge]/+page.svelte` — about fifteen lines. React, Next.js and Angular follow the same shape: the provider (`<BridgeProvider>` / `provideBridge()`), one auth route (`<BridgeAuthRoutes>` / `...bridgeAuthRoutes()`) and, with plans, one subscription route on `/subscription` (`<BridgeBillingRoutes>` / `...bridgeBillingRoutes()`). On NestJS it is `BridgeModule.forRoot({ guard: { global: true } })` in `AppModule` and the `.env` line; on Express, `createBridge()` and `app.use(bridge.auth())`. Do not write login, signup, callback or password pages by hand, and no fetch helper for tokens. `bridge guide mechanisms` explains the levels and customisation rungs if the developer asks for more.

**Order:** Frontend first, then backend. This lets you verify login works before adding backend guards.

## Step 5 — Route protection defaults

When setting up route protection, apply these sensible defaults:

**Frontend:**
- `defaultAccess: 'protected'` — everything requires login by default
- Mark as public: auth routes only (`/auth/*`) — the OAuth callback must be accessible
- Do NOT make other routes public by default. The user can relax this later for specific pages

**Backend:**
- `guard.global: true` with `defaultAccess: 'protected'`
- Mark as public: health check endpoints, public read-only APIs
- Use the framework's current-user accessor on endpoints that need user identity (the per-framework guide names it: `@CurrentUser()` for NestJS, `req.user` for Express, etc.)

Tell the user: "I've set up default route protection. You can refine which routes are public or protected using the Bridge CLI (`bridge role list`, `bridge flag list`) or by editing the route config directly."

## Step 6 — Verify

For each integrated project:

1. **Build check** — run the project's build command (from `package.json` scripts)
2. **Config check** — confirm the `appId` environment variable is set
3. **Route check** — confirm protected routes have guards and public routes are accessible
4. **Sign-in check** — ask the developer to sign up and sign in themselves in the running app: sign up at `/auth/signup`, open the verification email, set a password, sign in, sign out. Do not create test users for them. If a step fails, `bridge event auth-attempts --user <their email>` (MCP: `debug_auth_issue`) names the reason and the fix.
5. **Gate check** — run `npx @nebulr-group/bridge-cli check gates` in each project. Every gate in app code is a flag: it lists each direct role, privilege, plan or plan-feature check with the flag to use instead. Fix every one and run it again until it is clean. Only a check the developer explicitly asked to keep stays, marked `// bridge-gate-exception: <reason>`

If anything fails, including the gate check, diagnose and fix before moving on. Once the checks pass, move on to the summary in Step 6b — do NOT just dump a list of changed files at the user.

## Step 6b — Tell the developer what they just got

Fetch the success message template (MCP: `get_integration_guide` topic `integration-success`; CLI: `bridge guide integration-success`), then output it personalised for this project.

**Substitutions (always apply):**

- `[project-name]` → the `name` field from the project's `package.json`
- `[bridge-plugin]` → the installed Bridge plugin (e.g. `bridge-svelte`, `bridge-react`, `bridge-nestjs`)
- `[dev-url]` → the frontend dev server URL detected in Step 3b (e.g. `http://localhost:5173`)

**Personalisation rules:**

- Fill in every `[placeholder]` using the substitution guide at the bottom of the template. For `[what-i-actually-did]` and `[what-i-changed]`, draw from what you actually observed and changed during Steps 1–6 — the examples in the guide are illustrative only. Strip the `AGENT SUBSTITUTION GUIDE` section before outputting — it must never be shown to the developer.
- If both a frontend and a backend were integrated, group the bottom two sections by project rather than merging them into a flat list.
- **DO NOT write any text before the banner.** The very first character of your response must be the first character of the ASCII art. No "Perfect!", no "Here's your success message:", no transition sentence, no acknowledgement — nothing. Start with the `█` character. If you find yourself typing an intro, stop and delete it.
- **If the build is broken** or auth doesn't actually work end-to-end, prepend a single "Heads up:" line before the banner. Never bury bad news under it.

After delivering the message, the integration is complete.

## Step 7 — Offer follow-on tracks

After auth is wired and the success banner is printed, the developer commonly wants flags and billing next. Mention these one-liners so they know how to continue:

- **Feature Flags 2.0** → `bridge guide flags` (auto-detects framework, sets up flag evaluation, telemetry, realtime)
- **Billing 2.0** → `bridge guide billing` (plans, the subscription pages, the paywall, plan limits enforced by the backend)

Do not run them automatically — the developer decides when they want each track.
