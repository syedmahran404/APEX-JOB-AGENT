import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@apex/shared-logger',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
