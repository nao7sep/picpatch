"""Test shared worker source without installing inference dependencies."""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "runtimes/common/src"))
