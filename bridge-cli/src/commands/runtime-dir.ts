import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Absolute path to this module's own directory — `dist/commands` in the built
 * (ESM) CLI. Bundled prompts ship at `dist/prompts`, i.e. `../prompts` from
 * here.
 *
 * The `import.meta` token is deliberately confined to this single file. The
 * production build is ESM (`"type": "module"`), so `import.meta.url` resolves
 * correctly at runtime. Under ts-jest, however, sources are loaded as
 * CommonJS, where `import.meta` is an *uncatchable parse-time* SyntaxError
 * ("Cannot use 'import.meta' outside a module") that crashes the whole module
 * on import. To keep the rest of the command code importable by the jest
 * suite, jest maps this module to a CJS-safe stub (`runtime-dir.stub.ts`) via
 * `moduleNameMapper` — see jest.config.cjs.
 */
export const commandsDir: string = dirname(fileURLToPath(import.meta.url));
