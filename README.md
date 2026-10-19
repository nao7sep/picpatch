# PicPatch

PicPatch is a desktop app for local AI image generation and editing, with a standalone source package, PicPatchSdk, in the same repository. Both are in development. Inference targets Apple Silicon Macs; engines and models are acquired separately from the JavaScript dependencies.

For scripts and app integrations, start with the [PicPatchSdk guide](sdk/README.md). It covers engine and model setup, generation/editing, events, errors, resource paths and private sidecars. Import the package as `picpatchsdk`.

## Run from source

Use Node 24 or newer and npm. From the repository root:

```sh
npm install
npm start
```

The app owns its settings, sessions and records. SDK engine and model resources default under `~/.picpatchsdk`, independently of the app's `~/.picpatch` home. Model downloads and runtime setup are explicit operations.

Run `npm test` for the default app and SDK gate. See the [SDK development instructions](sdk/README.md#development) for its independent gate and live-test requirements.

## License

[GNU GPL v3 or later](LICENSE) © 2026 Yoshinao Inoguchi

## Contact

- **Name:** Yoshinao Inoguchi
- **GitHub:** [@nao7sep](https://github.com/nao7sep)
- **Email:** [yoshinao@inoguchi.com](mailto:yoshinao@inoguchi.com)
- **Website:** [inoguchi.com](https://inoguchi.com)
