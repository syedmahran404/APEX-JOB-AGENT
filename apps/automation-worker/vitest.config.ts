import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@apex/automation-worker',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
