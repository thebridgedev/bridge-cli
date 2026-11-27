# Roles and permissions — decision guide

Who may do what inside a customer's workspace. A **role** (Owner, Admin, Editor…) is a named bundle of **privileges** (`users:write`, `invoices:approve`…). Every signed-in person has one role per workspace, and Bridge reads their role key and privileges when it works out a flag, so one rule targets them in the browser and on the server alike.

> Read first: `bridge guide fit-together` (MCP: resource `bridge://guides/fit-together`), how roles, plans, limits and flags fit together. Other decision guides: `bridge guide decision <name>` (MCP: resource `bridge://guides/decisions/<name>`). How the pieces work underneath: `bridge guide mechanisms`.

## Which tool answers which question

| The question | Answered by | Guide |
|---|---|---|
| Which privileges does each kind of person have? | a **role**, a named bundle of privileges | this one |
| Is this route, endpoint or feature on for them? | a **flag**, whose rule targets a privilege (preferred) or a role | feature-control |
| How much do they get (projects, seats, exports)? | the **plan** | payments |
| May they change this one record? | the app's own code | — |

Access by who someone is goes through a flag rule, never a role check written into the app's code: `privileges contains "reports:read"` keeps working when roles are renamed or reshuffled, and `user.role eq "ADMIN"` is for when the developer means the role itself. A role never stands in for a plan ("Pro users are Admins") and a plan never stands in for a role.

## Start from what is there

| Read | MCP | CLI |
|---|---|---|
| Roles, their privileges, and which is the default | `list_roles` | `bridge role list` |
| One role in full | `get_role` | `bridge role list` |
| Privileges that exist | `list_privileges` | `bridge privilege list` |

Read the app's real roles first: the developer may have renamed, re-scoped or replaced any of them, so never assume what a role can do from its name. In the default setup a new app starts with three roles, a suggestion to reshape rather than a fixed set: **Owner** (`OWNER`: everything, including the workspace's settings, billing and permanent deletes), **Admin** (`ADMIN`: manage people, read the workspace and its billing) and **Member** (`MEMBER`: uses the app and sees the plan, nothing more). **Member is the default role.** Whoever creates a workspace is its Owner; anyone added after them without a role named gets the default.

The built-in privileges are named `resource:action`: `app:use`, `users:read`, `users:write`, `users:delete`, `workspace:read`, `workspace:write`, `workspace:delete`, `billing:read`, `billing:manage`, `keys:write`, and a few more for deletes that `bridge privilege list` shows.

## Ask the developer

Product questions. Ask, wait, never guess.

1. **What kinds of people use one customer's workspace?** For example: the person who pays, people who manage the team, people who do the work, people who only look.
2. **For each kind, what may they do that others may not?** Ask in the app's own verbs: approve an invoice, delete a project, invite a colleague, change billing.
3. **Which role should a newly invited person get?** The current default (Member on a new app) is a starting point, not an answer.
4. **Who may manage the subscription and billing?** (Bridge's own screens gate it on the flag `bridge-billing-manage`; its rule, which the developer may change, says who.)

## Decide yourself

- **Name privileges `resource:action`, lower-case: `projects:delete`, `invoices:approve`.** Reason: they read like the built-in ones and say exactly what they allow.
- **Role keys in capitals: `EDITOR`, `VIEWER`.** Reason: a flag rule on `user.role` compares the key exactly as written.
- **Control access with a flag rule on a privilege, never a role check in code.** Reason: roles get reshaped as the product grows; a privilege rule stays true, and the rule changes without a release.
- **Name the full privilege key in a rule** (`privileges contains "reports:read"`). Reason: a rule matches whole keys in the person's list, so `reports:read` does not match `reports:read-all`.
- **Keep Owner as the one role with everything.** Never strip it: every workspace needs someone who can manage it.
- **Make the lowest sensible role the default**, with `--default` when creating it or `bridge role set-default <ROLE>` for one that exists. Reason: a forgotten role on an invite then gives too little, not too much.
- **When changing a role's privileges, send the full list.** Reason: `--privilege` on `bridge role update` replaces the list, and anything left out is revoked.
- **When the action calls the server, put the same flag on the endpoint** (NestJS `@RequireFlag`). Reason: the server enforces, and anyone can call the API directly; the browser only shows or hides.

## Do it

| Step | MCP | CLI |
|---|---|---|
| Add a privilege | `create_privilege` | `bridge privilege create projects:delete --description "Delete projects"` |
| Create a role | `create_role` | `bridge role create EDITOR --name Editor --privilege projects:read --privilege projects:write` |
| Create it as the new default | `create_role` (`isDefault: true`) | `bridge role create VIEWER --name Viewer --privilege app:use --default` |
| Make an existing role the default | `set_default_role` | `bridge role set-default EDITOR` |
| Change a role's privileges | `update_role` (full list) | `bridge role update EDITOR --privilege …` (full list) |
| Give a person a role | `update_user` | `bridge member update <member> --workspace <id> --role EDITOR` |
| Gate a route, endpoint or feature on a privilege | `create_feature_flag` (rule on `privileges`) | `bridge flag create reports --when "privileges contains reports:read"` |
| Code for the framework | `get_integration_guide` (topic `feature-flags` or `team`) | `bridge guide flags --framework nestjs`, `bridge guide svelte team` |

On the NestJS backend the flag goes on the handler: `@RequireFlag('reports')`, whose rule is `privileges contains "reports:read"`. A person without it gets `403 FEATURE_OFF`. An app key (`x-api-key`) passes the same gate when the rule matches the key's privileges. A hard-coded role check is never the answer.

Setting the default on one role clears it from the previous default.

## Prove it

1. `list_roles` / `bridge role list` shows each role with exactly the privileges agreed, and the default where the developer wanted it.
2. `evaluate_feature_flag` / `bridge flag eval reports --context '{"privileges":["reports:read"]}'`, then with `'{"privileges":[]}'`: the answers differ.
3. Call the flag-gated server route as a person whose role lacks the privilege: it answers 403. Then with one who has it: it succeeds.

## Where this connects

- **Teams:** the role an invited person gets.
- **Fit together:** roles, plans, limits and flags side by side (`bridge guide fit-together`).
- **Feature control:** the flag rule that targets a privilege (preferred) or `user.role`.
- **Payments:** who may change the plan.
