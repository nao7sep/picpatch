# PicPatch

PicPatch is a desktop app for local AI image generation and editing, with a standalone source package, PicPatchSdk, in the same repository. Both are in development. Inference targets Apple Silicon Macs; engines and models are acquired separately from the JavaScript dependencies.

For scripts and app integrations, start with the [PicPatchSdk guide](sdk/README.md). It covers engine and model setup, generation/editing, events, errors, resource paths and private sidecars. Import the package as `picpatchsdk`.

## Run from source

Use Node 24 or newer. Double-click the launcher for your platform (`scripts/run-dev.command` on macOS, `scripts/run-dev.ps1` on Windows), or run it by hand:

```bash
npm install
npm run dev
```

`scripts/rebuild.command` builds and launches the packaged app as it would be released, and `scripts/run-built.command` launches that build again without rebuilding. The packaged app carries uv for engine setup; `npm run prepare:tools` fetches the pinned build once.

On first launch, setup guides you through choosing a model, installing its engine and downloading or registering the model. Nothing is downloaded until you choose it. The app keeps its settings, sessions and records under `~/.picpatch`; SDK engines and models default to `~/.picpatchsdk`, independently of the app.

## Tests

`npm test` runs the type check and the ordinary app and SDK suites. See the [SDK development instructions](sdk/README.md#development) for the SDK's own gate and live-test requirements.

## License

[GNU GPL v3 or later](LICENSE) © 2026 Yoshinao Inoguchi

## Contact

- **Name:** Yoshinao Inoguchi
- **GitHub:** [@nao7sep](https://github.com/nao7sep)
- **Email:** [yoshinao@inoguchi.com](mailto:yoshinao@inoguchi.com)
- **Website:** [inoguchi.com](https://inoguchi.com)
