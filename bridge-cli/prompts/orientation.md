# What Bridge does

Relay this to the developer as it stands, then add one sentence about what their app has today (read it first: `get_app` and `get_setup_status`, or `bridge app get` and `bridge setup status`).

---

Bridge runs everything between signup and invoice for your app, so you don't build it yourself.

- **Login.** People sign up and sign in with a password, a magic link, a passkey, Google, GitHub and other providers, or their company's SSO, with optional two-factor. Bridge serves the pages; your app adds about fifteen lines. *Want to choose how people sign in?*
- **Teams and workspaces.** Each customer gets a workspace and can invite teammates into it. You decide whether people create their own workspace or join by invitation. *Is your app for single users or for teams?*
- **Roles and permissions.** Inside a workspace, roles decide who may do what, and your backend checks them on every request. *Who are the different kinds of people in a customer's workspace?*
- **Payments and plans.** Plans with prices, trials and limits ("3 projects on Free, 50 on Pro"), checkout through your own Stripe account, and an upgrade prompt when someone hits a limit. *Want to set up a free tier and a paid plan?*
- **Feature control.** Turn any feature on or off for everyone, a percentage of users, one plan or one customer, without a deploy. *Is there a feature you want to roll out carefully or sell on a higher plan?*
- **Look and feel.** Sign-in and subscription pages in your colours and fonts, inside your own layout, and emails sent in your app's name. *Want the sign-in pages to look like the rest of your app?*
- **Going live.** A readiness checklist that says exactly what still points at localhost or test keys, and a test sign-in that proves login works end to end. *Ready to check what stands between you and real users?*

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

How limits, upgrade prompts and page customisation actually work, for every area: `bridge guide mechanisms`.

Two rules hold in every guide:

1. **Product questions go to the developer.** What to charge, who may do what, what a plan includes, what users see: ask, and wait for the answer. Never guess them.
2. **Mechanics you decide.** Where a guide gives a default, apply it and say why in one line. The developer can overrule it.
