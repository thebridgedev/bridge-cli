# How roles, plans, limits and flags fit together

Read this before any decision guide that touches who gets what. Every other guide builds on it. MCP: resource `bridge://guides/fit-together`. CLI: `bridge guide fit-together`.

## The rule

Features should be controlled with feature flags. A flag can switch a route, an API endpoint, a feature or a single piece of code; its rules change without a release and update live when someone's role or plan changes. If a plan sells the feature, include it on the plan as well. This is valuable because the plan is where the customer sees what they are buying: the pricing table, the upgrade dialog and the "not on your plan" reason all read the plan's list, and the flag's rule points at that same list, so changing what Pro includes is one edit in one place.

## One question, one tool

| The question | The tool | How |
|---|---|---|
| Is this route, API endpoint, feature or piece of code on for them? | a **flag** | The code asks for the flag by key; the flag's rule decides |
| Does their plan sell it? | the plan's **features list**, read by the flag's rule | `bridge plan feature add pro analytics`, then the rule `bridge:billing.entitlement.analytics eq true` |
| How many do they get (projects, exports, seats)? | a **plan limit** | `bridge plan quota set pro --metric exports --limit 100 --policy hard` |
| Who is this person, and may they do this kind of thing? | a flag rule on a **privilege** (preferred) or a **role** | `privileges contains "REPORTS_VIEW"`, or `user.role eq "ADMIN"` |
| May this person change this one record? | the app's own code | "Only the author edits their post" |

The flag's rule never names plans. It points at `bridge:billing.entitlement.<feature>`, so when Pro gains or loses a feature, the plan changes and no rule has to follow.

## Where a flag is not the tool

- **Numbers are plan limits.** "100 exports a month" or "10 projects" is a quota on the plan, not a flag. Bridge refuses at the limit and the upgrade dialog explains it.
- **Permission on one specific record stays in app code.** Whether this person may edit *this* invoice depends on data only the app has (who wrote it, which team owns it). The flag decides whether invoice editing exists for them at all; the app decides the record.
- **Checking a plan feature without a flag is the exception.** `@RequireEntitlement('analytics')` on the backend and `<Entitled to="analytics">` or `$entitlements.can('analytics')` in the UI read the plan's list directly. They work, and they are for the rare case where the developer asks for no flag. Use a flag by default: it can also carry a rollout, a trial group or a one-customer exception later, without a code change.

## Access by who someone is

Control it with a flag rule, never with a role check written into the app's code.

- **Prefer a privilege rule** (`privileges contains "REPORTS_VIEW"`) over a role rule (`user.role eq "ADMIN"`). A privilege rule keeps working when roles are renamed or reshuffled. Privilege keys are matched as text inside the person's list, so give each privilege a key that no other key contains (`REPORTS_VIEW`, not `REPORTS` next to `REPORTS_VIEW`).
- **A role rule is fine when the developer means the role itself.** Use the role key exactly as `list_roles` shows it; `ADMIN` and `admin` are different.
- **An admin-only page is a flag route rule, not a check on the page.** In SvelteKit: `{ match: '/admin/*', featureFlag: 'admin-area', redirectTo: '/' }`, with the flag `admin-area` ruled on a privilege. On the NestJS backend: `@RequireFlag('admin-area')` on the handler. Both read the same rule.
- **Roles are the app's own.** What a role can do is only ever "in the default setup". Read the app's real roles and privileges with `list_roles` / `bridge role list` before writing any rule, and never assume what a role grants from its name. In the default setup a new app has Owner, Admin and Member, and Member is the default for everyone after the first person in a workspace.

## The backend sees the same rule

A flag rule on a role, a privilege, the plan or a plan feature gives the same answer in the NestJS backend as in the browser, with no wiring: the plugin fills those in from the verified sign-in and from Bridge's own billing records. Nothing the client sends is used for them. Plan-limit numbers (`bridge:billing.quota.*`) are the one thing a server-side rule cannot see; limits are enforced by the plan-limit decorator anyway.

## Limits: count once, where the action happens

Ask the developer first: **"Does this action call your server?"** Then:

- **Yes, it calls the backend:** the backend counts it. One decorator on the handler (`@RequireQuota('exports')` in NestJS) refuses at the limit with `402` and records the use after a successful request. The frontend only shows the count and the upgrade dialog; it does not report the same metric.
- **No, it happens in the browser** (local-first, data on the device, no server of the developer's own): the browser counts it. `bridge.usage.report('exports')` for something that happened, `bridge.usage.set('projects', n)` for how many exist now, and `<QuotaGate metric="exports">` around the button so it stops at the limit. This is a first-class way to run limits. It trusts the browser: someone who edits the page's code could report less than they use.

Never count one metric in both places: it is counted twice. Never describe browser counting as a lesser or temporary option; ask the question above and follow the answer.

Counter or gauge: if deleting it frees room, it's a gauge and your app counts it; if it happened, it's a counter and Bridge counts it.

## What people see when something is off

A flag that is off says why, and the app shows each reason differently:

| Why it is off | In the browser | From the backend |
|---|---|---|
| Not on their plan | The upgrade dialog, naming the plans that include it | `402 FEATURE_NOT_IN_PLAN` |
| Their role or privileges | Hidden, or a line telling them to ask an admin | `403 FEATURE_NOT_PERMITTED` |
| Switched off | Hidden | `403 FEATURE_OFF` |

No upgrade dialog opens by itself. It opens when someone opens a gated route, clicks something gated (SvelteKit: `<FeatureFlag key="analytics" upgrade>` renders an "Upgrade to use this" button), or when the backend refuses with a `402`. A page that only renders a hidden feature opens nothing.

## Worked example

"Analytics on Pro. Only people who manage the workspace see settings. 100 exports a month on Pro."

1. `bridge plan feature add pro analytics --name "Analytics"`, and a flag `analytics` with the rule `bridge:billing.entitlement.analytics eq true`.
2. `bridge role list` first. Then a flag `workspace-settings` with a privilege rule, e.g. `privileges contains "TENANT_WRITE"` if that is the privilege the app's roles use for it, and a route rule on `/settings/*`.
3. Ask whether exporting calls the developer's server. If it does: `bridge plan quota set pro --metric exports --limit 100 --policy hard` and `@RequireQuota('exports')` on the export handler. If it does not: the same quota, `bridge.usage.report('exports')` in the browser and `<QuotaGate metric="exports">` around the button.

## Where each piece is decided

| Area | Decision guide |
|---|---|
| Flags and their rules | `bridge guide decision feature-control` |
| Roles and privileges | `bridge guide decision roles` |
| Plans, features and limits | `bridge guide decision payments` |
| Who is in a workspace | `bridge guide decision teams` |
| How limits, the upgrade dialog and page customisation work | `bridge guide mechanisms` |
