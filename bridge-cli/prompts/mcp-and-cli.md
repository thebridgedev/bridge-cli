# Protect your MCP endpoint and add CLI sign-in

Goal: your app's users reach it from an AI assistant (your MCP endpoint) and from a terminal (your own CLI), signed in with their app account. Bridge signs them in and checks the tokens; you build the MCP tools and the CLI commands. Nothing to register in Bridge: MCP sign-in and browser sign-in for your CLI are always on.

## 1. The MCP endpoint

Put `@nebulr-group/bridge-auth-core`'s guard in MCP mode in front of the endpoint **and** its well-known paths:

```ts
import { bridgeMcpGuard } from '@nebulr-group/bridge-auth-core/server';
import { bridgeMcpMiddleware } from '@nebulr-group/bridge-auth-core/server/node';

const guard = bridgeMcpGuard({ issuer: process.env.BRIDGE_ISSUER!, resource: 'https://acme.example/mcp' });
app.use(bridgeMcpMiddleware(guard)); // before app.post('/mcp', …)
```

At the edge, `guard.protect((request, caller) => …)` does the same. A tool reads the caller (user, workspace, privileges, whether it may delete) from `extra.authInfo.extra.caller`. Gate each tool with a feature flag, as any endpoint.

- `resource` is the endpoint's address exactly as assistants are given it. It must be on one of the app's addresses (`bridge app address list`), localhost in development mode, or listed with `bridge app mcp add <url>` when it is on another domain.
- Keep your API on the normal guard: it refuses assistants' tokens, and that is the point. Don't widen it.
- Run `bridge check mcp` at the end: it lists any MCP endpoint without the guard.

## 2. Your CLI

Use auth-core's CLI helper; it signs in through the browser (loopback and PKCE), stores the session privately and renews it:

```ts
import { createBridgeCli } from '@nebulr-group/bridge-auth-core/cli';

const bridge = createBridgeCli({ issuer: process.env.BRIDGE_ISSUER!, name: 'acme' });
await bridge.login();                      // or { code: true } on a machine without a browser
const token = await bridge.getAccessToken(); // send it to your API and your MCP endpoint
```

Its token is your app's own token: your API's normal guard and your MCP endpoint both accept it.

- Sign-in with a short code (machines without a browser) is off by default because attackers abuse it. Switch it on only when the developer asks: `bridge app tools set --short-code on`.
- Which assistants may connect: `bridge app tools` (any, by default); `bridge app tools set --any-assistant off --assistant claude cursor` to allow only some.

## 3. Prove it

Connect an assistant to the endpoint and call a tool; run your CLI's login and one command. `bridge user connections <email>` then lists both, and `bridge user disconnect <email> <id> --yes` ends one.
