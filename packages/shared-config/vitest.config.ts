import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@apex/shared-config',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
