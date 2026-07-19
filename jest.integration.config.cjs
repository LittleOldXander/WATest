// Import and spread the base configuration to prevent duplication
const baseConfig = require('./jest.config.cjs');

/** @type {import('jest').Config} */
module.exports = {
  ...baseConfig,
  displayName: 'integration',
  roots: ['<rootDir>/test/integration'],
  testTimeout: 30000, // 30 seconds for real Redis/MongoDB connections
};
