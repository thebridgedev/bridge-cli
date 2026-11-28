# Payments and plans — decision guide

What customers pay, what each plan includes, and what happens when they reach a limit. A **plan** belongs to a workspace, not to a person. It carries the prices, the trial, the limits ("3 projects on Free, 50 on Pro") and the list of features it sells ("Analytics on Pro"). The features themselves are switched by flags whose rules read that list; the plan never gets checked by name in code. Payments run through the developer's own Stripe account.

> Read first: `bridge guide fit-together` (MCP: resource `bridge://guides/fit-together`), how roles, plans, limits and flags fit together. Other decision guides: `bridge guide decision <name>` (MCP: resource `bridge://guides/decisions/<name>`). The full model behind limits and upgrade prompts: `bridge guide mechanisms`.

## Start from what is there

| Read | MCP | CLI |
|---|---|---|
| Plans with prices, trials, features and limits | `list_plans` | `bridge plan list` |
| Every metric the app counts, with its kind | `list_plan_quotas` | `bridge metric list` |
| Whether Stripe is connected | `get_stripe_status` | `bridge stripe status` |
| Billing settings (currency, checkout return) | `get_app` | `bridge billing settings` |

## Ask the developer

Product questions. Ask, wait, never guess. Then show the answer back as tables (plans, prices, limits, features) and create nothing until the developer confirms them.

1. **Which plans, and what are they called?** Is there a free one?
2. **What does each paid plan cost, in which currency, and monthly, yearly or both?**
3. **Is there a free trial, and how many days?** Must the trial take a card up front?
4. **What does each plan limit, and how much?** In their words: "2 tickets on Free, 100 on Pro", "10 seats", "1,000 exports a month".
5. **For each limit: at the limit, refuse, or keep going and charge per extra unit?** If they charge, how much per unit, and how many are included?
6. **Which features does each plan sell?** ("Analytics on Pro only.") They go on the plans' features lists.
7. **Do they want a welcome page for new customers** where they choose a plan? Offer it; create it only if they say yes.

**The tools will not guess these.** Called without one, a tool changes nothing and answers `DECISION_NEEDED` with the question to ask; `bridge plan create` stops the same way: `create_plan` (`amount`, `interval`, `currency`, `trial`, `trialDays`) · `apply_plan` (`name`, `prices.amount`, `prices.interval`, `prices.currency`, `trial`, `trialDays`) · `set_plan_price` (`currency`). A free plan (price 0) needs no trial answer.

## Decide yourself

- **Plan keys short and lower-case: `free`, `pro`, `team`.** Reason: the key is permanent and is what flag rules and the billing records use; the name can change any time.
- **Monthly and yearly prices of one tier are one plan with two prices,** never `pro-monthly` and `pro-yearly`. Reason: the plan page then shows one plan with both intervals.
- **A free plan gets a price of 0.** Reason: a workspace is put on a plan through one of its prices.
- **Counter or gauge?** If deleting it frees room, it's a gauge (tickets, projects, stored files: never reset); if it happened, it's a counter (exports, AI completions, emails: reset each billing period). Decide from that sentence and say which you chose: `bridge metric set <key> --kind counter|gauge`.
- **Seats are built in:** `bridge plan limit set pro seats=10`. Bridge counts the workspace's members itself and refuses an invite past the limit. No metric to create, nothing for the app to report.
- **Reuse metric names the app already has** (`bridge metric list`) before inventing new ones. Reason: two names for one thing split the count.
- **Connect Stripe with test keys first; live keys only when going live.** Reason: nobody is charged while you build. `bridge stripe connect` (test mode) / `setup_payments`.
- **Connect Stripe before adding paid prices.** Reason: each price is created in Stripe as it is saved.
- **Leave the paywall on** unless the developer says otherwise. Reason: a new workspace is then asked to choose a plan before it uses the app. It is the flag `bridge-app-active`; `billing: { paywall: false }` in `bridgeBootstrap()` turns the page off.
- **A workspace with no plan is normal.** It has none of the plan's features, and the plan page or the app's own upgrade prompt shows it the plans. Never report it as a fault.
- **One plan, one command:** `bridge plan create` with every `--price`, `--feature`, `--limit` and the trial, or `bridge plan apply <file>` / `apply_plan`. Reason: a plan is never left half set up.

## How a hard limit is enforced, end to end

Tell the developer this plainly; it is where integrations go wrong.

1. **The plan holds the number.** A limit is `<metric>=<n>` on the plan; the metric is a counter or a gauge.
2. **It is enforced on the server, where the action happens.** In NestJS one decorator on the handler that creates the thing, `@RequireQuota('exports')`. It holds a unit before the handler runs: a workspace at its limit gets `402` with `{ code: 'QUOTA_EXCEEDED', metric, used, limit, fix }` and the handler never runs. A `2xx` answer counts the unit; a failure gives it back. If Bridge cannot answer, the request is refused with `503`, never let through. Elsewhere, `usage.hold(actor, metric, …)` on the auth-core server client does the same.
3. **Gauges send the app's own count.** `@RequireQuota('tickets', { current })` on create and `@SyncQuota('tickets', { current })` on delete, where `current` returns the app's count from its own database. There is no decrement.
4. **Seats need no code.** Bridge refuses an invite past the seat limit by itself.
5. **The browser shows the count and explains the refusal; it never counts.** With no code at all, the upgrade dialog opens on the server's `402` (through `bridgeFetch`), names the limit and links to the plan page; someone who may not manage billing is told who to ask. Disabling a button before the click (`<QuotaGate>`) or showing "8 of 10" (`useQuota`) is optional.
6. **A usage price never refuses.** `--usage-price "exports 0.05 EUR/month included 100"`: past the included amount each unit is billed through Stripe.
7. **A feature a plan sells goes in the plan's features list, and a flag controls it.** `analytics` on `pro` makes `bridge:billing.entitlement.analytics` true on Pro and false elsewhere; the flag that controls the feature has the rule `bridge:billing.entitlement.analytics eq true`, so the rule never names a plan. On the server a flag-gated endpoint the plan keeps off answers `402 FEATURE_NOT_IN_PLAN`, which opens the upgrade dialog too.
8. **The plan page** (`/subscription/plan`) appears while the flag `bridge-app-active` is off for the workspace: the paywall.

The flag and its rule are set up in the **feature-control** guide.

## Do it

| Step | MCP | CLI |
|---|---|---|
| Connect Stripe (keys from the developer) | `setup_payments` | `bridge stripe connect --publishable-key pk_test_…` (asks for the secret key) |
| A metric | — (`set_plan_quota` names it) | `bridge metric set tickets --kind gauge --name Tickets` |
| Set up or reshape one plan in one call | `apply_plan` | `bridge plan apply plan.json` |
| Or create a plan with its prices | `create_plan` | `bridge plan create pro --name Pro --price "29 USD/month" --price "290 USD/year" --trial-days 14` |
| Add another price | `set_plan_price` | `bridge plan price set pro "290 USD/year"` |
| Add a limit | `set_plan_quota` | `bridge plan limit set pro tickets=100` |
| A per-unit price | `set_plan_quota` (`policy: metered`) | `bridge plan usage-price set pro "exports 0.05 USD/month included 100"` |
| Add a feature the plan sells | `add_plan_feature` | `bridge plan feature add pro analytics=Analytics` |
| Remove a plan no workspace is on | `delete_plan` | `bridge plan delete pro` |
| Stop selling a plan workspaces are on (they keep it) | `archive_plan` | `bridge plan archive pro` |
| Move a workspace to another plan | `set_tenant_plan` | `bridge tenant set-plan --id <workspace id> --plan free` |
| Where payers return after checkout | `update_app` (`checkoutReturnUrl`) | `bridge billing settings --return-url <url>` |
| Code for the framework | `get_integration_guide` (topic `billing`) | `bridge guide billing --framework svelte`, `bridge guide billing --framework nestjs` |

## Prove it

1. `list_plans` / `bridge plan list` matches the tables the developer confirmed; a plan with monthly and yearly pricing is one plan.
2. `get_stripe_status` / `bridge stripe status`: connected.
3. At the limit, call the limited handler with curl and a signed-in person's token: it answers `402 QUOTA_EXCEEDED`. In the app, the upgrade dialog opens and names the limit (a browser check).
4. A paid plan opens Stripe Checkout and returns to the subscription page on the new plan (a browser check).

Checks 3 (in the app) and 4 need a browser: without a browser tool, list them for the developer and start the summary with "Heads up: not verified in a browser".

## Exceptions

Checking a plan feature without a flag (`@RequireEntitlement` on the backend, `$entitlements.can` in the UI) exists for the rare case where the developer explicitly asks for no flag. Mark the line `// bridge-gate-exception: <reason>` so `check gates` leaves it.

## Where this connects

- **Fit together:** plans, limits, roles and flags side by side (`bridge guide fit-together`).
- **Feature control:** the flag whose rule reads the plan's features list.
- **Teams:** seats, and the plan belonging to the workspace.
- **Roles:** who may change the plan.
- **Going live:** live Stripe keys.
