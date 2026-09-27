# Login — decision guide

How people sign up and sign in to the developer's app. This guide says what to ask, what to decide yourself, and which tool or command does each step. The code itself is in the per-framework guide.

> Other decision guides: `bridge guide decision <name>` (MCP: resource `bridge://guides/decisions/<name>`). How the pieces work underneath: `bridge guide mechanisms`.

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
3. **Should sign-in happen on Bridge's hosted page, or inside the app on its own address?** Both use the same one route file; the look-and-feel guide covers what each looks like.
4. **Can anyone sign up, or only people who are invited?** This is a teams question: see the **teams** guide before changing it.
5. **For each social provider they pick: the client id and client secret** from that provider's console. Never invent, guess or reuse a credential.

## Decide yourself

Apply these without asking. Say the reason in one line.

- **Callback URL is `<frontend-url>/auth/oauth-callback`,** registered as a redirect URI and as the default callback. Reason: the sign-in route file serves that address, and Bridge refuses any callback it has not seen.
- **Add redirect URIs one at a time** with `add_redirect_uri` / `bridge app redirect-uris add`. Reason: they keep the rest of the list; nothing is lost.
- **Before changing allowed origins, read the current list and pass it back with the new origin added.** Reason: `update_app` and `bridge app update --allowed-origins` replace the whole list.
- **Set the UI URL to the frontend's address.** Reason: links in invitation and password-reset emails are built from it; unset, people land on Bridge's hosted pages.
- **Leave token lifetimes at their defaults** unless the developer raises it. Reason: the defaults are safe. There are no password-complexity rules to set; if asked, say so.
- **Write no sign-in pages by hand, and no token fetch helper.** Reason: the plugin serves every sign-in page (login, signup, callback, set password, forgot password, magic link, passkey setup, workspace selection) from one file.
- **Protect every route by default; make only `/auth/*` public.** Reason: a new page is private until someone decides otherwise.

## Do it

| Step | MCP | CLI |
|---|---|---|
| Turn magic link, passkeys or two-factor on or off | `update_auth_methods` | `bridge app update --magic-link-enabled true` (also `--passkeys-enabled`, `--mfa-enabled`) |
| Add a social provider with its credentials | `setup_sso` | `bridge setup sso --provider google --client-id … --client-secret …` |
| Register the callback URL | `add_redirect_uri` | `bridge app redirect-uris add <url>` |
| Set UI URL, default callback, allowed origins | `update_app` | `bridge app update --ui-url … --default-callback-uri … --allowed-origins …` |
| Change token lifetimes (seconds) | `update_password_policy` | `bridge auth password-policy --access-token-ttl 900` |
| Code for the framework | `get_integration_guide` (topic `auth`) | `bridge guide svelte` (hosted) or `bridge guide svelte sdk-auth` (in-app) |

`setup_sso` returns a callback URL. The developer must paste it into the provider's console, or that provider's sign-in fails with a redirect mismatch. Always show it to them with that instruction. `update_auth_methods` can switch a provider on but never saves its credentials.

## Prove it

Do not say "it should work". Show it working.

1. `diagnose_integration` / `bridge diagnose`: compares the project's env files with the real app and names every difference with its fix.
2. `create_test_user`, then `verify_login` / `bridge test-user create`, then `bridge test-user verify`: a real sign-in, with the token checked.
3. If sign-in works there but not in the app, the app code is the difference.
4. When a real person cannot sign in: `debug_auth_issue` / `bridge event auth-attempts --user <email>` gives each failed attempt with its reason and fix.

## Where this connects

- **Teams:** who can sign up, and whether they create a workspace or join one.
- **Roles:** what a person can do once signed in.
- **Look and feel:** hosted or in-app sign-in, and how the pages look.
- **Going live:** production URLs and redirect URIs replace the localhost ones.
