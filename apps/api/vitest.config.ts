import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    name: '@apex/api',
    include:
      process.env.RUN_INTEGRATION === '1'
        ? ['src/**/*.test.ts', 'test/**/*.test.ts']
        : ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude:
      process.env.RUN_INTEGRATION === '1'
        ? ['node_modules/**', 'dist/**']
        : ['**/*.integration.test.ts', 'node_modules/**', 'dist/**'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 60_000,
    hookTimeout: 120_000,
    globals: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
    },
  },
});
