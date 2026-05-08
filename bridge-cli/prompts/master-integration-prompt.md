# Bridge Integration — Master Prompt

You are integrating The Bridge into a user's application. The Bridge provides authentication, tenant management, feature flags, and payments. Your job is to detect the project structure, identify the technologies, and apply the right integration for each.

## Step 0 — Authenticate

Run `bridge auth login` and wait for it to print "Logged in as <email>". Once it exits, proceed to Step 1.

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
   - `@nebulr-group/bridge-svelte`, `@nebulr-group/bridge-react`, etc. → **Bridge already installed — check if wiring is complete**
   - `next-auth`, `@auth0/*`, `@clerk/*`, `lucia`, `passport` → **third-party auth present — warn user**

5. **Record for each project:**
   - Path (relative to working directory)
   - Type: `frontend` or `backend`
   - Framework + version
   - Package manager
   - Existing auth (if any)

## Step 1b — Check if Bridge is already integrated

If Step 1 detected `@nebulr-group/bridge-svelte` (or another Bridge plugin) in `dependencies`, check whether the integration is complete. **Audit both layout wiring AND the auth route files** — a layout-only audit produces false positives, where login and signup work but the signup verification email lands on a 404.

**Layout wiring (all three required):**

1. Does `src/routes/+layout.ts` (or equivalent) call `bridgeBootstrap()`?
2. Does `src/routes/+layout.svelte` render `<BridgeBootstrap>`?
3. Is `VITE_BRIDGE_APP_ID` set in `.env` (or `.env.local`, `.env.example`)?

**SDK auth route files (all seven required when `loginRoute` is set in `BridgeConfig` — i.e., SDK auth, not hosted auth):**

If the project's `BridgeConfig` includes `loginRoute` (in `+layout.ts`), it is using SDK auth and **all seven** of these route files must exist:

4. `src/routes/auth/login/+page.svelte`
5. `src/routes/auth/signup/+page.svelte`
6. `src/routes/auth/oauth-callback/+page.svelte`
7. `src/routes/auth/set-password/[token]/+page.svelte` — **critical:** signup verification emails land here. Missing this silently breaks 100% of new signups.
8. `src/routes/auth/forgot-password/+page.svelte`
9. `src/routes/auth/magic-link/+page.svelte`
10. `src/routes/auth/setup-passkey/[token]/+page.svelte`

Routes 6–10 must exist even if the corresponding feature (SSO, magic link, passkeys) is currently disabled in the Bridge admin config — the admin config toggles UI visibility, not route presence. If a feature is enabled later in production, the route must already be there.

If the project's `BridgeConfig` has no `loginRoute`, it is using hosted auth — only check #4 (login redirect target) and #6 (oauth-callback for SSO).

**Decision matrix:**

- **Layout wiring complete AND all required auth routes present:** Bridge is fully integrated. Skip to **Step 6b** to output the success message.
- **Layout wiring complete BUT auth routes missing:** Bridge is partially integrated — the missing routes will silently break signup or password reset. Offer to fetch the SDK auth guide (`bridge guide svelte sdk-auth`) and add only the missing files. Do not regenerate routes that already exist.
- **Layout wiring incomplete (regardless of route state):** Offer to complete the initial setup (proceed to Step 4).
- **Bridge is NOT installed:** Continue with Steps 2–6 for fresh setup.

When you find missing routes, list each missing path explicitly when you tell the user — they need to know exactly what's broken and why (e.g., "your `auth/set-password/[token]` route is missing — every new signup is currently hitting a 404 after clicking the verification email link").

## Step 2 — Present findings and confirm

Show the user what you found. Example:

```
I detected the following projects:

1. ./my-app-ui — SvelteKit 5 (frontend, bun)
   Existing auth: @nebulr/nblocks-svelte (will migrate to Bridge)

2. ./my-app-api — NestJS 11 (backend, bun)
   No existing auth detected

Which projects should I integrate? (all / select by number)
```

Wait for confirmation before proceeding. If the user selects specific projects, only integrate those.

**Auth approach (frontend projects only):**

After confirming which projects to integrate, ask about the auth approach:

```
Which auth approach do you want for the frontend?

- Hosted (default) — Bridge handles the login page. Fastest setup, zero UI to build.
- SDK — In-app login/signup forms. Full control over the auth UX.
```

Note the user's choice. It determines which guide to fetch in Step 4:
- **Hosted** → `bridge guide svelte` (default)
- **SDK** → `bridge guide svelte sdk-auth`

## Step 3 — Get Bridge app context

Run these commands to get the app configuration:

```bash
bridge app get
bridge info auth-config
```

Extract and note:
- `appId` — needed by both frontend and backend
- Enabled auth methods (password, magic link, SSO providers, passkeys, MFA)
- App URLs (apiUrl, uiUrl, callbackUrl)

If `bridge` CLI is not available or not configured, ask the user for the `appId` directly. They can find it in the Bridge dashboard.

## Step 3b — Configure the Bridge app for the frontend

Detect the frontend URL from dev scripts in package.json (e.g., `--port 3000`). **Show the detected URL to the user and ask for confirmation before proceeding.** Then configure the Bridge app so it accepts OAuth callbacks and CORS requests from the frontend:

```bash
bridge app update \
  --ui-url <frontend-url> \
  --default-callback-uri <frontend-url>/auth/oauth-callback \
  --redirect-uris <frontend-url>/auth/oauth-callback \
  --allowed-origins <frontend-url>
```

If the hosted cloud-views UI is on a different origin (e.g., `http://localhost:3091` in local dev), add it to `--allowed-origins` as well:

```bash
bridge app update --allowed-origins <frontend-url>,<hosted-url>
```

Without this, the Bridge API will reject the OAuth redirect (invalid redirect_uri) and block CORS requests from the frontend (origin not allowed).

## Step 4 — Fetch and apply plugin prompts

For each confirmed project, fetch the framework-specific integration prompt.

**Frontend projects** — use the auth approach chosen in Step 2:

| Framework | Hosted (default) | SDK |
|-----------|-------------------|-----|
| SvelteKit | `bridge guide svelte` | `bridge guide svelte sdk-auth` |
| React | `bridge guide react` | `bridge guide react sdk-auth` |
| Next.js | `bridge guide nextjs` | `bridge guide nextjs sdk-auth` |
| Angular | `bridge guide angular` | `bridge guide angular sdk-auth` |

**Backend projects:**

| Framework | Command |
|-----------|---------|
| NestJS | `bridge guide nestjs` |
| Express | `bridge guide express` |

Follow the plugin prompt instructions. Pass these values from Step 3:
- `appId` — same for all projects
- `packageManager` — detected in Step 1 (use it for all install commands)

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
- Add `@CurrentUser()` decorator to endpoints that need user identity

Tell the user: "I've set up default route protection. You can refine which routes are public or protected using the Bridge CLI (`bridge role list`, `bridge flag list`) or by editing the route config directly."

## Step 6 — Verify

For each integrated project:

1. **Build check** — run the project's build command (from `package.json` scripts)
2. **Config check** — confirm the `appId` environment variable is set
3. **Route check** — confirm protected routes have guards and public routes are accessible

If anything fails, diagnose and fix before moving on. Once the checks pass, move on to the summary in Step 6b — do NOT just dump a list of changed files at the user.

## Step 6b — Tell the developer what they just got

Run `bridge guide integration-success` to fetch the success message template, then output it personalised for this project.

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
