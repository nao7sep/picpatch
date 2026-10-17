# Worker resources

The worker is part of PicPatch's source package; Python and inference dependencies are prepared separately. Its uv project selects Python 3.15. Use `uv sync --project /absolute/picpatch/runtimes/mflux --extra inference --locked` to prepare that environment, or use a separate `UV_PROJECT_ENVIRONMENT` and pass its absolute interpreter to `createEditor({ pythonExecutable })`.

The package includes the worker source, shared model definitions, protocol schemas, `pyproject.toml` and `uv.lock`. It excludes environments, weights, caches and private experiment material. A local `npm pack` archive can be installed by a separate TypeScript consumer without publishing anything. Consumers need a TypeScript-aware runner such as `tsx`.

Worker paths resolve relative to the installed package, not the shell working directory. Preserve the package layout and externalize `picpatch` in a bundler; flattening the SDK into a single JavaScript file loses its resource locations. Use public package exports only. Models stay outside the package, and a separately prepared `sd-cli` remains a native backend dependency.

`inspectRuntime(pythonExecutable)` checks the model-free worker handshake without acquiring dependencies or models. Missing interpreters and missing worker resources fail with setup guidance. Import-time missing JSON resources mean the package itself is incomplete: restore the complete source package rather than copying selected TypeScript files.

This contract supports source-package consumers. Bundling an interpreter, native libraries or models into a GUI app requires a separate distribution and license review for that app.
