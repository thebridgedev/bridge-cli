# Changelog

## [1.0.0-alpha.6] - Unreleased

### Changed

- **Bridge's built-in privileges are named `resource:action`**, as every other privilege is: `users:read`, `users:write`, `users:delete`, `workspace:read`, `workspace:write`, `workspace:delete`, `roles:delete`, `flags:delete`, `app:delete`, `keys:write`, `branding:delete`, `communication:delete`, `phone-numbers:write`, and `app:use` for signed in (they were `USER_READ`, `TENANT_WRITE`, `AUTHENTICATED` and so on). The examples, `flag create --when` help and `check gates` advice use the new names. A `--privilege`, `--privileges` or `--when` naming one the old way needs the new name once your Bridge server has them.

## [1.0.0-alpha.5] - Unreleased

### Added

- **A line before every command says which server and app it acts on.** `bridge: acting on app Demo (<id>) · https://api.example.com · app from --app, server from BRIDGE_SERVER` goes to stderr, so stdout stays the result alone and a write never lands on another app unannounced. `BRIDGE_NO_BANNER=true` silences it.
- **The 0.x commands that returned:** `tenant` (list, get, create, update, set-plan, delete), `user` (list, get, invite, update, remove), `token` (list, create, revoke), `role set-default`, `branding get|update`, `event list`, `auth methods list|enable|disable`, `auth config`, `auth password-policy`, `flag toggle`, `flag schedule set|clear|list`, `flag export`, `flag import`, `setup communication`, `setup status`, `info app|auth-config|flags|plans|roles`, `doctor` (also `diagnose`: checks a project's env files against the app), `event auth-attempts`, `flag eval` (worked out on your machine from the flag's rule and the app's segments; `regex` uses the JavaScript engine), `flag init` and `guide` (read from Bridge's public repositories, so it needs the network). Each acts on the version 2 routes; `tenant`, `user` and `token` are the 0.x forms of `workspace`, `member` and `key`.
- **"Your app" and the mode.** `bridge app main` shows the main address and moves it (a move to another domain says how many passkeys stop working and needs `--confirm-passkeys`), `bridge app sign-in` shows and sets where users sign in and the paths under Advanced, `bridge app mode` shows development or production with the rules production keeps on (the password rule reads "Checked when users sign in" when Bridge cannot say) and switches it with `--yes`, with the number of users who must choose a new password. `bridge app create` takes `--mode` and `--main`.
- **`--dry-run` on deletes.** `flag delete`, `plan delete`, `tenant delete`, `user remove` and `token revoke` say what they would do and change nothing. A delete without `--dry-run` needs `--yes`.

### Changed

- **Without `--server`, `--issuer`, `BRIDGE_SERVER` or `BRIDGE_ISSUER`, and before any sign-in is saved, the CLI goes to `https://api.thebridge.dev`, as 0.x did.** Every command prints the server it reached, and a password goes only to the issuer that server names on its own address.
- **`plan create` and `invite send` ask what is yours to decide.** Without a price and a trial (`--price "<amount> <CURRENCY>/<interval>"` with `--trial-days <n>` or `--no-trial`; a free plan needs no trial answer), `plan create` stops with `DECISION_NEEDED` and the questions in `fields`, and creates nothing. `invite send` and `user invite` do the same without `--role`.

## [1.0.0-alpha.4] - Unreleased

### Changed

- **Change from 0.6: `bridge auth login --password` no longer signs in with delete rights.** The session can do what you may do, except delete: a delete command is refused with a 403 from Bridge. Add `--allow-delete` to allow deletes, up to what you hold yourself (Bridge never gives more than your own rights). The CLI now always tells Bridge which it wants (`delete: false` by default). Browser sign-in already works this way: you tick delete on the approval page, and `--allow-delete` is refused there. Scripts that sign in with `--password` and then delete things need `--allow-delete` added.
- **Roles, privileges, workspaces, members, invites and the pasted Stripe key run with your sign-in.** They call the same routes the dashboard uses (`/apps/{appId}/…`), so Bridge checks what you may do, as it does for the dashboard. The CLI no longer makes a one-day app key for them. `bridge invite send --workspace` emails the person an invite they accept, as the dashboard does; `--first-name` and `--last-name` go on the invite, and `--role OWNER` is allowed with a recent sign-in. With `BRIDGE_APP_KEY` set (CI), these commands run as your app's own server with that key, as before, and the CLI makes no key.

## [1.0.0-alpha.3] - Unreleased

### Changed

- **Browser sign-in through the dashboard.** The sign-in page your issuer publishes for the CLI may be on another address than the issuer: on The Bridge it is the dashboard. When you are already signed in there in that browser, you only approve the CLI; otherwise you sign in first, then approve. The CLI says so when it opens the page. Nothing else changes: the CLI still starts a sign-in request for its loopback with PKCE, and the code still goes only to `127.0.0.1`.

## [1.0.0-alpha.2] - 2026-11-15

### Added

- **`--server <address>`** (`BRIDGE_SERVER`). Give Bridge's address, such as `https://api.example.com`, instead of the issuer: the CLI reads the sign-in issuer from the server's published resource metadata, and only takes one on the server's own address. It is saved at sign-in, as the issuer.
- **`bridge app setup`.** Hooks up your project to the chosen app: writes its issuer into `.env` as `PUBLIC_BRIDGE_ISSUER`, on the Bridge you signed in to, and adds your development address as a browser origin and its `/auth` page as the email-links address. `--url`, `--auth-path`, `--dotenv` and `--var` change them.

### Changed

- **Browser sign-in starts a sign-in request.** `bridge auth login` asks Bridge to hold its loopback address, its PKCE challenge and its `state`, then opens Bridge's sign-in page with only the request's id. The code goes only to the CLI's loopback, and the CLI presents the same address when it trades the code, so Bridge binds the code to it. The page can now sign you in by any method it offers, and you can create your account there. Bridge versions that do not offer sign-in requests get "not offered"; sign in with `--password` there.

### Removed

- **`--sign-in-page` and `BRIDGE_SIGN_IN_PAGE`.** The CLI opens only the page the issuer publishes.

## [1.0.0-alpha.1] - 2026-11-09

### Added

- **`bridge invite send` · `list` · `revoke`.** Invites by email into your own workspace on Bridge, with your sign-in. With `--workspace <id>`, into one of your app's workspaces, with an app key (`BRIDGE_APP_KEY`, or a short-lived key the CLI makes and revokes). Bridge emails the link; sending again sends a new link and stops the old one. When your app has no email-links address, the error says how to add one.

## [1.0.0-alpha.0] - 2026-11-07

The first alpha of 1.0, for version 2 of Bridge's API. Install it with `npm install -g @nebulr-group/bridge-cli@alpha`; `latest` stays on 0.x.

### Added

- **Sign-in to your issuer.** `bridge auth login` opens Bridge's sign-in page and comes back to the CLI on `127.0.0.1`, with PKCE. `bridge auth login --password` signs in in the terminal, with the workspace step, for machines with no browser. The issuer is the one address the CLI needs; every endpoint comes from its metadata.
- **Sessions kept safely.** In the OS keychain when there is one, else in a file only you can read (0600). Renewed as you go, with a new refresh token each time. `bridge auth logout` ends the session at Bridge.
- **App setup on version 2:** apps and their addresses (`bridge app address`), app keys (`bridge key`), plans with prices, trials, usage prices, features and limits (`bridge plan`), products, metrics, taxes and billing settings, Stripe in test mode by a pasted key (`bridge stripe connect`), feature flags and their rules (`bridge flag`, `bridge flag rule`), roles, privileges, workspaces and members.

### Changed

- Every command calls a pinned version 2 endpoint. Results are JSON on stdout, errors JSON on stderr, as before.
- `bridge check gates` is unchanged.

### Removed

- The 0.x commands that have no version 2 endpoint yet: `guide`, `flag init`, `integration`, `setup`, `event`, `info`, `ops`, `branding`, `tenant` (except `workspace list`), `auth use`, `auth methods`, `auth config`. Stored 0.x logins are not read; sign in again.

## [0.6.6] - 2026-10-14

### Changed

- **Theming guidance for the Svelte pages.** `bridge guide` now explains how Bridge's sign-in and subscription pages match an app. They inherit its font, text size and text colour. A few `--bridge-*` variables, now including heading, button and label weights and a button shadow, cover the rest. Any plain CSS the app writes wins over Bridge's styles. The variable list in `bridge guide mechanisms` is brought up to date.

## [0.6.5] - 2026-10-14

### Added

- **Remove a plan.** `bridge plan delete --key <key>` deletes a plan no workspace is on. If workspaces are on it, nothing is deleted and you are told how many and what to do instead: archive the plan, or move or delete those workspaces first. `--dry-run` shows whether the delete would go through and which workspaces are on the plan. Deleting needs `bridge auth login --admin`.
- **Archive a plan.** `bridge plan archive --key <key>` stops selling a plan without disturbing the workspaces on it: they keep it and keep being billed, and nobody new can choose it. `--undo` brings it back.
- **Move a workspace to another plan.** `bridge tenant set-plan --name <name> --plan <key>` does what the plan picker on a workspace in the dashboard does, including moving a paid Stripe subscription to the new plan's price. `--interval` and `--currency` choose one of the plan's prices.

## [0.6.2] - 2026-10-01

### Added

- **`bridge auth methods`.** One command now lists every login method your app offers (password, magic link, passkeys, two-factor and each social provider) with whether it is on, and `bridge auth methods enable <method>` / `disable <method>` switches any one of them. Switching a social provider off keeps its credentials, so you can switch it back on without setting it up again; the last remaining login method cannot be switched off, and enabling a provider that has no credentials yet tells you where to add them.

## [0.6.1] - 2026-09-30

### Added

- **Sign-in guides for React, Next.js and Angular.** `bridge guide <framework> sdk-auth` now serves a sign-in guide for React, Next.js and Angular, and the guide list shows it for each of them. Previously only Svelte had one. The Express guide now describes the current Express package.

### Changed

- **Auth core 0.8.** The CLI now runs on `@nebulr-group/bridge-auth-core` 0.8, the version the Bridge framework packages require.

## [0.6.0] - 2026-09-30

### Added

- **One login for the whole workspace.** `bridge auth login` now approves access to every app in your workspace in the browser, the same way the MCP connection does. `bridge app list`, `bridge app use` and `bridge app create` list, switch and create apps without logging in again, and `--app` runs a single command against another app. A single-app login is still available for CI.
- **Check that login really works.** `bridge diagnose` compares your project's settings with the real app and says what to fix. `bridge setup status` lists what is configured and what is still missing before going live. `bridge test-user` creates a test user in a workspace marked as a test and proves a real sign-in, and `bridge event auth-attempts` shows why a person's recent sign-ins failed.
- **Callback addresses one at a time.** `bridge app redirect-uris list|add|remove` changes a single login callback address. Adding one no longer risks dropping the others.
- **Delete previews.** Delete commands take `--dry-run` and show what would be removed, such as a workspace's members and login accounts, without deleting anything.
- **A whole plan in one command.** `bridge plan apply` sets up or reshapes a plan's prices, trial and limits from one file.
- **Plan features.** `bridge plan feature list|add|remove`, and `--features` on `bridge plan create`, keep a plain list of what each plan includes. Flag rules can point at that list.
- **Limits on things that exist.** Plan limits take `--kind counter|gauge`. A gauge is a number your app keeps current, such as open tickets, and it does not reset each billing period. Seats can be a limit that Bridge counts from the workspace's members, pending invites included. The metrics your plans limit can be listed with their kind.
- **Default role.** `bridge role set-default`, and `--is-default` on `bridge role update`, choose which role new members get.
- **Guides for every decision.** `bridge guide orientation` gives a short map of what Bridge does. `bridge guide decision <area>` covers login, teams, roles, payments, feature control, look and feel, and going live. `bridge guide mechanisms` explains how limits, upgrades and customization work. The seven journeys, such as `add-login` and `go-live`, open by name.
- **Find direct access checks.** `bridge check gates` lists every place in your project that checks a role, privilege or plan directly and names the feature flag to use instead. It exits with an error while any remain.

### Changed

- **Flag warnings.** Flag output now warns when a flag that is switched on still returns an off value. It also warns when a rule names a plan or role that does not exist, including a plan named by its display name instead of its key.
- **Cleaner lists.** Workspace, plan and role lists no longer include internal payment references or tracking fields, and each role names its permissions by key.
- **Breaking: product decisions are asked, not defaulted.** Creating a plan without deciding its price or trial now stops and names the options to pass, instead of picking a value. Scripts that relied on the old defaults need to pass these values explicitly.
- **Guides follow one rule.** Every guide now teaches that each gate in app code is a feature flag whose rule gives the reason. The billing guide asks whether you want a welcome page instead of creating one.

### Fixed

- **Environment address.** `bridge flag init` writes the address of the environment you are signed in to. Previously it always wrote the production address.
- **References that led nowhere.** Every command and guide the CLI points to now exists. The message after an integration names the billing guide instead of a missing one, the guide list shows each framework's real guides, and reading the start guide no longer forces a login.
- **Flags config kept.** Running `bridge flag init` again no longer overwrites an existing flags config file. The NestJS snippet it prints puts the app id in the right field.
