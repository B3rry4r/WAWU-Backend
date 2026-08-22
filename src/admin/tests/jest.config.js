// Standalone Jest config for the admin ops-reads registration test — same
// additive pattern as the other per-resource tests/jest.config.js files. Run:
//   DATABASE_URL=... WAWU_ID_JWKS_URL=... npx jest --runInBand --config src/admin/tests/jest.config.js
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '../../../src',
  testRegex: 'admin/tests/.*\\.contract\\.spec\\.ts$',
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
