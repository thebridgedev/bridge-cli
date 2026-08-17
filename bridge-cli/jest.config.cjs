module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.spec.ts', '**/*.test.ts'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.spec.ts',
    '!src/index.ts',
    '!src/bin.ts',
    '!src/commands/runtime-dir.ts',
    '!src/commands/runtime-dir.stub.ts',
  ],
  // ts-jest with `moduleResolution: bundler` doesn't rewrite the `.js` suffix
  // on relative ESM-style imports inside .ts files. Strip it here so jest can
  // resolve `./credentials.js` → `./credentials.ts`.
  moduleNameMapper: {
    // runtime-dir.ts uses `import.meta`, an uncatchable parse-time SyntaxError
    // under ts-jest's CommonJS loader. Swap in a CJS-safe stub so the command
    // modules importing it stay loadable in tests. Must precede the `.js`-suffix
    // stripper below to win the first-match.
    '(^|/)runtime-dir(\\.js)?$': '<rootDir>/src/commands/runtime-dir.stub.ts',
    // Workspace sibling: resolve the mcp-core package to its TS source so the
    // suite runs regardless of whether node_modules carries a workspace
    // symlink (local in-container installs use --workspaces=false).
    '^@nebulr-group/bridge-mcp-core$': '<rootDir>/../bridge-mcp-core/src/index.ts',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  // @nebulr-group/bridge-auth-core ships ESM-only. Transform its dist JS to
  // CJS with ts-jest (allowJs) so tests can requireActual the canonical rule
  // evaluator/operators modules (TBP-236) instead of reimplementing them.
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {}],
    '^.+\\.js$': ['ts-jest', { tsconfig: { allowJs: true } }],
  },
  transformIgnorePatterns: ['/node_modules/(?!@nebulr-group/)'],
};
