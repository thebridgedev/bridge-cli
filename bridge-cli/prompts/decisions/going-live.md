# Going live — decision guide

Everything between "it works on my machine" and real users signing up and paying. Bridge keeps a readiness checklist for each app; this guide is how to work through it with the developer.

> Other decision guides: `bridge guide decision <name>` (MCP: resource `bridge://guides/decisions/<name>`). How the pieces work underneath: `bridge guide mechanisms`.

## Start from the checklist

`get_setup_status` / `bridge setup status` lists every item (redirect URIs, default callback, allowed origins, UI URL, sign-in methods and provider credentials, email sender, Stripe, plans, first real sign-in) as configured, missing or needing attention, each with its next step. Its `productionNeeds` is what must still change before real users arrive: localhost addresses, test Stripe keys, an unconfirmed sender. Work from that list, not from memory.

`list_apps` shows which apps this connection can reach. `diagnose_integration` / `bridge diagnose` compares the project's env files with the app they point at.

## Ask the developer

Product questions. Ask, wait, never guess.

1. **Is the app you have been building with already serving real users?** If yes, it is the production app. If no, see "a separate production app" below.
2. **What is the production address of the frontend** (and of the backend, if it calls Bridge)?
3. **For each social sign-in provider: the production client id and secret,** if they use a different provider app in production.
4. **The live Stripe keys** (`sk_live_…`, `pk_live_…`), from the Stripe account that should receive the money. Never invent, guess or reuse a key.
5. **Which address and name should emails come from** in production?

## Decide yourself

- **A separate Bridge app for production** when the current one has no real users. Reason: test users, test Stripe keys and localhost addresses stay out of production, and nothing in development can touch a real customer. Create it with `create_app`; it does not become the default, so pass its id as `app` or call `use_app`. Copy flags across with `export_feature_flags` then `import_feature_flags`, and recreate each plan with `apply_plan`.
- **Production env files carry the production app id and no base URL.** Reason: an unset base URL means Bridge's production API; a leftover stage or local base URL sends a production app id to the wrong place, and sign-in fails.
- **Add production addresses; remove localhost ones only from the production app.** Reason: removing them from the development app breaks local work.
- **Add redirect URIs one at a time and send allowed origins as a full list** (read first). Reason: the first keeps the list; the second replaces it.
- **Register the production callback in every social provider's console** (`setup_sso` returns it). Reason: providers refuse callbacks they do not know.
- **Never put a secret key in a browser variable** (`VITE_*`, `NEXT_PUBLIC_*`). Reason: everything in those ships to every visitor. `diagnose_integration` flags it.
- **A test user on a production app needs the developer's say-so.** Reason: it creates a workspace in the app real users share; the tool refuses without confirmation.

## Do it

| Step | MCP | CLI |
|---|---|---|
| Readiness checklist | `get_setup_status` | `bridge setup status` |
| Check a project's env files | `diagnose_integration` | `bridge diagnose` |
| Create a production app | `create_app`, then `use_app` | — (create it in the dashboard, then `bridge auth login --app <id>`) |
| Production URL, default callback, allowed origins | `update_app` | `bridge app update --ui-url … --default-callback-uri … --allowed-origins …` |
| Production callback URL | `add_redirect_uri` | `bridge app redirect-uris add <url>` |
| Live Stripe keys | `setup_payments` | `bridge setup payments --stripe-key sk_live_… --stripe-public-key pk_live_…` |
| Email sender | `setup_communication` | `bridge setup communication --from-address … --from-name …` |
| Copy flags | `export_feature_flags`, `import_feature_flags` | `bridge flag export --out flags.json`, `bridge flag import flags.json` |
| Copy a plan | `apply_plan` | `bridge plan apply --spec @plan.json` |

## Prove it

1. `get_setup_status` / `bridge setup status` again: show the developer what is left. Nothing in `productionNeeds` should be a surprise to them.
2. With the developer's agreement, `create_test_user` then `verify_login` (`bridge test-user create --confirm "<app name>"`, then `bridge test-user verify`) against the production app: a real sign-in from the production origin.
3. `get_stripe_status` / `bridge stripe status`: live keys, webhook working.
4. The first real sign-in appears on the checklist once someone signs up.

## Where this connects

- **Login:** redirect URIs, origins and provider credentials.
- **Payments:** live keys, and plans on the production app.
- **Feature control:** flags are per app.
- **Look and feel:** a confirmed sender address.
