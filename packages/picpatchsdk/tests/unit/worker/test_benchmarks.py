"""Resource summaries distinguish absent samples from observed low memory use."""
import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location('measure', Path(__file__).resolve().parents[3] / 'benchmarks/measure.py')
measure = importlib.util.module_from_spec(spec)
spec.loader.exec_module(measure)


def test_unsampled_comparison_is_unknown_not_zero():
    phases = [{'kind': 'start', 'index': 0, 'count': 0, 'time': '01'},
              {'kind': 'end', 'index': 0, 'seconds': 0.01, 'time': '02'}]
    result = measure.summarize([], phases)[0]
    assert result['peakFootprintBytes'] is None
    assert result['resourceStatus'] == 'not-measured'
    assert result['stages'][0]['sampleCount'] == 0
    assert result['stages'][0]['stage'] == 'operation'


def test_pressure_is_reported_separately_from_completion():
    phases = [{'kind': 'start', 'index': 0, 'count': 2, 'time': '01'},
              {'kind': 'end', 'index': 0, 'seconds': 1, 'time': '03'}]
    samples = [{'time': '02', 'footprintBytes': 100, 'residentBytes': 50, 'pressure': 4}]
    result = measure.summarize(samples, phases)[0]
    assert result['peakFootprintBytes'] == 100
    assert result['resourceStatus'] == 'pressure-observed'
