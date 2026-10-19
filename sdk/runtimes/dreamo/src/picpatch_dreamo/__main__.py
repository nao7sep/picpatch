"""The common worker protocol with a separately installed DreamO runtime."""
from picpatch_worker_core.entry import run as run_worker
from .adapter import DreamOAdapter


def run():
    return run_worker(adapter_factory=DreamOAdapter)


if __name__ == '__main__':
    raise SystemExit(run())
