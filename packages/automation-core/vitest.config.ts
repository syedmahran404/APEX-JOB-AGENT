import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@apex/automation-core',
    include: ['src/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 30_000,
  },
});
