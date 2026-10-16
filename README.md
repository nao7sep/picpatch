# PicPatch

PicPatch is a headless SDK being developed for local AI image editing: instruction-based changes, grouped reference images, masked edits, and text-to-image generation.

The public editor validates and prepares image files, owns a persistent worker process, and safely publishes completed outputs. An experimental offline adapter connects editing and generation to MFLUX 0.22.0 and FLUX.2 Klein 4B on Apple Silicon. The real-inference gate exercises the pinned 4-bit bundle through the public SDK. Portrait likeness and larger-image memory limits remain unverified. The SDK does not acquire Python or models automatically. Explicit model preparation is available through the SDK.

## Experimental local editing

Use `prepareModel(modelId, options)` and pass its returned `model` to `createEditor`. Both pinned bundles and compatible external bundles follow this flow; no Python class or handwritten manifest is needed. Advanced registrations use `{ variant, directory, manifest, quantize? }`, where `variant` selects the checkpoint architecture and defaults. Keep the bundle immutable while editing: verification is a point-in-time check, not a lock. Edits do not re-hash model files. The session supplies the request model by default and rejects a conflicting explicit model.

The selected interpreter must already contain the worker dependencies and the optional `inference` extra from `runtimes/mflux/pyproject.toml`. Installing that extra downloads substantial runtime packages, but no model weights. Use a separate environment from the ordinary test environment. Install the optional inference extra through uv. The SDK catalog supplies the pinned manifest and adapter configuration; `prepareModel` verifies the bundle before returning it.

The adapter supplies the source image first, followed by reference groups and images in caller order. It adds image ordinals, roles and group IDs to the instruction. Multiple pictures per person are preserved as separate references; this does not guarantee likeness or teach the model a new identity. Klein masked edits use final compositing. Explicit output dimensions must be multiples of 16; omitted dimensions use the source size for masked edits and 1024 by 1024 otherwise. Distilled variants use MFLUX's sampling defaults. Klein base variants use 50 steps and guidance 4, so they take substantially longer. Optional `quantize` accepts 4 or 8; omit it to use the checkpoint's configuration.

Models are loaded and released for each operation, while the worker is reused. This avoids retaining unmeasured model memory between operations, at the cost of reload latency. Progress reports loading, conditioning/editing, denoising steps and saving. Pixel output is saved without prompt metadata or sidecars. Hugging Face and Transformers run offline; the worker additionally rejects Python socket connections and isolates both Python and native standard output from protocol frames. This is not a general sandbox for arbitrary native packages.

After preparing the worker environment and a local bundle, run `npx tsx examples/edit-local.ts --instruction "Change the background to a garden" --source /absolute/source.png --directory /absolute/model/bundle`. Add `--python /absolute/prepared/python` to select another uv environment. The example imports the SDK, verifies the chosen catalog bundle and saves a uniquely named PNG beside the source. It never installs packages or downloads models.

## Preparing models and checking readiness

`listModels()` returns independent selections distinguished by `acquisition` and `evidence`. A `pinned` entry includes immutable component hashes, total download bytes, source/license links and `inference-tested` evidence. The first entry remains the community 4-bit Klein bundle (about 4.62 GB). An `external` entry has `api-tested` evidence and requires a caller-owned directory; it has no download option. All entries remain experimental. Evidence applies to the selected configuration, not every quantization or larger model in its family.

```ts
import { listModels, prepareModel, inspectReadiness, createEditor } from 'picpatch';

const choice = listModels()[0]!;
// Reuse a verified managed bundle; missing files fail without downloading.
const prepared = await prepareModel(choice.id);
// Alternatively: { directory: '/absolute/existing/bundle' } verifies in place.
// Explicit acquisition: prepareModel(choice.id, { download: true }).
const readiness = await inspectReadiness('/absolute/prepared/python', prepared.model);
const editor = createEditor({ pythonExecutable: '/absolute/prepared/python', model: prepared.model });
try {
  const result = await editor.edit({ instruction: 'Change the background to a garden', sourceImage: '/absolute/source.png' });
  console.log(result.image.path); // a new sibling PNG
} finally { await editor.dispose(); }
```

Preparation verifies every component, including cached or external bundles. Edits do not repeat that hashing. Downloads stream to private staging, verify the complete pinned revision, and publish it atomically. Existing invalid bundles are preserved and reported; preparation does not silently repair or replace them. Concurrent preparation can reuse a complete winner. Imports and read-only operations never download. The community distribution uses Apache-2.0 according to its pinned model card; runtime licensing is separate. Python and inference packages remain uv responsibilities.

`inspectReadiness` distinguishes file presence, integrity (`not-verified` by default), inference import/version status, and advertised capabilities. Use `{ verify: true }` for a fresh full integrity check or `{ load: true }` to load existing weights without generating an image. Loading may consume substantial memory and time; the worker exits and releases resources before the check resolves. Successful imports are not proof of successful loading, and successful loading is not a quality guarantee. Missing or wrong-size files, or corruption found by explicit verification, prevent a load check; missing packages, unsupported versions, import failures and load failures have distinct statuses. Process and I/O failures remain typed exceptions. Klein reports `maskMode: "composite"`; it does not natively condition on a mask.

Preparation and readiness accept cancellation, progress and `timeoutMs`. Preparation defaults to one hour; readiness defaults to thirty seconds for imports and ten minutes when hashing or loading. Active work settles before cleanup or rejection. A published bundle wins a cancellation race. Cleanup or durability warnings identify retained paths without invalidating a completed publication.

## Experimental external model families

The selectable variants are FLUX.2 Klein 4B/9B and base 4B/9B for editing and generation, plus Z-Image Base/Turbo, ERNIE-Image Base/Turbo and FLUX.1 Schnell, Dev and Krea Dev for generation only. FLUX.1 Fill Dev supports native masked editing; FLUX.1 Kontext Dev supports single-source instruction editing. Klein variants share one family implementation; the runtime selects the appropriate architecture and sampling defaults. The generation-only variants reject edits, references and masks. FLUX.3 is not implemented.

Only the pinned Klein 4B 4-bit bundle has real-weight inference evidence. Other selections have pipeline import and argument-mapping tests, not measured memory fit or quality evidence. Base sampling defaults follow the [upstream Klein example](https://huggingface.co/black-forest-labs/FLUX.2-klein-base-4B).

```ts
const prepared = await prepareModel('flux2-klein-9b', {
  directory: '/absolute/existing/mflux-bundle',
});
const editor = createEditor({ model: prepared.model });
try {
  await editor.generate({ prompt: 'A blue ceramic bowl.', outputDirectory: '/absolute/outputs' });
} finally {
  await editor.dispose();
}
```

External preparation reads a complete MFLUX directory layout: transformer, VAE, text encoder and tokenizer directories (plus the second encoder/tokenizer for FLUX.1). It hashes their files, validates shard references and returns an in-memory manifest with a deterministic local revision. File links used by Hugging Face caches are supported; component directory links are rejected. It neither copies nor modifies the bundle, and never downloads. The result reports `locally-fingerprinted`, which does not authenticate an upstream checkpoint or prove tensor compatibility. Select the variant explicitly; names of folders are not architecture evidence. Use `inspectReadiness(python, prepared.model, { load: true })` for an actual load check, and `verifyModel` for later explicit verification. Keep the complete bundle unchanged during use. Standalone checkpoint files and arbitrary architectures are not supported.

Shared MFLUX loading, progress, cancellation, output writing and memory cleanup live in `runtimes/mflux/src/picpatch_worker/backends/runtime.py`. `models.json` owns variant configuration and base defaults; `generation.py` handles text-only families, `klein.py` owns Klein reference conditioning and composite masking, `fill.py` supplies native Fill conditioning, and `kontext.py` supplies single-source Kontext conditioning.

Kontext (`flux1-kontext-dev`) uses the same `prepareModel` and `editor.edit` flow with a required `sourceImage`. It rejects masks, grouped references and text-only generation. The source is normalized without Klein's crop/downscale policy; MFLUX resizes the conditioning image to the output size. Output defaults to 1024 by 1024 and accepts multiples of 16. Kontext uses 25 steps and guidance 2.5. Its single-source conditioning offers another editing approach, not a verified identity-preservation guarantee.

Z-Image Base (`z-image`) uses 50 steps and guidance 4, following the pinned runtime's base-model example. ERNIE-Image (`ernie-image`) uses 50 steps and guidance 4; ERNIE-Image Turbo (`ernie-image-turbo`) uses 8 steps and guidance 1. These are text-only generation selections with the same four component directories used by Z-Image Turbo. Both base variants are substantially slower than their distilled counterparts. All new variants require complete local bundles and remain API/import-tested experiments; no additional weights are downloaded or implied to fit a particular Mac.

## Caller defaults and diagnostics

An editor accepts `defaults: { size?, seed?, outputDirectory? }`. Per-call values override these; absent size and seed continue to use the adapter's defaults. The session model is inherited, and a conflicting explicit model is rejected. Returned results contain the actual seed, dimensions and model provenance. Explicit model registration remains available for advanced local configurations.

An explicit `outputPath` wins over session destination settings. Otherwise PicPatch generates `edit-<UUID>.png` in the per-edit `outputDirectory`, the session's directory, or beside the authored source path, in that order. Reference-only compositions require a chosen destination. Directories must already exist; PicPatch never falls back to the working directory, creates an output directory implicitly, or overwrites an existing file. Input paths remain literal, including symlink paths.

If `pythonExecutable` is omitted, the editor uses the worker project's standard uv environment (`runtimes/mflux/.venv`), respecting `UV_PROJECT_ENVIRONMENT` relative to the worker project. It does not search system Python, inspect another application's environment, install dependencies or download anything. Use an explicit interpreter for another prepared environment.

Model and runtime operations, `editor.edit`, and `editor.generate` accept `onDiagnostic` alongside `onProgress` and cancellation. Diagnostics report an invocation ID, UTC time, operation, progress stages and one terminal success, failure or cancellation after owned work settles. Calls rejected before operation admission do not emit a lifecycle. The sink is caller-owned; PicPatch creates no log files and prints nothing. Sink failures never change the primary outcome, and asynchronous sink work is not awaited. Keep callbacks brief; a blocking synchronous callback blocks its caller. Progress callbacks remain synchronous and throwing one fails with `CALLBACK_FAILED`.

Diagnostic copies omit prompts, image data, paths, raw exception messages and stderr. They retain stable SDK error codes, selected I/O codes and bounded causal categories. Worker runtime errors also expose `error.diagnostic`, including failure phase, causal categories, known missing-runtime reasons or process-exit information. Python library messages and tracebacks are deliberately not forwarded because they can contain private inputs. The thrown local error keeps its original cause for the caller; the diagnostic sink receives only the safe projection.

```ts
await editor.edit({
  instruction: 'Use these colors in the source image',
  sourceImage: '/absolute/source.png',
  references: [{ id: 'palette', role: 'style', images: ['/absolute/palette.png'] }],
  outputDirectory: '/absolute/results',
}, {
  signal: controller.signal,
  onProgress: event => updateProgress(event),
  onDiagnostic: event => recordDiagnostic(event),
});
```

The controller and sinks above belong to the caller. Use `verifyModel` for explicit integrity verification and `resolveStoragePaths` for data/model root overrides; output destinations are independent of those managed roots.

## Text-to-image generation

The same editor generates images using the installed Klein bundle. No source or reference image is needed. Check `textToImage` in readiness capabilities when choosing a model; generation is supported only when explicitly advertised.

```ts
const generated = await editor.generate({
  prompt: 'A blue ceramic bowl on a white table',
  size: { width: 512, height: 512 },
  seed: 42,
  outputDirectory: '/absolute/results',
});
const edited = await editor.edit({
  instruction: 'Make the bowl green',
  sourceImage: generated.image.path,
});
```

Generation inherits the editor's model, size, seed and output-directory defaults. Supply an output path or a per-call/session output directory; generated filenames use `generate-<UUID>.png`. It returns the same artifact and provenance fields as editing, with empty references and input geometry. Generation rejects editing fields such as source images and masks. Use `edit` for image-conditioned work.

Both verbs share one active operation per editor, safe PNG publication, cancellation and diagnostics. Generation progress uses `verb: "generate"` and the `generating` denoising stage. `timeouts.generateMs` bounds generation independently of `editMs`, with the same thirty-minute default. The worker and weights are reused across verb choices without a second environment or model download; model objects are released after each operation.

## Masked editing

Pass `maskImage` with `sourceImage`, or add `--mask /absolute/mask.png` to the local-edit example. Klein generates a complete edit using the source and references; the mask is applied afterward and is not sent as an extra model reference. Describe the desired change in the instruction. The mask controls pixel replacement, not where the model directs its attention, so seams and instruction adherence still depend on generation quality.

Use an opaque grayscale PNG matching the oriented source. With Klein, black copies the normalized source exactly, white copies the generated edit, and gray interpolates 8-bit sRGB channels and alpha with rounded integer values. No automatic feathering or linear-light blending is applied. Exact preservation refers to decoded, oriented sRGB pixels, not the original file bytes or color profile; originals remain untouched. An all-black mask still runs inference and returns the preserved source pixels.

The first composite mode requires source width and height to be multiples of 16 and area at most 1,048,576 pixels, so no source pixels are lost to model resizing or cropping. Output size defaults to the oriented source size; an explicit or session-default size must match it. A mismatched mask, resized output or source requiring geometry changes fails with `INVALID_MASK`. References retain their independent geometry policy. Compositing runs inside the owned worker before the existing output validation and exclusive publication; cancellation never publishes a partial result.

FLUX.1 Fill Dev (`flux1-fill-dev`) instead feeds the source and mask into denoising. Its capabilities report `maskMode: "native"`, `sourceImageRequired: true`, and `maskRequired: true`. White identifies the region to replace; black supplies context to keep, but native generation does not promise identical pixels outside the mask. There is no final composite. Fill requires both images and rejects reference groups and text-only generation.

```ts
const prepared = await prepareModel('flux1-fill-dev', { directory: '/absolute/fill-bundle' });
const editor = createEditor({ model: prepared.model });
try {
  await editor.edit({
    instruction: 'A blue ceramic bowl.',
    sourceImage: '/absolute/source.png',
    maskImage: '/absolute/mask.png',
    size: { width: 512, height: 512 },
    outputDirectory: '/absolute/outputs',
  });
} finally {
  await editor.dispose();
}
```

The native source and mask must match after orientation. Fill permits an explicit output size in multiples of 16; MFLUX resizes both conditioning images together to that size. Without a size override, source dimensions are used and must already be multiples of 16. Prepared-input geometry describes the normalized snapshots; output dimensions describe the runtime's requested resize. Fill uses 25 steps and guidance 30; Dev and Krea Dev generation use 25 steps and guidance 3.5, following the pinned MFLUX CLI defaults. These three variants have API/import coverage only, with no real-weight quality or memory-fit claim and no pinned downloads.

## Development

Use Node.js 24 or newer, npm, and uv. The worker lock targets macOS arm64. The worker declares Python 3.15 (`>=3.15,<3.16`) in `runtimes/mflux/pyproject.toml`; uv selects a compatible interpreter and downloads one if needed. Run `uv sync --project runtimes/mflux --locked` to prepare the worker environment. Install the development dependencies with `npm ci`, then run `npm test`. This checks generated contracts, TypeScript source and examples, request validation, and TypeScript/Python protocol behavior. The Python test command lets uv prepare Python and the small locked validation and test dependencies; it never downloads models.

The ordinary suite uses simulated process streams and small generated images in temporary directories, and checks package-name imports and read-only consumer operations under isolated storage roots. `npm run test:full` additionally launches lightweight subprocess fixtures and the bundled Python worker, verifies reuse and termination, and exercises the public factory. It uses `runtimes/mflux/.venv` by default, or the environment selected by `UV_PROJECT_ENVIRONMENT` (relative paths resolve from `runtimes/mflux/`), and currently targets macOS/POSIX. The full gate exercises catalog preparation, readiness, text-only generation, generation-to-edit reuse, sequential editing, provenance, output collision protection and disposal with existing weights. It also tests explicit acquisition and cancellation against a tiny local HTTP fixture. Real inference uses `node_modules/.cache/picpatch-live/inference-config.json`, or an absolute editor-options JSON path supplied through `PICPATCH_INFERENCE_CONFIG`. Missing prerequisites fail explicitly. No test downloads models. The missing-backend test needs uv on PATH and cached worker wheels to create an isolated model-free environment offline. Live tests are type-checked by the ordinary gate.

To prepare the real-inference test after the development setup, run these commands from the repository root. The first installs the locked inference packages into a separate environment; the second explicitly downloads approximately 4.62 GB of pinned model files and verifies every component before publishing the local configuration. The runtime and test configuration stay in the ignored test cache; new model acquisitions use the configured model store. Existing external bundles can be reused without copying.

```sh
UV_PROJECT_ENVIRONMENT="$PWD/node_modules/.cache/picpatch-live/inference-runtime" \
  uv sync --project runtimes/mflux --python "$PWD/runtimes/mflux/.venv/bin/python" \
  --extra inference --no-dev --locked --no-python-downloads
npx tsx scripts/prepare-inference.ts --python "$PWD/node_modules/.cache/picpatch-live/inference-runtime/bin/python" --download
npm run test:full
```

Omit `--download` to reuse the managed cache without network access, or supply `--directory /absolute/existing/bundle` to verify and reuse external weights in place. The preparation tool calls the public SDK and acquires models only with `--download`; the test itself never downloads models. Its pinned manifest covers the encoder, transformer, VAE and tokenizer files required by this checkpoint. The full gate checks sequential grouped-reference/source edits, four and six references in two object groups, and cancellation after a denoising step using generated 256-pixel fixtures. It verifies artifacts, provenance and cleanup, not visual quality.

To test another Python version without replacing a working runtime, install the `inference` extra into a new `UV_PROJECT_ENVIRONMENT` using `uv sync --project runtimes/mflux --python /absolute/path/to/python --extra inference --locked --no-python-downloads`. Keep development dependencies installed for the gate. Copy the existing inference configuration to a separate JSON file and change only `pythonExecutable` to the new environment. Run `npm run test:full` with that environment, `UV_NO_SYNC=1` (to retain the inference extra), and `PICPATCH_INFERENCE_CONFIG` pointing to the copied configuration. This reuses the existing model bundle. Set `UV_OFFLINE=1` to prevent package acquisition during testing.

On macOS with Python 3.15, the lock selects PyTorch from its official CPU wheel index; MLX remains the inference engine. PyYAML and SentencePiece currently build from source, requiring a C++ toolchain and CMake. Other dependencies retain their normal PyPI source.

For resource measurements on macOS, run `python3 benchmarks/measure.py` with the same prepared configuration. It performs six sequential edits alternating four and six synthetic object references, with 512-pixel inputs and 768-pixel outputs. Use `--input-size 1024 --output-size 1024 --counts 2` for a single larger-input probe; counts accept two, four or six references per edit. It checks originals and output cleanup, samples process-tree physical footprint and resident memory, records system memory pressure and swap, and checks observed child-process exit. Reports separate loading, editing and saving costs using SDK progress boundaries and monotonic elapsed time; editing includes conditioning, lazy weight materialization and decoding; saving includes final settlement, publication and benchmark output checks. These are observed SDK phases, not GPU kernel timings. Phase peaks with no samples are null, not zero. Reports retain input geometry, model revision, runtime and seed without prompts or source paths. Repeated calls reuse the worker but reload the model, so later calls are not warm-model inference. Results stay in ignored `benchmarks/results/`. Sampled peaks are lower bounds, process charges may overlap, and system pressure includes other applications. This is a workload benchmark, not a portrait-likeness comparison or a memory guarantee for larger inputs.

Run `npm run example:request` to print an illustrative grouped-reference request. It does not read images, start a worker, or generate output. `npm run test:coverage` measures TypeScript behavioral coverage.

The private package resolves directly to TypeScript source. Consumers use a TypeScript-capable runner or bundler; no SDK build step is required. The worker’s `pyproject.toml` and `uv.lock` describe an internal package with JSON Schema validation and a separately locked optional `inference` extra. Ordinary setup and tests do not install that extra. Python and inference packages are provisioned through uv project commands, outside the SDK. The SDK accepts a prepared interpreter and does not install packages.

## Editing contracts

Call `validateEditRequest(request, capabilities?)` to validate metadata and obtain an independent copy. The normalized `EditRequest` requires a model, nonblank instruction, absolute PNG output path, and either a source image or nonempty reference groups. Masks require a source image. Reference group IDs and normalized reference paths must be unique. Group and image order is preserved.

Model capabilities describe supported reference roles, mask semantics, dimension constraints, and an optional maximum grouped reference count (excluding the source image). Klein additionally advertises `sourceImageRequired: false`, `referenceConditioning: "ordered-images-with-role-prompt"` and `defaultOutputSize: { width: 1024, height: 1024 }` through readiness and the worker handshake. A source or at least one reference is still required. The source goes first, then reference groups and images retain caller order; roles and group IDs become prompt labels, not separate native controls or identity guarantees. Explicit output dimensions must be positive multiples of 16. No reference-count or maximum-output-size limit is declared; this does not promise unlimited memory or successful completion on a particular machine. Unsupported requests produce `PicPatchUsageError`; malformed capability reports produce `PicPatchRuntimeError`. Cancellation has a distinct `PicPatchCancelledError` type.

`editor.edit` accepts `EditInput`, resolving session defaults and output naming into a strict `EditRequest` before validation. `validateEditRequest` checks metadata only. `editor.edit` additionally opens and fully decodes single-frame PNG, JPEG, and WebP files by content. It rejects missing, malformed, animated, and unsupported images, and detects reference duplicates through symlink or hardlink aliases. Original files remain untouched. Results describe output dimensions, actual seed, model revision, runtime version, and the original ordered references.

Preparation uses Sharp to apply EXIF orientation, convert image color to sRGB, strip metadata, and write private PNG copies. Klein advertises `inputGeometry: "klein-reference"`: source and reference images above 1,048,576 pixels are downscaled proportionally with Lanczos3, then each dimension is rounded down to a multiple of 16 by center cropping. Odd residual pixels leave one extra pixel removed from the right or bottom. Inputs are never upscaled or stretched to the output dimensions; each reference keeps its own geometry. Very small or narrow images that would produce a side below 16 pixels fail before model loading. The prepared dimensions match MFLUX’s native policy, so its subsequent geometry step does nothing; Sharp’s resampling is not promised to be pixel-identical to Pillow’s. No caller override is currently exposed.

`result.inputGeometry` records each caller path with original, oriented, scaled and prepared dimensions and crop offsets measured in scaled pixels. It includes unchanged inputs and uses source, mask (when supported), then reference order. Output dimensions and these conditioning dimensions are independent. Baseline preparation without a model policy preserves oriented dimensions. Masks must be opaque grayscale PNGs matching the oriented source dimensions; black preserves and white edits. Masked Klein edits require source dimensions that already satisfy the geometry policy; masks are never resized or cropped. Native processing has a 60-second budget per image; cancellation waits for an active native writer to settle before removing its files.

The output directory must already exist. Each edit owns a private temporary directory there; the worker receives only prepared paths and a private output path. Publication fully decodes the worker’s PNG, checks dimensions, syncs the completed file, then uses an exclusive atomic hard link. Existing destinations, including symlinks and hardlinks, are never overwritten—even if another writer creates the destination during an edit. The destination filesystem must support hard links; there is no non-atomic fallback.

Temporary files are removed after their writers settle. Publication failures retain the completed image and expose `error.recoveryDirectory`; unconfirmed worker termination also retains the workspace. Inspect and remove retained directories when safe; automatic recovery is not implemented. If an output was saved but temporary cleanup failed, the successful result includes `cleanupWarning` with the directory to remove. Cancellation after atomic publication cannot turn a saved result into failure.

`protocol/contracts.schema.json` owns the payload shapes. Run `npm run contracts:generate` after changing it; the default test gate checks generated types for drift.

## Local model inspection

`inspectModel` inventories a caller-selected absolute file or directory. `discoverModels()` searches the configured model directory; supplying absolute roots searches those locations instead. It searches recursively, grouping a directory with its nested components when it contains model configuration or weight filenames. It follows cached weight-file symlinks, skips nested directory symlinks and `.git`, and deduplicates aliases and overlapping bundles. There is no automatic home-directory scan.

```ts
import { inspectModel, discoverModels, resolveStoragePaths } from 'picpatch';

const locations = resolveStoragePaths(); // read-only; no directory creation
const inventory = await discoverModels();
const elsewhere = await discoverModels(['/absolute/path/to/local/models']);
const details = await inspectModel('/absolute/path/to/local/model');
```

Both operations are read-only, accept `signal`, `onProgress` and `timeoutMs` options (one minute by default), and need neither Python nor a network connection. They inspect file metadata without loading weights, parsing model configurations, hashing large files, or running model code. Missing locations and filesystem failures reject with `MODEL_IO`; a failed search does not return a deceptively complete partial list. An absent default model directory returns an empty list; missing explicit roots and broken directory links remain errors. Deadlines report `TIMEOUT`; cancellation and deadlines wait for active filesystem operations to settle before rejecting.

Candidate detection is based on filenames, so unrelated files with weight-like names may appear. Results always report integrity as `not-verified` and compatibility as `unknown`. `unverified` means weight-named files are present; `incomplete` means an empty, partial, or missing linked file was observed; `unrecognized` means no weight-named files were found. These states do not prove bundle completeness, safe contents, upstream identity, supported editing capabilities, or readiness to load. Use explicit manifest verification for stronger file checks; runtime compatibility still requires a tested adapter. Inspection is a point-in-time inventory, not a lock against other processes changing files.

### Model storage locations

`resolveStoragePaths({ dataDirectory?, modelsDirectory? })` resolves owned locations without filesystem I/O. Explicit options take precedence over `PICPATCH_DATA_DIR` and `PICPATCH_MODELS_DIR`; defaults are `~/.picpatch` and its `models` child. Overrides accept `~`, `$VAR` and `%VAR%`; relative values resolve against home, never the working directory. Unset expansion variables and invalid values are rejected. Configuration is read at each call. To use an explicit resolver option for discovery, pass `[locations.modelsDirectory]` as the roots.

These settings select model discovery locations; they do not move existing files, change a supplied editor model directory or redirect input/output paths. Explicit file paths remain literal. No directory is created by resolution or discovery, and only explicit preparation with `download: true` acquires a missing catalog bundle.

### Verifying a model bundle

`validateModelManifest` validates a model identity, a hexadecimal immutable source revision, and a required component list. Each component declares a relative path, role, exact byte length, and SHA-256 digest. Manifest types are generated from the shared schema. Obtain these pins from a source you trust; the built-in catalog supplies pins for its experimental Klein configuration, while custom manifests remain caller-provided evidence.

`verifyModel(directory, manifest, options?)` checks every declared file, streams its hash, detects changes while reading, and validates that shard-index mappings name weights in the manifest. File symlinks can point to shared cache blobs; directory symlinks cannot redirect verification outside the selected root. Unsafe or conflicting manifest paths are rejected before reading files. Verification never imports weights or executes model code.

Verification is a point-in-time result. Keep prepared model files unchanged; edits do not automatically detect later modifications. Call `verifyModel` again whenever you need a fresh integrity check.

A `matches-manifest` result means the declared files matched the supplied pins at verification time. It does not authenticate those pins, prove the manifest lists every component an adapter needs, or establish editing support; compatibility remains `unknown`. Missing files, mismatches and invalid indexes return an `invalid` result with component-level statuses. Filesystem failures throw `MODEL_IO`. Cancellation and progress use the same options as inspection; verification also accepts `timeoutMs`, defaulting to ten minutes. Active reads settle before cancellation or timeout is reported. No files are repaired, deleted, installed, or downloaded.

## Worker environment setup

`inspectRuntime(pythonExecutable, options?)` starts the bundled worker, checks its handshake, and waits for shutdown. It returns `worker-ready` plus the worker version and advertised model capabilities. This proves that the selected interpreter can run the worker, not that it matches the dependency lock or supports any image model. Inspection installs nothing and disables Python bytecode writes and user-site/Python-environment overrides.

Runtime inspection accepts cancellation, progress callbacks and `timeoutMs` for startup (thirty seconds by default). It always waits for worker shutdown; shutdown and forced termination have separate bounded budgets. Prepare environments with the uv commands above.

## Editor lifecycle

`createEditor({ pythonExecutable? })` accepts an optional absolute path to an existing Python interpreter with the worker’s locked dependencies installed. Construction is lazy and performs no setup or downloads. The first `edit` starts a lightweight worker handshake and checks advertised capabilities before opening or normalizing images. The handshake imports no inference libraries and loads no weights. Without a `model` option the worker advertises no models, so requests fail with `UNSUPPORTED_CAPABILITY` before image I/O. Supported requests still undergo full content and filesystem validation before inference.

```ts
import { createEditor } from 'picpatch';

const editor = createEditor({ pythonExecutable: '/absolute/path/to/python' });
try {
  await editor.edit({
    model: 'an-installed-supported-model',
    instruction: 'Change the background to a garden.',
    sourceImage: '/absolute/path/to/source.png',
    outputPath: '/absolute/path/to/edited.png',
  }, { signal: abortController.signal, onProgress: event => updateProgress(event) });
} finally {
  await editor.dispose();
}
```

`abortController` and `updateProgress` above belong to the caller. Run `npm run example:worker -- /absolute/path/to/python /absolute/path/to/source.png /absolute/path/to/unused-output.png` for a model-free preparation and startup example. The SDK invokes the interpreter directly, without a shell or an installer, and drains worker diagnostics without forwarding private data to the caller’s stdout or stderr.

An editor retains one worker across sequential calls. Overlapping calls reject with `BUSY`; disposal permanently prevents new edits. `dispose()` is idempotent and waits for process closure, cancelling active work if necessary. Callers must dispose their editors before exiting. Failed workers are not silently restarted and edits are never retried; create a new editor after resolving a runtime failure.

An already-cancelled edit does no work. Cancellation during preparation waits for the active file operation to settle. During startup it terminates the worker; during an edit it requests cancellation and waits for the terminal outcome. Unresponsive workers are terminated before the operation settles. A published output wins a cancellation race; a worker result still undergoing output validation can be cancelled. A throwing synchronous progress callback produces `CALLBACK_FAILED` and stops its worker. Progress callbacks should be synchronous.

Optional `timeouts` on `createEditor` override `startupMs` (30 seconds), `editMs` (30 minutes), `cancellationMs` (5 seconds), `shutdownMs` (5 seconds), and `terminationMs` (2 seconds). These are transport defaults, not measured model performance promises. Shutdown bounds both acknowledgement and subsequent exit. Termination first sends SIGTERM, then SIGKILL after `terminationMs`, with another `terminationMs` to confirm closure. Timeouts report `TIMEOUT`; cancelled edits report `PicPatchCancelledError`. If closure cannot be confirmed, `TERMINATION_FAILED` reports that uncertainty and the editor cannot be reused. Caller-owned files are never deleted. Private artifacts are cleaned up only after their writers settle; uncertain worker termination retains the workspace and reports its recovery directory.

The lifecycle targets macOS. POSIX workers use an owned process group for termination. On Windows only the direct child is terminated; descendant cleanup is not yet supported there. Workers must not daemonize or launch detached descendants. Abrupt termination of the host is outside the explicit disposal guarantee.

## Worker protocol

The model-free worker runs with `uv run --project runtimes/mflux --locked python -m picpatch_worker --protocol-dir /absolute/path/to/picpatch/protocol`. This direct command is useful for protocol development; ordinary SDK callers use `createEditor` to own the process. Run `npm run test:python:coverage` for Python coverage.

Each frame is one UTF-8 JSON object followed by LF. Standard output is reserved for frames; diagnostics go to standard error. Images travel as paths, never inline pixels. Consumers process one frame at a time and must close the session on malformed JSON, invalid messages, unsupported versions, or correlation failures. There is no arbitrary image-count or frame-size cap; actual model limits are advertised as capabilities.

All messages carry `version: 1`, a positive, strictly increasing request `id` (within JavaScript’s safe integer range), and `type`. Responses echo the request ID. Send `hello` first; `ready` supplies the worker version and available model capabilities. An optional local `model` registration in `hello` selects the adapter. Its capabilities describe the adapter contract, not proof of installed dependencies, complete weights or measured hardware support; loading happens during the edit. Without registration the worker advertises no models and returns `BACKEND_UNAVAILABLE` for edits.

An edit may produce `progress` followed by exactly one `result` or `error`. Optional completed/total counters appear together. Only one edit may be pending. A `cancel` request has its own ID and an edit `targetId`; `cancelAck` acknowledges the request, while the edit must still settle separately. An accepted cancellation can race with successful completion. Inference runs on one owned thread so the reader can acknowledge cancellation while the producer is still active. Cancellation checks occur around loading, denoising callbacks and saving; native calls that cannot respond are bounded by the parent process termination deadline. Send `shutdown` after pending operations settle, then wait for `shutdownAck` and process exit.

The internal TypeScript `ProtocolSession` validates correlation and session ordering; `WorkerProcess` owns the child process, pipes, deadlines, and termination. The Python entry point dispatches the protocol and inference and exits with status 2 for malformed input, without echoing private frame contents. Shared fixtures are validated by both languages.

## Repository layout

- `src/client.ts` constructs the public editor; `src/execution/` owns operation orchestration and the worker-backed execution boundary.
- `src/images/`, `src/models/` and `src/runtime/` own image artifacts, model management and runtime inspection respectively.
- `src/backends/mflux/` owns MFLUX launch configuration; `src/worker/` owns shared process and protocol handling.
- `runtimes/mflux/` contains the uv project and Python worker, with explicit model-family adapters under `src/picpatch_worker/backends/`.
- `protocol/` defines shared editing payloads and the versioned worker wire contract.
- `tests/` holds ordinary tests and small fixtures; `benchmarks/` holds the opt-in local resource benchmark.
- `examples/` contains source-consumed SDK examples; `scripts/` contains development tools.

No installation hook downloads a runtime or model. Model weights are not included in this repository.

## License

[GNU GPL v3 or later](LICENSE) © 2026 Yoshinao Inoguchi

## Contact

- **Name:** Yoshinao Inoguchi
- **GitHub:** [@nao7sep](https://github.com/nao7sep)
- **Email:** [yoshinao@inoguchi.com](mailto:yoshinao@inoguchi.com)
- **Website:** [inoguchi.com](https://inoguchi.com)
