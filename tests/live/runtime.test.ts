import { testPython } from '../helpers/python.ts';
import { expect, it } from 'vitest';
import { inspectRuntime } from '../../src/index.ts';
it('inspects the real environment and reports truthful model-free readiness', async () => {
  expect(await inspectRuntime(testPython)).toMatchObject({ status: 'worker-ready', models: [] });
});
