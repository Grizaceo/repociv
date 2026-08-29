# Hackathon Update Log (Nebius × NVIDIA window: 2026-08-26 → 2026-10-30)

Format: one line per meaningful commit. This file ships in the submission
explaining what was built inside the window.

## 2026-08-29 (window opened 2026-08-26 — this commit COUNTS as in-window work)
- PRAETORIAN base unit added (924d086): third dispatch family SCOUT/WORKER/PRAETORIAN, tier-visible roster
- Hackathon update log created (3e25fd5): in-window tracking starts
- First-class Nebius Token Factory client (server/nebius_client.py) + tests (5): Tier cascade Nemotron Nano/Super/Ultra, cost+latency accounting. Gate 982 passed/2 skipped. Deviation note: _post_with_retries returns the response object (consumer calls raise_for_status()+json()) to match the plan's own test seam; plan's verbatim snippet returned resp.json() contradicting its test.