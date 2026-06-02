"""Pytest configuration for backend tests."""
import os
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("REPOCIV_CONFIG_DIR", tempfile.mkdtemp(prefix="repociv-test-"))

sys.path.insert(0, str(Path(__file__).parent / "server"))
