import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/live/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 15_000,
    cache: { dir: 'node_modules/.cache/picpatch-live' },
  },
});
