import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests carry no timeouts: each waits for the result or event it needs.
    testTimeout: 0,
    hookTimeout: 0,
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    // The managed Python engine is Apple-only, and its tests start shebang scripts as fake tools.
    exclude: process.platform === 'win32' ? ['tests/unit/engine.test.ts'] : [],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/types.ts', 'src/contracts.generated.ts'],
    },
  },
});
