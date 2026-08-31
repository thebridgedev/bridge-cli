import { Command } from 'commander';
import { getManagementClient } from '../config.js';
import { outputSuccess, outputError } from '../output.js';
import { resolvePrivilegeId } from '../resolve.js';

/**
 * TBP-589 / TBP-592 — `bridge privilege` did not exist.
 *
 * The account API has served full CRUD under `/account/role/privilege` all
 * along; nothing in the CLI reached it. An app with custom privileges — which
 * is most non-trivial apps — therefore could not be provisioned by the CLI at
 * all. Porting one real app meant ten raw `POST /account/role/privilege` calls
 * with the credential JWT passed as `x-api-key`, entirely outside the tool
 * that exists to do this.
 *
 * `role create --privileges` also depends on `list` here: it resolves the keys
 * a human types into the ids the API stores.
 */
export function registerPrivilegeCommands(program: Command): void {
  const privilege = program
    .command('privilege')
    .description('Manage the privileges roles are built from');

  privilege.command('list')
    .description('List all privileges defined for this app')
    .action(async () => {
      try { outputSuccess(await getManagementClient().roles.listPrivileges()); }
      catch (err) { outputError(err); }
    });

  privilege.command('create')
    .description('Create a new privilege')
    .requiredOption('--key <key>', 'Privilege key, e.g. CASE_READ')
    .option('--description <desc>', 'What this privilege grants')
    .action(async (opts) => {
      try {
        outputSuccess(await getManagementClient().roles.createPrivilege({
          key: opts.key,
          description: opts.description,
        }));
      } catch (err) { outputError(err); }
    });

  privilege.command('update')
    .description('Update a privilege by --key or --id')
    .option('--key <key>', 'Privilege key to address (alternative to --id)')
    .option('--id <id>', 'Privilege ID to address (alternative to --key)')
    .option('--new-key <key>', 'Rename the privilege to this key')
    .option('--description <desc>', 'What this privilege grants')
    .action(async (opts) => {
      try {
        const id = await resolvePrivilegeId({ id: opts.id, key: opts.key });
        // `--key` addresses; `--new-key` renames. Keeping them separate means
        // addressing by key can never be misread as a rename (TBP-586).
        const data: { key?: string; description?: string } = {};
        if (opts.newKey !== undefined) data.key = opts.newKey;
        if (opts.description !== undefined) data.description = opts.description;
        outputSuccess(await getManagementClient().roles.updatePrivilege(id, data));
      } catch (err) { outputError(err); }
    });

  privilege.command('delete')
    .description('Delete a privilege by --key or --id')
    .option('--key <key>', 'Privilege key to address (alternative to --id)')
    .option('--id <id>', 'Privilege ID to address (alternative to --key)')
    .action(async (opts) => {
      try {
        const id = await resolvePrivilegeId({ id: opts.id, key: opts.key });
        // Needs ROLE_DELETE on the token. Destructive privileges are opt-in
        // (TBP-552) — a plain `bridge auth login` token is refused with 403;
        // `bridge auth login --admin` requests them (TBP-593).
        await getManagementClient().roles.deletePrivilege(id);
        outputSuccess({ deleted: true, id });
      } catch (err) { outputError(err); }
    });
}
