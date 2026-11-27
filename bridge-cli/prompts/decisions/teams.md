# Teams and workspaces — decision guide

How customers are grouped in the developer's app. In Bridge every signed-in person belongs to a **workspace** (the MCP tools and CLI 1.0's 0.x-style commands still call it a tenant). A workspace is one customer: it holds the people, their roles, and the plan the customer pays for.

> Read first: `bridge guide fit-together` (MCP: resource `bridge://guides/fit-together`), how roles, plans, limits and flags fit together. Other decision guides: `bridge guide decision <name>` (MCP: resource `bridge://guides/decisions/<name>`). How the pieces work underneath: `bridge guide mechanisms`.

## Start from what is there

| Read | MCP | CLI |
|---|---|---|
| Whether people can create their own workspace at sign-up | `get_app`, `get_auth_config` | `bridge auth config` (`signUp`) |
| Existing workspaces | `list_tenants` | `bridge workspace list` |
| The people in one workspace | `list_users` | `bridge member list --workspace <id>` |
| Roles an invited person can get | `list_roles` | `bridge role list` |
| Where invite links land (the email-links address) | `get_app` | `bridge app address list` |

## Ask the developer

Product questions. Ask, wait, never guess.

1. **Is the app for single people or for teams?** With teams, a customer invites colleagues into a shared workspace. For single people, each person simply has a workspace of their own and never sees the word.
2. **How does someone get in the first time?** Either they sign up and get a new workspace of their own, or they can only join by invitation from someone already inside.
3. **When someone is invited, which role should they get?** Read the app's real roles with `list_roles` / `bridge role list` first and offer those (in the default setup: Owner, Admin, Member, and Member is the default).
4. **Does the number of people per workspace depend on the plan?** ("1 user on Free, 10 on Pro.") If yes, that is the seat limit: see the **payments** guide.
5. **Can one person belong to several workspaces?** Bridge supports it and asks which one at sign-in; the question is whether the developer wants to offer it in their product.

**The tools will not guess these.** Called without one, a tool changes nothing and answers `DECISION_NEEDED` with the question to ask: `invite_user` (`role`). It offers the app's role keys and names the default one.

**Only changed when you pass them.** No tool sets these on its own; left out, the current value stays: `update_app` (`tenantSelfSignup`).

## Decide yourself

- **Self-signup on for a product people try on their own; off for invitation-only products.** Take it from the answer to question 2 (MCP: `update_app` `tenantSelfSignup`; otherwise the dashboard). Reason: with it off, a stranger who signs up has nowhere to land.
- **Use Bridge's team panel for inviting and managing people** (`<TeamPanel />` in SvelteKit, `bridge guide svelte team`) rather than a page of your own. Reason: it already handles invites, role changes and removal, and Bridge checks every change again.
- **The team panel's management actions are gated by the flag `bridge-team-manage`;** its rule (Bridge keeps it for every app) says who may manage people. Gate the team link and the team page with a flag ruled on a privilege, for example `privileges contains "users:write"`, used as `<FeatureFlag key="team-admin">` around the link and a route rule with `featureFlag: 'team-admin'` on the page. Never a list of role names in code. Reason: every gate in app code is a flag, and a privilege rule survives renamed roles.
- **An email-links address is required for invites.** Bridge emails the invite's link to it, where `/auth/invite` takes it; without one, sending is refused. `bridge app setup` adds it for development.
- **Seats are the built-in `seats` limit.** Bridge counts the workspace's members itself and refuses an invite past the limit, wherever it comes from. Nothing for the app to count or report; never a flag or an entitlement.
- **Never create workspaces from the app's own code for sign-ups.** Reason: Bridge creates one at sign-up when self-signup is on; creating them elsewhere makes duplicates.
- **Create workspaces by hand only for setup and support** (an existing customer you are migrating, or a demo).

## Do it

| Step | MCP | CLI |
|---|---|---|
| Allow or stop self-signup | `update_app` (`tenantSelfSignup`) | — (the dashboard) |
| Create a workspace by hand | `create_tenant` | `bridge tenant create --name … --owner-email …` |
| Invite someone into a workspace | `invite_user` | `bridge invite send <email> --role <ROLE> --workspace <id>` |
| See open invites, revoke one | — | `bridge invite list --workspace <id>`, `bridge invite revoke <invite> --workspace <id>` |
| Change someone's role | `update_user` | `bridge member update <member> --workspace <id> --role <ROLE>` |
| Limit seats per plan | `set_plan_quota` (metric `seats`) | `bridge plan limit set pro seats=10` |
| Code for the framework | `get_integration_guide` (topic `team`) | `bridge guide svelte team` |

Pass the role key the developer chose on every invite you make on their behalf; without one, `invite_user` invites nobody and asks which role.

## Prove it

1. Ask the developer to sign up themselves in the running app; their workspace then appears in `list_tenants` / `bridge workspace list`.
2. Invite a second address into that workspace and check it appears in `bridge invite list --workspace <id>` with the role you meant; once accepted, in `bridge member list --workspace <id>`.

## Where this connects

- **Roles:** the privileges each kind of person has, which flag rules then target.
- **Payments:** a plan belongs to the workspace, not to a person; seats are a plan limit.
- **Login:** whether sign-up is open at all.
