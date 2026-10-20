# PicPatch

Generate and edit images with local AI models.

PicPatch is a desktop app for local AI image generation and editing, with a standalone source package, PicPatchSdk, in the same repository. Both are in development. Every model runs on Apple Silicon Macs through Metal; 64-bit Windows runs the native engine's models (SD 1.5, SDXL and the other stable-diffusion.cpp families). Engines and models are acquired separately from the JavaScript dependencies.

For scripts and app integrations, start with the [PicPatchSdk guide](sdk/README.md). It covers engine and model setup, generation/editing, events, errors, resource paths and private sidecars. Import the package as `picpatchsdk`.

## Requirements

- An Apple Silicon Mac with macOS 26 or newer, or a 64-bit Windows PC. Models need roughly 8 to 32 GB of memory; the model picker shows each model's class, measured on an Apple M4.
- On Windows, the Microsoft Visual C++ Redistributable (x64), which the native engine needs. A Vulkan-capable graphics driver lets it use the GPU; without one it runs on the CPU, much more slowly.
- Disk space for the engines and models you choose.

## First launch

Release builds are unsigned, so the OS warns on first launch:

- **macOS:** right-click the app → **Open** (or run `xattr -dr com.apple.quarantine PicPatch.app`).
- **Windows:** SmartScreen → **More info** → **Run anyway**.

## Engines and models

Nothing is downloaded until you choose it in setup or in Managed tools.

- **Python engine (Mac only):** a uv-managed Python environment with the model's runtime packages, installed by the bundled uv from PyPI and the Python mirrors uv uses.
- **Native engine:** the pinned [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp) release, for SD 1.5, SDXL and other native models: the macOS build (about 90 MB) or the Windows Vulkan build (about 30 MB, with CPU fallback).
- **Downloadable models** (Mac only; 4-bit MLX bundles from Hugging Face, each pinned to a revision):

| Model | Download | Licence |
|---|---|---|
| FLUX.2 Klein 4B | 4.6 GB | Apache-2.0 |
| Z-Image Turbo | 5.9 GB | Apache-2.0 |
| FLUX.2 Klein 9B | 9.5 GB | FLUX non-commercial |
| FLUX.2 Klein Base 9B | 9.5 GB | FLUX non-commercial |
| FLUX.1 Fill dev | 9.6 GB | FLUX.1 dev non-commercial |

Other models are registered from files you already have; the model picker marks which ones have run with real weights in PicPatch's tests.

## Run from source

Use Node 24 or newer. Double-click the launcher for your platform (`scripts/run-dev.command` on macOS, `scripts/run-dev.ps1` on Windows), or run it by hand:

```bash
npm install
npm run dev
```

`scripts/rebuild.command` builds and launches the packaged app as it would be released, and `scripts/run-built.command` launches that build again without rebuilding. The packaged app carries uv for engine setup; `npm run prepare:tools` fetches the pinned build once, and installing an engine from a source run needs it too.

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
