import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@apex/shared-errors',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
