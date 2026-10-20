/** Whether a model can run now, by catalog id: ready, its files missing, or its engine missing. */
export type ModelState = 'ready' | 'missing' | 'engineMissing';
export type Readiness = Record<string, ModelState>;
