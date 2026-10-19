"""MFLUX entry point; shared protocol owns process I/O and lifetime."""
from picpatch_worker_core.entry import run as run_worker
from .backends import create_adapter


def run():
    return run_worker(adapter_factory=create_adapter)


if __name__ == "__main__":
    raise SystemExit(run())
