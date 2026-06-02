import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@apex/db',
    // The db package has only integration tests (run via test:integration).
    // In unit mode there are no `*.test.ts` files, so allow an empty run
    // instead of failing the suite.
    passWithNoTests: true,
    // Only unit tests by default. Integration tests live under src/__tests__/integration
    // and are run via the dedicated `test:integration` script (which sets a flag).
    include: process.env.RUN_INTEGRATION === '1'
      ? ['src/**/*.test.ts', 'src/**/*.integration.test.ts']
      : ['src/**/*.test.ts'],
    exclude: process.env.RUN_INTEGRATION === '1'
      ? ['node_modules/**', 'dist/**']
      : ['src/**/*.integration.test.ts', 'node_modules/**', 'dist/**'],
    environment: 'node',
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
