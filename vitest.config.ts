import { defineConfig } from 'vitest/config';
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  // Hooks run in registration order, so the shared leak check sees each page before a test file's cleanup.
  test: { include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.test.tsx'], setupFiles: ['tests/helpers/setup.ts'], sequence: { hooks: 'list' }, coverage: { provider: 'v8', reportsDirectory: 'coverage/app', include: ['src/main/**/*.ts', 'src/renderer/**/*.ts', 'src/renderer/**/*.tsx', 'src/shared/**/*.ts'] } },
});
