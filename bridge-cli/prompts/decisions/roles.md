# Roles and permissions — decision guide

Who may do what inside a customer's workspace. A **role** (Owner, Admin, Editor…) is a named bundle of **privileges** (`USER_WRITE`, `INVOICE_APPROVE`…). Every signed-in person has one role per workspace, and their token carries its role key and privileges, so the backend can check them on every request.

> Other decision guides: `bridge guide decision <name>` (MCP: resource `bridge://guides/decisions/<name>`). How the pieces work underneath: `bridge guide mechanisms`.

## Which tool answers which question

Three different questions, three different tools. Keep them apart.

| The question | Answered by | Guide |
|---|---|---|
| Who, inside a workspace, may do this? | a **role** and its privileges | this one |
| Is this feature on for them at all? | a **flag** | feature-control |
| How much do they get (projects, seats, exports)? | the **plan** | payments |

A role never stands in for a plan ("Pro users are Admins") and a plan never stands in for a role.

## Start from what is there

| Read | MCP | CLI |
|---|---|---|
| Roles, their privileges, and which is the default | `list_roles` | `bridge role list` |
| One role in full | `get_role` | — |
| Privileges that exist | `list_roles` (the `privileges` map) | `bridge privilege list` |

Read the app's real roles with `list_roles` first: the developer may have renamed, re-scoped or replaced any of them, so never assume what a role can do from its name. In the default setup a new app starts with three roles, a suggestion to reshape rather than a fixed set: **Owner** (`OWNER`, everything, including permanent deletes), **Admin** (`ADMIN`, manage people, read workspace settings) and **Member** (`MEMBER`, signed in and nothing more: no workspace settings, billing or managing people). In the default setup **Member is the default role**. Whoever creates a workspace is always its Owner; anyone added after them without a role named gets the default. Apps created before Member existed keep their own roles, and on many of them Owner is still the default.

## Ask the developer

Product questions. Ask, wait, never guess.

1. **What kinds of people use one customer's workspace?** For example: the person who pays, people who manage the team, people who do the work, people who only look.
2. **For each kind, what may they do that others may not?** Ask in the app's own verbs: approve an invoice, delete a project, invite a colleague, change billing.
3. **Which role should a newly invited person get?** The current default (see `list_roles`; Member on a new app in the default setup) is a starting point, not an answer.
4. **Who may manage the subscription and billing?**

## Decide yourself

- **Name privileges after actions, in capitals: `PROJECT_DELETE`, `INVOICE_APPROVE`.** Reason: they read like the existing ones (`USER_READ`, `TENANT_WRITE`) and say exactly what they allow.
- **Role keys in capitals too: `EDITOR`, `VIEWER`.** Reason: the token carries the key exactly as written, and a flag rule on `user.role` compares it case for case.
- **In code, check a privilege, not a role name.** Reason: roles get reshaped as the product grows; the privilege on a handler stays true.
- **Keep Owner as the one role with everything.** Never strip it: in the default setup it is the only role that can delete, and every workspace needs someone who can.
- **Make the lowest sensible role the default**, by creating it with the default setting on or with `set_default_role` / `bridge role set-default <key>` for a role that exists. Reason: a forgotten role on an invitation then gives too little, not too much.
- **When changing a role's privileges, send the full list.** Reason: the update replaces the list, and anything left out is revoked.
- **Enforce on the backend; hide buttons in the frontend only as a courtesy.** Reason: anyone can call the API directly.

## Do it

| Step | MCP | CLI |
|---|---|---|
| Add a privilege | — | `bridge privilege create --key PROJECT_DELETE --description …` |
| Create a role | `create_role` | `bridge role create --key EDITOR --name Editor --privileges PROJECT_READ,PROJECT_WRITE` |
| Create it as the new default | `create_role` (`isDefault: true`) | `bridge role create --key VIEWER --name Viewer --privileges … --is-default` |
| Make an existing role the default | `set_default_role` (`key`), or `update_role` (`isDefault: true`) | `bridge role set-default EDITOR`, or `bridge role update --key EDITOR --is-default` |
| Change a role's privileges | `update_role` (full list) | `bridge role update --key EDITOR --privileges …` (full list) |
| Give a person a role | `update_user` | `bridge user update --email … --role EDITOR --tenant-id …` |
| Code for the framework | `get_integration_guide` (topic `team`) | `bridge guide nestjs` (backend checks), `bridge guide svelte team` |

On the NestJS backend the check is a decorator on the handler: `@RequirePrivilege('PROJECT_DELETE')`, or `@RequireRole('ADMIN')` when the developer really means a role.

Setting the default on one role clears it from the previous default.

## Prove it

1. `list_roles` / `bridge role list` shows each role with exactly the privileges agreed, and the default where the developer wanted it.
2. Call a protected backend route as a user whose role lacks the privilege: it must answer 403. Then with one who has it: it must succeed.

## Where this connects

- **Teams:** the role an invited person gets.
- **Feature control:** a flag rule can target a privilege (preferred) or `user.role`, but "may this person do it" is still a privilege check on the backend.
- **Payments:** who may change the plan.
