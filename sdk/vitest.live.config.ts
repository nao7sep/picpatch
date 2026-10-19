import { defineConfig } from 'vitest/config';
import { liveCache } from './tests/helpers/live-cache.ts';
export default defineConfig({
  cacheDir: liveCache('vitest'),
  test: {
    include: ['tests/live/**/*.test.ts'],
    globalSetup: ['tests/helpers/setup-engine.ts'],
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
