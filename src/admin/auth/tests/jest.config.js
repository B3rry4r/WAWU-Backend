// Standalone Jest config for the admin auth contract tests — same additive
// pattern as the per-resource tests/jest.config.js files (kyc-submission,
// comment, verification-submission) and src/common/tests/jest.config.js, so
// this suite can be run on its own without touching package.json's shared
// `jest` block. Run with:
//   DATABASE_URL=... WAWU_ID_JWKS_URL=... npx jest --runInBand --config src/admin/auth/tests/jest.config.js
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '../../../../src',
  testRegex: 'admin/auth/tests/.*\\.contract\\.spec\\.ts$',
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
