import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@apex/ai-service',
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    environment: 'node',
    globals: false,
  },
});
