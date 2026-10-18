import { defineConfig } from 'vitest/config';
export default defineConfig({
  cacheDir: 'node_modules/.cache/picpatch-live',
  test: {
    include: ['tests/live/**/*.test.ts'],
    globalSetup: ['tests/helpers/setup-engine.ts'],
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
