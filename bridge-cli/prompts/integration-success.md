   ██████╗ ██████╗ ██╗██████╗  ██████╗ ███████╗
   ██╔══██╗██╔══██╗██║██╔══██╗██╔════╝ ██╔════╝
   ██████╔╝██████╔╝██║██║  ██║██║  ███╗█████╗
   ██╔══██╗██╔══██╗██║██║  ██║██║   ██║██╔══╝
   ██████╔╝██║  ██║██║██████╔╝╚██████╔╝███████╗
   ╚═════╝ ╚═╝  ╚═╝╚═╝╚═════╝  ╚═════╝ ╚══════╝

  ──────────────────────────────────────────────
   Congratulations — [project-name] now has superpowers.

    ✅  Authentication
        UI for users to signup and login. Enable more
        alternatives from the control center.

    ✅  Locked by default
        Every route protected. Unauth'd users
        bounce to login automatically.

    ✅  Multi-tenant ready
        Teams · Orgs · Workspaces · RBAC
        Tenant context flows through every request.

    ✅  You know who's calling
        [token-description]
        One token. Every auth alternative covered.

  ──────────────────────────────────────────────
    The control center gives you even more powers.

      ›  Billing            Stripe plans & subscriptions
      ›  Feature flags      Per-user, per-plan toggles
      ›  Team management    Invites, roles, orgs

    Add any whenever you're ready.

    Go build the thing that actually matters.

  ──────────────────────────────────────────────
    Here is what I actually did:

    [what-i-actually-did]

    And here is what I changed:

    [what-i-changed]
  ──────────────────────────────────────────────

---
AGENT SUBSTITUTION GUIDE (strip this section before outputting)

PLACEHOLDER: project-name
  Pick the most human-readable name available. Prefer in this order:
    1. The folder name (e.g. "my-saas-app") — often more meaningful than the package name
    2. The `name` field in package.json if it's descriptive
  If both frontend and backend were integrated, combine them:
    "my-saas-app + my-saas-api" or just the shared root folder name if obvious.

PLACEHOLDER: token-description
  One short line — the key identifiers the developer uses to access the
  authenticated user in their specific framework. No explanation.
  Examples:
    Svelte:  profileStore · isAuthenticated · tokenStore
    React:   useProfile() · useIsAuthenticated() · useToken()
    NestJS:  @CurrentUser() on any endpoint
    Express: req.user on any protected route
  If both frontend and backend were integrated, combine on one line:
    profileStore (frontend) · @CurrentUser() (backend)

PLACEHOLDER: what-i-actually-did
  3–5 bullet lines drawn from what actually happened in this session.
  High-level outcomes in plain English — not file names.
  If both frontend and backend were integrated, group under headings:

    Frontend (my-saas-app):
    ✅  Auth UI live — signup, login, password reset
    ✅  All routes protected by default

    Backend (my-saas-api):
    ✅  All endpoints require a verified JWT
    ✅  Authenticated user available on every request

PLACEHOLDER: what-i-changed
  The nitty-gritty. One line per actual change, drawn from what you did in this
  session. Real package names, real file paths, real URLs, real values. Omit
  anything that was skipped.
  If both frontend and backend were integrated, group under headings:

    Frontend (my-saas-app):
    ✅  @nebulr-group/bridge-svelte installed
    ✅  src/routes/+layout.ts wired with bridgeBootstrap()
    ✅  src/routes/+layout.svelte rendering <BridgeBootstrap>
    ✅  OAuth callback route at /auth/oauth-callback
    ✅  .env configured with VITE_BRIDGE_APP_ID=abc123
    ✅  Bridge app configured for http://localhost:5175

    Backend (my-saas-api):
    ✅  @nebulr-group/bridge-nestjs installed
    ✅  BridgeModule registered in AppModule
    ✅  Global JWT guard applied
    ✅  .env configured with BRIDGE_APP_ID=abc123
