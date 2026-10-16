# PicPatch

PicPatch is a headless SDK being developed for local AI image editing: instruction-based changes, grouped reference images, and masked edits.

The SDK exports typed editing contracts, categorized errors, and runtime request validation, but cannot edit images yet. The public editor validates and prepares image files, owns a persistent worker process, and safely publishes completed outputs. No runtime installer, model downloader, or inference backend is implemented. MFLUX is the first runtime candidate for an Apple Silicon Mac with 24 GB of unified memory; it is not installed by this scaffold.

## Development

Use Node.js 24 or newer, npm, uv, and Python 3.12 or newer. Install the development dependencies with `npm ci`, then run `npm test`. This checks generated contracts, TypeScript source and examples, request validation, and TypeScript/Python protocol behavior. The Python test command installs the small locked validation and test dependencies, but will not download Python or models.

The ordinary suite uses simulated process streams and small generated images in temporary directories. `npm run test:full` additionally launches lightweight subprocess fixtures and the bundled Python worker, verifies reuse and termination, and exercises the public factory. It needs the existing `worker/.venv` created by the ordinary Python test setup and currently targets macOS/POSIX. These tests perform no inference and download no models. Live tests are type-checked by the ordinary gate.

Run `npm run example:request` to print an illustrative grouped-reference request. It does not read images, start a worker, or generate output. `npm run test:coverage` measures TypeScript behavioral coverage.

The private package resolves directly to TypeScript source. Consumers use a TypeScript-capable runner or bundler; no SDK build step is required. The worker’s `pyproject.toml` and `uv.lock` describe an internal package with JSON Schema validation and no inference dependencies. Automatic worker environment setup and packaging remain planned work.

## Editing contracts

Call `validateEditRequest(request, capabilities?)` to validate metadata and obtain an independent copy. A request requires a model, nonblank instruction, absolute PNG output path, and either a source image or nonempty reference groups. Masks require a source image. Reference group IDs and normalized reference paths must be unique. Group and image order is preserved.

Optional model capabilities describe supported reference roles, mask semantics, dimension constraints, and maximum grouped reference count (excluding the source image). Unsupported requests produce `PicPatchUsageError`; malformed capability reports produce `PicPatchRuntimeError`. Cancellation has a distinct `PicPatchCancelledError` type.

`validateEditRequest` checks metadata only. `editor.edit` additionally opens and fully decodes single-frame PNG, JPEG, and WebP files by content. It rejects missing, malformed, animated, and unsupported images, and detects reference duplicates through symlink or hardlink aliases. Original files remain untouched. Results describe output dimensions, actual seed, model revision, runtime version, and the original ordered references.

Preparation uses Sharp to apply EXIF orientation, convert image color to sRGB, strip metadata, and write private PNG copies. Masks must be opaque grayscale PNGs matching the oriented source dimensions; black preserves and white edits. No resizing, cropping, or model-specific preprocessing is implemented yet. Native decoding has a 60-second processing budget; cancellation waits for an active native writer to settle before removing its files.

The output directory must already exist. Each edit owns a private temporary directory there; the worker receives only prepared paths and a private output path. Publication fully decodes the worker’s PNG, checks dimensions, syncs the completed file, then uses an exclusive atomic hard link. Existing destinations, including symlinks and hardlinks, are never overwritten—even if another writer creates the destination during an edit. The destination filesystem must support hard links; there is no non-atomic fallback.

Temporary files are removed after their writers settle. Publication failures retain the completed image and expose `error.recoveryDirectory`; unconfirmed worker termination also retains the workspace. Inspect and remove retained directories when safe; automatic recovery is not implemented. If an output was saved but temporary cleanup failed, the successful result includes `cleanupWarning` with the directory to remove. Cancellation after atomic publication cannot turn a saved result into failure.

`protocol/contracts.schema.json` owns the payload shapes. Run `npm run contracts:generate` after changing it; the default test gate checks generated types for drift.

## Local model inspection

`inspectModel` inventories a caller-selected absolute file or directory. `discoverModels` searches explicit absolute roots recursively, grouping a directory with its nested components when it contains model configuration or weight filenames. It follows cached weight-file symlinks, skips nested directory symlinks and `.git`, and deduplicates aliases and overlapping bundles. There is no automatic home-directory scan.

```ts
import { inspectModel, discoverModels } from 'picpatch';

const inventory = await discoverModels(['/absolute/path/to/local/models']);
const details = await inspectModel('/absolute/path/to/local/model');
```

Both operations are read-only, accept `signal` and `onProgress` options, and need neither Python nor a network connection. They inspect file metadata without loading weights, parsing model configurations, hashing large files, or running model code. Missing locations and filesystem failures reject with `MODEL_IO`; a failed search does not return a deceptively complete partial list.

Candidate detection is based on filenames, so unrelated files with weight-like names may appear. Results always report integrity as `not-verified` and compatibility as `unknown`. `unverified` means weight-named files are present; `incomplete` means an empty, partial, or missing linked file was observed; `unrecognized` means no weight-named files were found. These states do not prove bundle completeness, safe contents, upstream identity, supported editing capabilities, or readiness to load. Use explicit manifest verification for stronger file checks; runtime compatibility still requires a tested adapter. Inspection is a point-in-time inventory, not a lock against other processes changing files.

### Verifying a model bundle

`validateModelManifest` validates a model identity, a hexadecimal immutable source revision, and a required component list. Each component declares a relative path, role, exact byte length, and SHA-256 digest. Manifest types are generated from the shared schema. Obtain these pins from a source you trust; PicPatch does not currently ship a tested model catalog or fetch manifests.

`verifyModel(directory, manifest, options?)` checks every declared file, streams its hash, detects changes while reading, and validates that shard-index mappings name weights in the manifest. File symlinks can point to shared cache blobs; directory symlinks cannot redirect verification outside the selected root. Unsafe or conflicting manifest paths are rejected before reading files. Verification never imports weights or executes model code.

A `matches-manifest` result means the declared files matched the supplied pins at verification time. It does not authenticate those pins, prove the manifest lists every component an adapter needs, or establish editing support; compatibility remains `unknown`. Missing files, mismatches and invalid indexes return an `invalid` result with component-level statuses. Filesystem failures throw `MODEL_IO`. Cancellation and progress use the same options as inspection; verification also accepts `timeoutMs`, defaulting to ten minutes. Active reads settle before cancellation or timeout is reported. No files are repaired, deleted, installed, or downloaded.

## Editor lifecycle

`createEditor({ pythonExecutable })` accepts the absolute path to an existing Python interpreter with the worker’s locked dependencies installed. Construction is lazy and performs no setup or downloads. The first `edit` prepares the inputs, starts the worker, and checks its advertised capabilities. The current model-free worker advertises no models, so valid prepared requests fail with `UNSUPPORTED_CAPABILITY` and their temporary files are cleaned up.

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

The model-free worker runs with `uv run --project worker --locked --no-python-downloads python -m picpatch_worker --protocol-dir /absolute/path/to/picpatch/protocol`. This direct command is useful for protocol development; ordinary SDK callers use `createEditor` to own the process. Run `npm run test:python:coverage` for Python coverage.

Each frame is one UTF-8 JSON object followed by LF. Standard output is reserved for frames; diagnostics go to standard error. Images travel as paths, never inline pixels. Consumers process one frame at a time and must close the session on malformed JSON, invalid messages, unsupported versions, or correlation failures. There is no arbitrary image-count or frame-size cap; actual model limits are advertised as capabilities.

All messages carry `version: 1`, a positive, strictly increasing request `id` (within JavaScript’s safe integer range), and `type`. Responses echo the request ID. Send `hello` first; `ready` supplies the worker version and available model capabilities. This worker advertises no models and returns `BACKEND_UNAVAILABLE` for edits. It performs no image I/O or inference.

An edit may produce `progress` followed by exactly one `result` or `error`. Optional completed/total counters appear together. Only one edit may be pending. A `cancel` request has its own ID and an edit `targetId`; `cancelAck` acknowledges the request, while the edit must still settle separately. An accepted cancellation can race with successful completion. This worker always acknowledges cancellation as not accepted because no asynchronous edit can be running. Send `shutdown` after pending operations settle, then wait for `shutdownAck` and process exit.

The internal TypeScript `ProtocolSession` validates correlation and session ordering; `WorkerProcess` owns the child process, pipes, deadlines, and termination. The Python entry point dispatches the model-free protocol and exits with status 2 for malformed input, without echoing private frame contents. Shared fixtures are validated by both languages.

## Repository layout

- `src/` contains the public SDK contracts, request validation, image preparation and output handling, worker integration, and local model inspection.
- `worker/` contains the Python worker package and future MFLUX adapter.
- `protocol/` defines shared editing payloads and the versioned worker wire contract.
- `tests/` holds ordinary tests and small fixtures; `benchmarks/` will hold opt-in quality and performance experiments.
- `examples/` contains source-consumed SDK examples; `scripts/` contains development tools.

No installation hook downloads a runtime or model. Model weights are not included in this repository.

## License

[GNU GPL v3 or later](LICENSE) © 2026 Yoshinao Inoguchi

## Contact

- **Name:** Yoshinao Inoguchi
- **GitHub:** [@nao7sep](https://github.com/nao7sep)
- **Email:** [yoshinao@inoguchi.com](mailto:yoshinao@inoguchi.com)
- **Website:** [inoguchi.com](https://inoguchi.com)
