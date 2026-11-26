import { readPrivateFile, writePrivateFile } from './private-files.js';

/**
 * Telling the developer a newer CLI is out, on the line they use.
 *
 * - The line comes from the running version: a prerelease (`1.0.0-alpha.6`) follows `alpha`, any other `latest`, so a
 *   stable user is never told about an alpha.
 * - The registry is asked at most once a day, in the background while the command runs, with a short deadline. After
 *   the command, the CLI waits for it only a moment; a slow or unreachable registry prints nothing and delays nothing.
 * - The notice goes to stderr, after the command's own output, at most once a day; stdout and the exit code are the
 *   command's alone. It never asks anything. `BRIDGE_NO_UPDATE_NOTICE=true` switches it off.
 * - What was seen is kept in `<config dir>/update-check.json`, readable only by its owner.
 */
export const PACKAGE_NAME = '@nebulr-group/bridge-cli';
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
export const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_FILE = 'update-check.json';

export type Line = 'alpha' | 'latest';

export function lineOf(version: string): Line {
  return parseVersion(version)?.pre.length ? 'alpha' : 'latest';
}

interface Parsed {
  readonly core: [number, number, number];
  readonly pre: (number | string)[];
}

function parseVersion(version: string): Parsed | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version.trim());
  if (match === null) return null;
  const pre = match[4] === undefined ? [] : match[4].split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre };
}

/** Semantic version order: negative when `a` is older than `b`, 0 when equal or either is not a version. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (x === null || y === null) return 0;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return (x.core[i] as number) - (y.core[i] as number);
  // A release is newer than its prereleases.
  if (x.pre.length === 0 || y.pre.length === 0) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    if (typeof p === 'number' && typeof q === 'number') return p - q;
    if (typeof p === 'number') return -1;
    if (typeof q === 'number') return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** The version the registry has on a line, or null when it cannot say in time. Never throws. */
export async function fetchLineVersion(options: { registry?: string; line: Line; signal?: AbortSignal; deadlineMs: number }): Promise<string | null> {
  const registry = (options.registry ?? DEFAULT_REGISTRY).replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.deadlineMs);
  options.signal?.addEventListener('abort', () => controller.abort(), { once: true });
  try {
    const response = await fetch(`${registry}/-/package/${PACKAGE_NAME.replace('/', '%2f')}/dist-tags`, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const tags = (await response.json()) as unknown;
    const version = typeof tags === 'object' && tags !== null ? (tags as Record<string, unknown>)[options.line] : undefined;
    return typeof version === 'string' && parseVersion(version) !== null ? version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface UpdateCache {
  /** When the registry last answered, in ms. */
  checkedAt?: number;
  line?: Line;
  /** The version on that line when it last answered. */
  seen?: string;
  /** When the notice was last printed, in ms. */
  notifiedAt?: number;
}

export async function readCache(dir: string): Promise<UpdateCache> {
  try {
    const raw = await readPrivateFile(dir, CACHE_FILE);
    const parsed = raw === null ? null : (JSON.parse(raw) as unknown);
    return typeof parsed === 'object' && parsed !== null ? (parsed as UpdateCache) : {};
  } catch {
    return {};
  }
}

async function writeCache(dir: string, cache: UpdateCache): Promise<void> {
  try {
    await writePrivateFile(dir, CACHE_FILE, JSON.stringify(cache) + '\n');
  } catch {
    // A notice is never worth failing or slowing a command over.
  }
}

export function noticeText(current: string, newer: string): string {
  return `A newer Bridge CLI is out: ${newer} (you have ${current}). Run: bridge update`;
}

export function noticeOff(env: NodeJS.ProcessEnv): boolean {
  return env['BRIDGE_NO_UPDATE_NOTICE'] === 'true';
}

export interface NoticeOptions {
  readonly version: string;
  readonly dir: string;
  readonly registry?: string;
  readonly now: () => number;
  /** How long the registry is given in all. */
  readonly deadlineMs?: number;
  /** How long the CLI waits for it after the command, when it has not answered yet. */
  readonly graceMs?: number;
}

/**
 * Starts the check (when one is due) and returns what to call after the command: it gives the notice to print, or null.
 */
export function startUpdateCheck(options: NoticeOptions): { finish: () => Promise<string | null> } {
  const line = lineOf(options.version);
  const controller = new AbortController();
  const work = (async () => {
    const cache = await readCache(options.dir);
    const fresh = cache.line === line && cache.checkedAt !== undefined && options.now() - cache.checkedAt < DAY_MS && options.now() >= cache.checkedAt;
    if (fresh) return cache;
    const seen = await fetchLineVersion({ registry: options.registry, line, signal: controller.signal, deadlineMs: options.deadlineMs ?? 1_500 });
    if (seen === null) return cache.line === line ? cache : { ...cache, line, seen: undefined };
    const next: UpdateCache = { ...cache, line, seen, checkedAt: options.now() };
    await writeCache(options.dir, next);
    return next;
  })().catch((): UpdateCache => ({}));

  return {
    async finish() {
      const grace = options.graceMs ?? 250;
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), grace);
      });
      const cache = await Promise.race([work, late]);
      clearTimeout(timer);
      if (cache === null) {
        // Not in time: stop asking, and say nothing; the next command asks again.
        controller.abort();
        return null;
      }
      if (cache.line !== line || cache.seen === undefined || compareVersions(options.version, cache.seen) >= 0) return null;
      const now = options.now();
      if (cache.notifiedAt !== undefined && now - cache.notifiedAt < DAY_MS && now >= cache.notifiedAt) return null;
      await writeCache(options.dir, { ...cache, notifiedAt: now });
      return noticeText(options.version, cache.seen);
    },
  };
}
