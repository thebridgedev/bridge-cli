#!/usr/bin/env node
import { program } from './cli.js';

program.parseAsync(process.argv).catch(() => {
  process.exitCode = 1;
});
