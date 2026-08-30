/**
 * TBP-585 — the remote prompt URLs are only exercised when the bundled copy is
 * missing, so a wrong one stays invisible to everyone except the user who hits
 * the fallback. These tests pin the exact strings (verified 200 against
 * raw.githubusercontent.com) and forbid new hardcoded copies from drifting in.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  AUTH_MASTER_PROMPT_URL,
  CLI_PROMPTS_BASE_URL,
  GITHUB_RAW_BASE_URL,
  cliPromptUrl,
  pluginGuideUrl,
} from '../prompt-urls';

const RAW = 'https://raw.githubusercontent.com';

describe('prompt URLs', () => {
  it('uses the thebridgedev org', () => {
    expect(GITHUB_RAW_BASE_URL).toBe(`${RAW}/thebridgedev`);
  });

  it('keeps the nested bridge-cli/bridge-cli package path', () => {
    // The npm package sits in a subdirectory of the repo; dropping the second
    // `bridge-cli` segment is a 404.
    expect(CLI_PROMPTS_BASE_URL).toBe(`${RAW}/thebridgedev/bridge-cli/main/bridge-cli/prompts`);
  });

  it('builds the auth master integration prompt URL', () => {
    expect(AUTH_MASTER_PROMPT_URL).toBe(
      `${RAW}/thebridgedev/bridge-cli/main/bridge-cli/prompts/auth-master-integration-prompt.md`,
    );
  });

  it('builds the flags and billing master prompt URLs', () => {
    expect(cliPromptUrl('flags', 'master.md')).toBe(
      `${RAW}/thebridgedev/bridge-cli/main/bridge-cli/prompts/flags/master.md`,
    );
    expect(cliPromptUrl('billing', 'master.md')).toBe(
      `${RAW}/thebridgedev/bridge-cli/main/bridge-cli/prompts/billing/master.md`,
    );
  });

  it('builds per-framework plugin guide URLs from the same base', () => {
    expect(pluginGuideUrl('bridge-svelte/main', 'feature-flags-prompt.md')).toBe(
      `${RAW}/thebridgedev/bridge-svelte/main/mcp/feature-flags-prompt.md`,
    );
    expect(pluginGuideUrl('bridge-nestjs/main', 'billing-prompt.md')).toBe(
      `${RAW}/thebridgedev/bridge-nestjs/main/mcp/billing-prompt.md`,
    );
  });
});

describe('no drifting copies of the base URL', () => {
  async function tsFiles(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await tsFiles(full)));
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
    return out;
  }

  it('only prompt-urls.ts mentions raw.githubusercontent.com', async () => {
    const srcRoot = join(__dirname, '..');
    const allowed = new Set([
      join(srcRoot, 'prompt-urls.ts'),
      join(__dirname, 'prompt-urls.test.ts'),
    ]);
    const offenders: string[] = [];
    for (const file of await tsFiles(srcRoot)) {
      if (allowed.has(file)) continue;
      const content = await readFile(file, 'utf-8');
      if (content.includes('raw.githubusercontent.com')) offenders.push(relative(srcRoot, file));
    }
    expect(offenders).toEqual([]);
  });
});
