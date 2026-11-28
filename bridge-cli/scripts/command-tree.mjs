#!/usr/bin/env node
// CLI 1.0's command paths, one per line, from commander itself (run `npm run build` first).
// The plugin repos keep a copy as scripts/cli-1.0-commands.txt for their guides' currency tests:
//   node scripts/command-tree.mjs > <plugin>/scripts/cli-1.0-commands.txt
// With --options, each path is followed by its long options.
import { buildProgram } from '../dist/program.js';

const withOptions = process.argv.includes('--options');
const walk = (command, prefix) => {
  for (const sub of command.commands) {
    const path = `${prefix} ${sub.name()}`;
    const options = sub.options.map((option) => option.long).filter(Boolean);
    console.log(withOptions && options.length > 0 ? `${path}  ${options.join(' ')}` : path);
    walk(sub, path);
  }
};
walk(buildProgram({}, '0.0.0'), 'bridge');
