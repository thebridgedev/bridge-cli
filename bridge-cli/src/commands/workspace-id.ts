import { workspaces } from '../api/accounts.js';
import type { Context } from './context.js';

/** A workspace's id from its id or its name. */
export async function findWorkspaceId(ctx: Context, wanted: string): Promise<string> {
  return (await workspaces.find(await ctx.door(), wanted)).id;
}
