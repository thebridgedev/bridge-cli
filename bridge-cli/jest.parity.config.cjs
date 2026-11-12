// The CLI against a real deployment (TBP-935, C01): `npm run test:parity`. Skipped unless PARITY_* is set; see src/__tests__/parity.e2e.ts.
const base = require('./jest.config.cjs');
module.exports = { ...base, testMatch: ['**/*.e2e.ts'], testTimeout: 120000 };
