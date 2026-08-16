// Standalone Jest config for the Comment resource's contract tests.
//
// The shared `jest` block in the repo root package.json is being actively
// edited by other concurrent wave-0 build agents in this same checkout
// (observed live during this build: it flipped between at least three
// different ts-jest tsconfig overrides mid-session), so editing it here is
// an unreliable way to fix the "moduleResolution: bundler preserves dynamic
// import() under a commonjs module target" issue that breaks Prisma 7's
// generated client (generated/prisma/internal/class.ts uses `await
// import(...)` to lazily load its WASM query compiler; under ts-jest with
// `module: commonjs` + `moduleResolution: node` that import is correctly
// downleveled to `require()`, which Jest's CJS runtime can execute without
// `--experimental-vm-modules` — verified locally against this repo's actual
// generated client). This file is a self-contained, additive config (no
// edits to package.json) so this resource's tests are reproducible
// regardless of the shared file's current state. Run with:
//   DATABASE_URL=... npx jest --config src/comment/tests/jest.config.js
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '../../../src',
  testRegex: 'comment/tests/.*\\.contract\\.spec\\.ts$',
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
