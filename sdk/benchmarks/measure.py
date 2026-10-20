"""macOS process-tree physical footprint sampler for the local benchmarks.

Run with an existing Python from sdk/:
  python3 benchmarks/measure.py [--comparison-config /absolute/cases.json]
    [--input-size 512] [--output-size 768] [--counts 4,6,4,6,4,6]
With --comparison-config it runs benchmarks/compare-local.ts; join its run indices to
the records' measurementIndex. Without it, it runs benchmarks/references.ts. It samples
the process tree's footprint, memory pressure and swap. Samples are lower bounds and
include other applications' pressure; records made without the sampler say
memory: "not-measured". No packages or weights are acquired. Runs and samples stay in
the live cache's benchmarks/ folder.
"""
import argparse
import ctypes
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time


class Usage(ctypes.Structure):
    # sys/resource.h rusage_info_v0; byte sizes, including compressed/Metal ledger
    # charges in phys_footprint. RSS alone misses important unified-memory costs.
    _fields_ = [('uuid', ctypes.c_uint8 * 16)] + [(name, ctypes.c_uint64) for name in (
        'user', 'system', 'idle', 'interrupts', 'pageins', 'wired', 'resident',
        'footprint', 'start', 'exit')]



def live_cache() -> Path:
    """The live-test cache (see tests/helpers/live-cache.ts); PICPATCH_LIVE_CACHE moves it."""
    chosen = os.environ.get('PICPATCH_LIVE_CACHE')
    return Path(chosen) if chosen else Path(__file__).resolve().parent.parent / 'node_modules' / '.cache' / 'picpatch-live'

def descendants(rows, root):
    selected = {root}
    while True:
        expanded = selected | {pid for pid, parent in rows if parent in selected}
        if expanded == selected:
            return selected
        selected = expanded


def snapshot(lib, root):
    rows = [tuple(map(int, line.split())) for line in subprocess.check_output(
        ['ps', '-axo', 'pid=,ppid='], text=True).splitlines()]
    processes = []
    for pid in sorted(descendants(rows, root)):
        usage = Usage()
        if lib.proc_pid_rusage(pid, 0, ctypes.byref(usage)) == 0:
            processes.append({'pid': pid, 'footprintBytes': usage.footprint,
                              'residentBytes': usage.resident})
    return {'time': datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
            'processes': processes,
            'footprintBytes': sum(item['footprintBytes'] for item in processes),
            'residentBytes': sum(item['residentBytes'] for item in processes),
            'pressure': int(subprocess.check_output(['sysctl', '-n', 'kern.memorystatus_vm_pressure_level'], text=True))}


def summarize(samples, phases):
    runs = []
    for start in (event for event in phases if event['kind'] == 'start'):
        end = next((event for event in phases if event['kind'] == 'end' and event['index'] == start['index']), None)
        if end is None:
            continue
        active = [sample for sample in samples if start['time'] <= sample['time'] <= end['time']]
        next_boundary = next((event['time'] for event in phases if event['time'] > end['time'] and event['kind'] in ('start', 'disposed')), end['time'])
        idle = [sample for sample in samples if end['time'] < sample['time'] < next_boundary]
        transitions = [start] + [event for event in phases if event['kind'] == 'phase' and event['index'] == start['index']] + [end]
        stages = []
        for left, right in zip(transitions, transitions[1:]):
            window = [sample for sample in active if left['time'] <= sample['time'] < right['time']]
            stages.append({'stage': left.get('stage', 'preparation' if len(transitions) > 2 else 'operation'),
                           'seconds': right.get('elapsedSeconds', end['seconds']) - left.get('elapsedSeconds', 0),
                           'sampleCount': len(window),
                           'peakFootprintBytes': max((sample['footprintBytes'] for sample in window), default=None),
                           'peakResidentBytes': max((sample['residentBytes'] for sample in window), default=None),
                           'pressureLevels': sorted({sample['pressure'] for sample in window})})
        runs.append({'index': start['index'], 'references': start['count'], 'seconds': end['seconds'],
                     'inputSize': start.get('inputSize'), 'outputSize': start.get('outputSize'),
                     'stages': stages,
                     'peakFootprintBytes': max((sample['footprintBytes'] for sample in active), default=None),
                     'peakResidentBytes': max((sample['residentBytes'] for sample in active), default=None),
                     'pressureLevels': sorted({sample['pressure'] for sample in active}),
                     'resourceStatus': 'not-measured' if not active else 'pressure-observed' if any(sample['pressure'] > 1 for sample in active) else 'no-pressure-observed',
                     'settledFootprintBytes': idle[-1]['footprintBytes'] if idle else None})
    return runs


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--comparison-config', help='Run compare-local.ts with prepared caller scenarios instead of the reference workload.')
    parser.add_argument('--input-size', type=int, default=512)
    parser.add_argument('--output-size', type=int, default=768)
    parser.add_argument('--counts', default='4,6,4,6,4,6', help='Comma-separated reference counts (2, 4 or 6).')
    args = parser.parse_args()
    if args.input_size < 16 or args.output_size < 16 or args.output_size % 16:
        parser.error('Input size must be at least 16; output size must be a positive multiple of 16.')
    if not args.counts or any(count not in ('2', '4', '6') for count in args.counts.split(',')):
        parser.error('Counts must be a comma-separated sequence of 2, 4 or 6.')
    if sys.platform != 'darwin':
        raise RuntimeError('This sampler measures macOS process ledgers only.')
    root = Path(__file__).resolve().parent.parent
    base = live_cache() / 'benchmarks'
    base.mkdir(parents=True, exist_ok=True)
    output = Path(tempfile.mkdtemp(prefix='comparison-' if args.comparison_config else 'references-', dir=base))
    images = output / 'images'
    images.mkdir()
    lib = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
    lib.proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
    lib.proc_pid_rusage.restype = ctypes.c_int
    samples = []
    before = subprocess.check_output(['sysctl', '-n', 'vm.swapusage'], text=True).strip()
    env = dict(os.environ, HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', UV_OFFLINE='1')
    with (output / 'events.log').open('w') as events:
        command = (['node', str(root / 'benchmarks/compare-local.ts'), str(Path(args.comparison_config).resolve()), str(images)]
                   if args.comparison_config else
                   ['node', str(root / 'benchmarks/references.ts'), str(images),
                    '--input-size', str(args.input_size), '--output-size', str(args.output_size), '--counts', args.counts])
        process = subprocess.Popen(command,
                                   cwd=root, env=env, stdout=events)
        try:
            while process.poll() is None:
                samples.append(snapshot(lib, process.pid))
                time.sleep(0.5)
        finally:
            if process.poll() is None:
                process.terminate()
                process.wait()
    phases = [json.loads(line) for line in (output / 'events.log').read_text().splitlines()]
    observed = {item['pid'] for sample in samples for item in sample['processes']} - {process.pid}
    remaining = {int(pid) for pid in subprocess.check_output(['ps', '-axo', 'pid='], text=True).split()}
    report = {'platform': subprocess.check_output(['sw_vers', '-productVersion'], text=True).strip(),
              'chip': subprocess.check_output(['sysctl', '-n', 'machdep.cpu.brand_string'], text=True).strip(),
              'physicalMemoryBytes': int(subprocess.check_output(['sysctl', '-n', 'hw.memsize'], text=True)),
              'method': '0.5 second process-tree rusage_info_v0 physical footprint and RSS samples; peaks are sampled lower bounds; shared charges may overlap; OS pressure and swap are system-wide.',
              'exitCode': process.returncode, 'remainingChildPids': sorted(observed & remaining),
              'swapBefore': before, 'swapAfter': subprocess.check_output(['sysctl', '-n', 'vm.swapusage'], text=True).strip(),
              'events': phases, 'runs': summarize(samples, phases), 'samples': samples}
    (output / 'measurements.json').write_text(json.dumps(report, indent=2) + '\n')
    print(output, flush=True)
    if process.returncode or report['remainingChildPids']:
        raise RuntimeError('Benchmark failed or left observed child processes running; inspect measurements.')


if __name__ == '__main__':
    main()
