module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.test.ts', '!src/__tests__/**', '!src/bin.ts', '!src/cli.ts'],
  // ts-jest emits CommonJS, and `moduleResolution: bundler` keeps the `.js` suffix on
  // relative imports: strip it so `./client.js` resolves to `./client.ts`.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  // `ignoreDeprecations: '5.0'`: ts-jest forces `module: commonjs`, with which `bundler`
  // resolution falls back to node10, a hard error since TypeScript 5.9 without this.
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: { ignoreDeprecations: '5.0' } }],
  },
};
