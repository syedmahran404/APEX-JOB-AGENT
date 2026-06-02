import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@apex/vault-client',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
