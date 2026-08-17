module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.spec.ts', '**/*.test.ts'],
  // ts-jest with `moduleResolution: bundler` doesn't rewrite the `.js` suffix
  // on relative ESM-style imports inside .ts files. Strip it here so jest can
  // resolve `./types.js` → `./types.ts`. (Same convention as bridge-cli.)
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  // auth-core ships ESM-only, and the write tools import VALUES from it
  // (OPERATORS, validateRule) — not just types — so jest's CJS runtime must
  // transform it. Un-ignore it and let ts-jest compile its .js to CJS.
  transformIgnorePatterns: ['/node_modules/(?!@nebulr-group/bridge-auth-core/)'],
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: { allowJs: true } }],
  },
};
