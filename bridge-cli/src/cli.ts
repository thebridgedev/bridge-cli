import { readFileSync } from 'node:fs';
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
  },
  version,
);
