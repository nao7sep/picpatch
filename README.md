# PicPatch

PicPatch is a headless SDK being developed for local AI image editing: instruction-based changes, grouped reference images, and masked edits.

The SDK exports typed editing contracts, categorized errors, and runtime request validation, but cannot edit images yet. The public editor owns a persistent worker process. No runtime installer, model downloader, or inference backend is implemented. MFLUX is the first runtime candidate for an Apple Silicon Mac with 24 GB of unified memory; it is not installed by this scaffold.

## Development

Use Node.js 24 or newer, npm, uv, and Python 3.12 or newer. Install the development dependencies with `npm ci`, then run `npm test`. This checks generated contracts, TypeScript source and examples, request validation, and TypeScript/Python protocol behavior. The Python test command installs the small locked validation and test dependencies, but will not download Python or models.

The ordinary suite uses simulated process streams. `npm run test:full` additionally launches lightweight subprocess fixtures and the bundled Python worker, verifies reuse and termination, and exercises the public factory. It needs the existing `worker/.venv` created by the ordinary Python test setup and currently targets macOS/POSIX. These tests perform no inference and download no models. Live tests are type-checked by the ordinary gate.

Run `npm run example:request` to print an illustrative grouped-reference request. It does not read images, start a worker, or generate output. `npm run test:coverage` measures TypeScript behavioral coverage.

The private package resolves directly to TypeScript source. Consumers use a TypeScript-capable runner or bundler; no SDK build step is required. The worker’s `pyproject.toml` and `uv.lock` describe an internal package with JSON Schema validation and no inference dependencies. Automatic worker environment setup and packaging remain planned work.

## Editing contracts

Call `validateEditRequest(request, capabilities?)` to validate metadata and obtain an independent copy. A request requires a model, nonblank instruction, absolute PNG output path, and either a source image or nonempty reference groups. Masks require a source image. Reference group IDs and normalized reference paths must be unique. Group and image order is preserved.

Optional model capabilities describe supported reference roles, mask semantics, dimension constraints, and maximum grouped reference count (excluding the source image). Unsupported requests produce `PicPatchUsageError`; malformed capability reports produce `PicPatchRuntimeError`. Cancellation has a distinct `PicPatchCancelledError` type.

Validation does not open files or establish filesystem identity. Execution must reject existing output destinations, including aliases of inputs, and publish without overwriting. Results describe the output dimensions, actual seed, model revision, runtime version, and ordered references. File decoding, publication, and result production are not implemented yet.

`protocol/contracts.schema.json` owns the payload shapes. Run `npm run contracts:generate` after changing it; the default test gate checks generated types for drift.

## Editor lifecycle

`createEditor({ pythonExecutable })` accepts the absolute path to an existing Python interpreter with the worker’s locked dependencies installed. Construction is lazy and performs no setup or downloads. The first `edit` starts the worker and checks its advertised capabilities. The current model-free worker advertises no models, so edits fail with `UNSUPPORTED_CAPABILITY` before any image is opened.

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

`abortController` and `updateProgress` above belong to the caller. Run `npm run example:worker -- /absolute/path/to/python` for a model-free startup example. The SDK invokes the interpreter directly, without a shell or an installer, and drains worker diagnostics without forwarding private data to the caller’s stdout or stderr.

An editor retains one worker across sequential calls. Overlapping calls reject with `BUSY`; disposal permanently prevents new edits. `dispose()` is idempotent and waits for process closure, cancelling active work if necessary. Callers must dispose their editors before exiting. Failed workers are not silently restarted and edits are never retried; create a new editor after resolving a runtime failure.

Cancellation before startup does no work. During startup it terminates the worker; during an edit it requests cancellation and waits for the terminal outcome. Unresponsive workers are terminated before the operation settles. A confirmed successful result wins a cancellation race. A throwing synchronous progress callback produces `CALLBACK_FAILED` and stops its worker. Progress callbacks should be synchronous.

Optional `timeouts` on `createEditor` override `startupMs` (30 seconds), `editMs` (30 minutes), `cancellationMs` (5 seconds), `shutdownMs` (5 seconds), and `terminationMs` (2 seconds). These are transport defaults, not measured model performance promises. Shutdown bounds both acknowledgement and subsequent exit. Termination first sends SIGTERM, then SIGKILL after `terminationMs`, with another `terminationMs` to confirm closure. Timeouts report `TIMEOUT`; cancelled edits report `PicPatchCancelledError`. If closure cannot be confirmed, `TERMINATION_FAILED` reports that uncertainty and the editor cannot be reused. No output files are deleted on timeout or cancellation; artifact ownership and publication remain inference-layer work.

The lifecycle targets macOS. POSIX workers use an owned process group for termination. On Windows only the direct child is terminated; descendant cleanup is not yet supported there. Workers must not daemonize or launch detached descendants. Abrupt termination of the host is outside the explicit disposal guarantee.

## Worker protocol

The model-free worker runs with `uv run --project worker --locked --no-python-downloads python -m picpatch_worker --protocol-dir /absolute/path/to/picpatch/protocol`. This direct command is useful for protocol development; ordinary SDK callers use `createEditor` to own the process. Run `npm run test:python:coverage` for Python coverage.

Each frame is one UTF-8 JSON object followed by LF. Standard output is reserved for frames; diagnostics go to standard error. Images travel as paths, never inline pixels. Consumers process one frame at a time and must close the session on malformed JSON, invalid messages, unsupported versions, or correlation failures. There is no arbitrary image-count or frame-size cap; actual model limits are advertised as capabilities.

All messages carry `version: 1`, a positive, strictly increasing request `id` (within JavaScript’s safe integer range), and `type`. Responses echo the request ID. Send `hello` first; `ready` supplies the worker version and available model capabilities. This worker advertises no models and returns `BACKEND_UNAVAILABLE` for edits. It performs no image I/O or inference.

An edit may produce `progress` followed by exactly one `result` or `error`. Optional completed/total counters appear together. Only one edit may be pending. A `cancel` request has its own ID and an edit `targetId`; `cancelAck` acknowledges the request, while the edit must still settle separately. An accepted cancellation can race with successful completion. This worker always acknowledges cancellation as not accepted because no asynchronous edit can be running. Send `shutdown` after pending operations settle, then wait for `shutdownAck` and process exit.

The internal TypeScript `ProtocolSession` validates correlation and session ordering; `WorkerProcess` owns the child process, pipes, deadlines, and termination. The Python entry point dispatches the model-free protocol and exits with status 2 for malformed input, without echoing private frame contents. Shared fixtures are validated by both languages.

## Repository layout

- `src/` contains the public SDK contracts, request validation, and reserved image, model, and worker integration modules.
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
