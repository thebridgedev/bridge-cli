import { Command } from 'commander';
import { getManagementClient } from '../config.js';
import { outputSuccess, outputError } from '../output.js';

export function registerBrandingCommands(program: Command): void {
  const branding = program.command('branding').description('Manage branding');

  branding.command('get')
    .description('Get current branding configuration')
    .action(async () => {
      try { outputSuccess(await getManagementClient().branding.get()); }
      catch (err) { outputError(err); }
    });

  branding.command('update')
    .description('Update branding')
    .option('--bg-color <color>', 'Background color')
    .option('--text-color <color>', 'Text color')
    .option('--link-color <color>', 'Link color')
    .option('--primary-btn-bg <color>', 'Primary button background')
    .option('--primary-btn-text <color>', 'Primary button text')
    .option('--font-family <font>', 'Font family')
    .option('--border-radius <radius>', 'Border radius')
    .action(async (opts) => {
      try {
        const data = Object.fromEntries(
          Object.entries({
            bgColor: opts.bgColor,
            textColor: opts.textColor,
            linkColor: opts.linkColor,
            primaryButtonBgColor: opts.primaryBtnBg,
            primaryButtonTextColor: opts.primaryBtnText,
            fontFamily: opts.fontFamily,
            borderRadius: opts.borderRadius,
          }).filter(([, v]) => v !== undefined),
        );
        outputSuccess(await getManagementClient().branding.update(data as any));
      } catch (err) { outputError(err); }
    });
}
