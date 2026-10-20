# PicPatchSdk

PicPatchSdk is a private TypeScript SDK for local AI image generation and editing. It prepares images and models, runs inference, and publishes PNGs with optional private JSON sidecars. Apps and scripts own their interfaces, output locations, saved sessions and logs.

The SDK is in development. Inference targets Apple Silicon Macs through MFLUX or stable-diffusion.cpp (the managed native build requires macOS 26 or newer) and 64-bit Windows through stable-diffusion.cpp's Vulkan build, which needs the Microsoft Visual C++ Redistributable (x64) and falls back to the CPU. Each catalog entry lists the hosts its runtime supports and whether this computer is one; engine inspection reports `unsupported` elsewhere. Model support, memory needs and conditioning capabilities vary by selection. A catalog entry is not a promise of image quality or that its weights fit a particular machine.

## Use from source

The package name is `picpatchsdk`. In this repository it is the `sdk/` workspace; consumers import its public entry by package name. It is private and is not published to a registry. Link the source package through your package manager and install its declared dependencies. Keep its worker source, protocol schemas and runtime manifests alongside its TypeScript source.

Use Node 24 or newer with native TypeScript stripping. The SDK has no build step. A consumer script can run with `node script.ts` when its package manager resolves `picpatchsdk` to the source workspace. A released app must carry the SDK, its dependencies and worker resources with its own release; it must not depend on this checkout. Bundling requires preserving those resources and their package-relative locations. Browser consumers use type-only imports from `picpatchsdk/types`; inference runs in Node.

From this repository's root, `npm install` installs the JavaScript dependencies. It does not install an inference engine or model weights.

## Prepare an engine and model

Acquisition is explicit. For MFLUX, `installEngine` installs or reuses a managed Python environment with the locked inference dependencies, independently of system Python. The caller supplies an absolute path to uv. Python and package downloads may be substantial; this operation does not download models. Build prerequisites, when needed, remain the caller's responsibility; `toolDirectories` supplies their absolute directories without reading the caller's `PATH`.

```ts
import { installEngine, prepareModel } from 'picpatchsdk';

// Explicit setup: these calls may download runtime packages and model weights.
const engine = await installEngine({ uvExecutable: '/absolute/path/to/uv' });
const prepared = await prepareModel('flux2-klein-4b-4bit', { download: true });
```

`inspectEngine()` checks managed runtime readiness without installing. `installEngine` also accepts explicit engine, cache and Python directories, a time budget, cancellation, events and `offline: true`. Readiness is published only after the installed environment passes its checks. Engine identity includes platform, architecture, Python and dependency-lock identity. Engine storage is intended for local disks.

For an existing model, omit `download` to verify and reuse its managed bundle, or pass an absolute `directory` to use a compatible bundle in place. `prepareModel` verifies pinned components or fingerprints external files and returns a registration whose `model` is passed to the editor. It preserves invalid existing bundles rather than silently repairing them. Keep prepared files unchanged during use: inference does not re-hash them on every call. Use `verifyModel(directory, manifest)` for a fresh explicit check.

## Generate and edit

This example assumes the MFLUX engine and selected model are already prepared, and the source image and output directory exist. It downloads nothing. Replace the absolute example paths with your own.

```ts
import { createEditor, prepareModel } from 'picpatchsdk';

const prepared = await prepareModel('flux2-klein-4b-4bit');
const editor = createEditor({
  model: prepared.model,
  defaults: { outputDirectory: '/absolute/outputs' },
});
try {
  const generated = await editor.generate({
    prompt: 'A blue ceramic bowl on a white table.',
    seed: 42,
    size: { width: 1024, height: 1024 },
    sidecar: {},
  });
  if ('status' in generated) {
    console.log(generated.code); // A refusal, such as OUTPUT_CONFLICT.
  } else {
    console.log(generated.image.path);
    if (generated.sidecar?.status === 'failed') console.log(generated.sidecar.code);
  }

  const edited = await editor.edit({
    instruction: 'Change the background to a garden.',
    sourceImage: '/absolute/source.png',
    references: [{
      id: 'subject', role: 'subject',
      images: ['/absolute/reference-front.png', '/absolute/reference-side.png'],
    }],
  });
  if ('status' in edited) console.log(edited.code);
  else console.log(edited.image.path);
} finally {
  await editor.dispose();
}
```

The console output here belongs to the script. The SDK itself never writes to standard streams or creates a log.

Every image request needs `outputPath` or `outputDirectory` on the request, or an `outputDirectory` editor default. There is no automatic output beside the source. A directory produces a unique PNG filename; an explicit path must be an unused PNG destination. Supply only one of these fields on a request. Output directories must already exist.

The prepared model supplies the request's model identity. An explicit conflicting model is rejected. Request settings override editor defaults; sampling parameters merge by field. `seed: 0` is valid. Omitted size, sampling parameters and seed are resolved by the selected adapter and planning logic. `parameters` can contain steps, guidance, negative prompt, scheduler, sampler and edit strength or conditioning strengths, but only when advertised by the selected model's capabilities. Unsupported options fail rather than being silently ignored.

## Models and conditioning

Use `listModels()` for selectable IDs, capabilities, acquisition mode and evidence. Pinned selections include component hashes, download size and license information. External selections require caller-owned files and cannot be downloaded by `prepareModel`. The [catalog](src/models/catalog.ts), [MFLUX variant definitions](runtimes/mflux/src/picpatch_worker/backends/models.json) and [native selections](src/backends/stable-diffusion-cpp/models.ts) own the current inventory. Check each model's license separately from the SDK's license.

MFLUX selections cover Klein, FLUX.1 generation/Fill/Kontext, Z-Image, ERNIE-Image and Qwen generation/editing pipelines. Native selections cover SD1.5/SDXL generation, source variation and trained inpainting. Support is selection-specific: an adapter for one architecture does not accept arbitrary checkpoints. Evidence ranges from source auditing and API tests to real-weight execution tests; it does not establish identity preservation or image quality.

References preserve group and image order. Prompt grouping, dedicated identity conditioning and appearance conditioning are different capabilities. Several photos in a group do not train an identity. Native PhotoMaker/IP-Adapter, local LoRAs and structural control require compatible assets during model preparation and the corresponding advertised capability. See [identity editing](examples/identity-edit.ts), [source variation](examples/source-variation.ts) and the public [request types](src/contracts.generated.ts) for their shapes.

For native inference, explicitly install the supported engine or inspect an existing installation, then pass its executable to the editor:

```ts
import { installNativeEngine, prepareModel, createEditor } from 'picpatchsdk';

const engine = await installNativeEngine(); // May download the pinned native runtime.
const prepared = await prepareModel('sdxl', {
  directory: '/absolute/models', checkpoint: 'model.safetensors',
});
const editor = createEditor({ model: prepared.model, nativeExecutable: engine.nativeExecutable });
try {
  const result = await editor.generate({ prompt: 'A ceramic bowl.', outputDirectory: '/absolute/outputs' });
  if ('status' in result) console.log(result.code);
  else console.log(result.image.path);
} finally {
  await editor.dispose();
}
```

`checkpoint` and other declared component names are bundle-relative identifiers under the absolute `directory`; they are not independently resolved filesystem paths. MFLUX external preparation expects complete compatible component directories. Native preparation accepts the supported checkpoint layouts and optional companion assets. Neither path imports arbitrary model code.

`inspectModel` inventories a file or directory; `discoverModels` searches explicit roots or the default model root and reports per-location failures alongside discovered models. These are metadata inspections, not integrity or compatibility guarantees. `inspectModels` inventories the managed store. `openModel` performs cheap presence checks without re-hashing; persisted registrations can be read with `readModelRegistration`. `removeModel` explicitly removes a named managed entry, without traversing external link targets.

For MFLUX, `inspectReadiness(engine.pythonExecutable, prepared.model)` checks imports, file presence and capabilities. Its optional `verify: true` hashes files, and `load: true` loads weights without generating. These checks can consume substantial time or memory. `inspectRuntime` is a lower-level worker handshake check. A prepared interpreter is accepted by those probes, but `createEditor` uses `engineDirectory`, not a `pythonExecutable` option.

## Paths and profiles

Only SDK-owned resources have defaults:

| Resource | Default |
|---|---|
| Engine resources | `~/.picpatchsdk/engine` |
| Managed models | `~/.picpatchsdk/models` |
| Outputs, profiles, logs and caller history | No default; caller-owned |

`resolveStoragePaths({ engineDirectory?, modelsDirectory? })` returns absolute resource paths without creating directories. Override these locations per operation or through a profile; independent resource folders can coexist. The PicPatch app's `~/.picpatch` home is separate from the SDK's resource home.

Filesystem path arguments are absolute literals. The SDK does not expand `~`, `$VAR` or `%VAR%`, resolve relative paths, read process environment variables, or use the working directory. The `~` notation in the table describes the derived home default, not an accepted argument. Bundle component names and manifest paths are explicitly relative to their declared bundle root. Consumers resolve any environment-based configuration before calling the SDK.

Profiles are versioned, caller-owned JSON argument bundles. `readProfile(absolutePath)` returns `{ status: 'read', profile }` or an unsupported-version refusal. Pass the returned profile explicitly to operations that accept it; there is no profile search or automatic save. Explicit values override profile values, which override SDK defaults. Profiles can carry resource locations, a native executable, editor defaults and worker timeouts; they do not store secrets or name environment variables in the current API.

```ts
import { readProfile, prepareModel, createEditor } from 'picpatchsdk';

const loaded = await readProfile('/absolute/settings/profile.json');
if (loaded.status === 'refused') {
  console.log(loaded.code);
} else {
  const prepared = await prepareModel('flux2-klein-4b-4bit', { profile: loaded.profile });
  const editor = createEditor({ profile: loaded.profile, model: prepared.model });
  await editor.dispose();
}
```

## Events, progress and errors

Operation options expose `onEvent` for structured records. Events carry `type`, `name`, `operationId`, `verb`, UTC ISO time, level, stage and a short English message, plus typed startup, progress, refusal or error fields where applicable. Outcome names distinguish `operation.started`, `operation.succeeded`, `operation.refused`, `operation.failed` and `operation.cancelled`. Stage transitions use `operation.stage`.

Each editor emits `sdk.startup` on its first operation; standalone operations share one startup event per loaded SDK module. It includes the SDK name/version, Node version, platform and architecture, plus the editor's backend and worker timeouts when configured. Startup is delivered to that operation's hook, so attach your hook from the first call. There is no event replay. Events omit raw input and exception text; failure records carry safe structured causes. The original local error remains available to the caller.

The caller stores events wherever it keeps its own records. There is no `logPath`, log file writer or log result field. `debug: true` opts into diagnostic progress events; debug is off by default and never enabled from the environment. Info, warning and error events are not filtered by a configurable threshold.

Where counted work exists, `onProgress` receives `{ type: 'progress', stage, completed, total }`, throttled to at most ten updates a second with the final count retained. Stages alone are events, not fabricated progress. Engine installation reports stages through `onEvent` and does not accept `onProgress`. Both hooks are best effort: synchronous throws and rejected promises cannot change the operation outcome, asynchronous sinks are not awaited, and failed event hooks have no fallback. A progress-hook failure is reported once through the separate event hook.

```ts
import { createEditor, prepareModel, isPicPatchSdkError, type OperationOptions } from 'picpatchsdk';

const options: OperationOptions = {
  timeoutMs: 1_800_000,
  onEvent: event => console.log(JSON.stringify(event)),
  onProgress: progress => console.log(progress.completed, progress.total),
};
const prepared = await prepareModel('flux2-klein-4b-4bit', options);
const editor = createEditor({ model: prepared.model });
try {
  const result = await editor.generate({ prompt: 'A ceramic bowl.', outputDirectory: '/absolute/outputs' }, options);
  if ('status' in result) console.log(result.code, result.effect);
  else console.log(result.image.path);
} catch (error) {
  if (!isPicPatchSdkError(error)) throw error;
  console.log(error.code, error.kind, error.effect);
  // The consumer maps codes to its own user-facing copy and retry policy.
} finally {
  await editor.dispose();
}
```

`PicPatchSdkError` is the single error type. `isPicPatchSdkError` also recognizes its serialized data shape; `errorCodes` exports the code-to-kind mapping. Kinds are `invalid`, `unavailable`, `cancelled` and `internal`. `effect` is `none` or `unknown`, based on evidence of effects, not a promise that retrying is safe. Errors may include `subject`, typed `details` and a local `cause`; retained workspaces are identified by `details.recoveryDirectory`. English error messages are diagnostic, not localized presentation copy. Serialization preserves safe structured cause information rather than raw exception text.

Refusals are results, not exceptions: image operations return an `ImageResult` or `{ status: 'refused', code, ... }`. Check the union before accessing `image`. Native engine readiness includes a stable code and message. Model inspection findings and component verification outcomes also carry a code, message and `effect`. Sidecar failures and inventory item failures have their own outcomes; a successful parent call is not proof that every optional file or item succeeded. Consult the public types for each verb's result rather than assuming every result has the same `status` field.

## Planning, lifecycle and cancellation

`editor.plan(input, options?)` validates a generation/edit request without starting inference. It resolves sampling, dimensions, seed and destination and fingerprints inputs. Pass the unchanged returned plan to `editor.generate(plan)` or `editor.edit(plan)` on the same editor. Plans are instance-owned, not serialized job tickets. Changed inputs or destinations produce refusals instead of silently changing the planned operation.

Generation and editing calls on one editor run in submission order; their total time budget includes queue time. Separate editors and processes are independent. The SDK does not coordinate memory or GPU use across apps. Dispose every editor, preferably in `finally`; disposal cancels outstanding work and waits for owned processes to settle. It is idempotent and permanently closes the editor. A confirmed worker exit permits a fresh worker on a later explicit call; failed inference is never replayed automatically.

Pass an `AbortSignal` in operation options for cancellation. Worker startup, inference, cancellation, shutdown and termination have bounded budgets, with editor `timeouts` overrides and per-operation `timeoutMs`. Cancellation is checked at safe boundaries; an active native operation cannot always stop immediately. A published image wins a cancellation race. Unconfirmed termination or storage settlement can leave a private recovery directory and an error with `effect: 'unknown'`; timeout is not proof that the underlying work stopped.

## Images and private sidecars

The SDK decodes single-frame PNG, JPEG and WebP inputs, applies orientation and sRGB normalization, and works on private PNG copies. Model capabilities determine reference geometry, output constraints and mask semantics. Masks are opaque grayscale PNGs: black preserves and white edits, with intermediate-value behavior determined by the adapter. Composite masking is different from a model trained to condition on masks. Outpainting builds a supported source/mask canvas; see [the outpainting example](examples/outpaint.ts).

A completed PNG is decoded and checked before exclusive publication. Existing destinations are never overwritten. Output publication requires filesystem hard-link support; there is no non-atomic fallback. Temporary writers must settle before cleanup. A saved image with failed cleanup remains a success with `cleanupWarning`; uncertain failures may retain a recovery directory.

Every successful image result includes a versioned `record`. It identifies the SDK writer, optional calling app, model/revision, runtime, effective parameters, seed and content fingerprints. Input descriptions and their geometry are retained only when requested. Records use basenames and hashes of file contents, not hashes of full paths or absolute paths. Reproducibility is not a guarantee of identical pixels across runtimes or hardware.

Metadata stays separate from the image. `sidecar: {}` requests an adjacent `-picpatchsdk.json` file. Prompt/instruction retention requires `sidecar: { includeInputs: true }`; it is off by default. The image remains published if its sidecar fails, and `result.sidecar` reports that file's outcome independently. The result still contains the record. Do not treat a sidecar as safe to share merely because it omits prompts: model choices, seeds and other provenance can also be private.

`readArtifactRecord` reads and validates a sidecar, while `verifyArtifact(imagePath, record)` verifies correspondence with image bytes and dimensions. `saveArtifact(imagePath, outputPath, record, { sidecar: true })` saves a verified PNG without inference or re-encoding and optionally publishes its record alongside it. It refuses mismatches and existing destinations.

## Development

The [public entry](src/index.ts), [types](src/contracts.generated.ts), [error codes](protocol/error-codes.json), [examples](examples/) and tests are the API reference. The [changelog](CHANGELOG.md) records contract changes. SDK source, resources and test configuration live entirely inside this package.

From `sdk/`, run `npm test` for contract drift checks, TypeScript checks, ordinary TypeScript tests and Python worker tests. Python tests use the locked uv project; uv must be available and may acquire development dependencies. `npm run test:full` adds external/live tests. Consult [the live tests](tests/live/) before running that gate: real engines, models and explicit fixture configuration are required. From the repository root, `npm test` also checks and builds the app.

`npm run contracts:generate` regenerates types after protocol schema changes. Source examples and benchmark scripts are included in the SDK type check. The worker's JSON-lines protocol is internal transport, not an SDK logging surface; ordinary consumers use the public library API. No SDK CLI is provided.

### Live test cache

Live tests, their engines, models, configurations and outputs, and benchmark results live in the package's ignored `node_modules/.cache/picpatch-live`; `PICPATCH_LIVE_CACHE` moves it. The Python tests write no bytecode or pytest cache into the source tree.

### Live native tests

The native live tests read an absolute JSON configuration from `PICPATCH_NATIVE_INFERENCE_CONFIG`, or from `native-inference-config.json` in the live cache, naming the model directory, the `sd-cli` executable and the asset files. The tests acquire nothing: prepare the exact assets pinned in [native-sdxl-assets.json](tests/fixtures/native-sdxl-assets.json) (SDXL Base 1.0, PhotoMaker V1, CLIP ViT-H/14 and classic/Plus SDXL IP-Adapter, about 12 GB) and [native-sd15-assets.json](tests/fixtures/native-sd15-assets.json) (SD 1.5 base and inpaint checkpoints, about 8.6 GB, plus a 723 MB FP16 Canny ControlNet) from their pinned Hugging Face revisions, and keep weights outside tracked source. Each asset keeps its upstream licence. Small canvases and short schedules prove execution, not quality or a memory guarantee; synthetic untrained LoRAs prove application, not trained style.

### Benchmarks

The scripts in [benchmarks/](benchmarks/) are caller-owned comparisons, not SDK APIs, and never acquire models. `comparison.ts` exports `compare(cases, report, signal?)`: each case supplies an ID, prepared client options and ordered generate/edit operations (`sourceFromPrevious` chains an edit onto the previous result). `node benchmarks/compare-local.ts CONFIG OUTPUT_DIRECTORY` runs JSON scenarios and appends one versioned JSONL `ComparisonRecord` per settled operation, with outcome, nonprivate controls, model and runtime identity, seed, filenames, hardware and elapsed time; prompts and paths are excluded and existing reports are never overwritten. Unsupported combinations are recorded rather than translated, and equal seeds across models do not imply equal noise.

On macOS, `python3 benchmarks/measure.py --comparison-config /absolute/cases.json` runs the same scenarios while sampling process-tree footprint, memory pressure and swap into the live cache's `benchmarks/` folder; join its run indices to the records' `measurementIndex`. Samples are lower bounds and include other applications' pressure; records without the sampler say `memory: "not-measured"`. Without a configuration it runs the synthetic grouped-reference workload. `profile-klein-worker.py` is a benchmark-only MFLUX Klein worker launcher that records stage timings (pipeline construction, text encoding, each transformer step, VAE encode and decode); it relies on MFLUX 0.22.0 internals.

## License

[GNU GPL v3 or later](LICENSE) © 2026 Yoshinao Inoguchi
