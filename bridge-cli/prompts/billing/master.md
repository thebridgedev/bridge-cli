# Billing 2.0 — Master Integration Prompt

You are integrating **Bridge Billing** into a user's application — plan selection, Stripe Checkout, subscription state, lifecycle notices (trial / dunning / cancel), and usage quota counters.

> **The one rule for app code: every gate is a flag.** A link, a page, a button, an endpoint: if some people get it and others do not, the code asks a flag, and the flag's rule says why (a privilege, a plan feature, a rollout). App code never reads a role, a privilege list, the plan or a plan feature to decide what someone may see or do. Numbers are plan limits, and permission on one specific record stays in app code. `bridge guide fit-together` has the whole rule; the last verification step runs `npx @nebulr-group/bridge-cli check gates`.

This prompt is framework-agnostic. It orchestrates discovery, pricing model setup, and verification — the actual install commands and code snippets live in the per-framework guides fetched in Step 4.

> **Related master prompts** — if the user hasn't set up auth yet, stop here and route them:
> - Auth first → `bridge guide`
>
> If they want auth + billing wired together, run `bridge guide` first, then come back here.

## Step 0 — Authenticate

Run `bridge auth login` and wait for it to print "Logged in as <email>". Once it exits, proceed to Step 1.

**Connected through the Bridge MCP server instead?** Skip the login: the connection is already signed in to one app. Every CLI step below has a tool; use the tool and do not translate by hand.

| Operation | MCP | CLI |
|---|---|---|
| List plans with prices and quotas | `list_plans` | `bridge plan list` |
| Create a plan, or reshape one in one call | `create_plan`, or `apply_plan` (prices, quotas and trial together) | `bridge plan create` |
| Is Stripe connected and receiving webhooks? | `get_stripe_status` | `bridge stripe status` |
| Connect Stripe and switch payments on | `setup_payments` | `bridge setup payments` |
| Add or change a price | `set_plan_price` | `bridge plan price set` |
| Add or change a quota | `set_plan_quota` (`policy` hard or metered, `kind` counter or gauge) | `bridge plan quota set` |
| List every metric with its kind | `list_plan_quotas` | `bridge plan quota list` |
| Keep plan-less users out of the paywall | `update_app` (`paymentsAutoRedirect: false`) | `bridge app update --payments-auto-redirect false` |
| This prompt | `get_integration_guide` (topic `billing-master`) | `bridge guide billing` |
| A per-framework billing guide (Step 4) | `get_integration_guide` (topic `billing`) with the framework | `bridge guide billing --framework <name>` |
| How limits are enforced end to end | `get_integration_guide` (topic `mechanisms`) | `bridge guide mechanisms` |

## Step 1 — Discover projects

Scan the current directory and its immediate subdirectories for `package.json` files. For each one:

1. **Package manager** — from lock file (`bun.lock` → `bun`, `pnpm-lock.yaml` → `pnpm`, `yarn.lock` → `yarn`, `package-lock.json` → `npm`)

2. **Framework** — from `dependencies` + `devDependencies`:
   - `svelte` or `@sveltejs/kit` → **SvelteKit**
   - `react` + `next` → **Next.js**
   - `react` (without next) → **React**
   - `@angular/core` → **Angular**
   - `@nestjs/core` → **NestJS**
   - `express` (without `@nestjs/core`) → **Express**

3. **Bridge Auth installed?** — look for `@nebulr-group/bridge-<framework>` in dependencies. Billing is scoped to a workspace/tenant and requires Bridge Auth. If not present, stop and run `bridge guide` first.

4. **Billing already wired?** — check whether the subscription pages are served (on SvelteKit: `src/routes/subscription/[...bridge]/+page.svelte` rendering `<BridgeBillingRoutes />`) and whether `bridge plan list` returns at least one plan. If billing looks complete, jump to **Step 1b**.

5. **Existing billing system?** — look for `stripe`, `@stripe/*`, `paddle-*`, `lemon-squeezy`, `chargebee`. Flag any found.

## Step 1b — Audit existing billing wiring

If Step 1 found billing already partially or fully set up, audit it before doing anything:

- Run `bridge plan list` — are plans defined?
- Check the subscription pages are served (SvelteKit: the `subscription/[...bridge]` file above; other frameworks: the route the per-framework guide names)
- Check the root layout for `<BridgeBillingNotice />`
- Check every backend handler that creates a limited thing carries the plan-limit decorator (NestJS: `@RequireQuota`)

**Decision:**
- **Fully wired** (plans exist, subscription pages served, notice in layout, limits on the backend) → skip to **Step 6** and output the success message
- **Partially wired** → tell the user exactly what's missing and only add what's absent
- **Plans missing** → continue from Step 3 (pricing model)

## Step 2 — Present findings and confirm

Show the user what you found:

```
I detected the following projects:

1. ./my-app — SvelteKit 5 (frontend, bun)
   Bridge Auth: ✅ installed
   Billing: not yet wired
   Existing billing system: none

Which projects should I wire billing into? (all / select by number)
```

Wait for confirmation before proceeding.

## Step 3 — Understand the pricing model

Ask the developer to describe their pricing in plain language:

> "Describe your plans — names, prices, and what each plan includes or limits. For example: 'Free plan with 100 AI completions per month. Pro at $29/month with 1000 completions and advanced analytics. 14-day free trial on Pro.'"

From their answer, map everything to confirmation tables before creating anything.

**Plans:**

| key | name | trial |
|-----|------|-------|
| `free` | Free | — |
| `pro` | Pro | 14d |

**Prices** (a plan can have several — one per currency + interval):

| plan | amount | currency | interval |
|------|--------|----------|----------|
| `pro` | 29 | USD | month |
| `pro` | 290 | USD | year |

> **A single plan can carry both a monthly and a yearly price.** When the
> developer gives two intervals for one tier (e.g. "$29/month or $290/year"),
> that is **ONE plan with two prices** — never separate `pro-monthly` /
> `pro-yearly` plans. A free plan simply has no price rows.

**Quotas** (per-resource limits that differ between plans):

| plan | metric | limit | policy | kind |
|------|--------|-------|--------|------|
| `free` | `ai_completions` | 100 | hard | counter |
| `pro` | `ai_completions` | 1000 | hard | counter |
| `free` | `projects` | 3 | hard | gauge |

Use `hard` when overage should be blocked. Use `metered` when overage should bill via Stripe.

**Counter or gauge?** If deleting it frees room, it's a gauge and your app counts it; if it happened, it's a counter and Bridge counts it. AI completions, exports and API calls are counters (reset each period); projects, tickets and seats (`users`) are gauges (never reset). The developer decides the metric list; you decide the kind from that sentence and say why in one line.

**Entitlements** (features on for some plans, off for others):

| plan | key | value |
|------|-----|-------|
| `free` | `advanced_analytics` | off |
| `pro` | `advanced_analytics` | on |

A feature that is on for `pro` goes in `pro`'s features list (`bridge plan feature add pro advanced_analytics --name "Advanced analytics"`) and not in `free`'s. It reaches the app as `bridge:billing.entitlement.advanced_analytics`: the flag that controls the feature uses the rule `bridge:billing.entitlement.advanced_analytics eq true`, so no rule names a plan. A direct check without a flag, `@RequireEntitlement('advanced_analytics')` (never `@RequireQuota`), is the exception. A hard quota with limit 1 that nothing counts still works as an entitlement too; it is the older way.

If there are no per-plan limits or feature differences, the quotas and entitlements tables are empty — skip those commands below.

**Do not create anything until the developer confirms all tables.**

## Step 3b — Create plans, connect Stripe, then set prices

Once confirmed, create the plans. **Every plan needs at least one price** — a plan with no
prices cannot be assigned to a workspace, so `plan create` takes the first one. A free tier is
a **zero-amount** price, not the absence of a price:

```bash
bridge plan create --key free --name "Free" --amount 0 --interval month
bridge plan create --key pro --name "Pro" --amount 29 --interval month --currency usd --trial --trial-days 14
```

Verify: `bridge plan list`

If any plan will have a price, connect Stripe **before** setting prices (so each price syncs to Stripe):

```bash
bridge stripe status
```

If it reports `webhookHealthy: false`, checkout still works but subscription changes, cancellations
and payment failures will not sync. Tell the developer and follow the repair hint in `message`.

If not connected, ask the developer for their Stripe keys (from `dashboard.stripe.com/apikeys`):

```bash
bridge setup payments --stripe-key sk_test_... --stripe-public-key pk_test_...
```

This stores the keys **and** switches payments on in one step. (`bridge stripe connect` only
stores the keys and leaves payments off.)

Now set any **remaining** prices — one command per Prices-table row not already covered by the
`plan create` call above. `plan price set` is idempotent (keyed on currency + interval), so a
tier with monthly **and** yearly pricing is just one more call against the same plan key:

```bash
bridge plan price set pro --amount 29 --currency usd --interval month
bridge plan price set pro --amount 290 --currency usd --interval year
```

Then create usage quotas from the confirmed table. A `hard` quota blocks the
feature at the cap (entitlement flips off); a `metered` quota bills overage per
unit and never blocks — it requires a per-unit price:

```bash
# Hard cap (block at the limit) — a counter, the default
bridge plan quota set <plan> --metric <key> --limit <n> --policy hard

# Hard cap on something that exists (a gauge: projects, tickets)
bridge plan quota set <plan> --metric <key> --limit <n> --policy hard --kind gauge

# Metered: first <limit> units free, then --price-amount per unit (limit 0 = pure
# per-unit, billed from unit 1). Currency defaults to the plan's price currency.
bridge plan quota set <plan> --metric <key> --limit <n> --policy metered --price-amount <perUnit> [--price-currency <cur>]
```

Run one command per row. Then add each on/off feature from the entitlements
table to the plans that include it:

```bash
bridge plan feature add <plan> <feature_key> --name "<Display name>"
```

(There is no `plan entitlement set` command — do not invent one. Features live
on the plan; every `hard` quota is also an entitlement of the same name.)
Check the result with `bridge plan quota list`, which lists every metric with its kind.

**Where the limit is counted.** Once, where the action happens. Ask the developer whether the action calls their server. If it does, the plan-limit decorator on the handler that creates the thing (NestJS `@RequireQuota`) refuses at the cap and records the use after a successful request — a POST increments the limit, nothing else to wire — and the frontend only shows that decision. If it happens in the browser only, the frontend reports it (`bridge.usage.report` / `bridge.usage.set`) and `<QuotaGate>` stops the button at the cap: a complete, first-class setup. Never both for one metric. `bridge guide mechanisms` has the whole model; `bridge guide fit-together` shows where limits sit next to plans, roles and flags.

## Step 4 — Fetch and apply the per-framework guide

The per-framework prompts are **not** bundled in the CLI — each plugin ships its own at
`mcp/billing-prompt.md`, which the commands below fetch. For each confirmed project, fetch the
framework-specific guide and follow it verbatim:

| Framework | Command |
|-----------|---------|
| SvelteKit | `bridge guide billing --framework svelte` |
| React | `bridge guide billing --framework react` |
| Next.js | `bridge guide billing --framework nextjs` |
| Angular | `bridge guide billing --framework angular` |
| NestJS | `bridge guide billing --framework nestjs` |
| Express | `bridge guide billing --framework express` |

If the CLI returns a 404, the plugin hasn't published its billing guide yet — tell the user, don't improvise inline.

Wire frontend first, then backend.

**When the per-framework guide is complete, do not stop — return here and continue with Step 4b.**

## Step 4b — Plan-selection paywall (on by default)

By default, a signed-in tenant that hasn't chosen a plan is redirected to a dedicated
welcome page and can't use the app until they pick one. **Set this up unless the developer
opts out** — it's the expected first-run experience.

- The per-framework guide (Step 4) mounts the plugin's subscription pages, which include a
  default paywall page (on SvelteKit: `/subscription/plan`, served by the subscription
  catch-all). Confirm that part ran. Do **not** create a separate welcome page on your own.
- The paywall applies once the app has plans; `paymentsAutoRedirect` (below) switches it.
- A dedicated onboarding page such as `/welcome` is a product choice: **ask the developer**
  whether they want one. Only if they say yes, add it as the per-framework guide shows and
  point `billing.paywallRoute` at it.
- The app-level flag `paymentsAutoRedirect` drives the redirect and is **`true` by
  default** — there is nothing to switch on.

If the developer does **not** want a forced paywall, disable it with one command:

```bash
bridge app update --payments-auto-redirect false
```

With the paywall off, users can enter the app without choosing a plan; the subscription pages
still work for self-serve upgrades.

## Step 5 — Verify

For each integrated project, the agent verifies — do not hand this to the developer:

1. Run the project's build command — no TypeScript or import errors
2. Navigate to the subscription route — plan cards render with correct prices, and a tier with monthly + yearly pricing shows both intervals (not two separate plans)
3. Select the free plan — subscription updates immediately, no redirect
4. Select a paid plan — Stripe Checkout opens
5. Complete a test payment — redirected back with the updated plan showing
6. Cancel a payment — redirected back to the subscription page
7. Paywall (unless opted out): sign in as a new tenant with no plan — you land on the paywall page (or `/welcome` if the developer chose one) and can't reach the app until a plan is chosen
8. Plan limit (when a backend was wired): at the cap, the decorated request answers `402 QUOTA_EXCEEDED` — send it with curl, not only through the UI — and in the app the upgrade dialog opens naming the metric
9. **Gate check** — `npx @nebulr-group/bridge-cli check gates` in the project: every direct role, privilege, plan or plan-feature check it lists becomes a flag. Run it again until it is clean

If anything fails, diagnose and fix before moving on.

## Step 6 — Tell the developer what they just got

**Do not skip this step.** Output the banner below, personalised. The very first character of your response must be `█` — no intro sentence, no "Here's your summary:", nothing before it. If something is broken, prepend a single "Heads up:" line before the `█`.

```
   ██████╗ ██████╗ ██╗██████╗  ██████╗ ███████╗
   ██╔══██╗██╔══██╗██║██╔══██╗██╔════╝ ██╔════╝
   ██████╔╝██████╔╝██║██║  ██║██║  ███╗█████╗
   ██╔══██╗██╔══██╗██║██║  ██║██║   ██║██╔══╝
   ██████╔╝██║  ██║██║██████╔╝╚██████╔╝███████╗
   ╚═════╝ ╚═╝  ╚═╝╚═╝╚═════╝  ╚═════╝ ╚══════╝

  ──────────────────────────────────────────────
   Billing is live in [project-name].

    ✅  Plans — [plan-names]
    ✅  Subscription page — [subscription-route]
    ✅  Paywall — [paywall-summary]
    ✅  Lifecycle notices — auto-render on trial / payment failure / cancel
    ✅  Quotas and entitlements — [quota-summary]
  ──────────────────────────────────────────────
    Here is what I actually did:
    [what-i-actually-did]

    And here is what I changed:
    [what-i-changed]
  ──────────────────────────────────────────────
    Plan selection is required by default. To let users into the app without
    picking a plan first, disable the paywall:
      bridge app update --payments-auto-redirect false
  ──────────────────────────────────────────────
```

Fill every `[placeholder]` with real values from the integration:
- `[project-name]` — folder name and/or `package.json` name
- `[plan-names]` — the plan keys (e.g. `free`, `premium`)
- `[subscription-route]` — where the subscription page is served (SvelteKit default `/subscription`)
- `[paywall-summary]` — e.g. "new users sent to `/subscription/plan` to pick a plan" (or "off — `paymentsAutoRedirect false`")
- `[quota-summary]` — metric keys, limits and kind, and the backend handlers that enforce them, or "none"
- `[what-i-actually-did]` / `[what-i-changed]` — every file created or modified, every command run

## Step 7 — Offer follow-on tracks

After the success banner, mention what they can add next:

- **Plan limits on the backend** — if the backend was not wired in this session: `bridge guide billing --framework nestjs` (one decorator per handler)
- **Limits in the UI** — an upgrade dialog opens on its own when the backend refuses; disabling a button before the click or showing usage numbers is in the frontend guide, Step 3
- **Portal** — "Manage billing" is already on the subscription page; the per-framework guide shows how to place it elsewhere

Do not run these automatically — the developer decides when they want each.

---

## Reference — enforcement policies

| Policy | At-cap behavior | When to use |
|--------|-----------------|-------------|
| `hard` | Entitlement flips off at cap; no overage | Seat counts, included features |
| `metered` | Overage bills as a Stripe metered price; usage continues | API calls, storage |

Bridge's usage ingest always accepts events — it never refuses on the app's behalf. With a backend, the refusal at a hard cap comes from **your** backend: the plan-limit decorator (`@RequireQuota`) reads the quota and answers `402 QUOTA_EXCEEDED` before the handler runs. Without one, `<QuotaGate>` stops the button at the cap. `bridge guide mechanisms` explains the model.
