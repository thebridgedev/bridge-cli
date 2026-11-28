# Look and feel — decision guide

How Bridge's pages and emails look to the developer's users: the sign-in pages, the subscription pages, the team panel, and the emails Bridge sends in the app's name.

> How roles, plans, limits and flags fit together: `bridge guide fit-together` (MCP: resource `bridge://guides/fit-together`). Other decision guides: `bridge guide decision <name>` (MCP: resource `bridge://guides/decisions/<name>`). The SvelteKit look guide, with every design token: `bridge guide svelte branding`; the customisation rungs: `bridge guide mechanisms`.

## Where the pages live

With bridge-svelte 1.0, the sign-in, subscription and team pages render inside the developer's own layout, on their address. They are styled with the plugin's design tokens (`--bridge-*` CSS variables) set in the app's own stylesheet, taken from the app's existing design. The tokens are defined in `@nebulr-group/bridge-svelte/styles`; only those names exist, and `bridge guide svelte branding` lists them. (If the developer explicitly asks for Bridge's hosted sign-in page, respect that: that page is styled with the app's branding stored in Bridge, `update_branding` / `bridge branding update`. Give it the app's colours.)

**The pages Bridge adds must look like the developer's app, not like Bridge.** The plugin's built-in look (indigo buttons, grey borders) is a fallback for an app with no design of its own, never the finished result.

## Start from what is there

Read the app's own design first: it is in the project, not in Bridge.

| Read | Where |
|---|---|
| Colours, corners, spacing | The global stylesheet and its CSS variables (`:root { --primary: … }`), the Tailwind theme (`@theme` in the CSS, or `tailwind.config.*`), or the component library's tokens (shadcn-svelte, Skeleton, Flowbite, …) |
| Font | The font the app loads (`<link>` in `app.html`, `@font-face`, the `font-family` on `body`) |
| Buttons and inputs | An existing primary button and text input: background, text colour, border, corners, focus ring, weight, shadow |
| Page shell | How the app frames a page: a centred card, a max width, a header and footer, a background colour, dark mode |

| Read | MCP | CLI |
|---|---|---|
| App name, and the email sender | `get_app` | `bridge app get` |

## Ask the developer

Product questions. Ask, wait, never guess.

1. **Only when the project has no styles of its own:** what are the brand colours and font? Ask for exact values; do not pick colours for them. When the app has a design, take it from the code and do not ask.
2. **What name should users see** on sign-in pages and in emails?
3. **Which address and sender name should emails come from?** (Sign-up links, password resets, sign-in links, invites.)
4. **Beyond matching the app, should sign-in pages say anything of their own?** A different heading, or a page they design themselves.

## Decide yourself

Match the app's design without asking, and say which rung you stopped at.

- **Rung 0, layout:** the pages already sit inside the app's layout, in its font, text size and text colour. Never the stopping point on its own: the form inside still wears Bridge's colours.
- **Rung 1, tokens, always:** map the app's design onto the `--bridge-*` tokens in the app's own stylesheet: its primary colour to `--bridge-primary` (and `--bridge-primary-hover`, `--bridge-primary-fg`), its border colour to `--bridge-border`, its corner radius to `--bridge-border-radius`, its focus ring to `--bridge-input-focus`, its text and muted text to `--bridge-foreground` / `--bridge-muted`, its surfaces to `--bridge-bg` / `--bridge-muted-bg` / `--bridge-card-bg`, its error, success, info and warning colours to the `--bridge-alert-*` tokens, and, when the app has a type style of its own, its weights to `--bridge-font-weight-heading` / `--bridge-font-weight-button` / `--bridge-font-weight-label` and its shadows to `--bridge-button-shadow` / `--bridge-card-shadow`. Reference the app's own variables (`--bridge-primary: var(--primary)`) rather than copying values, so a later theme change carries over, dark mode included. Set a font (`--bridge-font-family`) only if the app puts it on something other than `body`. For anything the tokens don't cover, write plain CSS against Bridge's classes and `[data-bridge-*]` attributes, outside any `@layer`. Reason: the tokens are the supported contract, and Bridge's styles sit in a cascade layer named `bridge`, so plain app CSS always wins without `!important`. Tailwind utility classes on Bridge's elements lose where Bridge sets the same property; use plain CSS there.
- **Rung 2, frame and heading, when the app has a page shell:** if the app's own pages sit in a card, a panel or a two-column layout, pass the `frame` snippet so sign-in sits in the same one, using the app's own classes or components. Reason: it changes every page at once.
- **Rung 3, your own page; rung 4, headless:** only when the developer asks for it.
- **Never copy Bridge's components into the app to restyle them.** Reason: the copy stops receiving fixes.
- **An app with no styling of its own keeps Bridge's defaults,** and you say so in one line.
- **The developer asks for Bridge's default look:** leave the tokens alone.
- **A new sender address must be confirmed.** Bridge emails that address a link; until it is clicked, mail keeps coming from Bridge's default sender. Tell the developer to look for it.

## Do it

| Step | MCP | CLI |
|---|---|---|
| Name users see | `update_app` (`name`) | `bridge app update --name "Acme"` |
| Email sender | `setup_communication` | `bridge setup communication --from-address no-reply@acme.com --from-name Acme` |
| The tokens, the frame, every token's name | `get_integration_guide` (topic `branding`, framework `svelte`) | `bridge guide svelte branding` |
| The hosted page, only when asked for | `update_branding` | `bridge branding update --primary-btn-bg … --font-family … --border-radius …` |

## Prove it

1. Open the sign-in page, the subscription page and the team page in the running app next to one of the app's own pages: buttons, inputs, font, corners and the page frame match, in light and dark mode if the app has both. No Bridge indigo is left. This is a browser check: without a browser tool, list it for the developer and start the summary with "Heads up: not verified in a browser".
2. Ask the developer to trigger a password reset for their own account: the email arrives from the agreed sender, in the app's name, and its link opens the app.

## Where this connects

- **Login:** the sign-in pages this guide styles.
- **Payments:** the subscription and plan pages use the same tokens.
- **Going live:** a confirmed sender address before real users arrive.
