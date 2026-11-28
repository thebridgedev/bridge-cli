# What Bridge does

Relay this to the developer as it stands, then add one sentence about what their app has today (read it first: `get_app` and `get_setup_status`, or `bridge app get` and `bridge setup status`).

---

Bridge runs everything between signup and invoice for your app, so you don't build it yourself.

- **Login.** People sign up and sign in with a password, a sign-in link by email, a passkey, or social providers, with an optional second step. The sign-in pages run inside your app; it adds a handful of lines. *Want to choose how people sign in?*
- **Teams and workspaces.** Each customer gets a workspace and can invite teammates into it, each with a role. *Is your app for single users or for teams?*
- **Roles and permissions.** Inside a workspace, each person's role carries privileges, and feature flags use them to decide who gets which page, endpoint or feature, the same in the browser and on your server. *Who are the different kinds of people in a customer's workspace?*
- **Payments and plans.** Plans with prices, trials, limits ("3 projects on Free, 50 on Pro") and the features each one sells, checkout through your own Stripe account, and an upgrade prompt when someone hits a limit or a feature their plan lacks. *Want to set up a free tier and a paid plan?*
- **Feature control.** Feature flags switch any page, API endpoint or feature for everyone, a share of people, the plans that sell it, the people allowed to use it, or one customer, without a deploy. *Is there a feature you want to roll out carefully or sell on a higher plan?*
- **Look and feel.** Sign-in and subscription pages in your colours and fonts, inside your own layout, and emails sent in your app's name. *Want the sign-in pages to look like the rest of your app?*
- **Going live.** A readiness checklist that says exactly what still points at localhost or test keys. *Ready to check what stands between you and real users?*

This is the new Bridge. Apps use its 1.0 plugins, installed from the `alpha` tag: `@nebulr-group/bridge-svelte` (SvelteKit), `@nebulr-group/bridge-nestjs` (NestJS) and `@nebulr-group/bridge-auth-core` (any other JavaScript app). Each needs one setting, the app's issuer. React, Next.js, Angular and Express have no 1.0 plugin yet.

---

## Where to go next

Each area has a decision guide: the questions to ask the developer, and the defaults to apply without asking.

| Area | Decision guide | Journey |
|---|---|---|
| Login | `bridge guide decision login` | `bridge guide add-login` |
| Teams and workspaces | `bridge guide decision teams` | `bridge guide add-teams` |
| Roles and permissions | `bridge guide decision roles` | — |
| Payments and plans | `bridge guide decision payments` | `bridge guide add-paid-plan` |
| Feature control | `bridge guide decision feature-control` | `bridge guide add-feature-flag` |
| Look and feel | `bridge guide decision look-and-feel` | — |
| Going live | `bridge guide decision going-live` | `bridge guide go-live` |

In an MCP client the same guides are the resources `bridge://guides/decisions/<area>` (areas: `login`, `teams`, `roles`, `payments`, `feature-control`, `look-and-feel`, `going-live`), and the journeys are the server's prompts of the same names.

How roles, plans, limits and flags fit together, the rule every decision guide builds on: `bridge guide fit-together` (MCP: resource `bridge://guides/fit-together`). Read it before setting up any of them.

How limits, upgrade prompts and page customisation actually work, for every area: `bridge guide mechanisms`.

Two rules hold in every guide:

1. **Product questions go to the developer.** What to charge, who may do what, what a plan includes, what users see: ask, and wait for the answer. Never guess them.
2. **Mechanics you decide.** Where a guide gives a default, apply it and say why in one line. The developer can overrule it.
