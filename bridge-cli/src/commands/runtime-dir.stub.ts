import { join } from 'node:path';

/**
 * CJS-safe stand-in for `runtime-dir.ts` under ts-jest, which cannot parse the
 * real module's `import.meta` (see runtime-dir.ts for why). jest substitutes
 * this module via `moduleNameMapper` in jest.config.cjs.
 *
 * ts-jest runs with `process.cwd()` at the package root, where the source
 * prompts live at `<root>/prompts`. Returning `<root>/src/commands` mirrors the
 * production `dist/commands` shape so the existing
 * `join(here, '..', '..', 'prompts')` candidate resolves to `<root>/prompts`.
 */
export const commandsDir: string = join(process.cwd(), 'src', 'commands');
