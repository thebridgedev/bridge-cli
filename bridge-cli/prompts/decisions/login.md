# Login — decision guide

How people sign up and sign in to the developer's app. This guide says what to ask, what to decide yourself, and which tool or command does each step. The code itself is in the per-framework guide.

> How roles, plans, limits and flags fit together: `bridge guide fit-together` (MCP: resource `bridge://guides/fit-together`). Other decision guides: `bridge guide decision <name>` (MCP: resource `bridge://guides/decisions/<name>`). How the pieces work underneath: `bridge guide mechanisms`.

## Start from what is there

Read before you ask anything, so your questions are about changes, not about the current state.

| Read | MCP | CLI |
|---|---|---|
| Sign-in methods and token lifetimes | `get_auth_config` | `bridge auth config` |
| URLs, redirect URIs, allowed origins | `get_app` | `bridge app get` |
| The exact env variables for this project | `get_environment_info` | — |

A new app has password, magic link and passkeys on, two-factor off, and no social providers.

## Ask the developer

Product questions. Ask, wait, never guess.

1. **Which ways should people be able to sign in?** Password is always there. Offer magic link, passkeys, Google, GitHub, Microsoft (Azure AD), LinkedIn, Facebook. Company SSO (SAML or OIDC) is set up in the Bridge dashboard, not from here.
2. **Should two-factor sign-in be available?**
3. **Can anyone sign up, or only people who are invited?** This is a teams question: see the **teams** guide before changing it.
4. **For each social provider they pick: the client id and client secret** from that provider's console. Never invent, guess or reuse a credential.

**Only changed when you pass them.** No tool sets these on its own; left out, the current value stays: `update_auth_methods` (`mfaEnabled`, `passkeysEnabled`, `magicLinkEnabled`, `googleSsoEnabled`, `linkedinSsoEnabled`, `azureAdSsoEnabled`, `appleSsoEnabled`, `githubSsoEnabled`, `facebookSsoEnabled`).

## Decide yourself

Apply these without asking. Say the reason in one line.

- **Sign-in happens inside the app (SDK mode).** The pages render on the app's own address, inside its layout, styled to match the app (the **look and feel** guide says how). There is nothing to choose; tell the developer in one line. Reason: users never leave the app, and the pages look like the rest of it. (If the developer explicitly asks for Bridge's hosted sign-in page, or the app already uses it, respect that.)
- **Callback URL is `<frontend-url>/auth/oauth-callback`,** registered as a redirect URI and as the default callback. Reason: the sign-in route file serves that address, and Bridge refuses any callback it has not seen.
- **Add redirect URIs one at a time** with `add_redirect_uri` / `bridge app redirect-uris add`. Reason: they keep the rest of the list; nothing is lost.
- **Before changing allowed origins, read the current list and pass it back with the new origin added.** Reason: `update_app` and `bridge app update --allowed-origins` replace the whole list.
- **Set the UI URL to the frontend's address.** Reason: links in invitation and password-reset emails are built from it; unset, people land on a Bridge page instead of the app.
- **Leave token lifetimes at their defaults** unless the developer raises it. Reason: the defaults are safe. There are no password-complexity rules to set; if asked, say so.
- **Write no sign-in pages by hand, and no token fetch helper.** Reason: the plugin serves every sign-in page (login, signup, callback, set password, forgot password, magic link, passkey setup, workspace selection) from one file.
- **Protect every route by default; make only `/auth/*` public.** Reason: a new page is private until someone decides otherwise.

## Do it

| Step | MCP | CLI |
|---|---|---|
| See every login method and whether it is on | `get_auth_config` | `bridge auth methods list` |
| Turn magic link, passkeys, two-factor or a social provider on or off | `update_auth_methods` | `bridge auth methods enable magicLink` / `bridge auth methods disable google` |
| Add a social provider with its credentials | `setup_sso` | `bridge setup sso --provider google --client-id … --client-secret …` |
| Register the callback URL | `add_redirect_uri` | `bridge app redirect-uris add <url>` |
| Set UI URL, default callback, allowed origins | `update_app` | `bridge app update --ui-url … --default-callback-uri … --allowed-origins …` |
| Change token lifetimes (seconds) | `update_password_policy` | `bridge auth password-policy --access-token-ttl 900` |
| Code for the framework | `get_integration_guide` (topic `integration`, then `auth`) | `bridge guide svelte`, then `bridge guide svelte sdk-auth` |

`setup_sso` returns a callback URL. The developer must paste it into the provider's console, or that provider's sign-in fails with a redirect mismatch. Always show it to them with that instruction. `update_auth_methods` / `bridge auth methods` never save credentials: Bridge refuses to switch a social provider on until they are saved, and switching one off keeps them. Bridge also refuses to switch off the last remaining sign-in method.

## Prove it

Do not say "it should work". Show it working.

1. `diagnose_integration` / `bridge diagnose`: compares the project's env files with the real app and names every difference with its fix.
2. Ask the developer to sign up and sign in themselves in the running app: sign up, open the verification email, set a password, sign in, sign out. Do not create test users; a real signup is the only check that covers the app's own pages and the emails.
3. If a step fails, `debug_auth_issue` / `bridge event auth-attempts --user <their email>` names the reason and the fix.
4. When a real person cannot sign in: `debug_auth_issue` / `bridge event auth-attempts --user <email>` gives each failed attempt with its reason and fix.

## Where this connects

- **Teams:** who can sign up, and whether they create a workspace or join one.
- **Roles:** what a person can do once signed in.
- **Look and feel:** how the sign-in pages take on the app's design.
- **Going live:** production URLs and redirect URIs replace the localhost ones.
