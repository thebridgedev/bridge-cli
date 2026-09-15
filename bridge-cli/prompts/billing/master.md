# Billing 2.0 — Master Integration Prompt

You are integrating **Bridge Billing** into a user's application — plan selection, Stripe Checkout, subscription state, lifecycle notices (trial / dunning / cancel), and usage quota counters.

This prompt is framework-agnostic. It orchestrates discovery, pricing model setup, and verification — the actual install commands and code snippets live in the per-framework guides fetched in Step 4.

> **Related master prompts** — if the user hasn't set up auth yet, stop here and route them:
> - Auth first → `bridge guide`
>
> If they want auth + billing wired together, run `bridge guide` first, then come back here.

## Step 0 — Authenticate

Run `bridge auth login` and wait for it to print "Logged in as <email>". Once it exits, proceed to Step 1.

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

4. **Billing already wired?** — check whether a subscription/plan route exists (typically `/subscription` or `/plan`) and whether `bridge plan list` returns at least one plan. If billing looks complete, jump to **Step 1b**.

5. **Existing billing system?** — look for `stripe`, `@stripe/*`, `paddle-*`, `lemon-squeezy`, `chargebee`. Flag any found.

## Step 1b — Audit existing billing wiring

If Step 1 found billing already partially or fully set up, audit it before doing anything:

- Run `bridge plan list` — are plans defined?
- Check for a subscription route with `<PlanSelector>` mounted
- Check the root layout for `<BridgeBillingNotice />`

**Decision:**
- **Fully wired** (plans exist, selector mounted, notice in layout) → skip to **Step 6** and output the success message
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

| plan | metric | limit | policy |
|------|--------|-------|--------|
| `free` | `ai_completions` | 100 | hard |
| `pro` | `ai_completions` | 1000 | hard |

Use `hard` when overage should be blocked. Use `metered` when overage should bill via Stripe.

**Entitlements** (features on for some plans, off for others):

| plan | key | value |
|------|-----|-------|
| `free` | `advanced_analytics` | off |
| `pro` | `advanced_analytics` | on |

If there are no per-plan limits or feature differences, the quotas and entitlements tables are empty — skip those commands below.

**Do not create anything until the developer confirms all tables.**

## Step 3b — Create plans, connect Stripe, then set prices

Once confirmed, create the plans (no prices here — `plan create` never takes a price):

```bash
bridge plan create --key free --name "Free"
bridge plan create --key pro --name "Pro" --trial --trial-days 14
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
bridge stripe connect --secret-key sk_test_... --publishable-key pk_test_...
```

Now set prices — **one command per Prices-table row**. `plan price set` is idempotent
(keyed on currency + interval), so a tier with monthly **and** yearly pricing is just two
calls against the same plan key:

```bash
bridge plan price set pro --amount 29 --currency usd --interval month
bridge plan price set pro --amount 290 --currency usd --interval year
```

Then create usage quotas from the confirmed table. A `hard` quota blocks the
feature at the cap (entitlement flips off); a `metered` quota bills overage per
unit and never blocks — it requires a per-unit price:

```bash
# Hard cap (block at the limit)
bridge plan quota set <plan> --metric <key> --limit <n> --policy hard

# Metered: first <limit> units free, then --price-amount per unit (limit 0 = pure
# per-unit, billed from unit 1). Currency defaults to the plan's price currency.
bridge plan quota set <plan> --metric <key> --limit <n> --policy metered --price-amount <perUnit> [--price-currency <cur>]
```

Run one command per row. (There is no `plan entitlement set` command —
entitlements are derived from `hard` quotas automatically; do not invent one.)

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

- The per-framework guide (Step 4) creates a welcome route that renders `<PlanSelector>`
  and registers it as `billing.paywallRoute`. Confirm that part ran.
- The app-level flag `paymentsAutoRedirect` drives the redirect and is **`true` by
  default** — there is nothing to switch on.

If the developer does **not** want a forced paywall, disable it with one command:

```bash
bridge app update --payments-auto-redirect false
```

With the paywall off, users can enter the app without choosing a plan; any `<PlanSelector>`
or `/subscription` route you mounted still works for self-serve upgrades.

## Step 5 — Verify

For each integrated project, the agent verifies — do not hand this to the developer:

1. Run the project's build command — no TypeScript or import errors
2. Navigate to the subscription route — plan cards render with correct prices, and a tier with monthly + yearly pricing shows both intervals (not two separate plans)
3. Select the free plan — subscription updates immediately, no redirect
4. Select a paid plan — Stripe Checkout opens
5. Complete a test payment — redirected back with the updated plan showing
6. Cancel a payment — redirected back to the subscription page
7. Paywall (unless opted out): sign in as a new tenant with no plan — you land on the welcome route and can't reach the app until a plan is chosen

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
    ✅  Plan selector — [plan-selector-route]
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
- `[plan-selector-route]` — route where `<PlanSelector>` is mounted
- `[paywall-summary]` — e.g. "new users sent to `/welcome` to pick a plan" (or "off — `paymentsAutoRedirect false`")
- `[quota-summary]` — metric keys and limits, or "none"
- `[what-i-actually-did]` / `[what-i-changed]` — every file created or modified, every command run

## Step 7 — Offer follow-on tracks

After the success banner, mention what they can add next:

- **Webhook receiver** — receive subscription and quota events on your backend: `bridge guide billing --framework <name>`
- **Usage ingestion** — report usage from your backend: same guide, backend section
- **Portal** — let users manage their payment method or cancel: covered in the per-framework guide

Do not run these automatically — the developer decides when they want each.

---

## Reference — enforcement policies

| Policy | At-cap behavior | When to use |
|--------|-----------------|-------------|
| `hard` | Entitlement flips off at cap; no overage | Seat counts, included features |
| `metered` | Overage bills as a Stripe metered price; usage continues | API calls, storage |

The server always accepts `/usage/ingest` — hard policy means no metered price + entitlement gate, not server-side rejection.
