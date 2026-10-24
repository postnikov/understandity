import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'engines/*/test/**/*.test.ts', 'apps/server/test/**/*.test.ts'],
    environment: 'node',
  },
});
