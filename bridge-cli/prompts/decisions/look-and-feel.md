# Look and feel — decision guide

How Bridge's pages and emails look to the developer's users: the sign-in pages, the subscription pages, and the emails Bridge sends in the app's name.

> How roles, plans, limits and flags fit together: `bridge guide fit-together` (MCP: resource `bridge://guides/fit-together`). Other decision guides: `bridge guide decision <name>` (MCP: resource `bridge://guides/decisions/<name>`). The customisation levels in full, with every design token: `bridge guide mechanisms`.

## Two places pages can live

- **In the app (the default):** the pages render inside the developer's own layout, on their address. Styled with CSS design tokens (`--bridge-*`) in the app's own stylesheet, taken from the app's existing design.
- **Hosted (only when the developer asks for it):** Bridge serves sign-in on its own address. Styled with the app's **branding** (colours, font, corner radius), which Bridge stores.

Both use the same single route file; one setting switches sign-in into the app (`loginRoute: '/auth/login'` in SvelteKit's `bridgeBootstrap()`). Subscription pages always render in the app.

**The pages Bridge adds must look like the developer's app, not like Bridge.** Bridge's built-in look (indigo buttons, grey borders, system font) is a fallback for an app with no design of its own, never the finished result.

## Start from what is there

Read the app's own design first: it is in the project, not in Bridge.

| Read | Where |
|---|---|
| Colours, radius, spacing | The global stylesheet and its CSS variables (`:root { --primary: … }`), `tailwind.config.*` / the Tailwind `@theme` block, or the component library's theme (shadcn, MUI, Angular Material, Chakra, …) |
| Font | The font the app loads (`<link>` in the HTML shell, `@font-face`, `next/font`, the `font-family` on `body`) |
| Buttons and inputs | An existing primary button and text input: background, text colour, border, radius, focus ring, height |
| Page shell | How the app frames a page: a centred card, a max width, a header and footer, a background colour, dark mode |

| Read | MCP | CLI |
|---|---|---|
| Hosted-page branding | `get_branding` | `bridge branding get` |
| App name, and the email sender | `get_app` | `bridge app get` |

## Ask the developer

Product questions. Ask, wait, never guess.

1. **Only when the project has no styles of its own:** what are the brand colours and font? Ask for exact values; do not pick colours for them. When the app has a design, take it from the code and do not ask.
2. **What name should users see** on sign-in pages and in emails?
3. **Which address and sender name should emails come from?** (Invitations, password resets, magic links.)
4. **Beyond matching the app, should sign-in pages say anything of their own?** A different heading, or a page they design themselves.

**Only changed when you pass them.** No tool sets these on its own; left out, the current value stays: `update_branding` (`bgColor`, `textColor`, `linkColor`, `primaryButtonBgColor`, `primaryButtonTextColor`, `fontFamily`, `borderRadius`).

## Decide yourself

Sign-in is in the app unless the developer asked for hosted. Match the app's design without asking, and say which level you stopped at.

- **Level 0, layout:** in-app pages already sit inside the app's layout, so its header and navigation surround them. Never the stopping point on its own: the form inside still wears Bridge's colours.
- **Level 1, tokens — always:** map the app's design onto the `--bridge-*` tokens in the app's own stylesheet: its primary colour and hover to `--bridge-primary` / `--bridge-primary-hover` / `--bridge-primary-fg`, its border colour to `--bridge-border`, its corner radius to `--bridge-border-radius`, its focus ring to `--bridge-input-focus`, its text and muted text to `--bridge-foreground` / `--bridge-muted`, its surfaces to `--bridge-bg` / `--bridge-muted-bg`, its error and success colours to the alert tokens. Reference the app's own variables (`--bridge-primary: var(--primary)`) rather than copying values, so a later theme change carries over, dark mode included. The components inherit the page font, so set nothing for it unless the app sets its font on something other than `body`. Reason: tokens are the supported contract; ordinary CSS already wins over Bridge's defaults, so there is never a need for `!important`.
- **Level 2, frame and heading — when the app has a page shell:** if the app's own pages sit in a card, a panel or a two-column layout, pass the `frame` snippet so sign-in sits in the same one, using the app's own classes or components. Reason: it changes every page at once and keeps each page's own sub-steps.
- **Level 3, take over one page:** create that page's own route file (e.g. `src/routes/auth/login/+page.svelte`); every other page keeps working.
- **Level 4, headless:** build everything on `getBridgeAuth()`. Only when the developer asks for it.
- **Never copy Bridge's components into the app to restyle them.** Reason: the copy stops receiving fixes.
- **When the developer asked for hosted pages, or uses both, give the hosted branding the same colours as the app** (`update_branding`). Reason: a person moving between them should not notice.
- **A new sender address must be confirmed.** Bridge emails that address a link; until it is clicked, mail keeps coming from Bridge's default sender. Tell the developer to look for it.

## Do it

| Step | MCP | CLI |
|---|---|---|
| Hosted-page colours, font, corners | `update_branding` | `bridge branding update --primary-btn-bg '#1a1a2e' --font-family Inter` |
| Name users see | `update_app` (`name`) | `bridge app update --name "Acme"` |
| Email sender | `setup_communication` | `bridge setup communication --from-address no-reply@acme.com --from-name Acme` |
| In-app pages, tokens, snippets | `get_integration_guide` (topic `branding`, then `auth`) | `bridge guide svelte branding`, `bridge guide mechanisms` |

## Prove it

1. Open the sign-in page and the subscription page in the running app next to one of the app's own pages: buttons, inputs, font, corners and the page frame match, in light and dark mode if the app has both. No Bridge indigo is left.
2. Trigger a password reset for a test user: the email arrives from the agreed sender, in the app's name, and its link opens the app, not a Bridge page.

## Where this connects

- **Login:** sign-in is in-app by default; hosted is the same switch, used only on request.
- **Payments:** the subscription and plan-choice pages use the same tokens.
- **Going live:** a verified sender address before real users arrive.
