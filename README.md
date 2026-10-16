# PicPatch

PicPatch is a headless SDK being developed for local AI image editing: instruction-based changes, grouped reference images, and masked edits.

This repository is a scaffold. It exports draft TypeScript types and contains the internal Python worker package layout, but cannot edit images yet. No runtime installer, model downloader, or inference backend is implemented. MFLUX is the first runtime candidate for an Apple Silicon Mac with 24 GB of unified memory; it is not installed by this scaffold.

## Development

Use Node.js 24 or newer and npm. Install the development dependencies with `npm ci`, then run `npm test`. This checks the TypeScript source, examples, and test configuration. Vitest is configured, but there are no behavioral tests yet.

Run `npm run example:request` to print an illustrative grouped-reference request. It does not read images, start a worker, or generate output. `npm run test:coverage` is wired for future behavioral tests; the scaffold has no coverage evidence.

The private package resolves directly to TypeScript source. Consumers use a TypeScript-capable runner or bundler; no SDK build step is required. The worker requires Python 3.12 or newer. Its `pyproject.toml` and `uv.lock` describe an internal package with no inference dependencies. Worker setup and packaging remain planned work.

## Repository layout

- `src/` contains the public SDK contracts and reserved image, model, and worker integration modules.
- `worker/` contains the Python worker package and future MFLUX adapter.
- `protocol/worker.schema.json` reserves the shared wire contract and deliberately accepts no messages yet.
- `tests/` holds ordinary tests and small fixtures; `benchmarks/` will hold opt-in quality and performance experiments.
- `examples/` contains source-consumed SDK examples; `scripts/` is reserved for development and worker packaging tools.

No installation hook downloads a runtime or model. Model weights are not included in this repository.

## License

[GNU GPL v3 or later](LICENSE) © 2026 Yoshinao Inoguchi

## Contact

- **Name:** Yoshinao Inoguchi
- **GitHub:** [@nao7sep](https://github.com/nao7sep)
- **Email:** [yoshinao@inoguchi.com](mailto:yoshinao@inoguchi.com)
- **Website:** [inoguchi.com](https://inoguchi.com)
