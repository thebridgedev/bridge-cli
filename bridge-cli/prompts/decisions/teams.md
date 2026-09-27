# Teams and workspaces — decision guide

How customers are grouped in the developer's app. In Bridge every signed-in person belongs to a **workspace** (the API and the CLI call it a tenant). A workspace is one customer: it holds the people, their roles, and the plan the customer pays for.

> Other decision guides: `bridge guide decision <name>` (MCP: resource `bridge://guides/decisions/<name>`). How the pieces work underneath: `bridge guide mechanisms`.

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
3. **When someone is invited, which role should they get?** See the **roles** guide: on a new app the default role is Owner, so an invitee without a role becomes an Owner.
4. **Does the number of people per workspace depend on the plan?** ("1 user on Free, 10 on Pro.") If yes, that is a seat limit: see the **payments** guide.
5. **Can one person belong to several workspaces?** Bridge supports it and shows a workspace picker at sign-in; the question is whether the developer wants to offer it in their product.

## Decide yourself

- **Self-signup on for a product people try on their own; off for invitation-only products.** Take it from the answer to question 2 and set `tenantSelfSignup` to match. Reason: with it off, a stranger who signs up has nowhere to land.
- **Use Bridge's team panel for inviting and managing people** (`TeamManagementPanel` in SvelteKit) rather than a page of your own. Reason: it already handles invitations, role changes and removal against the right permissions.
- **Seats are the built-in `users` limit.** Reason: Bridge counts workspace members itself, so there is nothing for the app to count or report.
- **Never create workspaces from the app's own code for sign-ups.** Reason: Bridge creates one at signup when self-signup is on; creating them elsewhere makes duplicates.
- **Create workspaces by hand only for setup and support** (an existing customer you are migrating, or a demo).

## Do it

| Step | MCP | CLI |
|---|---|---|
| Allow or stop self-signup | `update_app` (`tenantSelfSignup`) | `bridge app update --tenant-self-signup true` |
| Create a workspace by hand | `create_tenant` | `bridge tenant create --name … --owner-email …` |
| Invite someone into a workspace | `invite_user` | `bridge user invite --email … --role … --tenant-id …` |
| Change someone's role | `update_user` | `bridge user update --email … --role … --tenant-id …` |
| Limit seats per plan | `set_plan_quota` (metric `users`, kind `gauge`) | `bridge plan quota set pro --metric users --limit 10 --policy hard --kind gauge` |
| Code for the framework | `get_integration_guide` (topic `team`) | `bridge guide svelte team` |

Pass a role key on every invitation you make on the developer's behalf; leaving it out gives the app's default role.

## Prove it

1. Create a test user (`create_test_user` / `bridge test-user create`) and sign in (`verify_login` / `bridge test-user verify`): the response names the workspace.
2. Invite a second address into that workspace and check it appears in `list_users` / `bridge user list` with the role you meant.

## Where this connects

- **Roles:** what each person in a workspace may do.
- **Payments:** a plan belongs to the workspace, not to a person; seats are a plan limit.
- **Login:** whether sign-up is open at all.
