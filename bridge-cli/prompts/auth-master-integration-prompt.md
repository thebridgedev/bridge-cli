# Bridge — Master Integration Prompt (1.0)

You are integrating **The Bridge** (sign-in, workspaces and teams, roles, plans, feature flags) into a user's application, on the new Bridge and its 1.0 plugins. Your job is to detect the project structure, identify the technologies, and apply the right per-framework guide for each.

> **The one rule for app code: every gate is a flag.** A link, a page, a button, an endpoint: if some people get it and others do not, the code asks a flag, and the flag's rule says why (a privilege, a plan feature, a rollout). App code never reads a role, a privilege list, the plan or a plan feature to decide what someone may see or do. Numbers are plan limits, and permission on one specific record stays in app code. `bridge guide fit-together` has the whole rule; the last verification step runs `npx @nebulr-group/bridge-cli@alpha check gates`.

This prompt is framework-agnostic. It orchestrates discovery, confirmation and verification; the install commands, file shapes and code live in the per-framework guides fetched in Step 4.

> **This is the 1.0 line.** The new Bridge works with the 1.0 plugins only, published on the `alpha` tag while 1.0 is in alpha: `@nebulr-group/bridge-svelte@alpha` (SvelteKit), `@nebulr-group/bridge-nestjs@alpha` (NestJS) and `@nebulr-group/bridge-auth-core@alpha` (any other JavaScript app). Never install them from `latest`: that is the 0.x line, which talks to the old Bridge and fails here. Each plugin needs **one setting, the app's issuer**; there is no app id setting and no API address.
>
> **React, Next.js, Angular and Express have no 1.0 plugin yet.** Do not build on their 0.x plugins: tell the developer, and offer auth-core (`bridge guide javascript`) for a JavaScript app, or wait for the plugin.

> **Related master prompts:** if the user asked for flags or billing specifically (not sign-in), route them:
> - Feature flags only → `bridge guide flags`
> - Plans and billing only → `bridge guide billing`
>
> If they want sign-in, flags and billing together, run this prompt first, then `bridge guide flags` and `bridge guide billing` at the end (or whichever subset they want).

## Step 0 — Sign in to Bridge

Install CLI 1.0 (`npm install -g @nebulr-group/bridge-cli@alpha`, or run every command below as `npx @nebulr-group/bridge-cli@alpha …`). Run `bridge auth login` (the first time with `--server https://<the Bridge>`): it opens the Bridge's sign-in page in the browser, where the developer signs in and approves the CLI. Wait for it to finish, then `bridge auth whoami` says who is signed in and which app commands act on. If the developer has several apps, `bridge app list` and `bridge app use <id>` pick the one.

**Connected through the Bridge MCP server instead?** Skip the login: the connection is already signed in to one app. Every CLI step below has a tool; use the tool and do not translate by hand.

| Operation | MCP | CLI |
|---|---|---|
| What Bridge does, to relay to the developer | `get_started` | `bridge guide orientation` |
| Read the app: issuer, addresses (Step 3) | `get_app`, `get_environment_info` (`issuer`) | `bridge app get` |
| Read the sign-in methods (Step 3) | `get_auth_config` | `bridge auth config` |
| Write the issuer into `.env` and add the dev address (Step 3b) | `update_app` (`allowedOrigins`, `uiUrl`) | `bridge app setup --url <dev address>` |
| Add one more address (Step 3b) | `update_app` (`allowedOrigins` replaces the whole list: send every origin) | `bridge app address add <url> --use browser-origin` / `--use email-links` |
| This prompt | `get_integration_guide` (topic `master`) | `bridge guide` |
| A per-framework guide (Step 4) | `get_integration_guide` (topic `integration`, then `auth`) with the framework | `bridge guide <framework>`, then `bridge guide <framework> sdk-auth` |
| Check the project's settings against the app (Step 6) | `diagnose_integration` | `bridge doctor` |
| Why the developer's own sign-in failed (Step 6) | `debug_auth_issue` with their email | `bridge event auth-attempts --user <email>` |
| Roles and flags for route protection (Step 5) | `list_roles`, `list_feature_flags` | `bridge role list`, `bridge flag list` |

---

**At the end of this integration you will output a success message** (Step 6b): MESSAGE 1 of the integration success guide. It opens with the Bridge banner, says what now works, then what you did, Bridge's footprint in the code and every change.

As you work through the steps below, track the following so you have it ready:
- **`[project-name]`**: folder name and/or `package.json` name for each project integrated
- **`[token-description]`**: how the developer reaches the signed-in person in their framework (the `session` and `user` stores on SvelteKit, `@CurrentActor()` on NestJS)
- **`[what-i-actually-did]`**: high-level outcomes: what works now that didn't before
- **`[what-i-changed]`**: every package installed, file created or modified, and address added, with exact values
- **`[footprint]`**: as you make each edit, note its file and its changes (one import, one wrapper, one guard, one env var…), whether the file is new, and whether you modified any of the developer's existing code. Count from this record, never estimate it afterwards
- **`[see-every-change]`**: the git state of each project, recorded in Step 1 before your first edit

## Step 1 — Discover projects

Scan the current directory and its immediate subdirectories for `package.json` files. For each one:

1. **Detect the package manager** from lock files, in this order:
   - `bun.lock` or `bun.lockb` → `bun`
   - `pnpm-lock.yaml` → `pnpm`
   - `yarn.lock` → `yarn`
   - `package-lock.json` or none → `npm`

2. **Detect the framework** (from `dependencies` + `devDependencies`):
   - `@sveltejs/kit` → **SvelteKit** (1.0 plugin: `bridge guide svelte`)
   - `@nestjs/core` → **NestJS** (1.0 plugin: `bridge guide nestjs`)
   - `next`, `react`, `@angular/core`, `express` → **no 1.0 plugin yet**: say so (see the note at the top) and offer auth-core, `bridge guide javascript`
   - any other JavaScript app (Vite, a plain Node server, a worker) → **auth-core**: `bridge guide javascript` (browser) and `bridge guide javascript server`

3. **Detect existing auth** (from `dependencies` + `devDependencies`):
   - `@nebulr-group/bridge-*` at a version below `1.0.0` → **Bridge 0.x**: it talks to the old Bridge. The 1.0 plugin replaces it; the per-framework guide's upgrade section says what changes
   - `@nebulr-group/bridge-*` at `1.0.0-alpha.*` or later → **Bridge 1.0 already installed**: check the wiring (Step 1b)
   - `@nebulr/nblocks-*` → nblocks, Bridge's predecessor: it is replaced
   - `next-auth`, `@auth0/*`, `@clerk/*`, `lucia`, `passport` → **third-party auth present**: warn the user

4. **Record for each project:** path, type (`frontend` or `backend`), framework and version, package manager, existing auth.

5. **Note the git state, before you edit anything.** Run `git status` in each project and record one of: clean; uncommitted changes already there (note which files); not a git repo, or no commits yet. The success message uses it to tell the developer how to see your changes. Never run `git init`, `git add`, `git stash` or `git commit`, and do not ask the developer about git.

## Step 1b — Check if Bridge 1.0 is already integrated

Don't guess from the dependency alone: audit the wiring with the per-framework guide, which lists the exact files the framework needs.

```
bridge guide <framework>              # the setup and its checklist
bridge guide <framework> sdk-auth     # the sign-in pages (SvelteKit)
```

**General decision matrix:**

- **Wiring complete and the sign-in pages are served** → Bridge is integrated. Skip to **Step 6** and verify.
- **Bootstrap wiring complete but the sign-in pages are missing** → partly integrated: without them the email links (finishing a sign-up, resetting a password, invites) land on a 404. On SvelteKit the fix is one file, `src/routes/auth/[...bridge]/+page.svelte` rendering `<BridgeAuthRoutes />`. Add only what is missing.
- **Bootstrap wiring incomplete** → complete the setup (Step 4).
- **Bridge is not installed** → Steps 2–6.

When you find missing pieces, name each one to the user and what it breaks ("the sign-up email's link lands on a missing page, so no new sign-up can finish").

## Step 2 — Tell the developer the plan, ask only what you cannot detect

**Talk to the developer in plain words, once, briefly.** Say what you are about to do. Ask only questions whose answer you could not find in the project. Do not recite what you detected (framework versions, package manager, the Bridge app's settings, enabled sign-in methods), show commands, or name configuration fields.

- **One project:** integrate it. Do not ask which.
- **Several projects:** ask once which to integrate ("I found a SvelteKit app in `./web` and a NestJS API in `./api`: set up both?").
- **Existing auth** (Bridge 0.x, nblocks or a third-party library): say so in one line and what will happen to it.
- **A framework with no 1.0 plugin:** say so in one line, and what you propose instead.

**Sign-in (frontend projects only).** Sign-in happens inside the app: the plugin serves the sign-in, sign-up, email-link and password pages on the app's own `/auth` routes, inside its own layout, styled to match the app's existing design (Step 4). There is nothing to choose. (If the developer explicitly asks for Bridge's hosted sign-in page, respect that: the per-framework sign-in guide has hosted mode.)

Example, the whole message:

```
I'll add sign-in to QR Studio: sign-in and sign-up pages inside the app, styled to
match it. Every page will need sign-in except the home page and those. I'll connect
your Bridge app to http://localhost:5180.

One question: should sign-in also work when you open the app over Tailscale? If so,
paste the full https://….ts.net:8445 address.
```

With no question left to ask, say what you are doing and carry on; do not wait for a "yes".

## Step 3 — Read the Bridge app (for you, not the developer)

```bash
bridge app get
bridge auth config
```

Note the app's **issuer** (`trust.issuer` in `bridge app get`; MCP: `get_environment_info` `issuer`): frontend and backend both need it, and it is the only Bridge setting they need. Note the enabled sign-in methods and the app's addresses. Use them to decide what to change; do not report them. If the CLI is not available, ask the developer for the issuer: it is in the app's settings in the Bridge dashboard.

## Step 3b — Connect the Bridge app to the project

Take the frontend's development address from the project: a port fixed in `vite.config.*`, `--port` in a dev script, the framework default otherwise (`http://localhost:5173` for Vite and SvelteKit). Ask only when it is genuinely unclear, or when the project also serves the app on another address (a tunnel, a LAN or Tailscale host, a second dev script); then ask whether sign-in should work there too, and add each address they confirm.

In the frontend project's folder:

```bash
bridge app setup --url <dev address>
```

This writes the app's issuer into `.env` (as `PUBLIC_BRIDGE_ISSUER`, what bridge-svelte reads; `--var <name>` writes another name, `--dotenv <file>` another file), and adds the address as a **browser origin** and `<address>/auth` as the **email-links address**. Running it again changes nothing. For every further address:

```bash
bridge app address add https://app.example.com --use browser-origin
bridge app address add https://app.example.com/auth --use email-links
bridge app address list
```

Why each matters (for you): without the browser origin Bridge refuses the page's calls; without the email-links address the links in Bridge's emails (finishing a sign-up, resetting a password, an invite) have nowhere to land, and sending an invite is refused. A NestJS backend needs no address: it reads the same issuer, as `BRIDGE_ISSUER`.

Tell the developer at most one line about this ("Connected your Bridge app to http://localhost:5180"), never the field names.

## Step 4 — Fetch and apply the per-framework guides

For each confirmed project, fetch the framework's guide.

| Framework | Setup | Sign-in pages, look |
|-----------|-------|---------------------|
| SvelteKit | `bridge guide svelte` | `bridge guide svelte sdk-auth`, `bridge guide svelte branding` |
| NestJS (backend) | `bridge guide nestjs` | `bridge guide nestjs auth` |
| Any other JavaScript app | `bridge guide javascript` | `bridge guide javascript server` for its server |
| React, Next.js, Angular, Express | no 1.0 plugin yet | `bridge guide react` (and the others) says what to use instead |

**Match the app's design.** The sign-in pages render inside the app, so they must look like the rest of it, not like Bridge's defaults. Before you finish, read the app's existing styles (global CSS, CSS variables, Tailwind theme, the font it loads, an existing button and input) and set the `--bridge-*` design tokens from them in the app's own stylesheet; if the app wraps its pages in a card or shell, give the sign-in pages the same frame. `bridge guide svelte branding` has the mapping and every token. Ask for colours only when the project has no styles of its own.

Follow the per-framework guide. Pass these values from Step 3:
- the **issuer**: the same for every project of the app. SvelteKit reads `PUBLIC_BRIDGE_ISSUER` (on SvelteKit 3, declared in `src/env.ts`, as the guide shows), NestJS reads `BRIDGE_ISSUER`, auth-core takes it as `createBridge({ issuer })`
- the **package manager**: detected in Step 1, for every install command

**What the handover looks like.** The guides are short because the plugins serve their own pages. On SvelteKit the whole sign-in integration is the issuer in `.env`, `src/routes/+layout.ts` (`export const ssr = false; export const load = bridgeBootstrap({ rules })`), `src/routes/+layout.svelte` (the styles import and `<BridgeBootstrap>`), and one file for every sign-in page, `src/routes/auth/[...bridge]/+page.svelte` rendering `<BridgeAuthRoutes />`. With plans, one more file serves the subscription pages: `src/routes/subscription/[...bridge]/+page.svelte` rendering `<BridgeBillingRoutes />`. On NestJS it is `BridgeModule.forRoot({ guard: { global: true } })` in `AppModule` and `BRIDGE_ISSUER` in the environment. Do not write sign-in, sign-up or password pages by hand, and no fetch helper for tokens (`bridgeFetch` adds the token). `bridge guide mechanisms` explains the levels and customisation rungs if the developer asks for more.

**Order:** frontend first, then backend, so sign-in works before backend guards are added.

## Step 5 — Route protection defaults

**Frontend (SvelteKit):**
- Every route needs a signed-in person by default (`defaultAccess: 'protected'`, the default); the sign-in pages under `/auth` are always open
- Mark as public only what is clearly public: the home or landing page (`{ match: '/', public: true }`), docs, a pricing page
- Do NOT make other routes public by default. The user can relax this later for specific pages

**Backend (NestJS):**
- `guard: { global: true }`: every route needs a valid credential
- Mark as public: health checks and public read-only endpoints (`@Public()`)
- Use `@CurrentActor()` on endpoints that need to know who calls (`personId`, `workspaceId`)

Tell the user: "Every page needs sign-in except the ones I made public. You can open more pages to visitors in `src/routes/+layout.ts`; who may use what beyond that is a flag (`bridge flag list`)."

## Step 6 — Verify

Run the terminal checks. If you have a browser tool, run the browser checks too. If you do not, list them for the developer, numbered, and start the summary with a Heads up line saying which checks were not run.

### Terminal checks

1. **Build**: run the project's build command (from `package.json` scripts)
2. **Settings**: `bridge doctor` in each project compares its Bridge settings with the app and names every difference with its fix; fix each one. `bridge app address list` shows the dev address as a browser origin and `<address>/auth` for email links
3. **Routes**: protected routes have a rule or guard, public ones say `public: true` / `@Public()`
4. **Gates**: `npx @nebulr-group/bridge-cli@alpha check gates` in each project lists each direct role, privilege, plan or plan-feature check with the flag to use instead. Fix every one and run it again until it is clean. Only a check the developer explicitly asked to keep stays, marked `// bridge-gate-exception: <reason>`

### Browser checks

Signing up needs the developer's own inbox, so these are the developer's, with or without a browser tool. List them, numbered:

1. Sign up at `/auth/sign-up` in the running app
2. Open the email's link: the sign-up finishes and you are signed in
3. Sign out, then sign in at `/auth/sign-in`
4. Open a protected page while signed out: you are sent to sign-in and come back to it afterwards

Do not create test users for them. If a step fails, `bridge event auth-attempts --user <their email>` (MCP: `debug_auth_issue`) names the reason and the fix.

If a terminal check fails, diagnose and fix before moving on. Then go on to Step 6b; do NOT just dump a list of changed files at the user.

## Step 6b — Tell the developer what they just got

Fetch the success message guide (MCP: `get_integration_guide` topic `integration-success`; CLI: `bridge guide integration-success`) and output its MESSAGE 1 (sign-in), personalised for this project. Do this even when the gate check's line is the last thing you read: it reminds you of this step.

**Substitutions (always apply):**

- `[project-name]` → the `name` field from the project's `package.json`
- `[bridge-plugin]` → the installed Bridge plugin (`bridge-svelte`, `bridge-nestjs`, `bridge-auth-core`)
- `[dev-url]` → the frontend development address from Step 3b (e.g. `http://localhost:5173`)

**Personalisation rules:**

- Fill in every `[placeholder]` using the substitution guide at the bottom of the template. For `[what-i-actually-did]`, `[footprint]` and `[what-i-changed]`, draw from what you actually observed and changed during Steps 1–6; the examples in the guide are illustrative only. Count the footprint from your record of each edit and pick `[see-every-change]` from the git state you noted in Step 1. Output MESSAGE 1 only: never the `WHICH MESSAGE TO SHOW` part, the MESSAGE headings or the `AGENT SUBSTITUTION GUIDE`.
- If both a frontend and a backend were integrated, group the bottom two sections by project.
- **DO NOT write any text before the banner.** The very first character of your response must be the first character of the ASCII art, unless the next rule applies.
- **When a check failed or was not run** (the build is broken, a terminal check is not clean, or the browser checks are still the developer's to do), the first line is "Heads up: not verified in a browser" (or what else was not verified) naming those checks, then the banner. Never bury bad news under it.

After delivering the message, the integration is complete.

## Step 7 — Offer follow-on tracks

After sign-in is wired and the success message is printed, mention these one-liners so they know how to continue:

- **Feature flags** → `bridge guide flags`
- **Plans and billing** → `bridge guide billing` (plans, the subscription pages, the paywall, plan limits on the server)
- **Teams** → `bridge guide svelte team` (the team panel)

Do not run them automatically: the developer decides when they want each track.
