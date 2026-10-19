# Changelog

## Unreleased

- Accept explicit prompt reference conditioning in GLM-Image and FLUX.2 Dev, matching their advertised capabilities; dedicated appearance and identity conditioning remain unsupported.

- Add experimental external GLM-Image and FLUX.2 Dev generation/reference-editing selections through a separately managed Diffusers runtime. Preparation fingerprints the complete local pipeline; these adapters have weight-free runtime evidence, not trained-weight qualification.
- Add source-audited native HiDream O1/Dev generation and ordered-reference editing, and MFLUX Ideogram4 generation with explicit steps and scalar guidance. Ideogram quality presets are not exposed; its supported output dimensions are 256–2048 pixels in multiples of sixteen.
- Model geometry can declare minimum dimensions, enforced before inference alongside existing multiples and maximum dimensions.

- Add experimental external generation selections for Krea 2 Turbo/Raw, Boogu Image Turbo, Ming Image Design, SD3.5 Large, Chroma and Chroma Radiance. Installed APIs and native source contracts are checked; these configurations are not trained-weight qualified.
- Local model registrations accept explicit CLIP-L, CLIP-G and T5 components for the supported native flow models, with manifest fingerprinting and persisted registration fixtures.

- Add an experimental offline DreamO 1.1 reference-edit path with separate learned indices for up to two single-photo subject/object groups. Its independently selected managed Python environment and fixed preprocessing/model components do not alter MFLUX installations. No trained-weight quality claim is implied by pipeline checks.
- Engine install/inspection accept `runtime: 'dreamo'`; image clients and readiness select the runtime from the prepared model. Shared worker protocol/lifecycle source remains bundled with the SDK.

- Return `present` from successful openModel calls: this cheap check confirms local file presence and size, not runtime compatibility or inference readiness.
- Rename the shared generation/editing runtime owner to createImageClient, ImageClient and ImageClientOptions; rename shared defaults to ImageDefaults, local model descriptors to LocalModel, and catalog entries to ModelCatalogEntry. These source API changes do not change serialized model registrations or image records.

- Add pinned, inference-tested Z-Image Turbo Q4 generation and FLUX.1 Fill Q4 native masked-edit bundles, with source revisions, complete component fingerprints and license information. External selections remain available.
- Release completed encoder and transformer stages in Z-Image and Fill single-image pipelines without changing cache limits or decode tiling.

- Record the effective mask mechanism in image results and private sidecars, including outpainting. Older records without the field remain readable and do not imply a preservation guarantee.
- Accept prepared SD1.5/SDXL depth and pose maps alongside Canny, with matching full ControlNet assets and family-specific architecture checks. Native selections expose conventional Euler, Heun and DPM samplers with discrete, Karras and exponential schedules; defaults remain unchanged. These additional choices have contract/source evidence, not trained-map quality claims.

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
