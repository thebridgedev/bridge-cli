# Look and feel — decision guide

How Bridge's pages and emails look to the developer's users: the sign-in pages, the subscription pages, and the emails Bridge sends in the app's name.

> How roles, plans, limits and flags fit together: `bridge guide fit-together` (MCP: resource `bridge://guides/fit-together`). Other decision guides: `bridge guide decision <name>` (MCP: resource `bridge://guides/decisions/<name>`). The customisation levels in full, with every design token: `bridge guide mechanisms`.

## Two places pages can live

- **Hosted:** Bridge serves sign-in on its own address. Styled with the app's **branding** (colours, font, corner radius), which Bridge stores.
- **In the app:** the same pages render inside the developer's own layout, on their address. Styled with CSS design tokens (`--bridge-*`) in the app's own stylesheet.

Both use the same single route file; one setting switches sign-in into the app (`loginRoute: '/auth/login'` in SvelteKit's `bridgeBootstrap()`). Subscription pages always render in the app.

## Start from what is there

| Read | MCP | CLI |
|---|---|---|
| Hosted-page branding | `get_branding` | `bridge branding get` |
| App name, and the email sender | `get_app` | `bridge app get` |

## Ask the developer

Product questions. Ask, wait, never guess.

1. **Should sign-in look like part of the app, on the app's own address, or is Bridge's hosted page fine?**
2. **What are the brand colours and font?** Ask for exact values or point at their existing stylesheet; do not pick colours for them.
3. **What name should users see** on sign-in pages and in emails?
4. **Which address and sender name should emails come from?** (Invitations, password resets, magic links.)
5. **Beyond colours, should sign-in pages say anything of their own?** A different heading, a frame around the form, a page they design themselves.

**Only changed when you pass them.** No tool sets these on its own; left out, the current value stays: `update_branding` (`bgColor`, `textColor`, `linkColor`, `primaryButtonBgColor`, `primaryButtonTextColor`, `fontFamily`, `borderRadius`).

## Decide yourself

Climb only as far as the answers require, and say which level you stopped at.

- **Level 0, nothing:** in-app pages already sit inside the app's layout, so its header and navigation surround them. Reason: often this alone is enough.
- **Level 1, tokens:** set `--bridge-primary`, `--bridge-border-radius` and friends on `:root`. Reason: tokens are the supported contract; ordinary CSS already wins over Bridge's defaults, so there is never a need for `!important`.
- **Level 2, frame and heading:** pass the `frame` and `heading` snippets to the sign-in routes component. Reason: it changes every page at once and keeps each page's own sub-steps.
- **Level 3, take over one page:** create that page's own route file (e.g. `src/routes/auth/login/+page.svelte`); every other page keeps working.
- **Level 4, headless:** build everything on `getBridgeAuth()`. Only when the developer asks for it.
- **Never copy Bridge's components into the app to restyle them.** Reason: the copy stops receiving fixes.
- **When both hosted pages and in-app pages are used, give them the same colours.** Reason: a person moving between them should not notice.
- **A new sender address must be confirmed.** Bridge emails that address a link; until it is clicked, mail keeps coming from Bridge's default sender. Tell the developer to look for it.

## Do it

| Step | MCP | CLI |
|---|---|---|
| Hosted-page colours, font, corners | `update_branding` | `bridge branding update --primary-btn-bg '#1a1a2e' --font-family Inter` |
| Name users see | `update_app` (`name`) | `bridge app update --name "Acme"` |
| Email sender | `setup_communication` | `bridge setup communication --from-address no-reply@acme.com --from-name Acme` |
| In-app pages, tokens, snippets | `get_integration_guide` (topic `branding`, then `auth`) | `bridge guide svelte branding`, `bridge guide mechanisms` |

## Prove it

1. Open the sign-in page and the subscription page in the running app (or the hosted page): colours and font match what the developer gave.
2. Trigger a password reset for a test user: the email arrives from the agreed sender, in the app's name, and its link opens the app, not a Bridge page.

## Where this connects

- **Login:** hosted or in-app sign-in is the same switch.
- **Payments:** the subscription and plan-choice pages use the same tokens.
- **Going live:** a verified sender address before real users arrive.
