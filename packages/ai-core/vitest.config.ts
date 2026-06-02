import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@apex/ai-core',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
