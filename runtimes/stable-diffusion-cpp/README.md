# Native runtime

PicPatch calls a prepared `sd-cli` directly. Use revision `68285df319457e2d79310b48513e4ba1bf8ebe9a` of [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp). A different CLI revision is rejected; importing PicPatch never builds or installs it. The runtime and model weights are separate dependencies, not distributed in this repository.

For a local Apple Silicon source build with Git, CMake and Xcode command-line tools:

```sh
git clone --no-checkout https://github.com/leejet/stable-diffusion.cpp.git sd-source
cd sd-source
git checkout 68285df319457e2d79310b48513e4ba1bf8ebe9a
git submodule update --init --recursive
cmake -S . -B build -DSD_METAL=ON -DSD_WEBP=OFF -DSD_WEBM=OFF -DCMAKE_BUILD_TYPE=Release
cmake --build build --target sd-cli -j4
build/bin/sd-cli --help
```

The help header must report the selected commit. When using source archives instead, preserve the exact ggml submodule revision `dc998771e700d49bbdf9a39cede22bb5b3311767` and set the source's `SDCPP_BUILD_COMMIT` metadata to the downloaded revision. An archive extracted inside another Git repository can otherwise inherit that repository's commit from upstream CMake's Git probe. Never stamp a different source revision merely to pass the SDK check.

The native real-inference gate uses the exact assets in [native-sdxl-assets.json](../../tests/fixtures/native-sdxl-assets.json): SDXL Base 1.0, the community PhotoMaker V1 conversion, CLIP ViT-H/14 and classic/Plus SDXL IP-Adapter. These total about 12 GB. Prepare them separately from their immutable Hugging Face revisions; keep weights outside tracked source. The test performs no acquisition. SDXL uses its Open RAIL++ terms; PhotoMaker/IP-Adapter assets and their base/vision dependencies retain their upstream terms. See the repositories identified in the fixture before redistributing weights.

Set `PICPATCH_NATIVE_INFERENCE_CONFIG` to an absolute JSON path, or save this configuration as `node_modules/.cache/picpatch-live/native-inference-config.json`:

```json
{
  "directory": "/absolute/model-directory",
  "executable": "/absolute/sd-cli",
  "checkpoint": "sd_xl_base_1.0.safetensors",
  "photoMaker": "photomaker-v1.safetensors",
  "clipVision": "clip-vision-h.safetensors",
  "ipAdapter": "ip-adapter_sdxl_vit-h.safetensors",
  "ipAdapterPlus": "ip-adapter-plus_sdxl_vit-h.safetensors"
}
```

Run `npm run test:full` after preparing both native and MFLUX prerequisites. The native test covers generation, repeated variation at zero/intermediate/full strength, loading cancellation, two-photo identity pooling, classic/Plus appearance conditioning, output provenance and cleanup. Small canvases and short schedules verify execution, not portrait quality or a general memory guarantee. SD1.5 and trained inpaint checkpoints require separate real-weight evaluation.

PicPatch disables batched classifier-free guidance for this pinned runtime. Its Metal group-normalization kernel can leave later batch items unwritten, producing NaN latents and uniformly white images while reporting success ([upstream issue #2149](https://github.com/leejet/stable-diffusion.cpp/issues/2149)). Separate CFG evaluations preserve the intended model operation at a possible speed cost. Reassess this workaround when updating the runtime pin.

PhotoMaker also uses runtime LoRA application: the pinned Metal backend rejects the in-place F16 addition used by immediate merging. PicPatch supplies `--lora-apply-mode at_runtime` for this workflow; the required PhotoMaker LoRA remains active. Native failures expose exit status or termination signal through content-free diagnostics, while private native logs remain suppressed.
