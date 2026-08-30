import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { commandsDir } from './runtime-dir.js';
import { outputSuccess, outputPrompt, outputError } from '../output.js';
import { readCredentials, isExpired } from '../credentials.js';
import { runLogin } from './auth/login.command.js';
import { AUTH_MASTER_PROMPT_FILENAME, AUTH_MASTER_PROMPT_URL, pluginGuideUrl } from '../prompt-urls.js';

/**
 * Locate the directory containing this module on disk so the bundled prompts
 * (shipped at `dist/prompts/`) can be read relative to it. The `import.meta`
 * resolution is isolated in `runtime-dir.ts` (and stubbed for jest) — see that
 * file for the dual-runtime rationale.
 *
 * The previous in-line `new Function('return import.meta.url')()` trick could
 * never work: a Function-constructor body runs in global *script* scope where
 * `import.meta` is a SyntaxError, so it threw even under ESM and silently fell
 * through to a `process.cwd()`-based branch — which only resolved correctly by
 * accident when the CWD happened to be the package root.
 */
function thisDir(): string {
  return commandsDir;
}

const GUIDE_REPOS: Record<string, string> = {
  react: 'bridge-react/main',
  svelte: 'bridge-svelte/main',
  angular: 'bridge-angular/main',
  nextjs: 'bridge-nextjs/main',
  express: 'bridge-express/main',
  nestjs: 'bridge-nestjs/main',
};

const AVAILABLE_FEATURES: Record<string, string[]> = {
  svelte: ['sdk-auth', 'feature-flags', 'flags', 'billing', 'team'],
  react: ['flags', 'billing'],
  nextjs: ['flags', 'billing'],
  angular: ['flags', 'billing'],
  nestjs: ['flags', 'billing'],
  express: ['flags', 'billing'],
};

const FLAGS_FRAMEWORKS = ['svelte', 'react', 'nextjs', 'angular', 'nestjs', 'express'] as const;
type FlagsFramework = (typeof FLAGS_FRAMEWORKS)[number];

const BILLING_FRAMEWORKS = ['svelte', 'react', 'nextjs', 'angular', 'nestjs', 'express'] as const;
type BillingFramework = (typeof BILLING_FRAMEWORKS)[number];

/**
 * Per-framework prompts are the responsibility of each plugin repo
 * (`bridge-<framework>/mcp/feature-flags-prompt.md` and `mcp/billing-prompt.md`).
 * Bridge-cli only bundles the generic master orchestrators
 * (`prompts/flags/master.md`, `prompts/billing/master.md`) — never per-framework
 * copies, which would diverge from the plugin's source of truth.
 *
 * Both alias sets are now exhaustive: every framework routes through fetchGuide
 * to its plugin repo's mcp/ folder. If the plugin repo doesn't have the file
 * yet, the user gets a clear "HTTP 404 — file may not exist yet in the plugin
 * repo" error pointing them at the right destination.
 */
const FLAGS_ALIAS_FRAMEWORKS: Set<FlagsFramework> = new Set(FLAGS_FRAMEWORKS);
const BILLING_ALIAS_FRAMEWORKS: Set<BillingFramework> = new Set(BILLING_FRAMEWORKS);

function guideFilename(feature?: string): string {
  if (!feature) return 'integration-prompt.md';
  return `${feature}-prompt.md`;
}

const guideCache = new Map<string, { content: string; fetchedAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function registerGuideCommands(program: Command): void {
  const guide = program.command('guide')
    .description('Integration guides — run with no arguments for the master integration prompt')
    .option('--json', 'Emit a JSON envelope instead of the raw markdown prompt')
    .action(async (_opts, command) => {
      try {
        const opts = command.optsWithGlobals() as { json?: boolean };
        await ensureAuthenticated();
        const creds = readCredentials()!;
        const raw = await fetchMasterPrompt();
        const guide = raw
          .replace('{{session.email}}', creds.user.email)
          .replace('{{session.appName}}', creds.app.name)
          .replace('{{session.appId}}', creds.app.id);
        if (opts.json) outputSuccess({ guide });
        else outputPrompt(guide);
      } catch (err) { outputError(err); }
    });

  const technologies = [...Object.keys(GUIDE_REPOS), 'custom'];

  guide.command('list')
    .description('List available integration guides and feature guides')
    .action(() => {
      outputSuccess({ technologies, features: AVAILABLE_FEATURES });
    });

  // TBP-206 — `bridge guide flags [--framework <name>]`
  guide.command('flags')
    .description('Feature Flags 2.0 integration prompt (use --framework for per-framework guide)')
    .option('--framework <name>', `Framework: ${FLAGS_FRAMEWORKS.join(' | ')} (auto-detected from package.json when omitted)`)
    .option('--cwd <path>', 'Project dir used for framework detection', process.cwd())
    .option('--json', 'Emit a JSON envelope instead of the raw markdown prompt')
    .action(async (_opts, command) => {
      try {
        const opts = command.optsWithGlobals() as {
          framework?: string;
          cwd?: string;
          json?: boolean;
        };
        // Always return the master when no --framework flag is given.
        // The master orchestrates discovery then calls bridge guide flags --framework <name> in Step 4.
        const content = opts.framework
          ? await fetchGuide(await resolveFlagsFramework(opts.framework, opts.cwd ?? process.cwd()) ?? opts.framework, 'feature-flags')
          : await fetchFlagsMasterPrompt();
        if (opts.json) {
          outputSuccess({
            feature: 'flags',
            framework: opts.framework ?? 'generic',
            guide: content,
          });
        } else {
          outputPrompt(content);
        }
      } catch (err) { outputError(err); }
    });

  // Billing 2.0 — `bridge guide billing [--framework <name>]`. Mirrors the
  // flags command shape. Auto-detects from package.json when --framework is
  // omitted; falls back to `prompts/billing/master.md` when detection fails.
  guide.command('billing')
    .description('Billing 2.0 integration prompt (use --framework for per-framework guide)')
    .option('--framework <name>', `Framework: ${BILLING_FRAMEWORKS.join(' | ')} (auto-detected from package.json when omitted)`)
    .option('--cwd <path>', 'Project dir used for framework detection', process.cwd())
    .option('--json', 'Emit a JSON envelope instead of the raw markdown prompt')
    .action(async (_opts, command) => {
      try {
        const opts = command.optsWithGlobals() as {
          framework?: string;
          cwd?: string;
          json?: boolean;
        };
        // Always return the master when no --framework flag is given.
        // The master orchestrates discovery, pricing-model elicitation, and
        // calls `bridge guide billing --framework <name>` itself in Step 4.
        const content = opts.framework
          ? await fetchGuide(await resolveBillingFramework(opts.framework, opts.cwd ?? process.cwd()) ?? opts.framework, 'billing')
          : await fetchBillingMasterPrompt();
        if (opts.json) {
          outputSuccess({
            feature: 'billing',
            framework: opts.framework ?? 'generic',
            guide: content,
          });
        } else {
          outputPrompt(content);
        }
      } catch (err) { outputError(err); }
    });

  for (const tech of Object.keys(GUIDE_REPOS)) {
    guide.command(tech)
      .argument('[feature]', 'Feature guide (e.g. sdk-auth, feature-flags, flags, billing, team)')
      .description(`Integration guide for ${tech}`)
      .option('--json', 'Emit a JSON envelope instead of the raw markdown prompt')
      .action(async (feature: string | undefined, _opts, command) => {
        try {
          const opts = command.optsWithGlobals() as { json?: boolean };
          // `flags` is a synonym for `feature-flags`. Both routes — `bridge
          // guide flags --framework <name>` and `bridge guide <name> flags` —
          // resolve to the same plugin-repo source of truth at
          // `bridge-<name>/mcp/feature-flags-prompt.md`. `billing` follows the
          // same pattern. There is no per-framework bundled fallback by design.
          let content: string;
          let resolvedFeature = feature ?? 'default';
          if (feature === 'flags' && FLAGS_FRAMEWORKS.includes(tech as FlagsFramework)) {
            content = await fetchGuide(tech, 'feature-flags');
            resolvedFeature = 'flags';
          } else if (feature === 'billing' && BILLING_FRAMEWORKS.includes(tech as BillingFramework)) {
            content = await fetchGuide(tech, 'billing');
            resolvedFeature = 'billing';
          } else {
            content = await fetchGuide(tech, feature);
          }
          if (opts.json) {
            outputSuccess({ technology: tech, feature: resolvedFeature, guide: content });
          } else {
            outputPrompt(content);
          }
        } catch (err) { outputError(err); }
      });
  }

  guide.command('custom')
    .description('Universal integration guide for any technology using REST API + JWKS')
    .option('--json', 'Emit a JSON envelope instead of the raw markdown prompt')
    .action((_opts, command) => {
      const opts = command.optsWithGlobals() as { json?: boolean };
      if (opts.json) outputSuccess({ technology: 'custom', guide: CUSTOM_GUIDE });
      else outputPrompt(CUSTOM_GUIDE);
    });

  guide.command('integration-success')
    .description('Integration success message template — output at the end of a completed integration')
    .option('--json', 'Emit a JSON envelope instead of the raw markdown prompt')
    .action(async (_opts, command) => {
      try {
        const opts = command.optsWithGlobals() as { json?: boolean };
        const content = await fetchIntegrationSuccess();
        if (opts.json) outputSuccess({ guide: content });
        else outputPrompt(content);
      } catch (err) { outputError(err); }
    });
}

async function fetchIntegrationSuccess(): Promise<string> {
  const here = thisDir();
  const candidates = [
    join(here, '..', 'prompts', 'integration-success.md'),
    join(here, '..', '..', 'prompts', 'integration-success.md'),
  ];
  for (const path of candidates) {
    try {
      return await readFile(path, 'utf-8');
    } catch {
      /* try next */
    }
  }
  throw new Error(`integration-success prompt not found. Tried: ${candidates.join(', ')}`);
}

/**
 * Detect framework from package.json so `bridge guide flags` can be called
 * bare. Same heuristic order as `bridge flag init`.
 */
export async function resolveFlagsFramework(
  override: string | undefined,
  cwd: string,
): Promise<FlagsFramework | undefined> {
  if (override) {
    if (!FLAGS_FRAMEWORKS.includes(override as FlagsFramework)) {
      throw new Error(
        `Unknown --framework: ${override}. Must be one of ${FLAGS_FRAMEWORKS.join(', ')}.`,
      );
    }
    return override as FlagsFramework;
  }
  try {
    const raw = await readFile(join(cwd, 'package.json'), 'utf-8');
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    if ('next' in deps) return 'nextjs';
    if ('@sveltejs/kit' in deps || 'svelte' in deps) return 'svelte';
    if ('@nestjs/core' in deps) return 'nestjs';
    if ('@angular/core' in deps) return 'angular';
    if ('react' in deps) return 'react';
    if ('express' in deps) return 'express';
  } catch {
    /* no package.json — fall through */
  }
  return undefined;
}

/**
 * Bridge-cli only bundles the generic master orchestrators. Per-framework
 * prompts always come from the plugin repos' mcp/ folder via `fetchGuide`.
 */
export async function fetchFlagsMasterPrompt(): Promise<string> {
  return fetchBundledMaster('flags');
}

export async function fetchBillingMasterPrompt(): Promise<string> {
  return fetchBundledMaster('billing');
}

async function fetchBundledMaster(feature: 'flags' | 'billing'): Promise<string> {
  const filename = 'master.md';

  // Local override for development (same env var as the rest of the guides).
  const localDir = process.env.BRIDGE_GUIDE_LOCAL_DIR;
  if (localDir) {
    const localPath = join(localDir, 'bridge-cli', 'bridge-cli', 'prompts', feature, filename);
    try {
      return await readFile(localPath, 'utf-8');
    } catch {
      /* fall through to bundled */
    }
  }

  // Two possible runtime locations:
  //   - Built CLI: dist/commands/guide.command.js → ../prompts/<feature>/master.md
  //   - Jest (ts-jest, run from src/): src/commands/guide.command.ts → ../../prompts/<feature>/master.md
  const here = thisDir();
  const candidates = [
    join(here, '..', 'prompts', feature, filename),
    join(here, '..', '..', 'prompts', feature, filename),
  ];
  for (const path of candidates) {
    try {
      return await readFile(path, 'utf-8');
    } catch {
      /* try next */
    }
  }
  const label = feature === 'flags' ? 'Flags' : 'Billing';
  throw new Error(
    `${label} master prompt not found. Tried: ${candidates.join(', ')}`,
  );
}

/**
 * Detect framework for Billing 2.0. Mirrors resolveFlagsFramework — same
 * package.json heuristic order, validated against BILLING_FRAMEWORKS.
 */
export async function resolveBillingFramework(
  override: string | undefined,
  cwd: string,
): Promise<BillingFramework | undefined> {
  if (override) {
    if (!BILLING_FRAMEWORKS.includes(override as BillingFramework)) {
      throw new Error(
        `Unknown --framework: ${override}. Must be one of ${BILLING_FRAMEWORKS.join(', ')}.`,
      );
    }
    return override as BillingFramework;
  }
  try {
    const raw = await readFile(join(cwd, 'package.json'), 'utf-8');
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    if ('next' in deps) return 'nextjs';
    if ('@sveltejs/kit' in deps || 'svelte' in deps) return 'svelte';
    if ('@nestjs/core' in deps) return 'nestjs';
    if ('@angular/core' in deps) return 'angular';
    if ('react' in deps) return 'react';
    if ('express' in deps) return 'express';
  } catch {
    /* no package.json — fall through */
  }
  return undefined;
}

async function ensureAuthenticated(): Promise<void> {
  const creds = readCredentials();
  if (!creds || isExpired(creds)) {
    process.stdout.write('No active Bridge session — opening your browser to log in.\n');
    await runLogin({});
  }
}

async function fetchGuide(tech: string, feature?: string): Promise<string> {
  const cacheKey = feature ? `${tech}:${feature}` : tech;
  const cached = guideCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.content;
  }

  const repoPrefix = GUIDE_REPOS[tech];
  if (!repoPrefix) throw new Error(`Unknown technology: ${tech}`);

  const filename = guideFilename(feature);

  // Local override for development: reads from filesystem before hitting GitHub
  const localDir = process.env.BRIDGE_GUIDE_LOCAL_DIR;
  if (localDir) {
    const localPath = join(localDir, `bridge-${tech}`, 'mcp', filename);
    try {
      const content = await readFile(localPath, 'utf-8');
      guideCache.set(cacheKey, { content, fetchedAt: Date.now() });
      return content;
    } catch {
      // Local file not found — fall through to remote fetch
    }
  }

  const url = pluginGuideUrl(repoPrefix, filename);
  const response = await fetch(url);

  if (!response.ok) {
    const label = feature ? `${tech}/${feature}` : tech;
    throw new Error(`Guide not available for ${label} (HTTP ${response.status}). The prompt file may not exist yet in the plugin repo.`);
  }

  const content = await response.text();
  guideCache.set(cacheKey, { content, fetchedAt: Date.now() });
  return content;
}

async function fetchMasterPrompt(): Promise<string> {
  const filename = AUTH_MASTER_PROMPT_FILENAME;

  // Local override for development
  const localDir = process.env.BRIDGE_GUIDE_LOCAL_DIR;
  if (localDir) {
    const localPath = join(localDir, 'bridge-cli', 'bridge-cli', 'prompts', filename);
    try {
      return await readFile(localPath, 'utf-8');
    } catch { /* fall through */ }
  }

  // Resolved-on-disk fallback (when the CLI runs from its own checkout).
  const here = thisDir();
  const candidates = [
    join(here, '..', 'prompts', filename),
    join(here, '..', '..', 'prompts', filename),
  ];
  for (const path of candidates) {
    try {
      return await readFile(path, 'utf-8');
    } catch {
      /* try next */
    }
  }

  // Remote fetch
  const response = await fetch(AUTH_MASTER_PROMPT_URL);
  if (!response.ok) {
    throw new Error(`Auth master integration prompt not available (HTTP ${response.status})`);
  }
  return response.text();
}

const CUSTOM_GUIDE = `# Universal Bridge Integration Guide

This guide covers integrating Bridge into any language/framework using the REST API directly.

## 1. Authentication — JWKS-based JWT Verification

Bridge issues JWTs signed with PS256. Verify them using your app's JWKS endpoint:

\`\`\`
GET https://api.thebridge.dev/v1/account/app/.well-known/jwks.json
\`\`\`

Use a JWT library in your language that supports JWKS auto-refresh:
- Node.js: \`jose\`
- Python: \`PyJWKClient\` from \`PyJWT\`
- Go: \`github.com/lestrrat-go/jwx\`
- Java: \`com.nimbusds:nimbus-jose-jwt\`
- Ruby: \`jwt\` gem

## 2. Token Structure

The access token contains:
- \`sub\` — User ID
- \`tid\` — Tenant ID
- \`role\` — User's role
- \`privileges\` — Array of privilege strings
- \`plan\` — Tenant's plan key

## 3. Feature Flags

Evaluate flags server-side:
\`\`\`
POST https://api.thebridge.dev/cloud-views/flags/bulkEvaluate/{appId}
Authorization: Bearer <user-access-token>
\`\`\`

## 4. User/Tenant Management

Use the Bridge REST API with an API token:
\`\`\`
GET https://api.thebridge.dev/v1/account/tenant
x-api-key: <your-api-token>
\`\`\`

## 5. Webhooks

Configure a webhook URL in your app settings to receive events:
- User created/updated/deleted
- Tenant created/updated
- Subscription changes

See the Bridge API documentation for the full webhook payload format.
`;
