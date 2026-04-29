/**
 * `bridge auth …` — top-level wiring for the auth command tree.
 *
 * Subcommand modules live in `./auth/*.command.ts`:
 *   - `login`           (TBP-113): browser-based PKCE auth.
 *   - `logout`          (TBP-113): revoke + delete credentials.
 *   - `status`          (TBP-113): show current login state.
 *   - `config`/`mfa`/`password-policy`: pre-existing app auth-config commands.
 */
import type { Command } from 'commander';
import { registerAuthLoginCommand } from './auth/login.command.js';
import { registerAuthLogoutCommand } from './auth/logout.command.js';
import { registerAuthStatusCommand } from './auth/status.command.js';
import { registerAuthConfigCommands } from './auth/config.command.js';

export function registerAuthCommands(program: Command): void {
  const auth = program
    .command('auth')
    .description('Authenticate with Bridge and manage app auth configuration');

  // TBP-113 — interactive credentials.
  registerAuthLoginCommand(auth);
  registerAuthLogoutCommand(auth);
  registerAuthStatusCommand(auth);

  // Pre-existing — app-level auth configuration.
  registerAuthConfigCommands(auth);
}
