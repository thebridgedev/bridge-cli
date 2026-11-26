import { spawn } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser } from './auth/browser-open.js';
import { processIo } from './io.js';
import { buildProgram } from './program.js';

// dist/cli.js sits at <package>/dist/cli.js, so the version is in ../package.json.
const here = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version: string };

export const program = buildProgram(
  {
    fetch: (input, init) => fetch(input, init),
    env: process.env,
    io: processIo,
    openBrowser,
    updates: {
      installPath: realpathSync(fileURLToPath(import.meta.url)),
      // The package manager's own output goes to stderr, so stdout stays the command's result.
      run: (command, args) =>
        new Promise((resolve) => {
          const child = spawn(command, [...args], { stdio: ['inherit', process.stderr, 'inherit'], shell: process.platform === 'win32' });
          child.on('error', () => resolve(127));
          child.on('exit', (code) => resolve(code ?? 1));
        }),
    },
  },
  version,
);
