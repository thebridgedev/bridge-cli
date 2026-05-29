// TBP-198 — Flags-only integration scaffold.
//
// `bridge flag init` (alias for the eventual `bridge init --flags-only`).
// Detects the project framework from package.json and prints:
//   - The appropriate `bridge.flag(...)` setup snippet for the framework
//   - A `bridge-flags.config.json` next to package.json with appId + baseUrl
//     + suggested provider config
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
  const pkgFor: Record<Exclude<FlagsFramework, 'unknown'>, string> = {
    svelte: '@nebulr-group/bridge-svelte/flags',
    react: '@nebulr-group/bridge-react/flags',
    nextjs: '@nebulr-group/bridge-nextjs/flags',
    angular: '@nebulr-group/bridge-angular/flags',
    nestjs: '@nebulr-group/bridge-nestjs/flags',
    express: '@nebulr-group/bridge-express/flags',
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
      `export const bridge = new BridgeFlags();`,
      `bridge.setContext({ identity: 'user-id', attributes: { /* ... */ } });`,
      ``,
      `// Read a flag — type is inferred from defaultValue.`,
      `const newDashboard = bridge.flag('new-dashboard', false);`,
      '```',
      ``,
      `Then point the SDK at appId=${ctx.appId} via ${ctx.baseUrl}/cloud-views/flags.`,
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
        '2. In `src/routes/+layout.ts`:',
        '   ```ts',
        `   import { BridgeFlags } from '${pkg}';`,
        '',
        '   export const bridge = new BridgeFlags();',
        `   bridge.configure({ appId: '${ctx.appId}', baseUrl: '${ctx.baseUrl}' });`,
        '   ```',
        '',
        '3. Use anywhere:',
        '   ```ts',
        '   const enabled = bridge.flag("new-dashboard", false);',
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
        '2. In `src/main.tsx`:',
        '   ```tsx',
        `   import { BridgeFlagsProvider } from '${pkg}';`,
        '',
        '   <BridgeFlagsProvider',
        `     appId="${ctx.appId}"`,
        `     baseUrl="${ctx.baseUrl}"`,
        '   >',
        '     <App />',
        '   </BridgeFlagsProvider>',
        '   ```',
        '',
        '3. Use the hook in any component:',
        '   ```tsx',
        `   import { useFlag } from '${pkg}';`,
        '',
        '   function NewDashboard() {',
        '     const enabled = useFlag("new-dashboard", false);',
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
        '2. Client side — `app/providers.tsx`:',
        '   ```tsx',
        `   "use client";`,
        `   import { BridgeFlagsProvider } from '${pkg}';`,
        '',
        '   export function Providers({ children }: { children: React.ReactNode }) {',
        '     return (',
        '       <BridgeFlagsProvider',
        `         appId="${ctx.appId}"`,
        `         baseUrl="${ctx.baseUrl}"`,
        '       >',
        '         {children}',
        '       </BridgeFlagsProvider>',
        '     );',
        '   }',
        '   ```',
        '',
        '3. Server side — anywhere in a Server Component / Route Handler:',
        '   ```ts',
        `   import { getServerBridgeFlags } from '${pkg}/server';`,
        '   const bridge = await getServerBridgeFlags({',
        `     appId: '${ctx.appId}',`,
        `     baseUrl: '${ctx.baseUrl}',`,
        '   });',
        '   const enabled = bridge.flag("new-dashboard", false);',
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
        '2. In `app.config.ts`:',
        '   ```ts',
        `   import { provideBridgeFlags } from '${pkg}';`,
        '',
        '   export const appConfig: ApplicationConfig = {',
        '     providers: [',
        '       provideBridgeFlags({',
        `         appId: '${ctx.appId}',`,
        `         baseUrl: '${ctx.baseUrl}',`,
        '       }),',
        '     ],',
        '   };',
        '   ```',
        '',
        '3. Inject the service:',
        '   ```ts',
        `   import { BridgeFlagsService } from '${pkg}';`,
        '',
        '   constructor(private flags: BridgeFlagsService) {}',
        '',
        '   newDashboard = this.flags.flag("new-dashboard", false);',
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
        '2. Import the module in `app.module.ts`:',
        '   ```ts',
        `   import { BridgeFlagsModule } from '${pkg}';`,
        '',
        '   @Module({',
        '     imports: [',
        '       BridgeFlagsModule.forRoot({',
        `         appId: '${ctx.appId}',`,
        `         baseUrl: '${ctx.baseUrl}',`,
        '         mode: "backend",',
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
        '   async handleRequest(req) {',
        '     const enabled = this.flags.flag("new-checkout", false, {',
        '       identity: req.user?.id,',
        '       attributes: { plan: req.user?.plan },',
        '     });',
        '   }',
        '   ```',
      ].join('\n');

    case 'express':
      return [
        '# Bridge Flags — Express (flags-only, backend mode)',
        '',
        `1. Install:`,
        '   ```bash',
        '   bun add @nebulr-group/bridge-express',
        '   ```',
        '',
        '2. At app bootstrap:',
        '   ```ts',
        `   import { createBridgeFlags } from '${pkg}';`,
        '',
        '   const bridge = createBridgeFlags({',
        `     appId: '${ctx.appId}',`,
        `     baseUrl: '${ctx.baseUrl}',`,
        '     mode: "backend",',
        '   });',
        '',
        '   app.use(bridge.middleware());',
        '   ```',
        '',
        '3. In a handler:',
        '   ```ts',
        '   app.get("/", (req, res) => {',
        '     const enabled = req.bridge.flag("new-home", false);',
        '     res.send(enabled ? "v2" : "v1");',
        '   });',
        '   ```',
      ].join('\n');
  }
}

// ── Provider config + next-steps blurbs ─────────────────────────────────────

function suggestedProviderConfig(framework: FlagsFramework): Record<string, unknown> {
  if (framework === 'nestjs' || framework === 'express') {
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
