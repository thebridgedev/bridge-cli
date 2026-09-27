# Feature control — decision guide

Turning features on and off for some people and not others, without a deploy. The tool is a **flag**: code asks for it by key, and the flag's rule decides the answer.

> Other decision guides: `bridge guide decision <name>` (MCP: resource `bridge://guides/decisions/<name>`). How the pieces work underneath: `bridge guide mechanisms`.

## The rule that decides everything else

- **Is a feature on for them? A flag.** Always, and for good. The flag is the stable place in code; the *reasons* live in its rule and change as the business does: 10% of users today, "plan is Pro" tomorrow, one named customer as an exception next month. Each of those is a rule edit, not new code.
- **How much do they get? The plan.** Prices, trials and limits live on the plan: see the **payments** guide.
- **Who inside a workspace may do it? A role.** See the **roles** guide.

A plan can also grant a feature on its own (a *plan feature*, checked with `@RequireEntitlement` on the backend and `<Entitled>` in the UI; the payments guide explains it). Use that only when the feature *is* what the plan sells and nothing else will ever decide it: the backend then refuses it without extra wiring. Anything that could ever need a rollout, a trial cohort or a one-customer exception is a flag.

## Start from what is there

| Read | MCP | CLI |
|---|---|---|
| Every flag with its rule, and warnings on flags that cannot mean what they look like | `list_feature_flags` | `bridge flag list` |
| One flag | `get_flag` | `bridge flag get <key>` |
| Plan keys and role keys, for rules | `list_plans`, `list_roles` | `bridge plan list`, `bridge role list` |

## Ask the developer

Product questions. Ask, wait, never guess.

1. **Which feature, in their words, and who should get it?** Everyone, nobody yet, a percentage of users, one plan, some roles, named customers, or a mix.
2. **What do people without it see?** Nothing at all, a teaser with an upgrade link, or the old version.
3. **Should it switch on or off by itself at a set time?**
4. **If it is tied to a plan: is it simply part of that plan for ever,** or might it later go to a trial group or a single customer too? (This picks flag or plan feature, above.)

## Decide yourself

- **Flag keys in kebab-case, named after the feature: `new-editor`, `analytics`.** Reason: the key is what code reads; it should still make sense after the rollout is over.
- **Boolean unless the developer needs variants.** Reason: on/off covers almost every case and reads plainly in code.
- **Target a plan by its key (`pro`), from `list_plans`, never its display name,** whatever an example elsewhere shows. Reason: the app sends the key.
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
| `privileges` | a list of privilege keys | as a list; target a role instead |

**Also sent by the browser SDKs, from the workspace's subscription:**

| Attribute | Value |
|---|---|
| `bridge:billing.plan` | the plan key, compared exactly |
| `bridge:billing.subscription.status` | `trial`, `active`, `past_due`, `cancel_at_period_end` or `canceled` |
| `bridge:billing.trial` | `true` or `false` |
| `bridge:billing.quota.<metric>.used` / `.limit` / `.remaining` | numbers |
| `bridge:billing.quota.<metric>.percent_used` | a fraction: `0.8` is 80% |
| `bridge:billing.entitlement.<name>` | `true` or `false`, including `app_active` (the subscription is active, trialing, past due or cancelling) |

**On the NestJS backend** only the signed-in person's id is filled in (as the identity). A rule on `tenant.plan` or `user.role` sees nothing there until the app passes those values from the verified user on each call; the NestJS flags guide shows how. Never pass values the client sent.

**Percentage rollouts** bucket on the identity: the person's id when signed in, a stored anonymous id in the browser otherwise. A backend call with no signed-in person gets the default.

Operators: `eq`, `neq`, `in`, `not_in`, `contains`, `not_contains`, `gt`, `lt`, `between`, `regex`, `exists`, `not_exists`.

A condition's values are always a list, even for a single value.

## Do it

| Step | MCP | CLI |
|---|---|---|
| Create a flag with its rule | `create_feature_flag` | `bridge flag create --key analytics --state on-with-rule --rule '<json>'` |
| Change a rule or values | `update_feature_flag` | `bridge flag update --key analytics --rule '<json>'` |
| Switch it on or off for everyone now (the rule is kept, unused while on) | `toggle_feature_flag` | `bridge flag toggle --key analytics --enabled true` |
| Check who gets what | `evaluate_feature_flag` | `bridge flag eval analytics --identity u1 --attribute tenant.plan=pro` |
| Switch at a set time | `set_flag_schedule` | `bridge flag schedule set analytics --at … --state on` |
| Copy flags between apps | `export_feature_flags`, `import_feature_flags` | `bridge flag export`, `bridge flag import <file>` |
| Code for the framework | `get_integration_guide` (topic `feature-flags`) | `bridge guide flags --framework svelte` |

A rule for "Pro only":

```json
{ "branches": [{ "conditions": [{ "attribute": "tenant.plan", "operator": "eq", "values": ["pro"] }], "returnValue": true }],
  "otherwiseValue": false, "rolloutPct": 100 }
```

## Prove it

1. `evaluate_feature_flag` / `bridge flag eval` with a context that should get the feature, then one that should not: the answers differ as the developer intended.
2. `list_feature_flags` / `bridge flag list` shows no warnings on the flag.
3. In the app, as a test user on each side of the rule.

## Where this connects

- **Payments:** plan keys, and plan features versus flags.
- **Roles:** role keys for `user.role`, and why a flag is not a permission.
- **Going live:** flags are per app; a production app needs its own (`export_feature_flags`, then `import_feature_flags`).
