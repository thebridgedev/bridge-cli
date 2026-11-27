# Bridge Billing — Master Integration Prompt (1.0)

You are integrating **Bridge billing** into a user's application, on the new Bridge and its 1.0 plugins: plans with prices and trials, Stripe Checkout, the subscription pages and the paywall, notices for trials and failed payments, and plan limits enforced on the server.

> **The one rule for app code: every gate is a flag.** A link, a page, a button, an endpoint: if some people get it and others do not, the code asks a flag, and the flag's rule says why (a privilege, a plan feature, a rollout). App code never reads a role, a privilege list, the plan or a plan feature to decide what someone may see or do. Numbers are plan limits, and permission on one specific record stays in app code. `bridge guide fit-together` has the whole rule; the last verification step runs `npx @nebulr-group/bridge-cli@alpha check gates`.

This prompt is framework-agnostic. It orchestrates discovery, the pricing model and verification; the install commands and code live in the per-framework guides fetched in Step 4.

> **This is the 1.0 line.** The subscription pages come from `@nebulr-group/bridge-svelte@alpha`; limits are enforced on the server with `@nebulr-group/bridge-nestjs@alpha` or `@nebulr-group/bridge-auth-core@alpha` (`/server`). Each needs one setting, the app's issuer, and a server that counts usage also needs an app key (`BRIDGE_APP_KEY`). React, Next.js, Angular and Express have no 1.0 plugin yet: tell the developer.

> **Related master prompts:** billing belongs to a workspace, so it needs sign-in. If the app has no Bridge sign-in yet, run `bridge guide` first, then come back here.

## Step 0 — Sign in to Bridge

Install CLI 1.0 (`npm install -g @nebulr-group/bridge-cli@alpha`, or `npx @nebulr-group/bridge-cli@alpha …`) and run `bridge auth login`; the developer signs in and approves the CLI in the browser. `bridge auth whoami` says which app commands act on.

**Connected through the Bridge MCP server instead?** Skip the login. Every CLI step below has a tool; use the tool and do not translate by hand.

| Operation | MCP | CLI |
|---|---|---|
| Plans with prices, trials, features and limits | `list_plans` | `bridge plan list` |
| Create a plan, or reshape one in one call | `create_plan`, or `apply_plan` | `bridge plan create <key> …`, or `bridge plan apply <file>` |
| Add or change one price | `set_plan_price` | `bridge plan price set <plan> "<amount> <CURRENCY>/<interval>"` |
| Add or change a limit | `set_plan_quota` | `bridge plan limit set <plan> <metric>=<n>` |
| A per-unit price above an included amount | `set_plan_quota` (`policy: metered`) | `bridge plan usage-price set <plan> "<metric> <amount> <CURRENCY>/<interval> included <n>"` |
| What the app counts, with its kind | `list_plan_quotas` | `bridge metric list`, `bridge metric set <key> --kind counter\|gauge` |
| A feature a plan sells | `add_plan_feature` | `bridge plan feature add <plan> <key>=<name>` |
| Is Stripe connected? | `get_stripe_status` | `bridge stripe status` |
| Connect Stripe (test mode) | `setup_payments` | `bridge stripe connect` |
| Where payers return after checkout | `update_app` (`checkoutReturnUrl`) | `bridge billing settings --return-url <url>` |
| This prompt | `get_integration_guide` (topic `billing-master`) | `bridge guide billing` |
| The per-framework billing guide (Step 4) | `get_integration_guide` (topic `billing`) with the framework | `bridge guide billing --framework <name>` |
| How limits are enforced end to end | `get_integration_guide` (topic `mechanisms`) | `bridge guide mechanisms` |

## Step 1 — Discover projects

Scan the current directory and its immediate subdirectories for `package.json` files. For each one:

1. **Package manager** from the lock file (`bun.lock` → `bun`, `pnpm-lock.yaml` → `pnpm`, `yarn.lock` → `yarn`, else `npm`).
2. **Framework**: `@sveltejs/kit` → SvelteKit; `@nestjs/core` → NestJS; `next`, `react`, `@angular/core`, `express` → no 1.0 plugin yet (say so); any other JavaScript server → auth-core (`bridge guide javascript server`).
3. **Bridge sign-in installed?** `@nebulr-group/bridge-svelte` at `1.0.0-alpha.*` or later, with `bridgeBootstrap()` in `src/routes/+layout.ts`. If not, stop and run `bridge guide` first. A version below `1.0.0` is the 0.x line, which does not work with the new Bridge.
4. **Billing already wired?** The subscription pages are served (`src/routes/subscription/[...bridge]/+page.svelte` rendering `<BridgeBillingRoutes />`) and `bridge plan list` returns at least one plan. If billing looks complete, go to **Step 1b**.
5. **Existing billing system?** `stripe`, `@stripe/*`, `paddle-*`, `lemon-squeezy`, `chargebee`: name any found.
6. **Note the git state, before you edit anything.** Run `git status` in each project and record one of: clean; uncommitted changes already there (note which files); not a git repo, or no commits yet. Never run `git init`, `git add`, `git stash` or `git commit`, and do not ask the developer about git. From your first edit on, keep a record of each change (its file, what it is, whether the file is new): the success message counts its footprint from that record.

## Step 1b — Audit existing billing wiring

- `bridge plan list`: are plans defined, with prices?
- The subscription pages are served (the file above)
- `<BillingNotice />` in the root layout, so trial ends and failed payments are shown
- Every server handler that creates a limited thing holds the limit (NestJS: `@RequireQuota`; SvelteKit or another server: `usage.hold` on the auth-core server client)

**Decision:** fully wired → skip to **Step 5** and verify; partly wired → tell the user exactly what's missing and add only that; plans missing → continue from Step 3.

## Step 2 — Present findings and confirm

```
I found:

1. ./my-app — SvelteKit (frontend, bun), Bridge sign-in set up, no billing yet
2. ./my-api — NestJS (backend, bun)

Which should I wire billing into? (all / by number)
```

Wait for confirmation before proceeding.

## Step 3 — Understand the pricing model

Ask the developer to describe their pricing in plain language:

> "Describe your plans: names, prices, and what each plan includes or limits. For example: 'Free with 3 projects. Pro at 29 USD a month or 290 a year, with 50 projects and analytics, and a 14-day trial.'"

From their answer, fill these tables and show them back before creating anything.

**Plans:**

| key | name | trial |
|-----|------|-------|
| `free` | Free | — |
| `pro` | Pro | 14 days |

**Prices** (one per currency and interval; a plan can have several):

| plan | price |
|------|-------|
| `free` | `0 USD/month` |
| `pro` | `29 USD/month` |
| `pro` | `290 USD/year` |

> **A plan can carry a monthly and a yearly price.** "29 a month or 290 a year" is **one plan with two prices**, never `pro-monthly` and `pro-yearly`. A free plan gets a price of 0.

**Limits** (numbers that differ between plans):

| plan | metric | limit | kind | past the limit |
|------|--------|-------|------|----------------|
| `free` | `projects` | 3 | gauge | refused |
| `pro` | `projects` | 50 | gauge | refused |
| `pro` | `exports` | 100 included | counter | 0.05 USD each above it |

**Counter or gauge?** If deleting it frees room, it's a gauge (projects, tickets, files): the server sets how many exist. If it happened, it's a counter (exports, API calls, AI completions): the server counts each one, and it starts again each period. `seats` and `api.calls` are built in: Bridge counts a workspace's members itself, and refuses an invite past the seat limit on its own. The developer decides the metric list; you decide the kind from that sentence and say why in one line.

**Past the limit:** refused (a limit, `--limit <metric>=<n>`) or charged per extra unit (a usage price with an included amount, `--usage-price`, which never refuses). One metric is one or the other.

**Plan features** (on for some plans, off for others):

| plan | feature |
|------|---------|
| `pro` | `analytics` (Analytics) |

A feature on `pro` goes in `pro`'s features list and not in `free`'s. It reaches flag rules as `bridge:billing.entitlement.analytics`: the flag that controls the feature uses the rule `bridge:billing.entitlement.analytics eq true`, so no rule names a plan.

If there are no limits or features, those tables are empty: skip their commands below.

**Do not create anything until the developer confirms all tables.**

## Step 3b — Connect Stripe, then create the plans

Paid prices are created in Stripe as they are saved, so connect Stripe first:

```bash
bridge stripe status
bridge stripe connect --publishable-key pk_test_…
```

`bridge stripe connect` asks for the test secret key (`sk_test_…`) without echo (or reads it with `--secret-key-stdin`). The keys are the developer's, from `dashboard.stripe.com/apikeys`: ask for them, never invent or reuse one. It needs a recent sign-in; the CLI says so when the session is older.

Then the metrics, and each plan in one command, from the confirmed tables:

```bash
bridge metric set projects --kind gauge --name "Projects"
bridge metric set exports --kind counter --name "Exports"

bridge plan create free --name "Free" --price "0 USD/month" --limit projects=3
bridge plan create pro --name "Pro" \
  --price "29 USD/month" --price "290 USD/year" \
  --trial-days 14 \
  --feature analytics=Analytics \
  --limit projects=50 \
  --usage-price "exports 0.05 USD/month included 100"
bridge plan list
```

A paid plan needs `--trial-days <n>` (add `--card-required` to ask for a card up front) or `--no-trial`: without one the command stops and asks (`DECISION_NEEDED`), and nothing is created. To change one entry later: `bridge plan price set`, `bridge plan limit set`, `bridge plan feature add`, `bridge plan usage-price set`; `bridge plan update <key>` with a list replaces that whole list.

**Where the limit is enforced: on the server, where the action happens.** Bridge counts the usage your server reports and knows each plan's limit; the server holds a unit before it does the thing, and refuses at the limit with `402`. NestJS: `@RequireQuota('exports')` on the handler (a counter), `@RequireQuota('projects', { current })` with `@SyncQuota('projects', { current })` on delete (a gauge). SvelteKit `+server.ts` or another JavaScript server: the auth-core server client's `usage.hold(actor, metric, …)`. The browser shows the numbers and the upgrade dialog from the same limit, and never counts. `bridge guide mechanisms` has the whole model.

## Step 4 — Fetch and apply the per-framework guide

| Framework | Command |
|-----------|---------|
| SvelteKit (the pages, the paywall, the notices) | `bridge guide billing --framework svelte` |
| NestJS (limits and plan features on the server) | `bridge guide billing --framework nestjs` |
| Any other JavaScript app | `bridge guide javascript`, `bridge guide javascript server` |

For React, Next.js, Angular or Express the command says there is no 1.0 plugin yet; tell the user, don't improvise.

Wire the frontend first, then the backend. **When the per-framework guide is done, return here and continue with Step 4b.**

## Step 4b — The paywall (on by default)

A signed-in workspace whose plan does not allow using the app is sent to the plan page (on SvelteKit, `/subscription/plan`, served by the subscription catch-all) and can't use the app until it picks a plan. It is the flag `bridge-app-active`, whose rule Bridge keeps for every app: while it is off for the workspace, the paywall shows. **Leave it on unless the developer opts out**; it is the expected first-run experience.

- Confirm the per-framework guide mounted the subscription pages. Do **not** create a separate welcome page on your own.
- A dedicated onboarding page such as `/welcome` is a product choice: **ask the developer**. Only if they say yes, add it as the per-framework guide shows and point `billing: { paywall: '/welcome' }` at it.
- If the developer does **not** want a forced paywall: `billing: { paywall: false }` in `bridgeBootstrap()`. The subscription pages still work for self-serve upgrades.

## Step 5 — Verify

Run the terminal checks. If you have a browser tool, run the browser checks too. If you do not, list them for the developer, numbered, and start the summary with a Heads up line saying which checks were not run.

### Terminal checks

1. **Build**: the project's build command passes, with no TypeScript or import errors
2. **Plans**: `bridge plan list` shows exactly the confirmed tables: names, prices (a plan with monthly and yearly pricing is one plan with two prices), trials, features and limits
3. **Stripe**: `bridge stripe status` says Stripe is connected
4. **The server refuses at the limit** (when a backend was wired): call the limited handler with curl and a signed-in person's token until the limit; the next call answers `402 QUOTA_EXCEEDED` (`metric`, `used`, `limit`)
5. **Plan-sold features**: `bridge flag get <key>` for each flag ruled on a plan feature shows `bridge:billing.entitlement.<feature> eq true`
6. **Gates**: `npx @nebulr-group/bridge-cli@alpha check gates` in the project: every direct role, privilege, plan or plan-feature check it lists becomes a flag. Run it again until it is clean

### Browser checks

1. The subscription page (`/subscription`) shows the plans with their prices; a plan with a monthly and a yearly price is one card with both intervals
2. Choosing the free plan changes the plan at once, with no checkout
3. Choosing a paid plan opens Stripe Checkout
4. A test payment (card `4242 4242 4242 4242`) returns to the subscription page on the new plan; a cancelled checkout returns too
5. The paywall (unless opted out): a new workspace with no plan lands on `/subscription/plan` (or the developer's `/welcome`) and can't reach the app until it picks one
6. At a limit (when a backend was wired): the action in the app opens the upgrade dialog naming the metric

A SvelteKit 1.0 app runs with `ssr = false`: its HTML is an empty shell, so curl cannot stand in for these. Stripe's checkout page may refuse an automated browser; that one check then goes to the developer.

If a terminal check fails, diagnose and fix before moving on.

## Step 6 — Tell the developer what they just got

**Do not skip this step.** Fetch the integration success guide (MCP: `get_integration_guide` topic `integration-success`; CLI: `bridge guide integration-success`) and output its MESSAGE 2 (plans, billing or plan limits), personalised. The very first character of your response must be `█`, unless the next rule applies.

- **When a check failed or was not run** (any browser check you could not run yourself), the first line is "Heads up: not verified in a browser", naming those checks, then the banner. Never print the banner alone over checks nobody ran.
- Fill every `[placeholder]` by the guide's substitution rules: the plan keys, the subscription route, the paywall, the plan limits and where each is enforced. Count `[footprint]` from your record of each edit, never estimate; pick `[see-every-change]` from the git state you noted in Step 1; give each line of `[what-i-changed]` its size in changes. Plans, prices and Stripe settings made through the CLI or MCP are app settings, not code
- Output MESSAGE 2 only: never the `WHICH MESSAGE TO SHOW` part, the MESSAGE headings or the substitution guide

## Step 7 — Offer follow-on tracks

- **Limits on the server**: if the backend was not wired in this session, `bridge guide billing --framework nestjs` (one decorator per handler)
- **Limits in the UI**: the upgrade dialog already opens on the server's `402`; `<QuotaGate>` around a button and `useQuota` for "8 of 10" are in the SvelteKit billing guide
- **Portal**: "Manage billing" is already on the subscription page; the SvelteKit guide shows `<BillingPortalButton>` for elsewhere

Do not run these automatically: the developer decides when they want each.

---

## Reference — past the limit

| Setting | At the limit | When to use |
|--------|-----------------|-------------|
| a limit (`--limit <metric>=<n>`) | the server holds a unit before the action and refuses with `402 QUOTA_EXCEEDED` | projects, seats, anything included up to a number |
| a usage price (`--usage-price "<metric> <amount> <CURRENCY>/<interval> included <n>"`) | never refuses; each unit above the included amount is billed through Stripe | API calls, exports, storage |

The refusal comes from **your** server: the backend plugin reads the limit and answers `402` before the handler runs, and if Bridge cannot answer it refuses with `503`, never lets the call through. The browser shows the limit and the upgrade dialog. Seats are the one limit Bridge refuses on its own, at the invite.
