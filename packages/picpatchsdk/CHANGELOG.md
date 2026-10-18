# Changelog

## Unreleased

- `installEngine` installs or reuses a managed Python 3.15 inference environment; `inspectEngine` checks its actual dependency/import readiness. Installation requires a caller-provided uv executable and never acquires models.
- Editor configuration uses `engineDirectory` instead of `pythonExecutable`. The worker and protocol stay with the SDK; compatible locked environments can be shared across independently released consumers.
- Engine readiness references use format version 1. Interrupted installations are not discoverable as ready, and existing environments remain usable during replacement.
- Worker and native subprocesses receive explicit environments rather than inheriting caller credentials or cache settings.

- Import the SDK as `picpatchsdk`; its source, worker, protocol and tests live in a standalone workspace package.
- Resource paths default under `~/.picpatchsdk/`. `StorageOptions.engineDirectory` replaces `dataDirectory`; resource overrides must be absolute and are no longer read from environment variables.
- Editing requires an explicit output path or output directory, supplied on the call or editor defaults.
- `onEvent`, `SdkEvent` and `EventOptions` replace `onDiagnostic`, `DiagnosticEvent` and `DiagnosticOptions`. Event and progress hooks cannot fail an operation; `CALLBACK_FAILED` is removed.
- Image metadata remains in optional sidecars, without embedded provenance.
