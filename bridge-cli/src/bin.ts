#!/usr/bin/env node
import { program } from './cli.js';

program.parseAsync(process.argv).catch(() => {
  // Keep a more specific code already set (e.g. 3 for a config error printed
  // by the preAction hook before it aborted the action).
  if (!process.exitCode) process.exitCode = 1;
});
