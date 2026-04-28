#!/usr/bin/env python3
"""Shim de compatibilidad — el servidor real está en server/bridge.py"""
import subprocess, sys
from pathlib import Path
real = Path(__file__).parent / "server" / "bridge.py"
subprocess.run([sys.executable, str(real)] + sys.argv[1:])
