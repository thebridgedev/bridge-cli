import { PACKAGE_NAME, type Line } from './updates.js';

/**
 * How the running CLI was installed, read from the real path of its own files (symlinks resolved) and, for a project's
 * own copy, from `npm_config_user_agent` (set by the package manager that ran it).
 */
export type Manager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export type Install =
  | { readonly kind: 'global'; readonly manager: Manager }
  | { readonly kind: 'npx' }
  | { readonly kind: 'local'; readonly manager: Manager }
  | { readonly kind: 'unknown' };

const PACKAGE_DIR = `/node_modules/${PACKAGE_NAME}/`;

function managerFromAgent(userAgent: string | undefined): Manager | undefined {
  const name = userAgent?.trim().split('/')[0]?.toLowerCase();
  return name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun' ? name : undefined;
}

export function detectInstall(realPath: string, userAgent?: string): Install {
  const path = realPath.replace(/\\/g, '/');
  const lower = path.toLowerCase();
  if (lower.includes('/_npx/')) return { kind: 'npx' };
  if (!lower.includes(PACKAGE_DIR)) return { kind: 'unknown' };
  if (lower.includes('/.bun/install/global/')) return { kind: 'global', manager: 'bun' };
  if (lower.includes('/pnpm/global/') || lower.includes('/.pnpm-global/')) return { kind: 'global', manager: 'pnpm' };
  if (lower.includes('/yarn/global/') || lower.includes('/.yarn-global/')) return { kind: 'global', manager: 'yarn' };
  // npm's global folder: `<prefix>/lib/node_modules` (macOS, Linux, nvm, Volta), `%APPDATA%\npm\node_modules` (Windows).
  if (lower.includes(`/lib${PACKAGE_DIR}`) || lower.includes(`/npm${PACKAGE_DIR}`)) return { kind: 'global', manager: 'npm' };
  const manager = managerFromAgent(userAgent) ?? (lower.includes('/node_modules/.pnpm/') ? 'pnpm' : 'npm');
  return { kind: 'local', manager };
}

export interface UpdatePlan {
  /** True when `bridge update` may run it itself: a global install. */
  readonly runnable: boolean;
  readonly command: string;
  readonly args: readonly string[];
  /** The command line to show. */
  readonly text: string;
  /** How it was installed, in words. */
  readonly how: string;
}

const GLOBAL: Record<Manager, string[]> = {
  npm: ['install', '-g'],
  pnpm: ['add', '-g'],
  yarn: ['global', 'add'],
  bun: ['add', '-g'],
};
const LOCAL: Record<Manager, string[]> = {
  npm: ['install'],
  pnpm: ['add'],
  yarn: ['add'],
  bun: ['add'],
};

export function updatePlan(install: Install, line: Line): UpdatePlan {
  const spec = `${PACKAGE_NAME}@${line}`;
  const plan = (runnable: boolean, command: string, args: string[], how: string): UpdatePlan => ({ runnable, command, args, text: [command, ...args].join(' '), how });
  switch (install.kind) {
    case 'global':
      return plan(true, install.manager, [...GLOBAL[install.manager], spec], `installed globally with ${install.manager}`);
    case 'local':
      return plan(false, install.manager, [...LOCAL[install.manager], spec], `a dependency of this project, installed with ${install.manager}; run it in the project`);
    case 'npx':
      return plan(false, 'npx', [spec], 'run through npx, from its cache; name the line to get the newest each time');
    default:
      return plan(false, 'npm', [...GLOBAL.npm, spec], 'not installed in a way the CLI recognises');
  }
}
