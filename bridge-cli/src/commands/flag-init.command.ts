// TBP-198 — Flags-only integration scaffold.
//
// `bridge flag init` (alias for the eventual `bridge init --flags-only`).
// Detects the project framework from package.json and prints:
//   - The framework's REAL flag-reading setup snippet
//   - A `bridge-flags.config.json` next to package.json with appId + baseUrl
//     + suggested provider config
//
// TBP-206 — every snippet below MUST correspond to a symbol that actually
// exists in the named package at an import specifier that actually resolves.
// The previous revision invented `createBridgeFlags()` middleware for express,
// `BridgeFlagsProvider` for react/nextjs and `provideBridgeFlags` for angular,
// and pointed every framework at a `/flags` subpath — several of which are not
// declared in the package's `exports` map. Agents followed the scaffold and
// wrote code that could not resolve, let alone run. If you change a snippet,
// re-verify it against the package source first.
//
// The command is deliberately NON-destructive: it never overwrites source
// files. The "scaffold" is text output (snippet + config file) for the agent
// or the developer to apply.

import { Command } from 'commander';
import { readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { getManagementClient, DEFAULT_BASE_URL } from '../config.js';
import { outputSuccess, outputError } from '../output.js';
import { readCredentials } from '../credentials.js';

export type FlagsFramework =
  | 'svelte'
  | 'react'
  | 'nextjs'
  | 'angular'
  | 'nestjs'
  | 'express'
  | 'unknown';

export function registerFlagInitCommand(flagParent: Command): void {
  flagParent
    .command('init')
    .description(
      'Scaffold a flags-only Bridge integration (no auth setup) — detects framework, prints setup snippet, writes bridge-flags.config.json',
    )
    .option('--framework <name>', 'Override framework detection: svelte | react | nextjs | angular | nestjs | express')
    .option('--cwd <path>', 'Project directory (defaults to current)', process.cwd())
    .option('--no-config', 'Skip writing bridge-flags.config.json')
    .option('--base-url <url>', 'Override the base URL written to config')
    .action(async (opts) => {
      try {
        const cwd: string = opts.cwd;
        const framework: FlagsFramework =
          (opts.framework as FlagsFramework | undefined) ?? (await detectFramework(cwd));

        const client = getManagementClient();
        const app = (await client.app.get()) as unknown as Record<string, unknown>;
        const appId = (app.id as string) ?? '';
        const appName = (app.name as string) ?? '';

        const baseUrl =
          (opts.baseUrl as string | undefined) ??
          // Pull the credentials file's baseUrl when available; falls back to
          // the public default. (BRIDGE_BASE_URL is honored by getManagementClient
          // already; we don't re-read it here to avoid divergence.)
          readCredentials()?.baseUrl ??
          DEFAULT_BASE_URL;

        const snippet = renderSnippet(framework, { appId, baseUrl });

        let configPath: string | undefined;
        if (opts.config !== false) {
          configPath = join(cwd, 'bridge-flags.config.json');
          await writeFile(
            configPath,
            JSON.stringify(
              {
                appId,
                appName,
                baseUrl,
                framework,
                provider: suggestedProviderConfig(framework),
              },
              null,
              2,
            ) + '\n',
            'utf8',
          );
        }

        outputSuccess({
          framework,
          app: { id: appId, name: appName },
          baseUrl,
          configFile: configPath,
          nextSteps: nextStepsFor(framework),
          snippet,
        });
      } catch (err) {
        outputError(err);
      }
    });
}

// ── Framework detection ─────────────────────────────────────────────────────

export async function detectFramework(cwd: string): Promise<FlagsFramework> {
  const pkgPath = join(cwd, 'package.json');
  let pkgRaw: string;
  try {
    pkgRaw = await readFile(pkgPath, 'utf8');
  } catch {
    return 'unknown';
  }
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(pkgRaw);
  } catch {
    return 'unknown';
  }
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };

  // Order matters: Next.js + React is detected as Next.js.
  if ('next' in deps) return 'nextjs';
  if ('@sveltejs/kit' in deps || 'svelte' in deps) return 'svelte';
  if ('@nestjs/core' in deps) return 'nestjs';
  if ('@angular/core' in deps) return 'angular';
  if ('react' in deps) return 'react';
  if ('express' in deps) return 'express';
  return 'unknown';
}

// ── Snippet rendering ───────────────────────────────────────────────────────

interface SnippetCtx {
  appId: string;
  baseUrl: string;
}

export function renderSnippet(framework: FlagsFramework, ctx: SnippetCtx): string {
  // Import specifiers that actually resolve for each framework (TBP-206).
  //
  //   svelte / react  — declare "./flags" in their package.json `exports` map.
  //   nextjs          — has NO "./flags" and NO "." key; FF 2.0 is folded into
  //                     "./client", server-side flags live under "./server".
  //   angular         — ships a single ng-packagr entry point; everything comes
  //                     from the bare specifier.
  //   nestjs          — declares "./flags" since 0.6.0 (TBP-613). Before that
  //                     it had no `exports` map, so `<pkg>/flags` fell back to
  //                     legacy resolution and 404'd, and this scaffolder
  //                     emitted `<pkg>/dist/flags` instead. Reaching into the
  //                     build directory was never right — it froze the dist
  //                     layout into a public contract — and generating it here
  //                     is how the wrong path spread. Requires >= 0.6.0.
  //   express         — no `exports` map and no flags entry point; the flag
  //                     surface is on the bare specifier.
  const pkgFor: Record<Exclude<FlagsFramework, 'unknown'>, string> = {
    svelte: '@nebulr-group/bridge-svelte/flags',
    react: '@nebulr-group/bridge-react/flags',
    nextjs: '@nebulr-group/bridge-nextjs/client',
    angular: '@nebulr-group/bridge-angular',
    nestjs: '@nebulr-group/bridge-nestjs/flags',
    express: '@nebulr-group/bridge-express',
  };

  if (framework === 'unknown') {
    return [
      `# Bridge Flags — generic setup`,
      ``,
      `Couldn't auto-detect your framework. Use the core SDK directly:`,
      ``,
      '```ts',
      `import { BridgeFlags } from '@nebulr-group/bridge-auth-core';`,
      ``,
      `// 'backend' refuses to bucket rollout flags without an identity;`,
      `// use 'frontend' in a browser runtime.`,
      `export const bridge = new BridgeFlags({ mode: 'backend' });`,
      ``,
      `// Load the rule set for your app (or let a framework SDK do it for you).`,
      `const res = await fetch(`,
      `  '${ctx.baseUrl}/admin/flags-internal/flags-cache/${ctx.appId}',`,
      `);`,
      `bridge.hydrate(await res.json());`,
      ``,
      `bridge.setContext({ identity: 'user-id', attributes: { /* plan, role, ... */ } });`,
      ``,
      `// Read a flag — T is inferred from defaultValue (boolean | string | number | json).`,
      `// Returns FlagEvalResult<T> = { value, passed }, NOT a bare value.`,
      `const { value: newDashboard } = bridge.flag('new-dashboard', false);`,
      '```',
    ].join('\n');
  }

  const pkg = pkgFor[framework];

  // Per-framework idiomatic snippet.
  switch (framework) {
    case 'svelte':
      return [
        '# Bridge Flags — SvelteKit (flags-only)',
        '',
        `1. Install:`,
        '   ```bash',
        '   bun add @nebulr-group/bridge-svelte',
        '   ```',
        '',
        '2. Configure + mount the runtime once — `src/routes/+layout.svelte`:',
        '   ```svelte',
        '   <script lang="ts">',
        `     import { BridgeProvider, bridgeConfig } from '@nebulr-group/bridge-svelte';`,
        '',
        '     bridgeConfig.initConfig({',
        `       appId: '${ctx.appId}',`,
        `       apiBaseUrl: '${ctx.baseUrl}',`,
        '     });',
        '',
        '     let { children } = $props();',
        '   </script>',
        '',
        '   <BridgeProvider>{@render children()}</BridgeProvider>',
        '   ```',
        '',
        '3. Read a flag in any component under the provider:',
        '   ```svelte',
        '   <script lang="ts">',
        `     import { useFlag } from '${pkg}';`,
        '',
        '     // Sync rune. Returns { value, passed } — NOT a bare value.',
        '     // T is inferred from the default: boolean | string | number | json.',
        `     const newDashboard = useFlag('new-dashboard', false);`,
        '   </script>',
        '',
        '   {#if newDashboard.value}<V2 />{:else}<V1 />{/if}',
        '   ```',
        '',
        '   Or declaratively:',
        '   ```svelte',
        `   import { FeatureFlag } from '${pkg}';`,
        '   <FeatureFlag flag="new-dashboard">…</FeatureFlag>',
        '   ```',
      ].join('\n');

    case 'react':
      return [
        '# Bridge Flags — React (flags-only)',
        '',
        `1. Install:`,
        '   ```bash',
        '   bun add @nebulr-group/bridge-react',
        '   ```',
        '',
        '2. In `src/main.tsx` — flags ride on the core Bridge runtime, so mount',
        '   `<BridgeProvider>` (there is no separate flags provider):',
        '   ```tsx',
        `   import { BridgeProvider } from '@nebulr-group/bridge-react';`,
        '',
        `   <BridgeProvider config={{ appId: '${ctx.appId}', apiBaseUrl: '${ctx.baseUrl}' }}>`,
        '     <App />',
        '   </BridgeProvider>',
        '   ```',
        '   (`VITE_BRIDGE_APP_ID` / `VITE_BRIDGE_API_BASE_URL` override the props.)',
        '',
        '3. Use the hook in any component:',
        '   ```tsx',
        `   import { useFlag } from '${pkg}';`,
        '',
        '   function NewDashboard() {',
        '     // Sync. Returns { value, passed } — destructure `value`.',
        `     const { value: enabled } = useFlag('new-dashboard', false);`,
        '     return enabled ? <V2 /> : <V1 />;',
        '   }',
        '   ```',
      ].join('\n');

    case 'nextjs':
      return [
        '# Bridge Flags — Next.js (flags-only)',
        '',
        `1. Install:`,
        '   ```bash',
        '   bun add @nebulr-group/bridge-nextjs',
        '   ```',
        '',
        '2. Client side — `app/providers.tsx`. FF 2.0 is folded into the',
        '   `./client` entry point; there is no `/flags` subpath and no separate',
        '   flags provider:',
        '   ```tsx',
        `   "use client";`,
        `   import { BridgeProvider } from '${pkg}';`,
        '',
        '   export function Providers({ children }: { children: React.ReactNode }) {',
        '     return (',
        `       <BridgeProvider config={{ appId: '${ctx.appId}', apiBaseUrl: '${ctx.baseUrl}' }}>`,
        '         {children}',
        '       </BridgeProvider>',
        '     );',
        '   }',
        '   ```',
        '',
        '   Then in any client component:',
        '   ```tsx',
        `   import { useFlag } from '${pkg}';`,
        `   const { value: enabled } = useFlag('new-dashboard', false);`,
        '   ```',
        '',
        '3. Server side — Server Component / Route Handler / middleware. The',
        '   server flag surface is a singleton, and every read is async and takes',
        '   the `NextRequest` (that is where identity comes from):',
        '   ```ts',
        `   import { FeatureFlagServer } from '@nebulr-group/bridge-nextjs/server';`,
        '',
        '   // Once at boot:',
        '   FeatureFlagServer.getInstance().init({',
        `     appId: '${ctx.appId}',`,
        `     apiBaseUrl: '${ctx.baseUrl}',`,
        '   });',
        '',
        '   // Per request — evaluated locally in-process, no round trip per flag:',
        `   const enabled = await FeatureFlagServer.getInstance().flagServer('new-dashboard', false, request);`,
        '   ```',
      ].join('\n');

    case 'angular':
      return [
        '# Bridge Flags — Angular (flags-only)',
        '',
        `1. Install:`,
        '   ```bash',
        '   bun add @nebulr-group/bridge-angular',
        '   ```',
        '',
        '2. In `app.config.ts` — one provider covers auth + flags (the package',
        '   ships a single entry point, so import from the bare specifier):',
        '   ```ts',
        `   import { provideBridge } from '${pkg}';`,
        '',
        '   export const appConfig: ApplicationConfig = {',
        '     providers: [',
        '       provideBridge({',
        `         appId: '${ctx.appId}',`,
        `         apiBaseUrl: '${ctx.baseUrl}',`,
        '       }),',
        '     ],',
        '   };',
        '   ```',
        '',
        '3. Inject `BridgeService` — `flag()` returns a Signal of { value, passed }:',
        '   ```ts',
        `   import { BridgeService } from '${pkg}';`,
        '',
        '   private bridge = inject(BridgeService);',
        '',
        `   newDashboard = this.bridge.flag('new-dashboard', false);`,
        '   // template: {{ newDashboard().value }}',
        '',
        '   // One-shot, non-reactive read:',
        `   // const { value } = this.bridge.evaluate('new-dashboard', false);`,
        '   ```',
      ].join('\n');

    case 'nestjs':
      return [
        '# Bridge Flags — NestJS (flags-only, backend mode)',
        '',
        `1. Install:`,
        '   ```bash',
        '   bun add @nebulr-group/bridge-nestjs',
        '   ```',
        '',
        '2. Import the module in `app.module.ts` (requires bridge-nestjs >= 0.6.0):',
        '   ```ts',
        `   import { BridgeFlagsModule } from '${pkg}';`,
        '',
        '   @Module({',
        '     imports: [',
        '       BridgeFlagsModule.forRoot({',
        `         apiBaseUrl: '${ctx.baseUrl}',`,
        `         apiKey: '${ctx.appId}',`,
        `         mode: 'backend',`,
        '       }),',
        '     ],',
        '   })',
        '   export class AppModule {}',
        '   ```',
        '',
        '3. Inject in any service / controller:',
        '   ```ts',
        `   import { BridgeFlagsService } from '${pkg}';`,
        '',
        '   constructor(private flags: BridgeFlagsService) {}',
        '',
        '   handleRequest(req) {',
        '     // Sync, evaluated locally in-process. Returns T directly.',
        `     const enabled = this.flags.flag('new-checkout', false, {`,
        '       identity: req.bridgeUser?.id,',
        '       attributes: { plan: req.bridgeUser?.plan },',
        '     });',
        '   }',
        '   ```',
      ].join('\n');

    case 'express':
      return [
        '# Bridge Flags — Express',
        '',
        '   NOTE: express does not have a standalone flags runtime. Flags are',
        '   part of the auth middleware, are boolean-only, require a user JWT,',
        '   and are evaluated remotely by the Bridge API (see TBP-516).',
        '',
        `1. Install:`,
        '   ```bash',
        '   bun add @nebulr-group/bridge-express',
        '   ```',
        '',
        '2. At app bootstrap:',
        '   ```ts',
        `   import { createBridge } from '${pkg}';`,
        '',
        '   const bridge = createBridge({',
        `     appId: '${ctx.appId}',`,
        `     apiBaseUrl: '${ctx.baseUrl}',`,
        '     guard: { defaultAccess: \'protected\' },',
        '   });',
        '',
        '   app.use(bridge.auth());',
        '   ```',
        '',
        '3. Gate a route on a flag — `featureFlag` accepts',
        '   `string | { any: string[] } | { all: string[] }`; a miss is a 403:',
        '   ```ts',
        `   app.get('/beta', bridge.protect({ featureFlag: 'new-home' }), (req, res) => {`,
        `     res.send('v2');`,
        '   });',
        '',
        '   // Or centrally, via guard.rules:',
        `   // { path: '/beta/**', privilege: 'AUTHENTICATED', featureFlag: { any: ['new-home', 'beta'] } }`,
        '   ```',
        '',
        '4. Read a flag inside a handler:',
        '   ```ts',
        `   import { BridgeConfigService, FeatureFlagService } from '${pkg}';`,
        '',
        '   const flags = new FeatureFlagService(',
        `     new BridgeConfigService({ appId: '${ctx.appId}', apiBaseUrl: '${ctx.baseUrl}' }),`,
        '   );',
        '',
        `   app.get('/', bridge.protect(), async (req, res) => {`,
        '     // Boolean only. Async — remote evaluation, cached 5 min per token.',
        `     const enabled = await flags.isEnabled('new-home', req.bridgeAccessToken!);`,
        `     res.send(enabled ? 'v2' : 'v1');`,
        '   });',
        '   ```',
      ].join('\n');
  }
}

// ── Provider config + next-steps blurbs ─────────────────────────────────────

function suggestedProviderConfig(framework: FlagsFramework): Record<string, unknown> {
  // Keys mirror the real option names on the framework's flags runtime
  // (`createBridgeFlags` / `BridgeFlagsModule.forRoot`) — `mode` is
  // `'frontend' | 'backend'`, `telemetry` is a partial TelemetryBatcherConfig.
  if (framework === 'express') {
    // express has no BridgeFlags runtime — nothing to configure. Flags are
    // enforced through `bridge.protect({ featureFlag })` and evaluated remotely
    // by the Bridge API. See TBP-516.
    return {
      runtime: 'none',
      note: 'bridge-express evaluates flags remotely inside the auth middleware; there is no local flags provider to configure.',
    };
  }
  if (framework === 'nestjs') {
    return { mode: 'backend', telemetry: { enabled: true, flushIntervalMs: 5000 } };
  }
  return { mode: 'frontend', telemetry: { enabled: true, flushIntervalMs: 5000 } };
}

function nextStepsFor(framework: FlagsFramework): string[] {
  const base = [
    'Apply the printed snippet to the file noted above.',
    'Run `bridge guide flags' + (framework !== 'unknown' ? ` --framework ${framework}` : '') + '` for the full integration prompt.',
    'Create your first flag: `bridge flag create --key hello-flag --state on --value-type boolean --on-value true --off-value false`',
    'Eval it locally: `bridge flag eval hello-flag --identity demo-user`',
  ];
  if (framework === 'unknown') {
    return [
      'Could not auto-detect your framework — pass --framework <name> to scope the snippet.',
      ...base,
    ];
  }
  return base;
}

/** Probe whether a path exists (used by tests). */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
