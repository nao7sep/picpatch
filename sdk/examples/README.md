# Examples

Runnable consumer scripts for PicPatchSdk, type-checked with the SDK's tests and run by hand from `sdk/` with plain Node: `node examples/<name>.ts ARGUMENTS`. Each script's first lines state its arguments. They acquire nothing unless the script says so: `install-engine.ts` installs the managed Python engine with a uv you supply. The others expect a prepared engine and model: a configuration from `scripts/prepare-inference.ts` (see `tests/live/README.md`) or an `sd-cli` and model files you name.

- `edit-request.ts` validates a request's shape and opens no files (`npm run example:request`).
- `install-engine.ts` installs or reuses the managed engine.
- `edit-local.ts`, `generate-and-fill.ts`, `klein-base.ts`, `outpaint.ts` and `artifact-sidecar.ts` run MFLUX generation and editing with a prepared configuration.
- `source-variation.ts`, `identity-edit.ts` and `structural-control.ts` run the native engine with your own model files.
