import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Command } from 'commander';
import { registerCommands, registerGlobalOptions } from './program.js';

// Read version from package.json so `bridge --version` never drifts from the
// published package. dist/cli.js lives at <pkg>/dist/cli.js, so `../package.json`
// resolves to the package root in both the published tarball and during dev.
const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
const { version } = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };

export const program = new Command();

program
  .name('bridge')
  .description('Bridge platform CLI — optimized for AI coding agents')
  .version(version);

// TBP-628 `--profile` (which stored login) and TBP-769 `--app` (which app
// within that login), plus the preAction hook that applies them.
registerGlobalOptions(program);

registerCommands(program);
