# Live tests

The live lane runs PicPatchSdk against real engines and models. It is a local gate (`npm run test:full`), never part of `npm test` or CI, and it acquires nothing: prepare what it reads first.

## Live cache

Engines, models, configurations and outputs live in the ignored `node_modules/.cache/picpatch-live`, so nothing a test writes can be committed. `PICPATCH_LIVE_CACHE` moves it to another absolute path.

## Managed engine and MFLUX model

The MFLUX tests read `inference-config.json` in the live cache, or the file `PICPATCH_INFERENCE_CONFIG` names. With the managed engine installed (`installEngine`), write it from `sdk/`:

```bash
node scripts/prepare-inference.ts [--engine /absolute/engine-directory] [--model flux2-klein-4b-4bit] [--download] [--directory /absolute/model-bundle] [--output /absolute/config.json]
```

It verifies the pinned model, downloading it only with `--download`, and records the engine and model the tests use.

## Native engine

The native tests read `native-inference-config.json` in the live cache, or the file `PICPATCH_NATIVE_INFERENCE_CONFIG` names: the model directory, the `sd-cli` executable and the asset files. Prepare the exact assets pinned in `tests/fixtures/native-sdxl-assets.json` (SDXL Base 1.0, PhotoMaker V1, CLIP ViT-H/14 and classic and Plus SDXL IP-Adapter, about 12 GB) and `tests/fixtures/native-sd15-assets.json` (SD 1.5 base and inpaint checkpoints, about 8.6 GB, and a 723 MB FP16 Canny ControlNet) from their pinned Hugging Face revisions, outside tracked source. Each asset keeps its upstream licence. Small canvases and short schedules prove execution, not quality or a memory guarantee; synthetic untrained LoRAs prove application, not trained style.
