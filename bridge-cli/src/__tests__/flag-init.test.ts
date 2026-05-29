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
import { detectFramework, renderSnippet } from '../commands/flag-init.command';

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
    expect(s).toMatch(/app-123/);
  });

  it('renders a React snippet', () => {
    const s = renderSnippet('react', ctx);
    expect(s).toMatch(/BridgeFlagsProvider/);
    expect(s).toMatch(/@nebulr-group\/bridge-react\/flags/);
  });

  it('renders a Next.js snippet covering client + server', () => {
    const s = renderSnippet('nextjs', ctx);
    expect(s).toMatch(/app\/providers\.tsx/);
    expect(s).toMatch(/getServerBridgeFlags/);
    expect(s).toMatch(/@nebulr-group\/bridge-nextjs\/flags/);
  });

  it('renders a NestJS snippet with backend mode', () => {
    const s = renderSnippet('nestjs', ctx);
    expect(s).toMatch(/BridgeFlagsModule/);
    expect(s).toMatch(/mode: "backend"/);
  });

  it('renders an Express snippet with middleware', () => {
    const s = renderSnippet('express', ctx);
    expect(s).toMatch(/createBridgeFlags/);
    expect(s).toMatch(/middleware/);
  });

  it('renders an Angular snippet with provideBridgeFlags', () => {
    const s = renderSnippet('angular', ctx);
    expect(s).toMatch(/provideBridgeFlags/);
    expect(s).toMatch(/@nebulr-group\/bridge-angular\/flags/);
  });

  it('returns a generic fallback for unknown', () => {
    const s = renderSnippet('unknown', ctx);
    expect(s).toMatch(/generic setup/i);
    expect(s).toMatch(/BridgeFlags/);
  });
});
