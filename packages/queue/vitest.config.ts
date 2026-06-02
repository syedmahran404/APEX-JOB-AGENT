import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@apex/queue',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
