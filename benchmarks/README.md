# Local comparisons

These are caller-owned scripts, not SDK scheduling APIs. They never acquire models. Prepare models/runtimes through the public SDK and documented runtime setup first.

`comparison.ts` exports `compare(cases, report, signal?)`. Each case supplies an ID, prepared editor options and an ordered list of ordinary generation/edit requests. For example, from a script beside it:

```ts
import { resolve } from 'node:path';
import { prepareModel } from 'picpatch';
import { compare } from './comparison.ts';

const { model } = await prepareModel('flux2-klein-4b-4bit');
await compare([{
  id: 'klein-variation',
  options: { model, defaults: { outputDirectory: resolve('results'), size: { width: 512, height: 512 }, seed: 42 } },
  operations: [
    { operation: 'generate', request: { prompt: 'A blue ceramic bowl on a wooden table.' } },
    { operation: 'edit', sourceFromPrevious: true, request: { instruction: 'Change the bowl to green.' } },
  ],
}], resolve('results/comparison.jsonl'));
```

The destination directory must exist. Supply a prepared interpreter explicitly when the default uv environment does not contain inference dependencies. For multiple models, add cases with their own prepared options and appropriate controls. Requests can use identity groups, appearance references, masks and outpaint canvases where their model supports them; unsupported combinations are recorded rather than silently translated. Family-appropriate prompts and schedules belong to the caller. Equal seeds across models do not imply equal initial noise.

For JSON scenarios, run `node benchmarks/compare-local.ts CONFIG OUTPUT_DIRECTORY`. This overrides each case's default output directory with the supplied directory; explicit request destinations remain caller-owned. Keep artifacts together to make their filenames unambiguous. Each settled operation appends one versioned JSONL `ComparisonRecord` containing outcome, effective nonprivate controls, model/runtime identity, seed, filenames, hardware and elapsed time. PNG sidecars are enabled without input disclosure; their status is recorded, including a saved PNG whose sidecar failed. Prompts and directory paths are excluded from records. The types in `comparison.ts` own the scenario and record shapes.

Independent operations continue after settled failures using a new editor. An edit with `sourceFromPrevious` runs only if the preceding operation succeeded; otherwise it is untested. Cancellation leaves the remainder untested. An uncertain disposal stops the run, preserving earlier records. Existing report files are never overwritten.

On macOS, `python3 benchmarks/measure.py --comparison-config /absolute/cases.json` runs the same scenarios with process-tree physical footprint/RSS samples, system memory pressure and swap. Results live in ignored `benchmarks/results/`; join measurement run indices to JSONL `measurementIndex`. Peaks are sampled lower bounds, shared process charges may overlap, and pressure includes other applications. No samples means unknown, not zero. No observed pressure does not promise comfortable headroom. Without this companion sampler, records say `memory: "not-measured"`.

`measure.py` without a comparison configuration retains the synthetic grouped-reference benchmark. Its `--counts`, `--input-size` and `--output-size` options apply to that workload only. Quality judgments and long-running endurance remain separate from successful file production.
