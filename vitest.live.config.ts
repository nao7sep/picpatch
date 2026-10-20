import { defineConfig } from 'vitest/config';
export default defineConfig({ oxc: { jsx: { runtime: 'automatic' } }, test: { include: ['tests/live/**/*.test.ts', 'tests/live/**/*.test.tsx'], testTimeout: 180_000, fileParallelism: false } });
