import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@apex/platform-adapter-linkedin',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 30_000,
  },
});
