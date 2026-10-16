// Standalone Jest config for the EMAIL-01 specs, same pattern as the other
// per-resource tests/jest.config.js files. Run with:
//   DATABASE_URL=... npx jest --runInBand --config src/admin/notifications/email/tests/jest.config.js
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '../../../../../src',
  testRegex: '/src/admin/notifications/email/tests/.*\\.spec\\.ts$',
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
