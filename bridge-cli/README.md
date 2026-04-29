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
bridge auth status   # show who you're logged in as and when the token expires
bridge auth logout   # revoke the token and delete the credentials file
```

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

The env var takes precedence over the credentials file when both are present, so you can safely export `BRIDGE_API_KEY` in a CI shell that also has a stale `credentials.json` from a developer's home directory.

Optional configuration (applies to both auth paths):

```bash
export BRIDGE_BASE_URL=https://api.thebridge.dev   # default
export BRIDGE_TENANT_ID=<tenant-id>                 # for user commands
export BRIDGE_DEBUG=true                            # enable debug logging
```

## Usage

All output is JSON by default for management commands. AI agents parse it directly; humans can pipe through `jq`. The `bridge auth status` and `bridge auth login` commands print human-readable text, since their primary audience is a human in a terminal.

```bash
bridge <command> <subcommand> [options]
```

### Auth (interactive credentials)

```bash
bridge auth login                # default: open browser, complete PKCE flow
bridge auth login --app acme     # pin to a specific app
bridge auth login --label "work laptop"
bridge auth login --no-browser   # print the URL (headless / SSH)
bridge auth status               # show current login state
bridge auth logout               # revoke token + delete local file
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
bridge tenant get --id <tenant-id>
bridge tenant create --owner-email admin@acme.com --name "Acme Corp" --plan enterprise
bridge tenant update --id <tenant-id> --name "Acme Corp Updated"
bridge tenant delete --id <tenant-id>
```

### Users

Requires tenant context via `--tenant-id` or `BRIDGE_TENANT_ID`.

```bash
bridge user list --tenant-id <tenant-id>
bridge user get --user-id <user-id> --tenant-id <tenant-id>
bridge user invite --email alice@acme.com --role ADMIN --tenant-id <tenant-id>
bridge user update --user-id <user-id> --role OWNER --tenant-id <tenant-id>
bridge user remove --user-id <user-id> --tenant-id <tenant-id>
```

### Access Roles

```bash
bridge role list
bridge role create --name Editor --key editor --privileges READ,WRITE
bridge role update --id <role-id> --privileges READ,WRITE,DELETE
bridge role delete --id <role-id>
```

### Feature Flags

```bash
bridge flag list
bridge flag create --key dark-mode --description "Dark mode UI" --enabled
bridge flag update --id <flag-id> --enabled true
bridge flag toggle --id <flag-id> --enabled true
bridge flag delete --id <flag-id>
```

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
```

### API Tokens

```bash
bridge token list
bridge token create --name "CI Token" --privileges USER_READ,TENANT_READ
bridge token revoke --id <token-id>
```

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

```bash
bridge guide list
bridge guide react
bridge guide nextjs
bridge guide express
bridge guide custom
```

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
