# Changelog

## Unreleased

- Route rejected editor requests through the shared event/error boundary, including invalid plans and calls after disposal. Validate debug options consistently and retain verification events/counts during readiness checks.
- Add code/message fields to native engine readiness and code/message/effect fields to model component verification and inspection findings. Export the runtime configuration type used by startup events.

- Remove SDK-owned log files and log result fields. Caller-owned onEvent receives stable event names, a startup record with SDK/runtime identity, and opt-in debug progress; onProgress remains independent.

- Add an erased browser-types entry for GUI consumers, keeping browser contracts separate from Node runtime imports.

- Add explicit native engine inspection and installation for the pinned official Apple Silicon build (macOS 26+), with integrity/architecture checks and complete-directory publication. Model and runtime acquisition share bounded HTTPS transport.

- Model preparation now takes modelsDirectory directly, matching opening and inventory. Discovery reports individual inaccessible locations without discarding other results. Managed inventory includes older revisions and incomplete attempts; removeModel explicitly detaches and removes one managed directory without traversing external links.

- Add saveArtifact for verified byte-preserving PNG saves with independently published private sidecars, using the same exclusive publication boundary as inference.

- Shared profiles work with native model preparation without redirecting external bundles. Undefined profile timeouts inherit defaults, malformed preparation options report invalid calls, and runtime-readiness and external-model types are available from the public entry.

- Bound stalled filesystem/native-image waits while retaining pending-write ownership and recovery locations. Late completion cannot resume expired work; optional sidecar settlement remains independent of the saved image.

- Separate stage events from throttled counted progress, return parsed profile/record/registration data in named read-result fields. Enforce Python worker package/ambient-state boundaries and declare directly imported runtime dependencies.

- Return private versioned artifact records on every saved image, with SDK/caller identity and encoded input/output hashes. Add record reading and artifact verification; optional sidecars use `-picpatchsdk.json` and fail independently of images.

- Add presence-only `openModel`, managed catalog inventory and versioned caller-owned model registrations; preparation remains the integrity boundary.

- Read-only versioned profiles bundle resource locations, timeouts and editor defaults; explicit arguments win without ambient configuration.
- Editors can plan generation/editing without launching inference, then execute the immutable decision with fixed parameters, seed, geometry and content fingerprints. Changed inputs or destinations return refusals.

- Calls on an editor run in submission order, capturing arguments and applying cancellation/time budgets while waiting. Confirmed worker death allows a fresh worker on a later explicit call; failed inference is never replayed.
- `PicPatchSdkError` replaces the separate usage/runtime/cancellation classes. `errorCodes` and `isPicPatchSdkError` expose a data-first contract with kind, effect, subject and typed details across process boundaries.
- Image calls return `ImageOutcome`: a completed image or an `OUTPUT_CONFLICT` refusal. Sidecar failures report their own effect and never remove a published image.

- `installEngine` installs or reuses a managed Python 3.15 inference environment; `inspectEngine` checks its actual dependency/import readiness. Installation requires a caller-provided uv executable and never acquires models.
- Editor configuration uses `engineDirectory` instead of `pythonExecutable`. The worker and protocol stay with the SDK; compatible locked environments can be shared across independently released consumers.
- Engine readiness references use format version 1. Interrupted installations are not discoverable as ready, and existing environments remain usable during replacement.
- Worker and native subprocesses receive explicit environments rather than inheriting caller credentials or cache settings.

- Import the SDK as `picpatchsdk`; its source, worker, protocol and tests live in a standalone workspace package.
- Resource paths default under `~/.picpatchsdk/`. `StorageOptions.engineDirectory` replaces `dataDirectory`; resource overrides must be absolute and are no longer read from environment variables.
- Editing requires an explicit output path or output directory, supplied on the call or editor defaults.
- `onEvent`, `SdkEvent` and `EventOptions` replace `onDiagnostic`, `DiagnosticEvent` and `DiagnosticOptions`. Event and progress hooks cannot fail an operation; `CALLBACK_FAILED` is removed.
- Image metadata remains in optional sidecars, without embedded provenance.
