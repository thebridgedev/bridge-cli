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
};
