# Login — decision guide

How people sign up and sign in to the developer's app, on the new Bridge and its 1.0 plugins. This guide says what to ask, what to decide yourself, and which tool or command does each step. The code itself is in the per-framework guide (`bridge guide svelte sdk-auth`, `bridge guide nestjs auth`, `bridge guide javascript`).

> How roles, plans, limits and flags fit together: `bridge guide fit-together` (MCP: resource `bridge://guides/fit-together`). Other decision guides: `bridge guide decision <name>` (MCP: resource `bridge://guides/decisions/<name>`). How the pieces work underneath: `bridge guide mechanisms`.

## Start from what is there

Read before you ask anything, so your questions are about changes, not about the current state.

| Read | MCP | CLI |
|---|---|---|
| Sign-in methods, token lifetimes, sign-up | `get_auth_config` | `bridge auth config`, `bridge auth methods list` |
| The issuer and the app's addresses | `get_app`, `get_environment_info` | `bridge app get`, `bridge app address list` |

## Ask the developer

Product questions. Ask, wait, never guess.

1. **Which ways should people be able to sign in?** Password, a sign-in link by email (magic link), passkeys, and social providers (Google, GitHub, Microsoft, LinkedIn, Facebook). Company sign-in (SSO) is set up in the Bridge dashboard.
2. **Should a second step (a code by text message) be available?**
3. **Can anyone sign up, or only people who are invited?** This is a teams question: see the **teams** guide before changing it.
4. **For each social provider they pick: the client id and secret** from that provider's console. They are saved in the Bridge dashboard (Authentication > Login), never through you. Never invent, guess or reuse a credential.

**Only changed when you pass them.** No tool sets these on its own; left out, the current value stays: `update_auth_methods` (`magicLinkEnabled`, `passkeysEnabled`, `mfaEnabled`, `googleSsoEnabled`, `githubSsoEnabled`, `azureAdSsoEnabled`, `linkedinSsoEnabled`, `facebookSsoEnabled`).

## Decide yourself

Apply these without asking. Say the reason in one line.

- **Install the 1.0 plugin from the `alpha` tag.** Reason: the new Bridge works with the 1.0 line only; `latest` is 0.x and fails here.
- **One setting: the issuer.** `bridge app setup` writes it into `.env` (`PUBLIC_BRIDGE_ISSUER` for SvelteKit; `BRIDGE_ISSUER` for NestJS). Reason: the plugin reads every endpoint from the issuer; there is no app id and no API address to set.
- **Sign-in happens inside the app.** The pages render on the app's own `/auth` routes, inside its layout, styled to match the app (the **look and feel** guide says how). There is nothing to choose; tell the developer in one line. (If the developer explicitly asks for Bridge's hosted sign-in page, respect that: the per-framework sign-in guide has hosted mode.)
- **The app's address is a browser origin, and `<address>/auth` its email-links address.** `bridge app setup --url <dev address>` adds both for development; add production ones with `bridge app address add`. Reason: Bridge refuses calls from a page whose origin it does not know, and its emails (finishing a sign-up, resetting a password, an invite) link to the email-links address.
- **Add addresses one at a time** with `bridge app address add`. Reason: it keeps the rest of the list. Through the MCP, `update_app` `allowedOrigins` replaces the whole list: read it first and send every origin.
- **Leave token lifetimes at their defaults** unless the developer raises it. Reason: the defaults are safe.
- **Write no sign-in pages by hand, and no token fetch helper.** Reason: one file (`<BridgeAuthRoutes />` under `src/routes/auth/[...bridge]/`) serves every sign-in page, and `bridgeFetch` adds the token.
- **Protect every route by default; make public only what is clearly public.** Reason: a new page is private until someone decides otherwise.

## Do it

| Step | MCP | CLI |
|---|---|---|
| See every login method and whether it is on | `get_auth_config` | `bridge auth methods list` |
| Turn sign-in links or passkeys on or off | `update_auth_methods` | `bridge auth methods enable magicLink` / `bridge auth methods disable passkeys` |
| A social provider, or the second step | `update_auth_methods`, after the credentials are saved in the dashboard | — (the dashboard) |
| The issuer into `.env`, the dev address | `get_environment_info` (`issuer`), `update_app` (`allowedOrigins`, `uiUrl`) | `bridge app setup --url <dev address>` |
| One more address | `update_app` (full `allowedOrigins` list) | `bridge app address add <url> --use browser-origin` / `--use email-links` |
| Change token lifetimes (seconds) | `update_password_policy` | `bridge auth password-policy --access-token-ttl 900` |
| Code for the framework | `get_integration_guide` (topic `integration`, then `auth`) | `bridge guide svelte`, then `bridge guide svelte sdk-auth` |

Bridge refuses to switch a social provider on until its credentials are saved, and refuses to switch off the last remaining sign-in method.

## Prove it

Do not say "it should work". Show it working.

1. `diagnose_integration` / `bridge doctor`: compares the project's settings with the real app and names every difference with its fix.
2. Ask the developer to sign up and sign in themselves in the running app: sign up, open the email's link, sign in, sign out. Do not create test users; a real sign-up is the only check that covers the app's own pages and the emails.
3. If a step fails, `debug_auth_issue` / `bridge event auth-attempts --user <their email>` names the reason and the fix.

## Where this connects

- **Teams:** who can sign up, and whether they create a workspace or join one.
- **Roles:** what a person can do once signed in.
- **Look and feel:** how the sign-in pages take on the app's design.
- **Going live:** production addresses next to the localhost ones.
