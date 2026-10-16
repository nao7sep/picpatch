"""Keep memory peaks scoped to their edit rather than previous process history."""
import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    'benchmark_measurement', Path(__file__).resolve().parents[3] / 'benchmarks/measure.py')
measurement = importlib.util.module_from_spec(spec)
spec.loader.exec_module(measurement)


def test_descendants_include_nested_workers_without_unrelated_processes():
    assert measurement.descendants([(1, 0), (2, 1), (3, 2), (4, 0)], 1) == {1, 2, 3}


def test_memory_summary_separates_active_and_settled_samples():
    def sample(time, footprint):
        return {'time': time, 'footprintBytes': footprint, 'residentBytes': footprint // 2, 'pressure': 1}
    events = [{'time': '1', 'kind': 'start', 'index': 0, 'count': 4},
              {'time': '3', 'kind': 'end', 'index': 0, 'seconds': 2},
              {'time': '5', 'kind': 'start', 'index': 1, 'count': 6},
              {'time': '7', 'kind': 'end', 'index': 1, 'seconds': 2},
              {'time': '9', 'kind': 'disposed'}]
    result = measurement.summarize([sample('0', 999), sample('2', 100), sample('4', 10),
                                    sample('6', 200), sample('8', 20)], events)
    assert [(run['peakFootprintBytes'], run['settledFootprintBytes']) for run in result] == [(100, 10), (200, 20)]
    assert [run['references'] for run in result] == [4, 6]
