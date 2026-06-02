import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@apex/scheduler',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
