import { z } from 'zod';
import type { BridgeToolDefinition } from '../types.js';
import { toErrorResult } from './errors.js';

/**
 * Branding write tool — mirrors `bridge branding update` (same seven
 * properties, partial update, only defined fields sent). The management type
 * `UpdateBrandingRequest` declares every field required, but the API accepts
 * partial updates — the CLI casts at the same boundary.
 */
export const updateBrandingTool: BridgeToolDefinition<{
  bgColor: z.ZodOptional<z.ZodString>;
  textColor: z.ZodOptional<z.ZodString>;
  linkColor: z.ZodOptional<z.ZodString>;
  primaryButtonBgColor: z.ZodOptional<z.ZodString>;
  primaryButtonTextColor: z.ZodOptional<z.ZodString>;
  fontFamily: z.ZodOptional<z.ZodString>;
  borderRadius: z.ZodOptional<z.ZodString>;
}> = {
  name: 'update_branding',
  description:
    "Update the Bridge-hosted auth pages' branding (login, signup, etc.). Only the fields " +
    'you pass are changed: bgColor, textColor, linkColor, primaryButtonBgColor, ' +
    'primaryButtonTextColor (CSS color values, e.g. "#1a1a2e"), fontFamily (CSS font-family ' +
    'value) and borderRadius (CSS length, e.g. "8px"). Returns the full updated branding ' +
    'configuration.',
  inputSchema: {
    bgColor: z.string().min(1).optional().describe('Page background color (CSS color).'),
    textColor: z.string().min(1).optional().describe('Body text color (CSS color).'),
    linkColor: z.string().min(1).optional().describe('Link color (CSS color).'),
    primaryButtonBgColor: z
      .string()
      .min(1)
      .optional()
      .describe('Primary button background color (CSS color).'),
    primaryButtonTextColor: z
      .string()
      .min(1)
      .optional()
      .describe('Primary button text color (CSS color).'),
    fontFamily: z.string().min(1).optional().describe('Font family (CSS font-family value).'),
    borderRadius: z.string().min(1).optional().describe('Border radius (CSS length, e.g. "8px").'),
  },
  handler: async (ctx, args) => {
    try {
      const data = Object.fromEntries(
        Object.entries({
          bgColor: args.bgColor,
          textColor: args.textColor,
          linkColor: args.linkColor,
          primaryButtonBgColor: args.primaryButtonBgColor,
          primaryButtonTextColor: args.primaryButtonTextColor,
          fontFamily: args.fontFamily,
          borderRadius: args.borderRadius,
        }).filter(([, v]) => v !== undefined),
      );
      if (Object.keys(data).length === 0) {
        return {
          success: false,
          error: {
            code: 'NO_FIELDS',
            message: 'No branding properties were provided; nothing to update.',
            fix: 'Pass at least one branding property, e.g. bgColor or primaryButtonBgColor.',
          },
        };
      }
      const branding = await ctx.management.branding.update(data as never);
      return { success: true, data: branding };
    } catch (err) {
      return toErrorResult(err);
    }
  },
};
