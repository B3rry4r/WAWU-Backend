// Standalone Jest config for the VerificationSubmission resource's contract
// tests — additive, no edits to package.json (comment/tests/jest.config.js
// established this pattern: the shared root `jest` block is being actively
// edited by other concurrent wave-0 build agents in this same checkout, so
// depending on it is unreliable; this file is self-contained and
// reproducible regardless of the shared file's current state). Run with:
//   DATABASE_URL=... npx jest --config src/verification-submission/tests/jest.config.js
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '../../../src',
  testRegex: 'verification-submission/tests/.*\\.contract\\.spec\\.ts$',
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
