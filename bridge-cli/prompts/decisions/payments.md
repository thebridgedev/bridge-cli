# Payments and plans — decision guide

What customers pay, what each plan includes, and what happens when they reach a limit. A **plan** belongs to a workspace, not to a person. It carries the price, the trial, the limits ("3 projects on Free, 50 on Pro") and the list of features it sells ("Analytics on Pro"). The features themselves are switched by flags whose rules read that list; the plan never gets checked by name in code. Payments run through the developer's own Stripe account.

> Read first: `bridge guide fit-together` (MCP: resource `bridge://guides/fit-together`), how roles, plans, limits and flags fit together. Other decision guides: `bridge guide decision <name>` (MCP: resource `bridge://guides/decisions/<name>`). The full model behind limits and upgrade prompts: `bridge guide mechanisms`.

## Start from what is there

| Read | MCP | CLI |
|---|---|---|
| Plans with prices and limits | `list_plans` | `bridge plan list` |
| Every metric the plans already limit, with its kind | `list_plan_quotas` | `bridge plan quota list` |
| Whether Stripe is connected and its webhook works | `get_stripe_status` | `bridge stripe status` |
| Whether new customers must pick a plan first (`paymentsAutoRedirect`) | `get_app` | `bridge app get` |

## Ask the developer

Product questions. Ask, wait, never guess. Then show the answer back as tables (plans, prices, limits) and create nothing until the developer confirms them.

1. **Which plans, and what are they called?** Is there a free one?
2. **What does each paid plan cost, in which currency, and monthly, yearly or both?**
3. **Is there a free trial, and how many days?**
4. **What does each plan limit, and how much?** In their words: "2 tickets on Free, 100 on Pro", "10 seats", "1,000 exports a month".
5. **For each limit: at the limit, block, or keep going and charge per extra unit?** If they charge, how much per unit?
6. **For each limit: does the action call your server?** ("Does clicking Export send a request to your backend?") The answer decides where it is counted; see below.
7. **Which features does each plan sell?** ("Analytics on Pro only.") They go on the plans' features lists.
8. **Do they want a welcome page for new customers** where they choose a plan? Offer it; create it only if they say yes.

**The tools will not guess these.** Called without one, a tool changes nothing and answers `DECISION_NEEDED` with the question to ask; the matching bridge command stops the same way: `create_plan` (`amount`, `interval`, `currency`, `trial`, `trialDays`) · `apply_plan` (`name`, `prices.amount`, `prices.interval`, `prices.currency`, `trial`, `trialDays`) · `set_plan_price` (`currency`). A free plan (price 0) needs no currency or trial answer, and a price added to a plan that charges in one currency reuses it.

**Only changed when you pass them.** No tool sets these on its own; left out, the current value stays: `update_app` (`paymentsAutoRedirect`).

## Decide yourself

- **Plan keys short and lower-case: `free`, `pro`, `team`.** Reason: the key is permanent and is what code, flag rules and tokens use; the name can change any time.
- **Monthly and yearly prices of one tier are one plan with two prices,** never `pro-monthly` and `pro-yearly`. Reason: the subscription page then shows one plan with a monthly/yearly switch.
- **A free plan gets a price of 0.** Reason: a plan with no price cannot be assigned to a workspace.
- **Counter or gauge?** If deleting it frees room, it's a gauge and your app counts it; if it happened, it's a counter and Bridge counts it. Exports, AI completions and emails are counters (reset each billing period). Tickets, projects and stored files are gauges (never reset). Decide from that sentence and say which you chose.
- **Seats are the built-in `users` metric, a gauge.** Reason: Bridge counts workspace members itself.
- **Reuse metric names the app already has** (`list_plan_quotas`) before inventing new ones. Reason: two names for one thing split the count.
- **Connect Stripe with test keys first; live keys only when going live.** Reason: nobody is charged while you build. Use `setup_payments` / `bridge setup payments`: it stores the keys and switches payments on in one step.
- **Connect Stripe before adding paid prices.** Reason: each price is created in Stripe as it is saved.
- **Leave "customers must pick a plan" on** (it is on by default) unless the developer says otherwise. Reason: a new workspace then always has a plan, so every limit and feature check has something to read.
- **One plan, one call:** `apply_plan` / `bridge plan apply` sets name, trial, prices and limits together. Reason: a plan is never left half set up.

## How a hard limit is enforced, end to end

Tell the developer this plainly; it is where integrations go wrong.

1. **The plan holds the number.** A limit is a quota on the plan: metric, limit, `hard`, and `counter` or `gauge`.
2. **It is counted once, where the action happens.** Ask whether the action calls the developer's server, then follow the answer. When it does, the backend counts and enforces it: in NestJS one decorator on the handler that creates the thing, `@RequireQuota('exports')`. Before the handler runs, a workspace at its limit gets `402` with `{ code: 'QUOTA_EXCEEDED', metric, used, limit, fix }` and the handler never runs. After a `2xx` answer, Bridge records one use. Nothing else to wire: no usage call, no counter table. If Bridge cannot answer, the request is refused with `503`, never let through.
3. **Gauges send the app's own count.** `@RequireQuota('tickets', { current })` on create and `@SyncQuota('tickets', { current })` on delete, where `current` returns the app's count from its own database. There is no decrement.
4. **Seats need no count at all.** `@RequireQuota('users')` on the invite handler checks the seat limit.
5. **With a backend, the frontend only shows the count and explains the refusal.** It does not report the same metric. With no code at all, the upgrade dialog opens on a `402`, names the limit, and links to the subscription page. A member who cannot manage billing is told to ask the owner. Disabling a button before the click (`<QuotaGate>`) or showing "8 of 10" (`useQuota`) is optional.
6. **When the action happens in the browser, the browser counts it.** For an app whose action never reaches a server of its own (local-first, data on the device), `bridge.usage.report('exports')` records something that happened and `bridge.usage.set('projects', n)` how many exist, and `<QuotaGate metric="exports">` around the button stops it at the limit. This is a first-class way to run limits; it trusts the browser. Never count one metric in both places.
7. **`metered` never blocks.** Past the included amount it bills per unit through Stripe.
8. **A feature a plan sells goes in the plan's features list, and a flag controls it.** `analytics` on `pro` makes `bridge:billing.entitlement.analytics` true on Pro and false elsewhere; the flag that controls the feature has the rule `bridge:billing.entitlement.analytics eq true`, so the rule never names a plan. Checking the feature directly without a flag (`@RequireEntitlement`, `<Entitled>`) is the exception. No upgrade dialog opens by itself: it opens when someone opens a gated route, clicks something gated, or the backend answers `402`. A hard quota with limit 1 still works the same way; it is the older way. Never put `@RequireEntitlement` and `@RequireQuota` on the same name: at the cap the entitlement answers `403` first and the upgrade dialog never opens.
9. **The plan-choice page** (`/subscription/plan`) appears only when the app has plans and "customers must pick a plan" is on. Turn it off with `update_app` (`paymentsAutoRedirect: false`) / `bridge app update --payments-auto-redirect false`.

The flag and its rule are set up in the **feature-control** guide.

## Do it

| Step | MCP | CLI |
|---|---|---|
| Connect Stripe (keys from the developer) | `setup_payments` | `bridge setup payments --stripe-key sk_test_… --stripe-public-key pk_test_…` |
| Set up or reshape one plan in one call | `apply_plan` | `bridge plan apply --spec @plan.json` |
| Or step by step: create a plan with its first price | `create_plan` | `bridge plan create --key pro --name Pro --amount 29 --interval month --currency usd --no-trial` |
| Add another price | `set_plan_price` | `bridge plan price set pro --amount 290 --interval year` |
| Add a limit | `set_plan_quota` | `bridge plan quota set pro --metric tickets --limit 100 --policy hard --kind gauge` |
| Add an on/off feature the plan sells | `add_plan_feature` | `bridge plan feature add pro analytics --name "Analytics"` |
| Turn off the forced plan choice | `update_app` | `bridge app update --payments-auto-redirect false` |
| Code for the framework | `get_integration_guide` (topic `billing`) | `bridge guide billing --framework svelte`, `bridge guide billing --framework nestjs` |

## Prove it

1. `list_plans` / `bridge plan list` matches the tables the developer confirmed; a plan with monthly and yearly pricing is one plan.
2. `get_stripe_status` / `bridge stripe status`: connected, webhook working.
3. At the limit, send the decorated request with curl: it answers `402 QUOTA_EXCEEDED`. In the app, the upgrade dialog opens and names the limit.
4. A paid plan opens Stripe Checkout and returns to the subscription page with the new plan.

## Where this connects

- **Fit together:** plans, limits, roles and flags side by side (`bridge guide fit-together`).
- **Feature control:** the flag whose rule reads the plan's features list.
- **Teams:** seats, and the plan belonging to the workspace.
- **Roles:** who may change the plan.
- **Going live:** live Stripe keys.
