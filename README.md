# PicPatch

PicPatch is a headless SDK being developed for local AI image editing: instruction-based changes, grouped reference images, and masked edits.

The SDK exports typed editing contracts, categorized errors, and runtime request validation, but cannot edit images yet. No runtime installer, model downloader, or inference backend is implemented. MFLUX is the first runtime candidate for an Apple Silicon Mac with 24 GB of unified memory; it is not installed by this scaffold.

## Development

Use Node.js 24 or newer, npm, uv, and Python 3.12 or newer. Install the development dependencies with `npm ci`, then run `npm test`. This checks generated contracts, TypeScript source and examples, request validation, and TypeScript/Python protocol behavior. The Python test command installs the small locked validation and test dependencies, but will not download Python or models.

Run `npm run example:request` to print an illustrative grouped-reference request. It does not read images, start a worker, or generate output. `npm run test:coverage` measures TypeScript behavioral coverage.

The private package resolves directly to TypeScript source. Consumers use a TypeScript-capable runner or bundler; no SDK build step is required. The worker’s `pyproject.toml` and `uv.lock` describe an internal package with JSON Schema validation and no inference dependencies. Worker setup and packaging remain planned work.

## Editing contracts

Call `validateEditRequest(request, capabilities?)` to validate metadata and obtain an independent copy. A request requires a model, nonblank instruction, absolute PNG output path, and either a source image or nonempty reference groups. Masks require a source image. Reference group IDs and normalized reference paths must be unique. Group and image order is preserved.

Optional model capabilities describe supported reference roles, mask semantics, dimension constraints, and maximum grouped reference count (excluding the source image). Unsupported requests produce `PicPatchUsageError`; malformed capability reports produce `PicPatchRuntimeError`. Cancellation has a distinct `PicPatchCancelledError` type.

Validation does not open files or establish filesystem identity. Execution must reject existing output destinations, including aliases of inputs, and publish without overwriting. Results describe the output dimensions, actual seed, model revision, runtime version, and ordered references. File decoding, publication, and result production are not implemented yet.

`protocol/contracts.schema.json` owns the payload shapes. Run `npm run contracts:generate` after changing it; the default test gate checks generated types for drift.

## Worker protocol

The model-free worker runs with `uv run --project worker --locked --no-python-downloads python -m picpatch_worker --protocol-dir /absolute/path/to/picpatch/protocol`. Its protocol directory is explicit; worker packaging and automatic process ownership are not implemented yet. Run `npm run test:python:coverage` for Python coverage.

Each frame is one UTF-8 JSON object followed by LF. Standard output is reserved for frames; diagnostics go to standard error. Images travel as paths, never inline pixels. Consumers process one frame at a time and must close the session on malformed JSON, invalid messages, unsupported versions, or correlation failures. There is no arbitrary image-count or frame-size cap; actual model limits are advertised as capabilities.

All messages carry `version: 1`, a positive, strictly increasing request `id` (within JavaScript’s safe integer range), and `type`. Responses echo the request ID. Send `hello` first; `ready` supplies the worker version and available model capabilities. This worker advertises no models and returns `BACKEND_UNAVAILABLE` for edits. It performs no image I/O or inference.

An edit may produce `progress` followed by exactly one `result` or `error`. Optional completed/total counters appear together. Only one edit may be pending. A `cancel` request has its own ID and an edit `targetId`; `cancelAck` acknowledges the request, while the edit must still settle separately. An accepted cancellation can race with successful completion. This worker always acknowledges cancellation as not accepted because no asynchronous edit can be running. Send `shutdown` after pending operations settle, then wait for `shutdownAck` and process exit.

The internal TypeScript `ProtocolSession` validates correlation and session ordering; it does not spawn a process or implement timeouts. The Python entry point dispatches the model-free protocol and exits with status 2 for malformed input, without echoing private frame contents. Shared fixtures are validated by both languages.

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
