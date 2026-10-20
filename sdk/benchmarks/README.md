# Benchmarks

Caller-owned comparisons of PicPatchSdk's image clients, run by hand on a prepared machine. They are not SDK APIs, are type-checked with the SDK's tests, and never acquire models: prepare the engine and models first (see `tests/live/README.md`). The two Node scripts write to the output directory they are given; `measure.py` writes its runs and samples to the live cache's `benchmarks/` folder.

## Scenarios: `compare-local.ts`

```bash
node benchmarks/compare-local.ts /absolute/cases.json /absolute/output-directory
```

`cases.json` lists cases, each with an ID, prepared image-client options and ordered generate or edit operations; `sourceFromPrevious: true` chains an edit onto the previous result. The script appends one versioned JSONL `ComparisonRecord` per settled operation: outcome, non-private controls, model and runtime identity, seed, filenames, hardware and elapsed time. Prompts and paths are left out, an existing report is never overwritten, and an unsupported combination is recorded rather than translated. Equal seeds across models do not imply equal noise. `comparison.ts` holds the `compare(cases, report, signal?)` function the script runs.

## Grouped references: `references.ts`

```bash
node benchmarks/references.ts /absolute/output-directory [--input-size 512] [--output-size 768] [--counts 4,6,4,6,4,6]
```

Runs the synthetic grouped-reference workload (`reference-workload.ts`) with the managed-engine configuration the live tests use.

## Memory: `measure.py` (macOS)

```bash
python3 benchmarks/measure.py [--comparison-config /absolute/cases.json] [--input-size 512] [--output-size 768] [--counts 4,6,4,6,4,6]
```

Runs either script while sampling the process tree's footprint, memory pressure and swap. With `--comparison-config` it runs `compare-local.ts`; join its run indices to the records' `measurementIndex`. Without it, it runs `references.ts`. Samples are lower bounds and include other applications' pressure; records made without the sampler say `memory: "not-measured"`.
