# Feature control — decision guide

Controlling who gets a route, an API endpoint, a feature or a single piece of code, without a deploy. The tool is a **flag**: code asks for it by key, and the flag's rule decides the answer.

> Read first: `bridge guide fit-together` (MCP: resource `bridge://guides/fit-together`), how roles, plans, limits and flags fit together. Other decision guides: `bridge guide decision <name>` (MCP: resource `bridge://guides/decisions/<name>`). How the pieces work underneath: `bridge guide mechanisms`.

## The rule that decides everything else

Features should be controlled with feature flags. A flag can switch a route, an API endpoint, a feature or a single piece of code; its rules change without a release and apply within seconds when someone's role or plan changes. If a plan sells the feature, include it on the plan as well, and point the flag's rule at the plan's list.

- **Is it on for them? A flag.** The flag is the stable place in code; the *reasons* live in its rule and change as the business does: 10% of people today, "the plan includes it" tomorrow, one named customer as an exception next month. Each of those is a rule edit, not new code.
- **Does a plan sell it? The plan's features list, and the flag's rule reads it:** `bridge:billing.entitlement.<feature> eq true`. The rule never names plans, so changing what Pro includes is one edit on the plan.
- **Who is this person? A flag rule on a privilege** (preferred) **or a role.** Never a role check written into the app's code.
- **How much do they get? A plan limit.** Numbers are not flags: see the **payments** guide.
- **May they change this one record? The app's own code.** Only the app knows who owns what.

**Every gate in app code is a flag.** App code never reads a role, a privilege list, the plan or a plan feature to decide what someone may see or do; before calling the work done, `npx @nebulr-group/bridge-cli@alpha check gates` lists any that are left.

## Start from what is there

| Read | MCP | CLI |
|---|---|---|
| Every flag with its rule | `list_feature_flags` | `bridge flag list` |
| One flag | `get_flag` | `bridge flag get <key>` |
| What each plan sells, for plan-feature rules | `list_plans` | `bridge plan list`, `bridge plan get <key>` |
| The app's real roles and privileges, for who-someone-is rules | `list_roles`, `list_privileges` | `bridge role list`, `bridge privilege list` |

Read the roles before writing a rule on them: the developer may have renamed or reshaped any of them, so never assume what a role grants from its name.

## Ask the developer

Product questions. Ask, wait, never guess.

1. **Which feature, in their words, and who should get it?** Everyone, nobody yet, a share of people, the plans that sell it, people allowed to do something, named customers, or a mix.
2. **If a plan sells it: which plans?** The answer goes on the plans' features lists, not into the rule.
3. **If it depends on who someone is: what may they do that others may not?** Ask in the app's verbs ("manage billing", "see reports"). That names a privilege; the roles guide covers creating one.
4. **What do people without it see?** Nothing at all, the old version, or, when the plan is the reason, an upgrade prompt they can click.
5. **Is it on a page people see before they sign in?** Then it must be a public flag.
6. **Should it switch on or off by itself at a set time?**

## Decide yourself

- **Flag keys in kebab-case, named after the feature: `new-editor`, `analytics`.** Reason: the key is what code reads; it should still make sense after the rollout is over.
- **Boolean unless the developer needs variants.** Reason: on/off covers almost every case and reads plainly in code.
- **A feature a plan sells: add it to the plan (`bridge plan feature add`), then rule on `bridge:billing.entitlement.<feature> eq true`.** Reason: the plan page, the upgrade dialog and the flag all read one list, and no rule names a plan.
- **Who someone is: rule on a privilege (`privileges contains "reports:read"`) before a role (`user.role eq "ADMIN"`).** Reason: a privilege rule survives renamed or reshuffled roles. Use the full privilege key: `contains` matches a whole key, never part of one.
- **An admin-only page is a flag route rule, not a check on the page.** Reason: the rule is changed in one place, and the server reads the same one.
- **Public only when a visitor must see it.** Reason: a flag is private by default, and a visitor who is not signed in gets its fallback; `--public` lets visitors read it, so its rule must not depend on who someone is.
- **Test the rule before relying on it** (`evaluate_feature_flag` / `bridge flag eval`). Reason: a rule on a fact Bridge does not have matches nobody.
- **Read flags through the plugin the per-framework guide names, never with a hand-written request.** Reason: a wrong address fails into "off", which looks exactly like "not bought".

## The facts a rule can test

Bridge works out every flag itself, from facts it holds about the caller. These are the exact names. Nothing the browser sends fills them.

| Attribute | Value | Compared |
|---|---|---|
| `user.id` | the person's id | exactly |
| `user.email` | their email | exactly |
| `user.role` | the role **key** in the current workspace, e.g. `OWNER`, `ADMIN` | exactly: `admin` does not match `ADMIN` |
| `privileges` | the person's privilege keys, as a list (`users:write`, …) | `contains`: the key is in the list. The preferred way to target who someone is |
| `tenant.id` | the workspace id | exactly |
| `tenant.plan` | the workspace's plan **key**, e.g. `pro` | ignoring case |
| `bridge:billing.plan` | the plan of the current subscription | exactly |
| `bridge:billing.trial` | `true` while on a trial | |
| `bridge:billing.subscription.status` | `trial`, `active`, `past_due`, `cancel_at_period_end` or `canceled` | |
| `bridge:billing.entitlement.<feature>` | `true` when the workspace's plan includes the feature; `app_active` while the subscription allows using the app | |

An app key calling the server is matched by its privileges: a rule on `privileges` can let a key through; rules on a role, a user or an email never match a key. A page can pass **hints** (`bridgeBootstrap({ hints: { country: 'SE' } })`) for rules on facts only the page knows; who the person is always comes from their token, never from a hint.

**The standard flags.** Bridge keeps three for every app, and the plugins' own screens gate on them; their rules are the developer's to change:

| Flag | Default rule | Gates |
|---|---|---|
| `bridge-billing-manage` | `privileges contains "billing:manage"` | choosing a plan, the billing portal, the upgrade dialog's button |
| `bridge-team-manage` | `privileges contains "users:write"` | inviting, changing roles, removing members in the team panel |
| `bridge-app-active` | `bridge:billing.entitlement.app_active eq true` | the paywall: while it is off, signed-in people go to the plan page |

**Why it is off.** A flag that is off for a plan reason carries the plan feature that would turn it on (`reason.entitlement`), so the plugin can offer an upgrade: `<FeatureFlag key="analytics" upgrade>` in SvelteKit. A flag-gated server endpoint answers `402 FEATURE_NOT_IN_PLAN` when the plan is why, `403 FEATURE_OFF` otherwise.

**A share of people** (`--rollout 25`) is counted by the person, so each keeps the same answer.

Operators: `eq`, `neq`, `contains`, `not_contains`, `in`, `not_in`, `gt`, `lt`, `between`, `regex`, `exists`, `not_exists`.

## Do it

| Step | MCP | CLI |
|---|---|---|
| Create a flag with a one-branch rule | `create_feature_flag` | `bridge flag create analytics --when "bridge:billing.entitlement.analytics eq true"` |
| Several conditions, all needed | `create_feature_flag` | repeat `--when` |
| A share of the people it matches | `create_feature_flag` | `--rollout 25` with `--when` |
| Add a branch to an existing rule | `update_feature_flag` | `bridge flag rule add <key> --when "…" --value …` |
| A whole rule as JSON | `update_feature_flag` | `bridge flag rule set <key> --rule-file rule.json` |
| Readable by visitors | `create_feature_flag` / `update_feature_flag` | `bridge flag create <key> --public`, `bridge flag update <key> --private` |
| On for everyone now; off (the kill switch); back | `toggle_feature_flag` | `bridge flag on <key>`, `bridge flag off <key>`, `bridge flag restore <key>` |
| Add the feature to the plans that sell it | `add_plan_feature` | `bridge plan feature add pro analytics=Analytics` |
| Check who gets what | `evaluate_feature_flag` | `bridge flag eval analytics --context '{"bridge:billing.entitlement.analytics":true}'` |
| Switch at a set time | `set_flag_schedule` | `bridge flag schedule set analytics --at 2026-12-01T09:00:00Z --state on` |
| Copy flags between apps | `export_feature_flags`, `import_feature_flags` | `bridge flag export --out flags.json`, `bridge flag import flags.json` |
| Code for the framework | `get_integration_guide` (topic `feature-flags`) | `bridge guide flags --framework svelte` |

A rule as JSON, for "the plans that sell analytics":

```json
{ "branches": [{ "conditions": [{ "attribute": "bridge:billing.entitlement.analytics", "operator": "eq", "values": [true] }], "returnValue": true }],
  "otherwiseValue": false }
```

## Prove it

1. `evaluate_feature_flag` / `bridge flag eval` with a context that should get the feature, then one that should not: the answers differ as the developer intended.
2. `bridge flag get <key>` shows the state and rule agreed.
3. In the app, signed in as a person on each side of the rule: shown and hidden (a browser check; without a browser tool, hand it to the developer and start the summary with "Heads up: not verified in a browser").
4. `npx @nebulr-group/bridge-cli@alpha check gates` in the project: no direct role, privilege, plan or plan-feature check left.

## Exceptions

Checking a plan feature without a flag (`@RequireEntitlement` on the backend, `$entitlements.can` in the UI) exists for the rare case where the developer explicitly asks for no flag. Mark the line `// bridge-gate-exception: <reason>` so `check gates` leaves it.

## Where this connects

- **Fit together:** the rule above, with roles, plans, limits and flags side by side (`bridge guide fit-together`).
- **Payments:** the plan's features list the rule points at, and limits for anything counted.
- **Roles:** the privileges and roles a who-someone-is rule targets.
- **Going live:** flags are per app; a production app needs its own (`bridge flag export`, then `bridge flag import`).
