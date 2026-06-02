import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@apex/platform-adapter-linkedin',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
