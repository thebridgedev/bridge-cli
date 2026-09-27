import { HttpError } from '@nebulr-group/bridge-auth-core';
import { getManagementHttp } from './config.js';

/*
 * TBP-709 (E) — `--dry-run` on the destructive commands.
 *
 * The preview is the server's: every delete route has a read-only sibling,
 * `GET <route>/deletion-preview`, that answers with what the delete would
 * remove and removes nothing. It passes the same guards as the delete, so a
 * login without the destructive privilege gets the same 403 — and it is the
 * same answer the MCP tools' `dryRun` shows.
 *
 * Why a GET on its own path, and never `?dryRun=true` on the DELETE: this CLI
 * is released separately from the server and is pointed at servers that
 * predate previews. Such a server ignores an unknown query parameter and
 * PERFORMS THE DELETE; it answers an unknown path with 404. So a 404 here
 * means "no previews on this server", and the command stops — it never falls
 * back to the delete.
 */
export class PreviewNotSupportedError extends Error {
  readonly code = 'PREVIEW_NOT_SUPPORTED';
  constructor(readonly path: string, readonly serverBody?: unknown) {
    super(
      `This Bridge server does not support deletion previews yet (GET ${path} answered 404). ` +
        'Nothing was deleted. Run without --dry-run only if you mean to delete.',
    );
    this.name = 'PreviewNotSupportedError';
  }
}

/*
 * A server that HAS the route still 404s a record that does not exist, with
 * its own message ("tenant not found"). An unknown route gets the framework's
 * "Cannot GET …" (or a bare "Not Found" from a proxy in front). Only the
 * former is passed through as-is; either way the command fails and deletes
 * nothing — this only decides which message the user reads.
 */
function isRecordNotFound(body: unknown): boolean {
  const message = body && typeof body === 'object' ? (body as { message?: unknown }).message : undefined;
  return typeof message === 'string' && !/^Cannot GET\b/.test(message) && message !== 'Not Found';
}

export function previewPath(path: string): string {
  return `${path}/deletion-preview`;
}

export async function dryRunPreview(path: string, headers?: Record<string, string>): Promise<unknown> {
  const route = previewPath(path);
  let preview: Record<string, unknown>;
  try {
    preview = await getManagementHttp().get<Record<string, unknown>>(route, headers);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404 && !isRecordNotFound(err.body)) {
      throw new PreviewNotSupportedError(route, err.body);
    }
    throw err;
  }
  return {
    ...(preview && typeof preview === 'object' ? preview : {}),
    dryRun: true,
    next: 'Nothing was changed. Run the same command without --dry-run to go ahead.',
  };
}
