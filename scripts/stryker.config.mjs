// Shared Stryker configuration, run from a package directory by scripts/run-mutation-tests.mjs.
export default {
  testRunner: 'vitest',
  plugins: ['@stryker-mutator/vitest-runner'],
  // Run each mutant against only the tests that import the mutated file.
  vitest: { related: true },
  coverageAnalysis: 'perTest',
  // The Vitest configs import ../../scripts, which a sandbox copy of the package would break.
  inPlace: true,
  // Module-level mutants force every test to rerun; they are slow and rarely informative.
  ignoreStatic: true,
  concurrency: 2,
  timeoutMS: 30_000,
  reporters: ['json', 'progress'],
  jsonReporter: { fileName: process.env.MUTATION_REPORT ?? 'reports/mutation/mutation.json' },
  thresholds: { high: 90, low: 70, break: null },
}
