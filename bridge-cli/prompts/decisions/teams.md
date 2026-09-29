# Teams and workspaces — decision guide

How customers are grouped in the developer's app. In Bridge every signed-in person belongs to a **workspace** (the API and the CLI call it a tenant). A workspace is one customer: it holds the people, their roles, and the plan the customer pays for.

> Read first: `bridge guide fit-together` (MCP: resource `bridge://guides/fit-together`), how roles, plans, limits and flags fit together. Other decision guides: `bridge guide decision <name>` (MCP: resource `bridge://guides/decisions/<name>`). How the pieces work underneath: `bridge guide mechanisms`.

## Start from what is there

| Read | MCP | CLI |
|---|---|---|
| Whether people can create their own workspace (`tenantSelfSignup`) | `get_app` | `bridge app get` |
| Existing workspaces | `list_tenants` | `bridge tenant list` |
| The people in one workspace | `list_users` | `bridge user list --tenant-id <id>` |
| Roles an invited person can get | `list_roles` | `bridge role list` |

## Ask the developer

Product questions. Ask, wait, never guess.

1. **Is the app for single people or for teams?** With teams, a customer invites colleagues into a shared workspace. For single people, each person simply has a workspace of their own and never sees the word.
2. **How does someone get in the first time?** Either they sign up and get a new workspace of their own, or they can only join by invitation from someone already inside.
3. **When someone is invited, which role should they get?** Read the app's real roles with `list_roles` first and offer those. See the **roles** guide: in the default setup a new app's default role is Member, while older apps often still default to Owner.
4. **Does the number of people per workspace depend on the plan?** ("1 user on Free, 10 on Pro.") If yes, that is a seat limit: see the **payments** guide. Then ask: **do invites go through Bridge's built-in team page, or through your own invite handler?**
5. **Can one person belong to several workspaces?** Bridge supports it and shows a workspace picker at sign-in; the question is whether the developer wants to offer it in their product.

**The tools will not guess these.** Called without one, a tool changes nothing and answers `DECISION_NEEDED` with the question to ask; the matching bridge command stops the same way: `invite_user` (`role`). It offers the app's role keys and names the default one.

**Only changed when you pass them.** No tool sets these on its own; left out, the current value stays: `update_app` (`tenantSelfSignup`).

## Decide yourself

- **Self-signup on for a product people try on their own; off for invitation-only products.** Take it from the answer to question 2 and set `tenantSelfSignup` to match. Reason: with it off, a stranger who signs up has nowhere to land.
- **Use Bridge's team panel for inviting and managing people** (`TeamManagementPanel` in SvelteKit) rather than a page of your own. Reason: it already handles invitations, role changes and removal against the right permissions.
- **Gate the team link and the team page with a flag ruled on a privilege**, for example a flag `team-admin` with `privileges contains "USER_WRITE"` after reading `list_roles`, used as `<FeatureFlag key="team-admin">` around the link and a route rule with `featureFlag: 'team-admin'` on the page. Never a list of role names in code. Reason: every gate in app code is a flag, and a privilege rule survives renamed roles.
- **Seats are a plan limit you name (`seats`), a gauge counted from membership.** Reason: Bridge counts the workspace's active members itself, pending invites included, so there is nothing for the app to count or report. Check it where invites happen: `<TeamManagementPanel seatsMetric="seats" />` on the built-in team page, or `@RequireQuota('seats')` on the app's own invite handler. Bridge's invite API does not refuse at the limit by itself. Never a flag or an entitlement.
- **Never create workspaces from the app's own code for sign-ups.** Reason: Bridge creates one at signup when self-signup is on; creating them elsewhere makes duplicates.
- **Create workspaces by hand only for setup and support** (an existing customer you are migrating, or a demo).

## Do it

| Step | MCP | CLI |
|---|---|---|
| Allow or stop self-signup | `update_app` (`tenantSelfSignup`) | `bridge app update --tenant-self-signup true` |
| Create a workspace by hand | `create_tenant` | `bridge tenant create --name … --owner-email …` |
| Invite someone into a workspace | `invite_user` | `bridge user invite --email … --role … --tenant-id …` |
| Change someone's role | `update_user` | `bridge user update --email … --role … --tenant-id …` |
| Limit seats per plan | `set_plan_quota` (metric `seats`, kind `gauge`, source `membership`) | `bridge plan quota set pro --metric seats --limit 10 --policy hard --kind gauge --source membership` |
| Code for the framework | `get_integration_guide` (topic `team`) | `bridge guide svelte team` |

Pass the role key the developer chose on every invitation you make on their behalf; without one, `invite_user` and `bridge user invite` invite nobody and ask which role.

## Prove it

1. Create a test user (`create_test_user` / `bridge test-user create`) and sign in (`verify_login` / `bridge test-user verify`): the response names the workspace.
2. Invite a second address into that workspace and check it appears in `list_users` / `bridge user list` with the role you meant.

## Where this connects

- **Roles:** the privileges each kind of person has, which flag rules then target.
- **Payments:** a plan belongs to the workspace, not to a person; seats are a plan limit.
- **Login:** whether sign-up is open at all.
