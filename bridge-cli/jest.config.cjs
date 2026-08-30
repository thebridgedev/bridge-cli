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
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  // @nebulr-group/bridge-auth-core ships ESM-only. Transform its dist JS to
  // CJS with ts-jest (allowJs) so tests can requireActual the canonical rule
  // evaluator/operators modules (TBP-236) instead of reimplementing them.
  // `ignoreDeprecations` is required on BOTH transforms, and is not optional
  // housekeeping — without it every suite fails at load with TS5107 under the
  // TypeScript the `^5.7.3` range now resolves to (5.9.x).
  //
  // Why it happens: tsconfig.json sets `moduleResolution: bundler`, but ts-jest
  // forces `module: commonjs` to emit CJS. `bundler` is illegal with commonjs,
  // so TypeScript falls back to the implied `node10` — which 5.9 deprecates as
  // a hard error. Nothing here actually asks for node10; it is the residue of
  // that override. Silencing it keeps the suite running until ts-jest's ESM
  // path replaces the CJS transform wholesale.
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: { ignoreDeprecations: '6.0' } }],
    '^.+\\.js$': ['ts-jest', { tsconfig: { allowJs: true, ignoreDeprecations: '6.0' } }],
  },
  // Whitelisting auth-core alone is not enough: it transforms fine and then
  // dies on `import … from 'jose'`. Since auth-core 0.4.0-beta.11 its jose
  // dependency is jose 6, which dropped its CommonJS build and is ESM-only
  // (TBP-225), so jose must be transformed too. Mirrors the same fix in
  // bridge-express and bridge-nestjs.
  transformIgnorePatterns: ['/node_modules/(?!(@nebulr-group|jose)/)'],
};
