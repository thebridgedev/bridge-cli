/**
 * TBP-198 — Unit tests for flags-only scaffold helpers.
 *
 * Covers:
 *   - detectFramework() — Next.js takes precedence over React; SvelteKit
 *     detected from `@sveltejs/kit`; NestJS from `@nestjs/core`; unknown
 *     when no signal matches.
 *   - renderSnippet() — happy path per framework + unknown fallback.
 */

// Mock auth-core for the same reason as flag-command.test.ts.
jest.mock(
  '@nebulr-group/bridge-auth-core',
  () => ({
    __esModule: true,
    BridgeManagement: jest.fn(),
    HttpError: class HttpError extends Error {},
  }),
  { virtual: true },
);

import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectFramework, renderSnippet, type FlagsFramework } from '../commands/flag-init.command';

async function makeProjectWith(deps: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-cli-flag-init-'));
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'tmp', dependencies: deps }),
    'utf8',
  );
  return dir;
}

describe('detectFramework', () => {
  let dirs: string[] = [];

  afterEach(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
    dirs = [];
  });

  async function project(deps: Record<string, string>): Promise<string> {
    const d = await makeProjectWith(deps);
    dirs.push(d);
    return d;
  }

  it('returns "nextjs" when next is present (even with react)', async () => {
    const cwd = await project({ next: '14.0.0', react: '18.0.0' });
    await expect(detectFramework(cwd)).resolves.toBe('nextjs');
  });

  it('returns "svelte" for SvelteKit', async () => {
    const cwd = await project({ '@sveltejs/kit': '^2.0.0', svelte: '^5.0.0' });
    await expect(detectFramework(cwd)).resolves.toBe('svelte');
  });

  it('returns "nestjs" for a NestJS project', async () => {
    const cwd = await project({ '@nestjs/core': '^10.0.0' });
    await expect(detectFramework(cwd)).resolves.toBe('nestjs');
  });

  it('returns "angular" for an Angular project', async () => {
    const cwd = await project({ '@angular/core': '^17.0.0' });
    await expect(detectFramework(cwd)).resolves.toBe('angular');
  });

  it('returns "react" when only react is present', async () => {
    const cwd = await project({ react: '18.0.0' });
    await expect(detectFramework(cwd)).resolves.toBe('react');
  });

  it('returns "express" for a plain express server', async () => {
    const cwd = await project({ express: '4.18.0' });
    await expect(detectFramework(cwd)).resolves.toBe('express');
  });

  it('returns "unknown" when no signal matches', async () => {
    const cwd = await project({ lodash: '^4.0.0' });
    await expect(detectFramework(cwd)).resolves.toBe('unknown');
  });

  it('returns "unknown" when no package.json exists', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bridge-cli-no-pkg-'));
    dirs.push(cwd);
    await expect(detectFramework(cwd)).resolves.toBe('unknown');
  });
});

describe('renderSnippet', () => {
  const ctx = { appId: 'app-123', baseUrl: 'https://api.thebridge.dev' };

  it('renders a Svelte snippet', () => {
    const s = renderSnippet('svelte', ctx);
    expect(s).toMatch(/SvelteKit/);
    expect(s).toMatch(/@nebulr-group\/bridge-svelte\/flags/);
    expect(s).toMatch(/useFlag/);
    expect(s).toMatch(/bridgeConfig\.initConfig/);
    expect(s).toMatch(/app-123/);
  });

  it('renders a React snippet using BridgeProvider + useFlag', () => {
    const s = renderSnippet('react', ctx);
    expect(s).toMatch(/<BridgeProvider/);
    expect(s).toMatch(/@nebulr-group\/bridge-react\/flags/);
    expect(s).toMatch(/const \{ value: enabled \} = useFlag/);
  });

  it('renders a Next.js snippet covering client + server', () => {
    const s = renderSnippet('nextjs', ctx);
    expect(s).toMatch(/app\/providers\.tsx/);
    expect(s).toMatch(/@nebulr-group\/bridge-nextjs\/client/);
    expect(s).toMatch(/@nebulr-group\/bridge-nextjs\/server/);
    expect(s).toMatch(/FeatureFlagServer\.getInstance\(\)/);
    expect(s).toMatch(/flagServer\(/);
  });

  it('renders a NestJS snippet with backend mode', () => {
    const s = renderSnippet('nestjs', ctx);
    expect(s).toMatch(/BridgeFlagsModule/);
    expect(s).toMatch(/mode: 'backend'/);
    expect(s).toMatch(/apiBaseUrl:/);
    expect(s).toMatch(/apiKey:/);
  });

  it('renders an Express snippet using createBridge + protect', () => {
    const s = renderSnippet('express', ctx);
    expect(s).toMatch(/createBridge\(/);
    expect(s).toMatch(/bridge\.auth\(\)/);
    expect(s).toMatch(/bridge\.protect\(\{ featureFlag: 'new-home' \}\)/);
    expect(s).toMatch(/FeatureFlagService/);
    expect(s).toMatch(/isEnabled\(/);
  });

  it('renders an Angular snippet with provideBridge + BridgeService', () => {
    const s = renderSnippet('angular', ctx);
    expect(s).toMatch(/provideBridge\(\{/);
    expect(s).toMatch(/BridgeService/);
    expect(s).toMatch(/this\.bridge\.flag\(/);
  });

  it('returns a generic fallback for unknown', () => {
    const s = renderSnippet('unknown', ctx);
    expect(s).toMatch(/generic setup/i);
    expect(s).toMatch(/BridgeFlags/);
    expect(s).toMatch(/\{ value: newDashboard \} = bridge\.flag/);
  });

  // TBP-206 regression guard: every snippet must reference only import
  // specifiers and symbols that actually exist. These were all emitted by the
  // pre-fix scaffold and none of them resolve.
  const PHANTOM_SYMBOLS = [
    'createBridgeFlags(',
    'BridgeFlagsProvider',
    'provideBridgeFlags',
    'getServerBridgeFlags',
    'req.bridge.flag',
    '@nebulr-group/bridge-express/flags',
    '@nebulr-group/bridge-nextjs/flags',
    '@nebulr-group/bridge-angular/flags',
    // bridge-nestjs has no `exports` map, so this specifier 404s at runtime.
    "'@nebulr-group/bridge-nestjs/flags'",
  ];

  it.each<FlagsFramework>(['svelte', 'react', 'nextjs', 'angular', 'nestjs', 'express', 'unknown'])(
    'the %s snippet references no non-existent API',
    (framework) => {
      const s = renderSnippet(framework, ctx);
      for (const phantom of PHANTOM_SYMBOLS) {
        expect(s).not.toContain(phantom);
      }
    },
  );
});
