#!/usr/bin/env node
import { program } from './cli.js';

program.parseAsync(process.argv).catch(() => {
  if (!process.exitCode) process.exitCode = 1;
});
