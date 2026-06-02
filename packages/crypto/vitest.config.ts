import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@apex/crypto',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
