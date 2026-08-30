/**
 * Single source of truth for every raw.githubusercontent.com URL the CLI builds.
 *
 * TBP-585: `bridge integrate` and `bridge guide` each hardcoded their own copy
 * of the base URL and drifted — integrate pointed at the wrong GitHub org
 * (`nebulr-group`) *and* the wrong path (missing the nested package dir), so its
 * remote fallback was a permanent 404. The fallback is invisible in normal use
 * (an installed CLI reads the bundled prompt first), which is exactly why it
 * must be derived rather than retyped.
 *
 * Nothing outside this module should contain a raw.githubusercontent literal;
 * `src/__tests__/prompt-urls.test.ts` enforces that.
 */

/** GitHub org that owns every Bridge repo the CLI reads content from. */
export const GITHUB_RAW_BASE_URL = 'https://raw.githubusercontent.com/thebridgedev';

/**
 * The published npm package lives in a `bridge-cli/` subdirectory of the
 * `bridge-cli` repo — hence the doubled segment. Dropping it yields a 404.
 */
export const CLI_PROMPTS_BASE_URL = `${GITHUB_RAW_BASE_URL}/bridge-cli/main/bridge-cli/prompts`;

/** URL of a prompt bundled in this repo, e.g. cliPromptUrl('flags', 'master.md'). */
export function cliPromptUrl(...segments: string[]): string {
  return [CLI_PROMPTS_BASE_URL, ...segments].join('/');
}

/**
 * URL of a per-framework prompt owned by a plugin repo. `repoPrefix` is the
 * `<repo>/<ref>` pair from GUIDE_REPOS, e.g. `bridge-svelte/main`.
 */
export function pluginGuideUrl(repoPrefix: string, filename: string): string {
  return `${GITHUB_RAW_BASE_URL}/${repoPrefix}/mcp/${filename}`;
}

/** Master auth integration prompt — shared by `bridge integrate` and `bridge guide`. */
export const AUTH_MASTER_PROMPT_FILENAME = 'auth-master-integration-prompt.md';
export const AUTH_MASTER_PROMPT_URL = cliPromptUrl(AUTH_MASTER_PROMPT_FILENAME);
