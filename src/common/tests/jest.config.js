// Standalone Jest config for the Phase 4.5 protected-registry regression
// suite — same additive pattern as the per-resource tests/jest.config.js
// files (kyc-submission, comment, verification-submission), so the baseline
// can be re-run on its own after every admin build wave without depending on
// package.json's shared `jest` block. Run with:
//   DATABASE_URL=... npx jest --runInBand --config src/common/tests/jest.config.js
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '../../../src',
  testRegex: 'common/tests/.*\\.regression\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'commonjs',
          moduleResolution: 'node',
          resolvePackageJsonExports: false,
        },
      },
    ],
  },
  transformIgnorePatterns: ['node_modules/(?!(jose)/)'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  testEnvironment: 'node',
};
