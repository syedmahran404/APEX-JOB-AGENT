import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@apex/shared-events',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
