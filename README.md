# PicPatch

PicPatch is a headless SDK being developed for local AI image editing: instruction-based changes, grouped reference images, and masked edits.

The SDK exports typed editing contracts, categorized errors, and runtime request validation, but cannot edit images yet. No runtime installer, model downloader, or inference backend is implemented. MFLUX is the first runtime candidate for an Apple Silicon Mac with 24 GB of unified memory; it is not installed by this scaffold.

## Development

Use Node.js 24 or newer and npm. Install the development dependencies with `npm ci`, then run `npm test`. This checks generated contracts, TypeScript source and examples, and request-validation behavior.

Run `npm run example:request` to print an illustrative grouped-reference request. It does not read images, start a worker, or generate output. `npm run test:coverage` measures TypeScript behavioral coverage.

The private package resolves directly to TypeScript source. Consumers use a TypeScript-capable runner or bundler; no SDK build step is required. The worker requires Python 3.12 or newer. Its `pyproject.toml` and `uv.lock` describe an internal package with no inference dependencies. Worker setup and packaging remain planned work.

## Editing contracts

Call `validateEditRequest(request, capabilities?)` to validate metadata and obtain an independent copy. A request requires a model, nonblank instruction, absolute PNG output path, and either a source image or nonempty reference groups. Masks require a source image. Reference group IDs and normalized reference paths must be unique. Group and image order is preserved.

Optional model capabilities describe supported reference roles, mask semantics, dimension constraints, and maximum grouped reference count (excluding the source image). Unsupported requests produce `PicPatchUsageError`; malformed capability reports produce `PicPatchRuntimeError`. Cancellation has a distinct `PicPatchCancelledError` type.

Validation does not open files or establish filesystem identity. Execution must reject existing output destinations, including aliases of inputs, and publish without overwriting. Results describe the output dimensions, actual seed, model revision, runtime version, and ordered references. File decoding, publication, and result production are not implemented yet.

`protocol/contracts.schema.json` owns the payload shapes. Run `npm run contracts:generate` after changing it; the default test gate checks generated types for drift.

## Repository layout

- `src/` contains the public SDK contracts, request validation, and reserved image, model, and worker integration modules.
- `worker/` contains the Python worker package and future MFLUX adapter.
- `protocol/worker.schema.json` reserves the shared wire contract and deliberately accepts no messages yet.
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
