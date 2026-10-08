# Changelog

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
