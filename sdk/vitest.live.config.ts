// The live lane: PicPatchSdk against real engines and models, a local gate (npm run test:full) that is never part
// of npm test or CI. It acquires nothing, so prepare what it reads first: the managed engine and the MFLUX
// configuration (scripts/prepare-inference.ts), and for the native tests the assets tests/helpers/live-cache.ts
// names. Everything it writes stays in the ignored live cache. Small canvases and short schedules prove execution,
// not quality or a memory guarantee; synthetic untrained LoRAs prove application, not trained style.
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
