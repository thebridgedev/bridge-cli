# Bridge Auth — Master Integration Prompt

You are integrating **Bridge Authentication** (auth, tenant management, RBAC) into a user's application. Your job is to detect the project structure, identify the technologies, and apply the right per-framework integration for each.

This prompt is framework-agnostic. It orchestrates discovery, confirmation, and verification — the actual install commands, file shapes, and code snippets live in the per-framework guides fetched in Step 4.

> **Related master prompts** — if the user asked for flags or billing specifically (not auth), stop here and route them:
> - Feature Flags 2.0 only → `bridge guide flags`
> - Billing 2.0 only → `bridge guide billing`
>
> If they want auth + flags + billing wired together, run this prompt first, then chain `bridge guide flags` and `bridge guide billing` at the end (or whichever subset they want).

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
bridge guide <framework>              # hosted-auth audit checklist
bridge guide <framework> sdk-auth     # SDK-auth audit checklist (in-app forms)
```

The framework guide tells you precisely what must exist (bootstrap call, provider wrapping, callback routes, environment variables). Apply that checklist to the project on disk.

**General decision matrix** (independent of framework):

- **Wiring complete AND all required auth routes present** → Bridge is fully integrated. Skip to **Step 6b** and output the success message.
- **Bootstrap wiring complete BUT auth routes missing** → Bridge is partially integrated. The missing routes silently break signup verification, password reset, or SSO callback. Tell the user explicitly which files are missing (the framework guide lists them by name). Add only what's missing — do not regenerate existing routes.
- **Bootstrap wiring incomplete** (regardless of route state) → Offer to complete the initial setup (proceed to Step 4).
- **Bridge is NOT installed** → Continue with Steps 2–6 for fresh setup.

When you find missing pieces, list each one explicitly to the user — they need to know what's broken and why (e.g., "the signup verification email route is missing — every new signup is currently hitting a 404 after clicking the verification link").

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
- **Hosted** → `bridge guide <framework>` (default)
- **SDK** → `bridge guide <framework> sdk-auth`

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

Detect the frontend URL from dev scripts in `package.json` (e.g., `--port 3000`, `--port 5173`). **Show the detected URL to the user and ask for confirmation before proceeding.** Then configure the Bridge app so it accepts OAuth callbacks and CORS requests from the frontend:

```bash
bridge app update \
  --ui-url <frontend-url> \
  --default-callback-uri <frontend-url>/auth/oauth-callback \
  --redirect-uris <frontend-url>/auth/oauth-callback \
  --allowed-origins <frontend-url>
```

If the hosted cloud-views UI is on a different origin (e.g., `http://localhost:3091` in local dev, `https://app.thebridge.dev` in prod), add it to `--allowed-origins` as well:

```bash
bridge app update --allowed-origins <frontend-url>,<hosted-url>
```

Without this, the Bridge API will reject the OAuth redirect (invalid redirect_uri) and block CORS requests from the frontend (origin not allowed).

## Step 4 — Fetch and apply per-framework guides

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

Follow the per-framework guide instructions verbatim. Pass these values from Step 3:
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
- Use the framework's current-user accessor on endpoints that need user identity (the per-framework guide names it: `@CurrentUser()` for NestJS, `req.user` for Express, etc.)

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

## Step 7 — Offer follow-on tracks

After auth is wired and the success banner is printed, the developer commonly wants flags and billing next. Mention these one-liners so they know how to continue:

- **Feature Flags 2.0** → `bridge guide flags` (auto-detects framework, sets up flag evaluation, telemetry, realtime)
- **Billing 2.0** → `bridge guide billing` (subscriptions, plan selector, quota banners, webhook receiver)

Do not run them automatically — the developer decides when they want each track.
