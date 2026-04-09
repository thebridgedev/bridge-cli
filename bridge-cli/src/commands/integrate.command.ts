import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { outputSuccess, outputError } from '../output.js';

const MASTER_PROMPT_GITHUB_URL =
  'https://raw.githubusercontent.com/nebulr-group/bridge-cli/main/prompts/master-integration-prompt.md';

export function registerIntegrateCommand(program: Command): void {
  program
    .command('integrate')
    .description('Get the master integration prompt — detects your project and guides you through Bridge setup')
    .action(async () => {
      try {
        const content = await fetchMasterPrompt();
        outputSuccess({ guide: content });
      } catch (err) {
        outputError(err);
      }
    });
}

async function fetchMasterPrompt(): Promise<string> {
  // Local override for development
  const localDir = process.env.BRIDGE_GUIDE_LOCAL_DIR;
  if (localDir) {
    // The master prompt lives alongside the CLI, not in a plugin repo
    const localPath = join(localDir, 'bridge-cli', 'bridge-cli', 'prompts', 'master-integration-prompt.md');
    try {
      return await readFile(localPath, 'utf-8');
    } catch {
      // Fall through to bundled copy
    }
  }

  // Try bundled copy (relative to dist/)
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const bundledPath = join(__dirname, '..', 'prompts', 'master-integration-prompt.md');
    return await readFile(bundledPath, 'utf-8');
  } catch {
    // Fall through to remote fetch
  }

  // Remote fetch as last resort
  const response = await fetch(MASTER_PROMPT_GITHUB_URL);
  if (!response.ok) {
    throw new Error(`Master integration prompt not available (HTTP ${response.status})`);
  }
  return response.text();
}
