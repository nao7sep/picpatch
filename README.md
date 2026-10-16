# PicPatch

PicPatch is a headless SDK being developed for local AI image editing: instruction-based changes, grouped reference images, and masked edits.

The public editor validates and prepares image files, owns a persistent worker process, and safely publishes completed outputs. An experimental offline adapter connects grouped-reference editing to MFLUX 0.22.0 and FLUX.2 Klein 4B on Apple Silicon. The real-inference gate exercises the pinned 4-bit bundle through the public SDK. Portrait likeness and larger-image memory limits remain unverified. The SDK does not acquire Python or models automatically.

## Experimental local editing

Supply `createEditor` with `model: { adapter: 'mflux-flux2-klein-4b', directory, manifest, quantize? }`. `directory` must be an existing absolute model bundle path; `manifest` uses the verification contract described below. Verify the bundle during preparation with `verifyModel` and require a `matches-manifest` result before using it. Edits do not re-hash model files. The pinned development preparation script performs this verification before publishing its configuration. Keep the directory immutable while editing: verification neither locks the bundle nor proves an incomplete manifest covers everything MFLUX reads. The request's `model` must equal `manifest.model`. The returned revision is the caller-supplied manifest revision, not an independently authenticated identity.

The selected interpreter must already contain the worker dependencies and the optional `inference` extra from `worker/pyproject.toml`. Installing that extra downloads substantial runtime packages, but no model weights. Use a separate environment from the ordinary test environment. Install the optional inference extra through uv; a model catalog is not automated yet. The development test uses the pinned manifest in `tests/fixtures/klein-4b-4bit.manifest.json`.

The adapter supplies the source image first, followed by reference groups and images in caller order. It adds image ordinals, roles and group IDs to the instruction. Multiple pictures per person are preserved as separate references; this does not guarantee likeness or teach the model a new identity. Masks are rejected. Explicit output dimensions must be multiples of 16; omitted dimensions use 1024 by 1024. MFLUX's distilled generation defaults apply. Optional `quantize` accepts 4 or 8; omit it to use the checkpoint's configuration.

Models are loaded and released for each edit, while the worker is reused. This avoids retaining unmeasured model memory between operations, at the cost of reload latency. Progress reports loading, conditioning/editing, denoising steps and saving. Pixel output is saved without prompt metadata or sidecars. Hugging Face and Transformers run offline; the worker additionally rejects Python socket connections and isolates both Python and native standard output from protocol frames. This is not a general sandbox for arbitrary native packages.

Use `npx tsx examples/edit-local.ts /absolute/editor-options.json /absolute/edit-request.json` with a prepared interpreter, local bundle and existing input images. The example only uses supplied files; it never installs packages or downloads models.

## Development

Use Node.js 24 or newer, npm, and uv. The worker lock targets macOS arm64. The worker declares Python 3.15 (`>=3.15,<3.16`) in `worker/pyproject.toml`; uv selects a compatible interpreter and downloads one if needed. Run `uv sync --project worker --locked` to prepare the worker environment. Install the development dependencies with `npm ci`, then run `npm test`. This checks generated contracts, TypeScript source and examples, request validation, and TypeScript/Python protocol behavior. The Python test command lets uv prepare Python and the small locked validation and test dependencies; it never downloads models.

The ordinary suite uses simulated process streams and small generated images in temporary directories. `npm run test:full` additionally launches lightweight subprocess fixtures and the bundled Python worker, verifies reuse and termination, and exercises the public factory. It uses `worker/.venv` by default, or the environment selected by `UV_PROJECT_ENVIRONMENT` (relative paths resolve from `worker/`), and currently targets macOS/POSIX. The full gate also runs real inference using `node_modules/.cache/picpatch-live/inference-config.json`, or an absolute editor-options JSON path supplied through `PICPATCH_INFERENCE_CONFIG`. Missing prerequisites fail explicitly. No test downloads models. The missing-backend test needs uv on PATH and cached worker wheels to create an isolated model-free environment offline. Live tests are type-checked by the ordinary gate.

To prepare the real-inference test after the development setup, run these commands from the repository root. The first installs the locked inference packages into a separate environment; the second explicitly downloads approximately 4.62 GB of pinned model files and verifies every component before publishing the local configuration. Both the environment and weights stay in the ignored test cache.

```sh
UV_PROJECT_ENVIRONMENT="$PWD/node_modules/.cache/picpatch-live/inference-runtime" \
  uv sync --project worker --python "$PWD/worker/.venv/bin/python" \
  --extra inference --no-dev --locked --no-python-downloads
node_modules/.cache/picpatch-live/inference-runtime/bin/python scripts/prepare-inference.py
npm run test:full
```

Use `scripts/prepare-inference.py --offline` through that same interpreter to rebuild the configuration from cached weights without network access. The preparation tool is an explicit development download command; the test itself never downloads models. Its pinned manifest covers the encoder, transformer, VAE and tokenizer files required by this checkpoint. The full gate checks sequential grouped-reference/source edits, four and six references in two object groups, and cancellation after a denoising step using generated 256-pixel fixtures. It verifies artifacts, provenance and cleanup, not visual quality.

To test another Python version without replacing a working runtime, install the `inference` extra into a new `UV_PROJECT_ENVIRONMENT` using `uv sync --project worker --python /absolute/path/to/python --extra inference --locked --no-python-downloads`. Keep development dependencies installed for the gate. Copy the existing inference configuration to a separate JSON file and change only `pythonExecutable` to the new environment. Run `npm run test:full` with that environment, `UV_NO_SYNC=1` (to retain the inference extra), and `PICPATCH_INFERENCE_CONFIG` pointing to the copied configuration. This reuses the existing model bundle. Set `UV_OFFLINE=1` to prevent package acquisition during testing.

On macOS with Python 3.15, the lock selects PyTorch from its official CPU wheel index; MLX remains the inference engine. PyYAML and SentencePiece currently build from source, requiring a C++ toolchain and CMake. Other dependencies retain their normal PyPI source.

For resource measurements on macOS, run `python3 benchmarks/measure.py` with the same prepared configuration. It performs six sequential edits alternating four and six synthetic object references, with 512-pixel inputs and 768-pixel outputs. It checks originals and output cleanup, samples process-tree physical footprint and resident memory, records system memory pressure and swap, and checks observed child-process exit. Results stay in ignored `benchmarks/results/`. Sampled peaks are lower bounds, process charges may overlap, and system pressure includes other applications. This is a workload benchmark, not a portrait-likeness comparison or a memory guarantee for larger inputs.

Run `npm run example:request` to print an illustrative grouped-reference request. It does not read images, start a worker, or generate output. `npm run test:coverage` measures TypeScript behavioral coverage.

The private package resolves directly to TypeScript source. Consumers use a TypeScript-capable runner or bundler; no SDK build step is required. The worker’s `pyproject.toml` and `uv.lock` describe an internal package with JSON Schema validation and a separately locked optional `inference` extra. Ordinary setup and tests do not install that extra. Python and inference packages are provisioned through uv project commands, outside the SDK. The SDK accepts a prepared interpreter and does not install packages.

## Editing contracts

Call `validateEditRequest(request, capabilities?)` to validate metadata and obtain an independent copy. A request requires a model, nonblank instruction, absolute PNG output path, and either a source image or nonempty reference groups. Masks require a source image. Reference group IDs and normalized reference paths must be unique. Group and image order is preserved.

Optional model capabilities describe supported reference roles, mask semantics, dimension constraints, and maximum grouped reference count (excluding the source image). Unsupported requests produce `PicPatchUsageError`; malformed capability reports produce `PicPatchRuntimeError`. Cancellation has a distinct `PicPatchCancelledError` type.

`validateEditRequest` checks metadata only. `editor.edit` additionally opens and fully decodes single-frame PNG, JPEG, and WebP files by content. It rejects missing, malformed, animated, and unsupported images, and detects reference duplicates through symlink or hardlink aliases. Original files remain untouched. Results describe output dimensions, actual seed, model revision, runtime version, and the original ordered references.

Preparation uses Sharp to apply EXIF orientation, convert image color to sRGB, strip metadata, and write private PNG copies. Masks must be opaque grayscale PNGs matching the oriented source dimensions; black preserves and white edits. The baseline preparation does not resize or crop. The experimental MFLUX adapter delegates reference conditioning to MFLUX: references above one megapixel are downscaled preserving aspect ratio, then center-cropped to multiples of 16 pixels. Very small or narrow references can be rejected. Native decoding has a 60-second processing budget; cancellation waits for an active native writer to settle before removing its files.

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

These settings select model discovery locations; they do not move existing files, change a supplied editor model directory or redirect input/output paths. Explicit file paths remain literal. No directory is created by resolution or discovery, and model acquisition is not implemented yet.

### Verifying a model bundle

`validateModelManifest` validates a model identity, a hexadecimal immutable source revision, and a required component list. Each component declares a relative path, role, exact byte length, and SHA-256 digest. Manifest types are generated from the shared schema. Obtain these pins from a source you trust; PicPatch does not currently ship a tested model catalog or fetch manifests.

`verifyModel(directory, manifest, options?)` checks every declared file, streams its hash, detects changes while reading, and validates that shard-index mappings name weights in the manifest. File symlinks can point to shared cache blobs; directory symlinks cannot redirect verification outside the selected root. Unsafe or conflicting manifest paths are rejected before reading files. Verification never imports weights or executes model code.

Verification is a point-in-time result. Keep prepared model files unchanged; edits do not automatically detect later modifications. Call `verifyModel` again whenever you need a fresh integrity check.

A `matches-manifest` result means the declared files matched the supplied pins at verification time. It does not authenticate those pins, prove the manifest lists every component an adapter needs, or establish editing support; compatibility remains `unknown`. Missing files, mismatches and invalid indexes return an `invalid` result with component-level statuses. Filesystem failures throw `MODEL_IO`. Cancellation and progress use the same options as inspection; verification also accepts `timeoutMs`, defaulting to ten minutes. Active reads settle before cancellation or timeout is reported. No files are repaired, deleted, installed, or downloaded.

## Worker environment setup

`inspectRuntime(pythonExecutable, options?)` starts the bundled worker, checks its handshake, and waits for shutdown. It returns `worker-ready` plus the worker version and advertised model capabilities. This proves that the selected interpreter can run the worker, not that it matches the dependency lock or supports any image model. Inspection installs nothing and disables Python bytecode writes and user-site/Python-environment overrides.

Runtime inspection accepts cancellation, progress callbacks and `timeoutMs` for startup (thirty seconds by default). It always waits for worker shutdown; shutdown and forced termination have separate bounded budgets. Prepare environments with the uv commands above.

## Editor lifecycle

`createEditor({ pythonExecutable })` accepts the absolute path to an existing Python interpreter with the worker’s locked dependencies installed. Construction is lazy and performs no setup or downloads. The first `edit` prepares the inputs, starts the worker, and checks its advertised capabilities. Without a `model` option the worker advertises no models, so valid prepared requests fail with `UNSUPPORTED_CAPABILITY` and their temporary files are cleaned up.

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

The model-free worker runs with `uv run --project worker --locked python -m picpatch_worker --protocol-dir /absolute/path/to/picpatch/protocol`. This direct command is useful for protocol development; ordinary SDK callers use `createEditor` to own the process. Run `npm run test:python:coverage` for Python coverage.

Each frame is one UTF-8 JSON object followed by LF. Standard output is reserved for frames; diagnostics go to standard error. Images travel as paths, never inline pixels. Consumers process one frame at a time and must close the session on malformed JSON, invalid messages, unsupported versions, or correlation failures. There is no arbitrary image-count or frame-size cap; actual model limits are advertised as capabilities.

All messages carry `version: 1`, a positive, strictly increasing request `id` (within JavaScript’s safe integer range), and `type`. Responses echo the request ID. Send `hello` first; `ready` supplies the worker version and available model capabilities. An optional local `model` registration in `hello` selects the adapter. Its capabilities describe the adapter contract, not proof of installed dependencies, complete weights or measured hardware support; loading happens during the edit. Without registration the worker advertises no models and returns `BACKEND_UNAVAILABLE` for edits.

An edit may produce `progress` followed by exactly one `result` or `error`. Optional completed/total counters appear together. Only one edit may be pending. A `cancel` request has its own ID and an edit `targetId`; `cancelAck` acknowledges the request, while the edit must still settle separately. An accepted cancellation can race with successful completion. Inference runs on one owned thread so the reader can acknowledge cancellation while the producer is still active. Cancellation checks occur around loading, denoising callbacks and saving; native calls that cannot respond are bounded by the parent process termination deadline. Send `shutdown` after pending operations settle, then wait for `shutdownAck` and process exit.

The internal TypeScript `ProtocolSession` validates correlation and session ordering; `WorkerProcess` owns the child process, pipes, deadlines, and termination. The Python entry point dispatches the protocol and inference and exits with status 2 for malformed input, without echoing private frame contents. Shared fixtures are validated by both languages.

## Repository layout

- `src/` contains the public SDK contracts, request validation, image preparation and output handling, worker integration, and local model inspection.
- `worker/` contains the Python worker package and experimental MFLUX adapter.
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
