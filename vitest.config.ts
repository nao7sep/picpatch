import { defineConfig } from 'vitest/config';
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: { include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.test.tsx'], coverage: { provider: 'v8', reportsDirectory: 'coverage/app', include: ['src/app/**/*.ts', 'src/renderer/**/*.ts', 'src/renderer/**/*.tsx'] } },
});
