import { getManagementHttp } from './config.js';

/*
 * TBP-709 (E) — `--dry-run` on the destructive commands.
 *
 * The preview is the server's: the delete route itself answers
 * `?dryRun=true` with what the delete would remove and removes nothing. It
 * passes the same guards as the delete, so a login without the destructive
 * privilege gets the same 403 — and it is the same answer the MCP tools'
 * `dryRun` shows.
 */
export async function dryRunPreview(path: string, headers?: Record<string, string>): Promise<unknown> {
  const preview = await getManagementHttp().delete<Record<string, unknown>>(`${path}?dryRun=true`, headers);
  return {
    ...(preview && typeof preview === 'object' ? preview : {}),
    dryRun: true,
    next: 'Nothing was changed. Run the same command without --dry-run to go ahead.',
  };
}
