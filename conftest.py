"""Pytest configuration: add server/ to sys.path so tests can import server modules."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / "server"))
