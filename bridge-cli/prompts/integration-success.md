   ██████╗ ██████╗ ██╗██████╗  ██████╗ ███████╗
   ██╔══██╗██╔══██╗██║██╔══██╗██╔════╝ ██╔════╝
   ██████╔╝██████╔╝██║██║  ██║██║  ███╗█████╗
   ██╔══██╗██╔══██╗██║██║  ██║██║   ██║██╔══╝
   ██████╔╝██║  ██║██║██████╔╝╚██████╔╝███████╗
   ╚═════╝ ╚═╝  ╚═╝╚═╝╚═════╝  ╚═════╝ ╚══════╝

  ──────────────────────────────────────────────
   Congratulations! [project-name] now has superpowers.

    ✅  Authentication
        Sign-in and signup pages for your users. Turn on
        more ways to sign in from the Control Center.

    ✅  Locked by default
        Every route protected. Signed-out users
        go to the sign-in page automatically.

    ✅  Multi-tenant ready
        Teams · Orgs · Workspaces · RBAC
        Workspace context flows through every request.

    ✅  You know who's calling
        [token-description]
        One token. Every way to sign in covered.

  ──────────────────────────────────────────────
    The Control Center gives you even more powers.

      ›  Billing            Stripe plans & subscriptions    →  bridge guide [framework] billing
      ›  Feature flags      Per-user, per-plan toggles      →  bridge guide flags
      ›  Team management    Invites, roles, orgs            →  bridge guide [framework] team

    Run any of those when you're ready.

    Go build the thing that actually matters.

  ──────────────────────────────────────────────
    Here is what I actually did:

    [what-i-actually-did]

    Bridge's footprint in your code:

    [footprint]

    [see-every-change]

    And here is what I changed:

    [what-i-changed]
  ──────────────────────────────────────────────

---
AGENT SUBSTITUTION GUIDE (strip this section before outputting)

No em dashes (—) anywhere in the text you output. Use a colon, a comma or a
period instead. In prose say "sign in" and "signup" (not "login"),
"Control Center", "workspace" (not "tenant") and "app" (not "application").

PLACEHOLDER: project-name
  Pick the most human-readable name available. Prefer in this order:
    1. The folder name (e.g. "my-saas-app"), often more meaningful than the package name
    2. The `name` field in package.json if it's descriptive
  If both frontend and backend were integrated, combine them:
    "my-saas-app + my-saas-api" or just the shared root folder name if obvious.

PLACEHOLDER: framework
  In the Control Center next-steps lines, replace `[framework]` with the
  framework slug used by `bridge guide` (`svelte`, `react`, `nextjs`, `angular`,
  `nestjs`, `express`). Use the frontend framework when both frontend and
  backend were integrated. Leave `bridge guide flags` unchanged: that command
  auto-detects the framework from `package.json`.

PLACEHOLDER: token-description
  One short line: the key identifiers the developer uses to access the
  signed-in user in their specific framework. No explanation.
  Examples:
    Svelte:  profileStore · isAuthenticated · tokenStore
    React:   useProfile() · useIsAuthenticated() · useToken()
    NestJS:  @CurrentUser() on any endpoint
    Express: req.user on any protected route
  If both frontend and backend were integrated, combine on one line:
    profileStore (frontend) · @CurrentUser() (backend)

PLACEHOLDER: what-i-actually-did
  3–5 bullet lines drawn from what actually happened in this session.
  High-level outcomes in plain English, not file names.
  If both frontend and backend were integrated, group under headings:

    Frontend (my-saas-app):
    ✅  Sign-in pages live: signup, sign in, password reset
    ✅  All routes protected by default

    Backend (my-saas-api):
    ✅  All endpoints require a verified JWT
    ✅  Signed-in user available on every request

HOW TO COUNT THE FOOTPRINT (used by footprint, see-every-change, what-i-changed)
  - Count only the changes YOU made in this session, from your own record of
    each edit. Never estimate, and never count from `git diff` alone: the tree
    may hold the developer's own work, and `git diff` does not show new
    (untracked) files at all.
  - The unit is a CHANGE, not a line. One change is one logical unit: an
    import, a wrapper, a guard, a hook call, a handler or a button with its
    handler, a component placed, an env var, a dependency, a config entry, a
    route, a decorator or a module registration. An 8-line handler is one
    change; a 3-name import statement is one import.
  - "Imports or config" = imports, env vars, dependencies and config entries.
  - Source files = the code files you created or modified. Env files,
    package.json and lockfiles are config: they appear as env vars and
    dependencies, not as source files. Stylesheets are styling, never code.
  - New files are part of the footprint: count each one as touched and as new.
  - Bridge app settings you changed through the CLI or MCP (callback URL,
    allowed origins, redirect URIs, plans, flags) are listed in what-i-changed
    but are NOT code changes and are not counted.
  - Nothing changed this session (Bridge was already fully integrated): the
    footprint is the single line "Nothing changed this session: Bridge was
    already wired in." Drop see-every-change, and what-i-changed lists only
    the Bridge app settings you changed, or "Nothing to change."

PLACEHOLDER: footprint
  Two to four short lines, in this order:

  1. Size, one line:
       3 source files touched, 1 new · 11 changes, 7 of them imports or config
     Leave out ", 1 new" when no file is new. Use "1 source file" in the
     singular. Frontend and backend both integrated: one line per side,
     headed like the other sections:
       Frontend (my-saas-app): 3 source files touched, 1 new · 8 changes, 5 of them imports or config
       Backend (my-saas-api): 1 source file touched · 4 changes, 3 of them imports or config

  2. Existing logic, one line. Only when it is TRUE that you added code and
     changed none of the developer's existing statements, write:
       None of your existing logic changed: only additions, plus <body> wrapped.
     naming the one wrapping you did (`<body>`, the app, the root layout), or
     ending at "only additions." when you wrapped nothing. If you modified or
     removed any of their code, say what instead, plainly:
       2 of your lines changed: the old login check in app/page.tsx, now a Bridge guard.

  3. Styling, one or two lines, kept apart from code. Count CSS in lines.
     Only `--bridge-*` tokens mapped to the app's colors:
       Styling: 16 lines map Bridge to your colors.
     Tokens plus more styling to match the app:
       Styling is optional: 16 lines map Bridge to your colors, and 46 more
       copy your app's borders and shadows.
     No styling: leave the styling line out.

PLACEHOLDER: see-every-change
  One line (two at most), chosen from the `git status` you ran in each project
  BEFORE your first edit. Never run `git init`, `git add` or `git commit` for
  the developer, and do not ask them about git.
  - Git repo, clean before you started, no new files:
      See every change: git diff
  - Git repo, clean before you started, you created files (`git diff` does
    not show new files; `git status` lists them):
      See every change: git status, then git diff
  - Git repo, the developer already had uncommitted changes: point only at
    the files you touched, and name new files on their own line:
      See every change: git diff -- app/layout.tsx app/page.tsx
      New files: app/auth/[...bridge]/page.tsx
    If one of those files already had the developer's own uncommitted edits,
    add "(also shows your earlier edits)" after the command.
  - Not a git repo, or a repo with no commits yet:
      Tip: commit before your next integration and git diff shows the whole footprint.
  Frontend and backend in separate repos in different states: one line per
  side, starting "Frontend:" / "Backend:". Files ignored by git (often
  `.env.local`) never show in git; they are listed in what-i-changed anyway.

PLACEHOLDER: what-i-changed
  The nitty-gritty. One line per file (or per small group of config files),
  drawn from what you did in this session. Real file paths, real package
  names, real URLs, real values. Omit anything that was skipped.
  End each line with its size in changes, in parentheses, lined up in one
  column where the width allows:
    - the changes in that file, using the units above: (1 import, 1 wrapper)
    - a file you created starts with "new: ": (new: 1 import, 1 component)
    - a stylesheet: (styling only)
    - a Bridge app setting: (app setting, not code)
  The sizes must add up to the totals in the footprint.
  Example (Next.js):

    ✅  app/layout.tsx: <BridgeProvider> around the app       (1 import, 1 wrapper)
    ✅  app/auth/[...bridge]/page.tsx: every sign-in page      (new: 1 import, 1 component)
    ✅  app/page.tsx: studio needs sign-in, Sign out button    (2 imports, 1 guard, 1 button)
    ✅  .env.local, package.json                               (2 env vars, 1 dependency)
    ✅  app/globals.css                                        (styling only)
    ✅  Bridge app: http://localhost:3000 as callback + origin (app setting, not code)

  If both frontend and backend were integrated, group under headings:

    Frontend (my-saas-app):
    ✅  src/routes/+layout.ts: bridgeBootstrap({ rules }) as the load      (1 import, 1 hook call)
    ✅  src/routes/+layout.svelte: app wrapped in <BridgeBootstrap>         (1 import, 1 wrapper)
    ✅  src/routes/auth/[...bridge]/+page.svelte: every sign-in page        (new: 1 import, 1 component)
    ✅  .env, package.json: VITE_BRIDGE_APP_ID=abc123, bridge-svelte        (1 env var, 1 dependency)
    ✅  Bridge app: http://localhost:5175 as callback + origin              (app setting, not code)

    Backend (my-saas-api):
    ✅  src/app.module.ts: BridgeModule.forRoot({ guard: { global: true } }) (1 import, 1 module registration)
    ✅  .env, package.json: BRIDGE_APP_ID=abc123, bridge-nestjs             (1 env var, 1 dependency)
