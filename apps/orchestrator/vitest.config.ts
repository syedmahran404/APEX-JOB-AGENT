import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@apex/orchestrator',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
