import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@apex/lint-rules',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
