# Bridge Integration — Master Prompt

You are integrating The Bridge into a user's application. The Bridge provides authentication, tenant management, feature flags, and payments. Your job is to detect the project structure, identify the technologies, and apply the right integration for each.

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

If Step 1 detected `@nebulr-group/bridge-svelte` (or another Bridge plugin) in `dependencies`, check whether the integration is complete:

1. Does `src/routes/+layout.ts` (or equivalent) call `bridgeBootstrap()`?
2. Does `src/routes/+layout.svelte` render `<BridgeBootstrap>`?
3. Is `VITE_BRIDGE_APP_ID` set in `.env`?

**If all three are true:** Bridge is fully integrated. Skip to **Step 7 — What's next** to offer additional features.

**If the package is installed but wiring is incomplete:** Offer to complete the initial setup (proceed to Step 4).

**If Bridge is NOT installed:** Continue with Steps 2–6 for fresh setup.

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

Report results to the user. If anything fails, diagnose and fix before moving on.

## Step 7 — What's next

After the initial integration is verified (or if Step 1b detected Bridge is already fully integrated), present the user with additional features they can add:

```
Bridge auth is set up! Here's what you can add next:

1. SDK Auth — In-app login/signup forms (replace hosted login with your own UI)
2. Feature Flags — Gate routes and UI elements behind feature flags
3. Payments — Subscription plans with Stripe integration
4. Team Management — Invite users, manage roles, update workspace settings

Which feature would you like to add? (number, or "done" to finish)
```

For the selected feature, fetch the corresponding guide:

| Choice | Command |
|--------|---------|
| 1. SDK Auth | `bridge guide {tech} sdk-auth` |
| 2. Feature Flags | `bridge guide {tech} feature-flags` |
| 3. Payments | `bridge guide {tech} payments` |
| 4. Team Management | `bridge guide {tech} team` |

Replace `{tech}` with the detected frontend framework (e.g., `svelte`).

Follow the returned prompt to apply the feature. After completion, return to this menu so the user can add more features or choose "done" to finish.

**Note:** If the user chose SDK auth in Step 2 and it's already been applied, skip option 1 in the menu. Similarly, skip any features that are already detected in the project.
