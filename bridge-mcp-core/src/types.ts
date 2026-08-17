import type { BridgeManagement } from '@nebulr-group/bridge-auth-core';
import type { z } from 'zod';

/**
 * Everything a Bridge tool needs to do its work. Transport shells construct
 * this (an authenticated management client) and hand it to the core via the
 * ctxFactory passed to `registerBridgeTools` — the core never authenticates
 * or reads credentials itself.
 */
export interface ToolContext {
  management: BridgeManagement;
}

/**
 * Structured tool output, matching the Bridge CLI's stdout contract:
 * `{ success: true, data }` on success, `{ success: false, error }` on
 * failure, where `error.fix` is an optional agent-actionable remediation hint.
 */
export type ToolResult =
  | { success: true; data: unknown }
  | { success: false; error: { code: string; message: string; fix?: string } };

/**
 * A single transport-agnostic Bridge tool. `inputSchema` is a Zod raw shape
 * (the form the official MCP SDK consumes directly); the handler receives the
 * parsed arguments typed from that shape plus the ToolContext.
 */
export interface BridgeToolDefinition<S extends z.ZodRawShape> {
  name: string;
  description: string;
  inputSchema: S;
  handler: (
    ctx: ToolContext,
    args: z.objectOutputType<S, z.ZodTypeAny>,
  ) => Promise<ToolResult>;
}

/** Erased form used by the registry and registration loop. */
export type AnyBridgeToolDefinition = BridgeToolDefinition<z.ZodRawShape>;
