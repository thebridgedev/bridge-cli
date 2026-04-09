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

Set your Bridge API key as an environment variable:

```bash
export BRIDGE_API_KEY=<your-api-token>
```

Optional configuration:

```bash
export BRIDGE_BASE_URL=https://account-api.thebridge.dev  # default
export BRIDGE_TENANT_ID=<tenant-id>                        # for user commands
export BRIDGE_DEBUG=true                                   # enable debug logging
```

## Usage

All output is JSON by default. AI agents parse it directly; humans can pipe through `jq`.

```bash
bridge <command> <subcommand> [options]
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

### Auth Configuration

```bash
bridge auth config
bridge auth mfa --enabled true
bridge auth password-policy --access-token-ttl 3600
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

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Client error (4xx) |
| 2 | Server error (5xx) |
| 3 | Configuration error (missing API key, etc.) |

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run locally
node bridge-cli/dist/bin.js --help

# Package
npm run package
```
