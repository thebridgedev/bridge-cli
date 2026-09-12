# @nebulr-group/bridge-cli

CLI for the Bridge platform — optimized for AI coding agents (Claude Code, Cursor, Copilot) and developers.

## Installation

```bash
npm install -g @nebulr-group/bridge-cli
```

Or run directly with npx:

```bash
npx @nebulr-group/bridge-cli tenant list
```

## Authentication

bridge-cli supports two authentication paths.

### 1. Interactive (recommended for humans + AI agents) — `bridge auth login`

```bash
bridge auth login
```

Opens your default browser, runs through a PKCE-secured loopback flow (RFC 8252), and stores a 10-day token at `~/.config/bridge/credentials.json` (mode `0600`). After that, every subsequent `bridge` command picks the token up automatically — no env vars needed.

```bash
bridge auth status   # show every stored app, and which one is active
bridge auth logout   # revoke the active token and remove it locally
```

#### Several apps at once

The credentials file holds one credential per app, so you can log in to your
local, stage and prod apps and move between them without a browser round-trip —
the tokens are already on disk with days left on them.

```bash
bridge auth login --label northwhistle-local     # once per app
bridge auth login --label northwhistle-prod

bridge auth status                               # lists both, marks the active one
bridge auth use northwhistle-local               # switch the default, offline
bridge --profile northwhistle-prod app get       # target ONE command, default untouched
```

A profile is selected by its `--label`, its app id, or its app name, in that
order. An ambiguous name is an error rather than a guess. `BRIDGE_PROFILE` does
the same thing as `--profile` for a whole shell session.

Prefer `--profile` over `bridge auth use` in scripts and long-running agent
sessions: `use` mutates state another process may be reading, `--profile` does
not.

Every command prints one line to **stderr** naming the app that answered:

```
bridge: northwhistle-prod (606b4416fabdc800087d09ec) · https://api.thebridge.dev · via saved default
```

stdout stays pure JSON, so this does not disturb anything parsing it. Silence it
with `BRIDGE_NO_BANNER=true` if you are already certain which app you are on.

`bridge auth logout` removes the active app only. Use `--profile <name>` for a
specific one, or `--all` to clear the file.

Existing single-app credentials files keep working and are upgraded in place the
next time something writes.

#### `bridge auth login` flags

| Flag | Description |
|------|-------------|
| `--app <id\|name>` | Pin to a specific app, skipping the picker on the consent screen. |
| `--label <text>`  | Friendly label stored on the token (default: `bridge-cli`). Useful when listing CLI tokens at `app.thebridge.dev/keys`. |
| `--no-browser`    | Print the authorization URL instead of opening a browser. Use this on headless boxes or over SSH. |

When the token expires (10 days), the next command fails with a friendly `Token expired. Run `bridge auth login` to re-authenticate.` message.

The credentials file location honors `XDG_CONFIG_HOME`:

```bash
$XDG_CONFIG_HOME/bridge/credentials.json   # if XDG_CONFIG_HOME is set
~/.config/bridge/credentials.json          # otherwise
```

### 2. Service-account / CI — `BRIDGE_API_KEY`

For non-interactive contexts (CI/CD pipelines, Docker images, headless agents) set the API key directly in the environment:

```bash
export BRIDGE_API_KEY=<your-api-token>
```

If you have logged in via `bridge auth login`, the credentials file always wins — a fresh login takes effect immediately, even when `BRIDGE_API_KEY` is still exported in your shell. `BRIDGE_API_KEY` is only used when no credentials file is present (the typical CI runner shape). To switch back to env-var auth on a developer machine, run `bridge auth logout --all` first.

Because that trips people up, the CLI now says so at the moment it happens: with
both present you get a line on stderr telling you `BRIDGE_API_KEY` is set and
being ignored, and what to do instead. To point the CLI at a different app, use
`--profile`, not the env vars.

**`BRIDGE_APP_ID` has no effect on any path.** The app is carried by the
credential itself — a login token and an API key are both already scoped to one
app, so there is nothing for it to change. It is called out on stderr whenever it
is set, rather than being quietly ignored.

Optional configuration (applies to both auth paths):

```bash
export BRIDGE_BASE_URL=https://api.thebridge.dev   # default
export BRIDGE_TENANT_ID=<tenant-id>                 # for user commands
export BRIDGE_DEBUG=true                            # enable debug logging
```

### 3. Targeting a local stack

Two exports, then log in as usual — the browser flow works against a local
stack the same way it does against production:

```bash
export BRIDGE_BASE_URL=http://localhost:3200        # bridge-api
export BRIDGE_AUTH_BASE_URL=http://localhost:3091   # consent screen (cloud-views)

bridge auth login
```

`BRIDGE_BASE_URL` is where commands send their API calls; `BRIDGE_AUTH_BASE_URL`
is where `bridge auth login` opens the consent screen. Set the second one too,
or you will authenticate against production and then issue commands against
your local API with a token it does not accept.

There is deliberately **no config file to source** (TBP-121). A sourceable file
mixed CLI settings with two demo apps' settings, pinned an undocumented app id,
and kept a long-lived API key on disk in plaintext; two exports cover the same
ground without any of that. For CI, use `BRIDGE_API_KEY` as described above.

One more, for working on the integration guides themselves:

```bash
export BRIDGE_GUIDE_LOCAL_DIR=/path/to/thebridge-platform/bridge-plugins
```

`bridge guide` and `bridge integrate` then read prompts from that directory
instead of fetching them from GitHub, so edits show up without a release.

## Usage

All output is JSON by default for management commands. AI agents parse it directly; humans can pipe through `jq`. The `bridge auth status` and `bridge auth login` commands print human-readable text, since their primary audience is a human in a terminal.

```bash
bridge <command> <subcommand> [options]
```

### Addressing a resource

Every command that acts on a single resource takes **either** its opaque id
**or** its human-readable identifier — you never have to run a `list` first just
to look up an id.

| Noun | Human-readable option | Id option |
|---|---|---|
| flag | `--key <key>` (or a positional `<key>` on `get` / `eval` / `schedule`) | `--id` |
| role | `--key <key>` (or a positional `<idOrKey>` on `get`) | `--id` |
| plan | positional `<key>` — plans are key-native, no id anywhere | — |
| tenant | `--name <name>` | `--id` |
| user | `--email <email>` | `--user-id` |
| token | `--name <name>` | `--id` |

Rules, the same for every noun:

- Pass exactly one. Both together, or neither, is an error.
- An identifier that matches nothing fails and names the `list` command to run.
- An identifier that matches **more than one** resource fails, lists the
  candidates, and changes nothing. The CLI never picks one for you — pass `--id`
  to disambiguate.

`--name` and `--email` exist because tenants, users and tokens have no key
field. Of those, only a user's email is unique; tenant and token names are free
text, which is exactly why the ambiguity check is a hard failure.

### Auth (interactive credentials)

```bash
bridge auth login                # default: open browser, complete PKCE flow
bridge auth login --app acme     # pin to a specific app
bridge auth login --label "work laptop"
bridge auth login --no-browser   # print the URL (headless / SSH)
bridge auth status               # show every stored app, active one marked
bridge auth use <label|app-id>   # switch the default app, no browser
bridge auth logout               # revoke + remove the active app
bridge auth logout --all         # ...or every stored app
bridge --profile <label> <cmd>   # target one app for one command
```

### Auth Configuration (app-level — separate from `auth login`)

```bash
bridge auth config
bridge auth mfa --enabled true
bridge auth password-policy --access-token-ttl 3600
```

### App

```bash
bridge app get
bridge app update --name "My App" --mfa-enabled true
```

### Tenants

```bash
bridge tenant list
bridge tenant get --name "Acme Corp"              # or --id <tenant-id>
bridge tenant create --owner-email admin@acme.com --name "Acme Corp" --plan enterprise
bridge tenant update --name "Acme Corp" --locale sv
bridge tenant update --name "Acme Corp" --new-name "Acme Corp Updated"
bridge tenant delete --name "Acme Corp"           # or --id <tenant-id>
```

Tenants have no key field, so they are addressed by `--name`. Names are **not**
enforced unique — if two tenants share one, the command fails and lists both
rather than guessing. Use `--id` to disambiguate.

`tenant update --name` addresses the tenant when `--id` is absent; passed
alongside `--id` it keeps its original meaning and renames the tenant.
`--new-name` always renames, whichever way you addressed it.

### Users

Requires tenant context via `--tenant-id` or `BRIDGE_TENANT_ID`.

```bash
bridge user list --tenant-id <tenant-id>
bridge user get --email alice@acme.com --tenant-id <tenant-id>      # or --user-id <user-id>
bridge user invite --email alice@acme.com --role ADMIN --tenant-id <tenant-id>
bridge user update --email alice@acme.com --role OWNER --tenant-id <tenant-id>
bridge user remove --email alice@acme.com --tenant-id <tenant-id>
```

Users have no key field either; `--email` is the human-readable address and is
unique within a tenant (matched case-insensitively).

### Access Roles

```bash
bridge role list
bridge role get ADMIN
bridge role create --name Editor --key editor --privileges READ,WRITE
bridge role update --key editor --privileges READ,WRITE,DELETE     # or --id <role-id>
bridge role delete --key editor                                    # or --id <role-id>
```

### Feature Flags

```bash
bridge flag list
bridge flag create --key dark-mode --description "Dark mode UI" --enabled
bridge flag update --key dark-mode --state on                      # or --id <flag-id>
bridge flag update --key dark-mode --new-key dark-theme            # rename
bridge flag toggle --key dark-mode --enabled true                  # or --id <flag-id>
bridge flag delete --key dark-mode                                 # or --id <flag-id>
```

`flag update --key` addresses the flag when `--id` is absent; passed alongside
`--id` it keeps its original meaning and renames the flag. `--new-key` always
renames, whichever way you addressed it.

### Branding

```bash
bridge branding get
bridge branding update --bg-color "#ffffff" --text-color "#000000"
```

### Subscription Plans

```bash
bridge plan list
bridge plan create --key pro --name "Pro Plan"
bridge plan update --key pro --name "Pro Plan v2"

# Prices — a plan can have several (one per currency + interval). Idempotent.
bridge plan price set pro --amount 29 --currency usd --interval month
bridge plan price set pro --amount 290 --currency usd --interval year
bridge plan price rm  pro --interval year

# Usage quotas (hard | metered caps)
# hard = block at the cap; metered = bill overage per unit (needs --price-amount)
bridge plan quota set pro --metric ai_completions --limit 1000 --policy hard
# Metered: first 1000 free, then $0.002/unit (currency from the plan's price)
bridge plan quota set pro --metric ai_completions --limit 1000 --policy metered --price-amount 0.002
# Pure per-unit (billed from unit 1)
bridge plan quota set pro --metric api_calls --limit 0 --policy metered --price-amount 0.01 --price-currency usd
bridge plan quota rm  pro --metric ai_completions
```

### API Tokens

```bash
bridge token list
bridge token create --name "CI Token" --privileges USER_READ,TENANT_READ
bridge token revoke --name "CI Token"             # or --id <token-id>
```

Token names are free text and not enforced unique — a duplicate name fails and
lists the candidates instead of revoking one at random.

### Events

```bash
bridge event list
bridge event list --type USER_CREATED --since 24h --limit 50
```

### Setup Workflows (multi-step)

```bash
bridge setup sso --provider google --client-id <id> --client-secret <secret>
bridge setup payments --stripe-key sk_test_xxx
bridge setup communication --provider sendgrid --api-key <key> --from-address noreply@acme.com
```

### Info (context for AI agents)

```bash
bridge info app
bridge info auth-config
bridge info flags
bridge info plans
bridge info roles
```

### Integration Guides

Three master prompts orchestrate the per-framework guides:

```bash
bridge guide              # Bridge Auth master prompt (auth, RBAC, tenants)
bridge guide flags        # Feature Flags 2.0 master prompt
bridge guide billing      # Billing 2.0 master prompt (subscriptions, quotas, webhooks)
```

Per-framework guides:

```bash
bridge guide list
bridge guide <framework>                    # auth guide (svelte | react | nextjs | angular | nestjs | express)
bridge guide <framework> sdk-auth           # in-app auth UI (frontend frameworks only)
bridge guide flags --framework <name>       # flags-specific guide
bridge guide billing --framework <name>     # billing-specific guide
bridge guide custom                         # REST API fallback for any language
```

`bridge guide flags` and `bridge guide billing` auto-detect the framework from `package.json` when `--framework` is omitted — they fall back to the generic master prompt if no framework signal is found.

## Output Format

**Success:**

```json
{
  "success": true,
  "data": { ... }
}
```

**Error:**

```json
{
  "success": false,
  "error": {
    "code": "TENANT_HAS_ACTIVE_SUBSCRIPTION",
    "message": "Cannot delete tenant with active subscription.",
    "details": { ... }
  }
}
```

`bridge auth login`, `bridge auth logout`, and `bridge auth status` print plain text (they're the only commands aimed primarily at humans).

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Client error (4xx), or `bridge auth login` failed/cancelled |
| 2 | Server error (5xx) |
| 3 | Configuration error (missing API key, expired credentials, etc.) |

## Security notes

- `bridge auth login` uses RFC 8252 loopback PKCE — the loopback URL is always `http://127.0.0.1:<random-port>/callback` (never `localhost`, to avoid DNS spoofing).
- The loopback HTTP server handles a single request, then closes — no port stays bound.
- The CSRF `state` parameter is verified on the callback before the code is exchanged.
- The credentials file is written with mode `0600` (owner-only). Its parent directory is created with mode `0700`.
- The CLI never logs the JWT or the PKCE `code_verifier`.

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run locally
node bridge-cli/dist/bin.js --help

# Test
npm test
```
