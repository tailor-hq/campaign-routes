/** @type {import('jest').Config} */
export default {
  preset: 'ts-jest/presets/default-esm',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1'
  },
  // node, not jsdom: the core touches no browser API, and the ES5 guard reads
  // its own source off disk.
  testEnvironment: 'node',
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        useESM: true,
        isolatedModules: true,
        diagnostics: false,
        tsconfig: {
          // The tests run as ES2020 while the shipped code targets ES5. The
          // guard is the thing that keeps the source honest; making the test
          // runner match production would only make the tests harder to write.
          target: 'ES2020',
          module: 'esnext',
          moduleResolution: 'node',
          verbatimModuleSyntax: false
        }
      }
    ]
  }
};
