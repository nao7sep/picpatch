import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { catalogModel, listModels } from '../../src/models/catalog.ts';
import { inspectModels } from '../../src/models/opening.ts';
import { validateModelManifest } from '../../src/models/verification.ts';

vi.mock('../../src/models/verification.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/models/verification.ts')>();
  return { ...actual, validateModelManifest: vi.fn(actual.validateModelManifest) };
});

let directory: string | undefined;
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

it('builds and validates each pinned catalog manifest once across inventory and lookup', async () => {
  directory = await mkdtemp(join(tmpdir(), 'picpatch-catalog-'));
  const models = listModels();
  const pinned = models.filter(model => model.acquisition === 'pinned');
  const inventory = await inspectModels({ modelsDirectory: directory });
  expect(inventory.models.map(model => model.id)).toEqual(pinned.map(model => model.id));
  for (const entry of models) expect(catalogModel(entry.id)).toEqual(entry);
  expect(validateModelManifest).toHaveBeenCalledTimes(pinned.length);
});

it('isolates nested caller mutations from later catalog lists and direct lookups', () => {
  const original = listModels();
  const returned = listModels();
  const pinned = returned.find(entry => entry.acquisition === 'pinned')!;
  if (pinned.acquisition !== 'pinned') throw new Error('No pinned catalog fixture');
  pinned.manifest.components[0]!.sha256 = 'changed';
  pinned.capabilities.referenceRoles.length = 0;
  pinned.profile.purposes.length = 0;
  pinned.tested.length = 0;
  (pinned.runtime.hosts as string[]).length = 0;
  returned.length = 0;
  expect(listModels()).toEqual(original);
  expect(catalogModel(original[0]!.id)).toEqual(original[0]);
  const selected = catalogModel(original[0]!.id);
  selected.profile.name = 'changed';
  expect(catalogModel(original[0]!.id)).toEqual(original[0]);
});
