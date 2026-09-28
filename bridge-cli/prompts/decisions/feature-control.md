# Feature control — decision guide

Controlling who gets a route, an API endpoint, a feature or a single piece of code, without a deploy. The tool is a **flag**: code asks for it by key, and the flag's rule decides the answer.

> Read first: `bridge guide fit-together` (MCP: resource `bridge://guides/fit-together`), how roles, plans, limits and flags fit together. Other decision guides: `bridge guide decision <name>` (MCP: resource `bridge://guides/decisions/<name>`). How the pieces work underneath: `bridge guide mechanisms`.

## The rule that decides everything else

Features should be controlled with feature flags. A flag can switch a route, an API endpoint, a feature or a single piece of code; its rules change without a release and update live when someone's role or plan changes. If a plan sells the feature, include it on the plan as well, and point the flag's rule at the plan's list.

- **Is it on for them? A flag.** The flag is the stable place in code; the *reasons* live in its rule and change as the business does: 10% of users today, "the plan includes it" tomorrow, one named customer as an exception next month. Each of those is a rule edit, not new code.
- **Does a plan sell it? The plan's features list, and the flag's rule reads it:** `bridge:billing.entitlement.<feature> eq true`. The rule never names plans, so changing what Pro includes is one edit on the plan.
- **Who is this person? A flag rule on a privilege** (preferred) **or a role.** Never a role check written into the app's code.
- **How much do they get? A plan limit.** Numbers are not flags: see the **payments** guide.
- **May they change this one record? The app's own code.** Only the app knows who owns what.

Checking a plan feature without a flag (`@RequireEntitlement` on the backend, `<Entitled>` or `$entitlements.can` in the UI) is available, and it is the exception: use it only when the developer asks for no flag.

## Start from what is there

| Read | MCP | CLI |
|---|---|---|
| Every flag with its rule, and warnings on flags that cannot mean what they look like | `list_feature_flags` | `bridge flag list` |
| One flag | `get_flag` | `bridge flag get <key>` |
| What each plan sells, for plan-feature rules | `list_plans` | `bridge plan list`, `bridge plan feature list <plan>` |
| The app's real roles and privileges, for who-someone-is rules | `list_roles` | `bridge role list` |

Read the roles before writing a rule on them: the developer may have renamed or reshaped any of them, so never assume what a role grants from its name.

## Ask the developer

Product questions. Ask, wait, never guess.

1. **Which feature, in their words, and who should get it?** Everyone, nobody yet, a percentage of users, the plans that sell it, people allowed to do something, named customers, or a mix.
2. **If a plan sells it: which plans?** The answer goes on the plans' features lists, not into the rule.
3. **If it depends on who someone is: what may they do that others may not?** Ask in the app's verbs ("manage billing", "see reports"). That names a privilege; the roles guide covers creating one.
4. **What do people without it see?** Nothing at all, the old version, or, when the plan is the reason, an upgrade prompt they can click.
5. **Should it switch on or off by itself at a set time?**

## Decide yourself

- **Flag keys in kebab-case, named after the feature: `new-editor`, `analytics`.** Reason: the key is what code reads; it should still make sense after the rollout is over.
- **Boolean unless the developer needs variants.** Reason: on/off covers almost every case and reads plainly in code.
- **A feature a plan sells: add it to the plan (`add_plan_feature`), then rule on `bridge:billing.entitlement.<feature> eq true`.** Reason: the pricing table, the upgrade dialog and the flag all read one list, and no rule names a plan.
- **Who someone is: rule on a privilege (`privileges contains "REPORTS_VIEW"`) before a role (`user.role eq "ADMIN"`).** Reason: a privilege rule survives renamed or reshuffled roles. Use full privilege keys that no other key contains, since the list is matched as text.
- **An admin-only page is a flag route rule, not a check on the page.** Reason: the rule is changed in one place and the backend reads the same one.
- **Always give the rule an `otherwiseValue`, and make it the safe answer (usually `false`).** Reason: anyone the rule does not match gets it.
- **Test the rule with the exact attributes the app sends before relying on it** (`evaluate_feature_flag` / `bridge flag eval`). Reason: a rule on an attribute the app never sends silently answers `otherwiseValue` for everyone.
- **Read flags through the SDK the per-framework guide names, never with a hand-written request.** Reason: a wrong address fails into "off", which looks exactly like "not bought".
- **Treat a warning from `list_feature_flags` as a bug to fix now.**

## The attributes a rule can test

These are the exact names and values. A rule on any other name matches nothing unless the app sends that attribute itself.

**Sent by the browser SDKs** (SvelteKit, React, Next.js, Angular) for a signed-in person, read from their token:

| Attribute | Value | Compared |
|---|---|---|
| `user.id` | the person's id | exactly |
| `user.email` | their email | exactly |
| `user.role` | the role **key** as created, e.g. `OWNER`, `ADMIN` | exactly: `admin` does not match `ADMIN` |
| `tenant.id` | the workspace id | exactly |
| `tenant.plan` | the plan **key**, e.g. `pro` (not the name) | ignoring case: `Pro` matches `pro` |
| `privileges` | the person's privilege keys, as a list | `contains`: the key appears in the list. The preferred way to target who someone is |

**Also sent by the browser SDKs, from the workspace's subscription:**

| Attribute | Value |
|---|---|
| `bridge:billing.plan` | the plan key, compared exactly |
| `bridge:billing.subscription.status` | `trial`, `active`, `past_due`, `cancel_at_period_end` or `canceled` |
| `bridge:billing.trial` | `true` or `false` |
| `bridge:billing.quota.<metric>.used` / `.limit` / `.remaining` | numbers |
| `bridge:billing.quota.<metric>.percent_used` | a fraction: `0.8` is 80% |
| `bridge:billing.entitlement.<name>` | `true` or `false`: a feature in the plan's features list is `true` when the workspace's plan includes it, so "the plan includes analytics" is the rule `bridge:billing.entitlement.analytics eq true`. Also `app_active` (the subscription is active, trialing, past due or cancelling) |

**On the NestJS backend** the same attributes are filled in with no wiring: `user.role`, `privileges`, `user.id`, `user.email`, `tenant.id` and `tenant.plan` from the verified sign-in, and `bridge:billing.plan`, `.subscription.status`, `.trial` and `.entitlement.<name>` from Bridge's own billing records. A rule gives the same answer there as in the browser. Only the plan-limit numbers (`bridge:billing.quota.*`) are browser-only. Values the client sends are never used for these.

**Why it is off.** A flag that is off says why: `plan` (the plan does not include it, so an upgrade would turn it on), `permission` (role or privileges), or `off` (switched off). No upgrade dialog opens by itself: it opens when someone opens a gated route or clicks something gated (SvelteKit: `<FeatureFlag key="analytics" upgrade>`). A flag-gated backend endpoint answers `402 FEATURE_NOT_IN_PLAN`, `403 FEATURE_NOT_PERMITTED` or `403 FEATURE_OFF`.

**Percentage rollouts** bucket on the identity: the person's id when signed in, a stored anonymous id in the browser otherwise. A backend call with no signed-in person gets the default.

Operators: `eq`, `neq`, `in`, `not_in`, `contains`, `not_contains`, `gt`, `lt`, `between`, `regex`, `exists`, `not_exists`.

A condition's values are always a list, even for a single value.

## Do it

| Step | MCP | CLI |
|---|---|---|
| Create a flag with its rule | `create_feature_flag` | `bridge flag create --key analytics --state on-with-rule --rule '<json>'` |
| Change a rule or values | `update_feature_flag` | `bridge flag update --key analytics --rule '<json>'` |
| Switch it on or off for everyone now (the rule is kept, unused while on) | `toggle_feature_flag` | `bridge flag toggle --key analytics --enabled true` |
| Add the feature to the plans that sell it | `add_plan_feature` | `bridge plan feature add pro analytics --name "Analytics"` |
| Check who gets what | `evaluate_feature_flag` | `bridge flag eval analytics --identity u1 --attribute bridge:billing.entitlement.analytics=true` |
| Switch at a set time | `set_flag_schedule` | `bridge flag schedule set analytics --at … --state on` |
| Copy flags between apps | `export_feature_flags`, `import_feature_flags` | `bridge flag export`, `bridge flag import <file>` |
| Code for the framework | `get_integration_guide` (topic `feature-flags`) | `bridge guide flags --framework svelte` |

A rule for "the plans that sell analytics":

```json
{ "branches": [{ "conditions": [{ "attribute": "bridge:billing.entitlement.analytics", "operator": "eq", "values": [true] }], "returnValue": true }],
  "otherwiseValue": false, "rolloutPct": 100 }
```

A rule for "people who may see reports":

```json
{ "branches": [{ "conditions": [{ "attribute": "privileges", "operator": "contains", "values": ["REPORTS_VIEW"] }], "returnValue": true }],
  "otherwiseValue": false, "rolloutPct": 100 }
```

## Prove it

1. `evaluate_feature_flag` / `bridge flag eval` with a context that should get the feature, then one that should not: the answers differ as the developer intended.
2. `list_feature_flags` / `bridge flag list` shows no warnings on the flag.
3. In the app, as a test user on each side of the rule.

## Where this connects

- **Fit together:** the rule above, with roles, plans, limits and flags side by side (`bridge guide fit-together`).
- **Payments:** the plan's features list the rule points at, and limits for anything counted.
- **Roles:** the privileges and roles a who-someone-is rule targets; read them with `list_roles` first.
- **Going live:** flags are per app; a production app needs its own (`export_feature_flags`, then `import_feature_flags`).
