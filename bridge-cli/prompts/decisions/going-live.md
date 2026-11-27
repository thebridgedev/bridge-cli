# Going live — decision guide

Everything between "it works on my machine" and real users signing up and paying. Bridge keeps a readiness checklist for each app; this guide is how to work through it with the developer.

> How roles, plans, limits and flags fit together: `bridge guide fit-together` (MCP: resource `bridge://guides/fit-together`). Other decision guides: `bridge guide decision <name>` (MCP: resource `bridge://guides/decisions/<name>`). How the pieces work underneath: `bridge guide mechanisms`.

## Start from the checklist

`get_setup_status` / `bridge setup status` lists every item (the app's addresses, sign-in methods, the email sender, Stripe, plans, the first real sign-in) as configured, missing or needing attention, each with its next step. Its `productionNeeds` is what must still change before real users arrive: localhost addresses, test Stripe keys, an unconfirmed sender. Work from that list, not from memory.

`list_apps` / `bridge app list` shows which apps the developer has. `diagnose_integration` / `bridge doctor` compares the project's settings with the app they point at.

## Ask the developer

Product questions. Ask, wait, never guess.

1. **Is the app you have been building with already serving real users?** If yes, it is the production app. If no, see "a separate production app" below.
2. **What is the production address of the frontend** (and of the backend)?
3. **For each social sign-in provider: the production client id and secret,** if they use a different provider app in production. They are saved in the dashboard.
4. **The live Stripe keys** (`sk_live_…`, `pk_live_…`), from the Stripe account that should receive the money. Never invent, guess or reuse a key.
5. **Which address and name should emails come from** in production?

**Only changed when you pass them.** No tool sets these on its own; left out, the current value stays: `update_app` (`uiUrl`, `allowedOrigins`) · `setup_communication` (`fromAddress`, `fromName`).

## Decide yourself

- **A separate Bridge app for production** when the current one has no real users. Reason: test users, test Stripe keys and localhost addresses stay out of production. Create it with `bridge app create --name <name> --browser-origin <url> --email-links <url>/auth` (MCP: `create_app`, then `use_app`). Copy flags across with `bridge flag export` then `bridge flag import`, and recreate each plan with `bridge plan apply`.
- **Production settings carry the production app's issuer.** Reason: the issuer names the app; a leftover development issuer sends production sign-ins to the wrong app. `bridge doctor` names it.
- **Add production addresses; remove localhost ones only from the production app.** Reason: removing them from the development app breaks local work.
- **Add addresses one at a time** (`bridge app address add`). Through the MCP, `update_app` `allowedOrigins` replaces the whole list: read it first.
- **The server's app key is the production app's own** (`bridge key create --name "production server"`, shown once). Reason: a key acts for one app only, and never belongs in a browser bundle (`PUBLIC_*`, `VITE_*`).
- **Register the production return address in every social provider's console.** Reason: providers refuse returns they do not know.

## Do it

| Step | MCP | CLI |
|---|---|---|
| Readiness checklist | `get_setup_status` | `bridge setup status` |
| Check a project's settings | `diagnose_integration` | `bridge doctor` |
| Create a production app | `create_app`, then `use_app` | `bridge app create --name <name>` (it becomes the app commands act on) |
| Production addresses | `update_app` | `bridge app address add https://app.example.com --use browser-origin`, `bridge app address add https://app.example.com/auth --use email-links` |
| A key for the production server | — (keys are made by people) | `bridge key create --name "production server"` |
| Live Stripe keys | `setup_payments` | `bridge stripe connect --live --publishable-key pk_live_…` |
| Email sender | `setup_communication` | `bridge setup communication --from-address … --from-name …` |
| Copy flags | `export_feature_flags`, `import_feature_flags` | `bridge flag export --out flags.json`, `bridge flag import flags.json` |
| Copy a plan | `apply_plan` | `bridge plan apply plan.json` |

## Prove it

1. `get_setup_status` / `bridge setup status` again: show the developer what is left. Nothing in `productionNeeds` should be a surprise to them.
2. Ask the developer to sign up and sign in themselves on the production address. If it fails, `debug_auth_issue` / `bridge event auth-attempts --user <their email>` names the reason.
3. `get_stripe_status` / `bridge stripe status`: live keys connected.
4. The first real sign-in appears on the checklist once someone signs up.

## Where this connects

- **Login:** addresses and provider credentials.
- **Payments:** live keys, and plans on the production app.
- **Feature control:** flags are per app.
- **Look and feel:** a confirmed sender address.
