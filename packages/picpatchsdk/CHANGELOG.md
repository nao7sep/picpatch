# Changelog

## Unreleased

- Import the SDK as `picpatchsdk`; its source, worker, protocol and tests live in a standalone workspace package.
- Resource paths default under `~/.picpatchsdk/`. `StorageOptions.engineDirectory` replaces `dataDirectory`; resource overrides must be absolute and are no longer read from environment variables.
- Editing requires an explicit output path or output directory, supplied on the call or editor defaults.
- `onEvent`, `SdkEvent` and `EventOptions` replace `onDiagnostic`, `DiagnosticEvent` and `DiagnosticOptions`. Event and progress hooks cannot fail an operation; `CALLBACK_FAILED` is removed.
- Image metadata remains in optional sidecars, without embedded provenance.
