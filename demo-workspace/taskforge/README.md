# TaskForge — demo city #2

A tiny task-queue utility with **one failing test** (case-sensitivity slip in
the hero lookup). Run:

```bash
python3 -m pytest test_taskforge.py -q   # 1 failed, 2 passed
```

Demo story: a WORKER unit fixes the bug in `taskforge.py` and the suite
goes green.