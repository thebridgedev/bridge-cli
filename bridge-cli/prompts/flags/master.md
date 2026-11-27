# Bridge Feature Flags — Master Integration Prompt (1.0)

You are integrating **Bridge feature flags** into a user's application, on the new Bridge and its 1.0 plugins: the flags-only path. No sign-in scaffolding beyond what flags need, no billing components. If the user also wants sign-in or billing, run `bridge guide` (the master) or `bridge guide billing` afterwards.

> **The one rule for app code: every gate is a flag.** A link, a page, a button, an endpoint: if some people get it and others do not, the code asks a flag, and the flag's rule says why (a privilege, a plan feature, a rollout). App code never reads a role, a privilege list, the plan or a plan feature to decide what someone may see or do. Numbers are plan limits, and permission on one specific record stays in app code. `bridge guide fit-together` has the whole rule; the last verification step runs `npx @nebulr-group/bridge-cli@alpha check gates`.

Flags are the standard way to control a route, an API endpoint, a feature or a piece of code. A feature a plan sells is listed on the plan and the flag's rule points at `bridge:billing.entitlement.<feature>`, never at plan names; access by who someone is is a rule on a privilege (preferred) or a role, never a role check in code. `bridge guide decision feature-control` has the questions to ask.

This master prompt orchestrates discovery, confirmation and verification. The install commands and runnable code live in the per-framework guides on each 1.0 plugin's line; this master plans, they wire.

> **This is the 1.0 line.** Install the plugins from the `alpha` tag: `@nebulr-group/bridge-svelte@alpha`, `@nebulr-group/bridge-nestjs@alpha`, `@nebulr-group/bridge-auth-core@alpha`. Each needs one setting, the app's issuer. React, Next.js, Angular and Express have no 1.0 plugin yet: tell the developer, and use auth-core for a JavaScript app.

## How flags work in 1.0 (1-minute version)

**Bridge works out each flag for the caller; your code only reads the result.** The plugin asks Bridge for the results of the person who is signed in (their token says who they are, their workspace and its plan), and Bridge evaluates every rule against facts it holds itself: the person's role and privileges, the workspace's plan and plan features. Nothing the browser sends can make a rule match. A flag Bridge gave no result for is off, or gives the fallback you pass, so gates fail closed.

| Field | Values |
|---|---|
| state | `off` · `on` · `on-with-rule` |
| type | `boolean` (default) · `string` · `number` · `json` |
| on value / off value | typed by the type |
| rule | ordered branches of AND-ed conditions, the first match wins; a branch may give its value to a share of the people it matches (`--rollout`) |
| public | a visitor who is not signed in may read it; every other flag gives a visitor its fallback |

The rule's attributes are Bridge's: `privileges`, `user.role`, `user.id`, `user.email`, `tenant.id`, `tenant.plan`, `bridge:billing.plan`, `bridge:billing.trial`, `bridge:billing.subscription.status`, `bridge:billing.entitlement.<feature>`. `bridge guide decision feature-control` has their exact values.

**Staying current.** In the browser, the plugin's Live connection hears when a flag, the plan or the session changes and reads the results again within a second; without a socket it polls. On a server, each request's results are read from Bridge for that request's caller, so a changed rule applies to the next request. No webhook carries flag changes: read them through the plugin.

## The helpers, per 1.0 plugin

| Where | Gate a page or route | Show or hide markup | A value in code |
|---|---|---|---|
| SvelteKit (`@nebulr-group/bridge-svelte`) | a route rule `{ match: '/reports', featureFlag: 'reports', redirectTo: '/' }` in `bridgeBootstrap()`, or `requireFlag('reports', { redirectTo: '/' })` in one page's `load` | `<FeatureFlag key="reports">…</FeatureFlag>` (`upgrade` for a plan-sold feature) | `useFlag('reports')` (`.value`, `.reason`), `flag('theme', 'light')` (a store) |
| SvelteKit server (`@nebulr-group/bridge-svelte/server`) | `requireFlag(event, 'reports')` in a `+server.ts` | — | `flagsFor(event)` |
| NestJS (`@nebulr-group/bridge-nestjs`) | `@RequireFlag('reports')` on the handler (also `{ any: [...] }`, `{ all: [...] }`), or a route rule with `featureFlag` | — | `@Flag('page-size', 20)` parameter, `@Flags()`, `BridgeService.flags(request)`; `BridgeService.visitorFlags()` on a `@Public()` route |
| Any other JavaScript app (`@nebulr-group/bridge-auth-core`) | your router's guard calling `bridge.flags.enabled('reports')` | `bridge.flags.subscribe(render)` | `bridge.flags.get('theme', 'light')`, `bridge.flags.reason('reports')` |
| Its server (`@nebulr-group/bridge-auth-core/server`) | `(await bridge.flags.forRequest(request)).enabled('reports')` | — | `bridge.flags.forVisitor()` for a caller who is not signed in |

The server is where a gate is enforced: the backend plugin refuses the call (`402 FEATURE_NOT_IN_PLAN` when the plan is why, `403 FEATURE_OFF` otherwise). The browser shows or hides with the same flag and the same rule. Put the flag on both when the action calls the server.

## Step 0 — Sign in to Bridge

Install CLI 1.0 (`npm install -g @nebulr-group/bridge-cli@alpha`, or `npx @nebulr-group/bridge-cli@alpha …`) and run `bridge auth login`; the developer signs in and approves the CLI in the browser. `bridge auth whoami` says which app commands act on.

**Connected through the Bridge MCP server instead?** Skip the login. Every CLI step has a tool:

| Operation | MCP | CLI |
|---|---|---|
| Every flag with its rule | `list_feature_flags` | `bridge flag list` |
| One flag | `get_flag` | `bridge flag get <key>` |
| Create a flag with its rule | `create_feature_flag` | `bridge flag create <key> --when "<attribute> <operator> <value>"` |
| Change a rule or values | `update_feature_flag` | `bridge flag update <key> …`, `bridge flag rule add <key> --when …` |
| On for everyone, or off (the kill switch) | `toggle_feature_flag` | `bridge flag on <key>`, `bridge flag off <key>` |
| What it gives someone | `evaluate_feature_flag` | `bridge flag eval <key> --context '<json>'` |
| This prompt | `get_integration_guide` (topic `flags-master`) | `bridge guide flags` |
| The per-framework guide (Step 4) | `get_integration_guide` (topic `feature-flags`) with the framework | `bridge guide flags --framework <name>` |

---

**At the end of this integration you will output a success message:** MESSAGE 3 (feature flags) of the integration success guide (MCP: `get_integration_guide` topic `integration-success`; CLI: `bridge guide integration-success`).

Track as you work:
- **`[project-name]`**: folder name and/or `package.json` name for each project
- **`[identity-source]`**: who the flags are worked out for: the signed-in person (Bridge sign-in), or visitors (public flags only)
- **`[what-i-actually-did]`**: high-level outcomes
- **`[what-i-changed]`**: every package installed, file modified, env var set, flag created
- **`[footprint]`**: as you make each edit, note its file and its changes, whether the file is new, and whether you modified any of the developer's existing code
- **`[see-every-change]`**: the git state of each project, recorded in Step 1 before your first edit

## Step 1 — Discover projects

Scan the current directory and its immediate subdirectories for `package.json` files. For each one:

1. **Package manager** from the lock file (`bun.lock`/`bun.lockb` → `bun`, `pnpm-lock.yaml` → `pnpm`, `yarn.lock` → `yarn`, else `npm`).
2. **Framework**: `@sveltejs/kit` → SvelteKit; `@nestjs/core` → NestJS (backend); `next`, `react`, `@angular/core`, `express` → no 1.0 plugin yet (say so; offer auth-core); any other JavaScript app → auth-core.
3. **Bridge 1.0 already installed?** A SvelteKit app that calls `bridgeBootstrap()` and renders `<BridgeBootstrap>` already has flags running: there is nothing to install or start. A NestJS app with `BridgeModule.forRoot(...)` has the flag decorators. A `@nebulr-group/bridge-*` below `1.0.0` is the 0.x line, which does not work with the new Bridge: the 1.0 plugin replaces it.
4. **Existing flag system?** `launchdarkly-*`, `@unleash/*`, `posthog-js`, `growthbook-*`: warn the user that Bridge flags run beside it unless they migrate.
5. **Record** for each project: path, type (frontend/backend), framework, package manager, existing flag system.
6. **Note the git state, before you edit anything.** Run `git status` in each project and record one of: clean; uncommitted changes already there (note which files); not a git repo, or no commits yet. Never run `git init`, `git add`, `git stash` or `git commit`, and do not ask the developer about git.

## Step 2 — Present findings and confirm

```
I found:

1. ./my-app-ui — SvelteKit (frontend, bun), Bridge 1.0 sign-in already set up
2. ./my-app-api — NestJS (backend, bun)

Which should I wire flags into? (all / by number)
```

Wait for confirmation. **Who are the flags for?** In 1.0 a flag is worked out for the signed-in person. A page visitors see before signing in can read only the flags the developer marks public (`bridge flag create <key> --public`); ask only when the feature is on a public page.

## Step 3 — Read the app

```bash
bridge app get
bridge flag list
```

Note the issuer (`trust.issuer`; it is every plugin's one setting) and the flags that already exist. If the CLI is not available, ask the developer for the issuer from the app's settings in the Bridge dashboard.

## Step 4 — Fetch the per-framework guide and follow it

```bash
bridge guide flags --framework <svelte|nestjs|javascript>
```

(`bridge guide <framework> feature-flags` is the same guide.) For React, Next.js, Angular or Express the command says there is no 1.0 plugin yet; do not improvise one against their 0.x plugins.

Each per-framework guide covers: the install (nothing more when the plugin is already there for sign-in), where flags start, the helpers above with runnable code, public flags for visitors, values other than on and off, and troubleshooting.

**Create the flag the developer asked for** with its rule, after asking who gets it (`bridge guide decision feature-control`):

```bash
bridge flag create reports --description "The reports page" --when "privileges contains reports:read"
bridge flag create analytics --when "bridge:billing.entitlement.analytics eq true"
bridge flag create new-editor --when "tenant.id in <workspace id>" --rollout 25
```

**Order:** frontend first, then backend.

## Step 5 — Verify

Run the terminal checks. If you have a browser tool, run the browser checks too. If you do not, list them for the developer, numbered, and start the summary with a Heads up line saying which checks were not run.

### Terminal checks

1. **Build**: the project's build command (from `package.json` scripts) passes
2. **The flag**: `bridge flag get <key>` shows the state and rule the developer asked for
3. **Who gets it**: `bridge flag eval <key> --context '{"privileges":["reports:read"]}'` (the facts of someone who should get it) gives the on value, and a context that should not gives the off value. With a rollout, pass `--identity <id>`
4. **The server refuses** (when a backend was wired): call the gated endpoint as someone the flag is off for, with curl and their token: it answers `403 FEATURE_OFF`, or `402 FEATURE_NOT_IN_PLAN` when the plan is why
5. **Gates**: `npx @nebulr-group/bridge-cli@alpha check gates` in the project: every direct role, privilege, plan or plan-feature check it lists becomes a flag. Run it again until it is clean

### Browser checks

1. Signed in as someone the flag is on for, the gated page, link or button shows
2. Signed in as someone it is off for, it is hidden, and a gated route sends them to its `redirectTo`
3. `bridge flag off <key>`: within seconds the open page hides it, with no reload; `bridge flag restore <key>` brings it back
4. A plan-sold feature with `<FeatureFlag upgrade>`: on a plan without it, the upgrade prompt shows in its place and opens the upgrade dialog

A SvelteKit 1.0 app runs with `ssr = false`: its HTML is an empty shell, so curl cannot stand in for these.

If anything fails, diagnose and fix before moving on.

## Step 6 — Tell the developer what they just got

**Do not skip this step.** Fetch the integration success guide (MCP: `get_integration_guide` topic `integration-success`; CLI: `bridge guide integration-success`) and output its MESSAGE 3 (feature flags), personalised for what you actually did:

- Fill every `[placeholder]` by the guide's substitution rules. Count `[footprint]` from your record of each edit, never estimate; pick `[see-every-change]` from the git state you noted in Step 1; give each line of `[what-i-changed]` its size in changes
- Output MESSAGE 3 only: never the `WHICH MESSAGE TO SHOW` part, the MESSAGE headings or the substitution guide
- Group by project if both frontend and backend were integrated
- Do not write any text before the banner: start with the `█` character, unless the next rule applies
- **When a check failed or was not run**, the first line is "Heads up: not verified in a browser" (or what else was not verified), naming the checks, then the banner

After delivering the message, the flags integration is complete.
