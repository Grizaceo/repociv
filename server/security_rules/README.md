# RepoCiv Security Rules

This directory contains YARA-style rule definitions for the Security Harness.

## Rule Categories

| Category | Source | Description |
|---|---|---|
| **secrets** | cybersecurity-lab/scanners/secrets_detector.py | 15 patterns for API keys, tokens, passwords, private keys |
| **injection** | Adapted from YARA rules for LLM context | 10 patterns for prompt injection, jailbreaks, exfiltration |
| **ioc** | cybersecurity-lab/scanners/ioc_scanner.py | Suspicious domains, TLDs, public IPs |
| **drift** | cybersecurity-lab/check_drift.py | Protected file/dir patterns, scope enforcement |

## Adding New Rules

Rules are defined as Python regex patterns in `server/security_harness.py`.

To add a new secret pattern:
```python
_SECRET_PATTERNS.append(
    ("New Service Token", re.compile(r"new_pattern_here")),
)
```

To add a new injection rule:
```python
_INJECTION_PATTERNS.append(
    ("New Attack Name", re.compile(r"attack_regex"), "severity"),
)
```

## Red-Blue Cycle (from IMPROVEMENT_CYCLE.md)

Periodically run adversarial tests to verify coverage:

```bash
pytest server/security_harness_test.py -v -k "adversarial"
```

Gaps found → add new patterns → replay → verify blocked.
