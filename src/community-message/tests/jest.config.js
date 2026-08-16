// Standalone Jest config for the CommunityMessage resource's contract
// tests — mirrors src/comment/tests/jest.config.js exactly (same rationale:
// the shared root package.json `jest` block is being actively edited by
// other concurrent build agents in this checkout, so this resource's test
// run is self-contained instead of depending on that file's current
// state). Run with:
//   DATABASE_URL=... npx jest --config src/community-message/tests/jest.config.js
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '../../../src',
  testRegex: 'community-message/tests/.*\\.contract\\.spec\\.ts$',
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
