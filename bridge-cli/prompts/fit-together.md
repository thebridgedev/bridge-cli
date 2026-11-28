# How roles, plans, limits and flags fit together

Read this before any decision guide that touches who gets what. Every other guide builds on it. MCP: resource `bridge://guides/fit-together`. CLI: `bridge guide fit-together`.

## The one rule for app code

**Every gate in app code is a flag.** A link, a page, a button, an endpoint: if some people get it and others do not, the code asks a flag, and the flag's rule says why: a privilege (`privileges contains "users:write"`), a plan feature (`bridge:billing.entitlement.analytics eq true`) or a rollout. App code never reads a role, a privilege list, the plan or a plan feature to decide what someone may see or do.

Two things are not gates and are not flags: **numbers** are plan limits (held on the server with `@RequireQuota`, shown in the browser with `<QuotaGate>`), and **permission on one specific record** stays in app code ("only the author edits their post").

Before calling the work done, run `npx @nebulr-group/bridge-cli@alpha check gates` in the project. It lists every direct role, privilege, plan or plan-feature check with the flag to use instead. Fix each one.

- **SvelteKit (bridge-svelte 1.0):** a piece of UI or a nav link is `<FeatureFlag key="…">`; a page is a route rule `{ match: '/admin/*', featureFlag: 'admin-area', redirectTo: '/' }` in `bridgeBootstrap()`; a value is `useFlag('…')`.
- **NestJS (bridge-nestjs 1.0):** an endpoint is `@RequireFlag('…')` on the handler (`@RequireFeatureFlag` is the same decorator).
- **Any other JavaScript app (auth-core 1.0):** `bridge.flags.enabled('…')` in the browser, `(await bridge.flags.forRequest(request)).enabled('…')` on the server.

## Why a flag

Features should be controlled with feature flags. A flag can switch a route, an API endpoint, a feature or a single piece of code; its rules change without a release and apply within seconds when someone's role or plan changes. If a plan sells the feature, include it on the plan as well. The plan is where the customer sees what they are buying: the plan page, the upgrade dialog and the "not on your plan" reason all read the plan's list, and the flag's rule points at that same list, so changing what Pro includes is one edit in one place.

## One question, one tool

| The question | The tool | How |
|---|---|---|
| Is this route, API endpoint, feature or piece of code on for them? | a **flag** | The code asks for the flag by key; the flag's rule decides |
| Does their plan sell it? | the plan's **features list**, read by the flag's rule | `bridge plan feature add pro analytics=Analytics`, then the rule `bridge:billing.entitlement.analytics eq true` |
| How many do they get (projects, exports)? | a **plan limit** | `bridge plan limit set pro exports=100` |
| How many people fit in a workspace? | the built-in **`seats`** limit, counted from membership by Bridge | `bridge plan limit set pro seats=10` |
| Who is this person, and may they do this kind of thing? | a flag rule on a **privilege** (preferred) or a **role** | `privileges contains "reports:read"`, or `user.role eq "ADMIN"` |
| May this person change this one record? | the app's own code | "Only the author edits their post" |

The flag's rule never names plans. It points at `bridge:billing.entitlement.<feature>`, so when Pro gains or loses a feature, the plan changes and no rule has to follow.

## Where a flag is not the tool

- **Numbers are plan limits.** "100 exports a month" or "10 projects" is a limit on the plan, not a flag. The server refuses at the limit and the upgrade dialog explains it.
- **Seats are a plan limit too, counted from membership.** Bridge counts the workspace's members itself and refuses an invite past the limit, wherever the invite comes from. Never a flag or an entitlement.
- **Permission on one specific record stays in app code.** Whether this person may edit *this* invoice depends on data only the app has. The flag decides whether invoice editing exists for them at all; the app decides the record.

## Access by who someone is

Control it with a flag rule, never with a role check written into the app's code.

- **Prefer a privilege rule** (`privileges contains "reports:read"`) over a role rule (`user.role eq "ADMIN"`). A privilege rule keeps working when roles are renamed or reshuffled. `contains` on `privileges` means the person holds exactly that key: `reports:read` does not match `reports:read-all`.
- **Privileges are named `resource:action`.** The built-in ones include `app:use`, `users:read`, `users:write`, `workspace:read`, `workspace:write`, `billing:read` and `billing:manage`; `bridge privilege list` shows the app's own.
- **A role rule is fine when the developer means the role itself.** Use the role key exactly as `bridge role list` shows it; `ADMIN` and `admin` are different.
- **An admin-only page is a flag route rule, not a check on the page.** In SvelteKit: `{ match: '/admin/*', featureFlag: 'admin-area', redirectTo: '/' }`, with the flag `admin-area` ruled on a privilege. On the NestJS backend: `@RequireFlag('admin-area')` on the handler. Both read the same rule.
- **The team page is the same.** Bridge's own team panel gates its management actions on the flag `bridge-team-manage`; gate the team link and route on a flag ruled on the privilege that manages people (for example `privileges contains "users:write"`), never on a list of role names.
- **Roles are the app's own.** Read the app's real roles and privileges with `list_roles` / `bridge role list` before writing any rule, and never assume what a role grants from its name. In the default setup a new app has Owner (`OWNER`), Admin (`ADMIN`) and Member (`MEMBER`).

## The server sees the same rule

Bridge works out every flag itself, for the caller of each request, from facts it holds: the person's role and privileges from their sign-in, the workspace's plan and plan features from its own billing records. The browser and the server get the same answer for the same person, with no wiring, and nothing a client sends is used for those facts. The server is where a gate is enforced, with the backend plugin; the browser shows or hides.

## Limits: count once, on the server

Usage is counted on the server, where the action happens: the backend plugin holds a unit before the handler runs (`@RequireQuota('exports')` in NestJS; `usage.hold` on the auth-core server client elsewhere), refuses at the limit with `402`, and counts it when the handler succeeds. The browser shows the count and opens the upgrade dialog on that `402`; it never reports usage. An app with no server of its own adds one endpoint for the action (a SvelteKit `+server.ts`).

Counter or gauge: if deleting it frees room, it's a gauge (the server sets how many exist); if it happened, it's a counter (the server counts each one).

## What people see when something is off

A flag that is off says why, and the app shows each reason differently:

| Why it is off | In the browser | From the backend |
|---|---|---|
| Not on their plan | The upgrade dialog, naming the plans that include it | `402 FEATURE_NOT_IN_PLAN` |
| Anything else: the rule, a rollout, switched off | Hidden, or the page's own wording | `403 FEATURE_OFF` |

No upgrade dialog opens by itself. It opens when someone opens a gated route, clicks something gated (SvelteKit: `<FeatureFlag key="analytics" upgrade>` shows an upgrade prompt in its place), or when the backend refuses with a `402`. A page that only renders a hidden feature opens nothing.

## Worked example

"Analytics on Pro. Only people who manage the workspace see settings. 100 exports a month on Pro."

1. `bridge plan feature add pro analytics=Analytics`, and a flag: `bridge flag create analytics --when "bridge:billing.entitlement.analytics eq true"`.
2. `bridge role list` first. Then a flag with a privilege rule, e.g. `bridge flag create workspace-settings --when "privileges contains workspace:write"`, and a route rule on `/settings/*`.
3. `bridge plan limit set pro exports=100` and `@RequireQuota('exports')` on the export handler.
4. `npx @nebulr-group/bridge-cli@alpha check gates`: nothing left that reads a role, a privilege, the plan or a plan feature directly.

## Exceptions

**Checking a plan feature without a flag is the exception.** `@RequireEntitlement('analytics')` on the backend and `$entitlements.can('analytics')` in the UI read the plan's list directly. They are for the rare case where the developer explicitly asks for no flag. Mark each such line `// bridge-gate-exception: <reason>` so `check gates` leaves it. Use a flag by default: it can also carry a rollout, a trial group or a one-customer exception later, without a code change.

## Where each piece is decided

| Area | Decision guide |
|---|---|
| Flags and their rules | `bridge guide decision feature-control` |
| Roles and privileges | `bridge guide decision roles` |
| Plans, features and limits | `bridge guide decision payments` |
| Who is in a workspace | `bridge guide decision teams` |
| How limits, the upgrade dialog and page customisation work | `bridge guide mechanisms` |
