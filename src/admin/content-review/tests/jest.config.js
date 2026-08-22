// Standalone Jest config for the admin content-review contract tests — same
// additive pattern as the other per-resource tests/jest.config.js files, so
// this suite can be run on its own without touching package.json's shared
// `jest` block. Run with:
//   DATABASE_URL=... WAWU_ID_JWKS_URL=... npx jest --runInBand --config src/admin/content-review/tests/jest.config.js
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '../../../../src',
  testRegex: 'admin/content-review/tests/.*\\.contract\\.spec\\.ts$',
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
