import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { outputSuccess, outputError } from '../output.js';

const GUIDE_BASE_URL = 'https://raw.githubusercontent.com/nebulr-group';
const GUIDE_REPOS: Record<string, string> = {
  react: 'bridge-react/main',
  svelte: 'bridge-svelte/main',
  angular: 'bridge-angular/main',
  nextjs: 'bridge-nextjs/main',
  express: 'bridge-express/main',
  nestjs: 'bridge-nestjs/main',
};

const AVAILABLE_FEATURES: Record<string, string[]> = {
  svelte: ['sdk-auth', 'feature-flags', 'payments', 'team'],
};

function guideFilename(feature?: string): string {
  if (!feature) return 'integration-prompt.md';
  return `${feature}-prompt.md`;
}

const guideCache = new Map<string, { content: string; fetchedAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function registerGuideCommands(program: Command): void {
  const guide = program.command('guide')
    .description('Integration guides — run with no arguments for the master integration prompt')
    .action(async () => {
      try {
        const content = await fetchMasterPrompt();
        outputSuccess({ guide: content });
      } catch (err) { outputError(err); }
    });

  const technologies = [...Object.keys(GUIDE_REPOS), 'custom'];

  guide.command('list')
    .description('List available integration guides and feature guides')
    .action(() => {
      outputSuccess({ technologies, features: AVAILABLE_FEATURES });
    });

  for (const tech of Object.keys(GUIDE_REPOS)) {
    guide.command(tech)
      .argument('[feature]', 'Feature guide (e.g. sdk-auth, feature-flags, payments, team)')
      .description(`Integration guide for ${tech}`)
      .action(async (feature?: string) => {
        try {
          const content = await fetchGuide(tech, feature);
          outputSuccess({ technology: tech, feature: feature ?? 'default', guide: content });
        } catch (err) { outputError(err); }
      });
  }

  guide.command('custom')
    .description('Universal integration guide for any technology using REST API + JWKS')
    .action(() => {
      outputSuccess({
        technology: 'custom',
        guide: CUSTOM_GUIDE,
      });
    });
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

  const url = `${GUIDE_BASE_URL}/${repoPrefix}/mcp/${filename}`;
  const response = await fetch(url);

  if (!response.ok) {
    const label = feature ? `${tech}/${feature}` : tech;
    throw new Error(`Guide not available for ${label} (HTTP ${response.status}). The prompt file may not exist yet in the plugin repo.`);
  }

  const content = await response.text();
  guideCache.set(cacheKey, { content, fetchedAt: Date.now() });
  return content;
}

const MASTER_PROMPT_GITHUB_URL =
  'https://raw.githubusercontent.com/nebulr-group/bridge-cli/main/prompts/master-integration-prompt.md';

async function fetchMasterPrompt(): Promise<string> {
  // Local override for development
  const localDir = process.env.BRIDGE_GUIDE_LOCAL_DIR;
  if (localDir) {
    const localPath = join(localDir, 'bridge-cli', 'bridge-cli', 'prompts', 'master-integration-prompt.md');
    try {
      return await readFile(localPath, 'utf-8');
    } catch { /* fall through */ }
  }

  // Remote fetch
  const response = await fetch(MASTER_PROMPT_GITHUB_URL);
  if (!response.ok) {
    throw new Error(`Master integration prompt not available (HTTP ${response.status})`);
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
