/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test/unit'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.test.json' }],
  },
  // Source uses NodeNext-style `./thing.js` specifiers that resolve to
  // `./thing.ts` at compile time. Jest resolves at runtime, so strip the
  // extension for module resolution.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  clearMocks: true,
  // A coding-assignment reviewer should see each executable acceptance
  // criterion, not merely a count of passing tests.
  verbose: true,
  displayName: 'unit',
};
