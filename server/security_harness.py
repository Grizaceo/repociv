"""RepoCiv — Security Harness (Fase 1.5).

3-layer defense-in-depth for the Agent OS, ported from cybersecurity-lab:

  Layer 1 — Pre-dispatch Gate:  scan mission text + artifacts before agent runs
  Layer 2 — Post-execution Audit: verify agent output for secrets, drift, behavior
  Layer 3 — Runtime Enforcement:  monitor agent process (placeholder for Docker, Fase 5)

Incident levels:
  L0 Clean       — all scans pass, normal operation
  L1 Suspicious  — 1 scanner detects, report + alert, NO pause
  L2 High Risk   — multiple scanners + secrets, pause dispatch, preserve evidence
  L3 Last Resort — exfiltration confirmed, kill switch (Fase 5)

Design:
  - All detectors are regex/pattern-based (no ML dependencies).
  - Quarantine uses atomic rename with path-traversal protection.
  - Alert system deduplicates within 30-minute windows.
  - HMAC audit log ensures tamper-evident incident records.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import re
import shutil
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# ── Incident Levels ──────────────────────────────────────────────────────────

INCIDENT_L0_CLEAN = 0
INCIDENT_L1_SUSPICIOUS = 1
INCIDENT_L2_HIGH_RISK = 2
INCIDENT_L3_LAST_RESORT = 3

INCIDENT_LABELS = {
    INCIDENT_L0_CLEAN: "L0-CLEAN",
    INCIDENT_L1_SUSPICIOUS: "L1-SUSPICIOUS",
    INCIDENT_L2_HIGH_RISK: "L2-HIGH_RISK",
    INCIDENT_L3_LAST_RESORT: "L3-LAST_RESORT",
}

# ── Result dataclasses ───────────────────────────────────────────────────────


@dataclass
class Finding:
    """A single security finding from any scanner."""
    scanner: str       # "secrets", "injection", "ioc", "drift", "behavioral"
    severity: str      # "low", "medium", "high", "critical"
    description: str
    evidence: str = ""
    line_number: int | None = None


@dataclass
class GateResult:
    """Result of pre-dispatch security gate."""
    blocked: bool
    findings: list[Finding] = field(default_factory=list)
    incident_level: int = INCIDENT_L0_CLEAN
    reason: str = ""

    @property
    def clean(self) -> bool:
        return not self.blocked and not self.findings


@dataclass
class AuditResult:
    """Result of post-execution security audit."""
    clean: bool
    findings: list[Finding] = field(default_factory=list)
    incident_level: int = INCIDENT_L0_CLEAN
    quarantined_files: list[str] = field(default_factory=list)


# ── Secrets Detector ─────────────────────────────────────────────────────────
# 15 patterns ported from cybersecurity-lab/scanners/secrets_detector.py

_SECRET_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("AWS Access Key",        re.compile(r"AKIA[0-9A-Z]{16}", re.ASCII)),
    ("AWS Secret Key",        re.compile(r"(?:aws_secret_access_key|aws_secret)\s*[=:]\s*[A-Za-z0-9/+=]{40}", re.I)),
    ("GitHub Token",          re.compile(r"gh[pousr]_[A-Za-z0-9_]{36,255}")),
    ("GitHub Classic PAT",    re.compile(r"ghp_[A-Za-z0-9]{36}")),
    ("Generic API Key",       re.compile(r"""(?:api[_-]?key|apikey|api[_-]?secret)\s*[=:]\s*['"]?[A-Za-z0-9\-_]{20,}['"]?""", re.I)),
    ("Generic Secret",        re.compile(r"""(?:secret|password|passwd|pwd|token|auth_token|access_token|bearer)\s*[=:]\s*['"]?[A-Za-z0-9\-_./+=]{8,}['"]?""", re.I)),
    ("Private Key Block",     re.compile(r"-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----")),
    ("Slack Token",           re.compile(r"xox[bpras]-[0-9]{10,13}-[0-9]{10,13}-[a-zA-Z0-9]{24,34}")),
    ("Stripe Key",            re.compile(r"[sr]k_(?:live|test)_[A-Za-z0-9]{20,}")),
    ("Google API Key",        re.compile(r"AIza[0-9A-Za-z\-_]{35}")),
    ("Heroku API Key",        re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")),
    ("JWT Token",             re.compile(r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}")),
    ("Base64 Encoded Secret", re.compile(r"""(?:secret|password|key)\s*[=:]\s*['"]?[A-Za-z0-9+/]{40,}={0,2}['"]?""", re.I)),
    ("Database URL",          re.compile(r"(?:postgres|mysql|mongodb|redis)://[^\s'\"]{10,}", re.I)),
    ("SendGrid Key",          re.compile(r"SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}")),
]


def scan_text_for_secrets(text: str) -> list[Finding]:
    """Scan text for hardcoded secrets. Returns findings."""
    findings: list[Finding] = []
    for name, pattern in _SECRET_PATTERNS:
        for match in pattern.finditer(text):
            # Mask the actual secret in the evidence
            raw = match.group()
            masked = raw[:8] + "..." + raw[-4:] if len(raw) > 16 else raw[:4] + "***"
            findings.append(Finding(
                scanner="secrets",
                severity="high",
                description=f"Potential {name} detected",
                evidence=masked,
            ))
    return findings


def scan_files_for_secrets(file_paths: list[str]) -> list[Finding]:
    """Scan files on disk for hardcoded secrets."""
    findings: list[Finding] = []
    for fpath in file_paths:
        try:
            content = Path(fpath).read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        for f in scan_text_for_secrets(content):
            f.evidence = f"{Path(fpath).name}: {f.evidence}"
            findings.append(f)
    return findings


# ── Prompt Injection Detector ────────────────────────────────────────────────
# YARA-style rules adapted for LLM prompt injection in agent missions.

_INJECTION_PATTERNS: list[tuple[str, re.Pattern[str], str]] = [
    ("Ignore previous instructions",
     re.compile(r"ignore\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+instructions?", re.I),
     "high"),
    ("System prompt override",
     re.compile(r"(?:you\s+are\s+now|act\s+as|pretend\s+(?:to\s+be|you\s+are)|new\s+system\s+prompt)", re.I),
     "high"),
    ("Jailbreak attempt",
     re.compile(r"(?:\bDAN\b|do\s+anything\s+now|jailbreak|bypass\s+(?:safety|filter|restriction))", re.I),
     "critical"),
    ("Data exfiltration instruction",
     re.compile(r"(?:send|post|upload|exfiltrate|transmit)\s+(?:to|data\s+to)\s+(?:https?://|ftp://)", re.I),
     "critical"),
    ("Shell injection via backticks",
     re.compile(r"`[^`]*(?:curl|wget|nc|ncat|bash|sh|python|perl|ruby)\s+[^`]*`"),
     "high"),
    ("Hidden instruction marker",
     re.compile(r"(?:\[INST\]|\[/INST\]|<\|system\|>|<\|user\|>|<\|assistant\|>)", re.I),
     "medium"),
    ("Base64 encoded payload",
     re.compile(r"(?:eval|exec|system|subprocess)\s*\(\s*(?:base64|b64decode)", re.I),
     "critical"),
    ("Environment variable exfiltration",
     re.compile(r"(?:echo|print|cat|type)\s+\$?(?:ENV|env)\b.*(?:KEY|SECRET|TOKEN|PASSWORD|PASS)", re.I),
     "high"),
    ("File read attack",
     re.compile(r"(?:cat|type|head|tail|less|more)\s+(?:/etc/(?:passwd|shadow)|~/.ssh/|\.env\b)", re.I),
     "critical"),
    ("Reverse shell pattern",
     re.compile(r"(?:bash\s+-i|/dev/tcp/|mkfifo|nc\s+-[el])", re.I),
     "critical"),
]


def scan_text_for_injections(text: str) -> list[Finding]:
    """Scan text for prompt injection / jailbreak attempts."""
    findings: list[Finding] = []
    for name, pattern, severity in _INJECTION_PATTERNS:
        for match in pattern.finditer(text):
            findings.append(Finding(
                scanner="injection",
                severity=severity,
                description=f"Prompt injection: {name}",
                evidence=match.group()[:120],
            ))
    return findings


# ── IOC Scanner ──────────────────────────────────────────────────────────────
# Indicators of Compromise: malicious domains, suspicious IPs, encoded payloads.

_SUSPICIOUS_DOMAINS = [
    "pastebin.com", "hastebin.com", "transfer.sh", "file.io",
    "ngrok.io", "ngrok.app", "serveo.net", "localtunnel.me",
    "requestbin.com", "webhook.site", "hookbin.com",
    "burpcollaborator.net", "interact.sh", "oast.fun",
]

_SUSPICIOUS_TLD = [".tk", ".ml", ".ga", ".cf", ".gq", ".xyz", ".top", ".buzz"]

_IOC_IP_RE = re.compile(
    r"\b(?:(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)\.){3}"
    r"(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)\b"
)

# Private/reserved IPs are NOT suspicious
_PRIVATE_IP_RE = re.compile(
    r"^(?:10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|127\.|0\.)"
)


def scan_text_for_iocs(text: str) -> list[Finding]:
    """Scan text for Indicators of Compromise."""
    findings: list[Finding] = []
    text_lower = text.lower()

    # Check suspicious domains
    for domain in _SUSPICIOUS_DOMAINS:
        if domain in text_lower:
            findings.append(Finding(
                scanner="ioc",
                severity="high",
                description=f"Suspicious domain reference: {domain}",
                evidence=domain,
            ))

    # Check suspicious TLDs
    for tld in _SUSPICIOUS_TLD:
        if tld in text_lower:
            findings.append(Finding(
                scanner="ioc",
                severity="medium",
                description=f"Suspicious TLD reference: {tld}",
                evidence=tld,
            ))

    # Check for public IPs (non-private)
    for match in _IOC_IP_RE.finditer(text):
        ip = match.group()
        if not _PRIVATE_IP_RE.match(ip):
            findings.append(Finding(
                scanner="ioc",
                severity="medium",
                description=f"Public IP reference: {ip}",
                evidence=ip,
            ))

    return findings


# ── Drift Detector ───────────────────────────────────────────────────────────

# Files/dirs an agent should NEVER modify
_PROTECTED_PATTERNS = [
    re.compile(r"\.env$"),
    re.compile(r"\.env\.[a-z]+$"),
    re.compile(r"\.ssh/"),
    re.compile(r"\.gnupg/"),
    re.compile(r"\.git/(?!ignore)"),  # .gitignore is OK, .git/config is not
    re.compile(r"node_modules/"),
    re.compile(r"__pycache__/"),
    re.compile(r"\.repociv/"),
    re.compile(r"docker-compose\.yml$"),
    re.compile(r"Dockerfile$"),
]


def detect_drift(
    repo_root: str,
    changed_files: list[str],
    allowed_scope: list[str] | None = None,
) -> list[Finding]:
    """Detect if agent modified files outside of allowed scope or in protected areas."""
    findings: list[Finding] = []
    root = Path(repo_root).resolve()

    for fpath in changed_files:
        fp = Path(fpath)
        # Resolve relative paths against repo root
        if not fp.is_absolute():
            fp = root / fp
        try:
            resolved = fp.resolve()
        except Exception:
            findings.append(Finding(
                scanner="drift",
                severity="critical",
                description=f"Cannot resolve path (possible traversal): {fpath}",
                evidence=fpath,
            ))
            continue

        # Path traversal check — must be under repo root
        try:
            resolved.relative_to(root)
        except ValueError:
            findings.append(Finding(
                scanner="drift",
                severity="critical",
                description=f"Path traversal detected — file outside repo: {fpath}",
                evidence=str(resolved),
            ))
            continue

        # Protected patterns
        rel = str(resolved.relative_to(root)).replace("\\", "/")
        for pat in _PROTECTED_PATTERNS:
            if pat.search(rel):
                findings.append(Finding(
                    scanner="drift",
                    severity="high",
                    description=f"Protected file/dir modified: {rel}",
                    evidence=rel,
                ))
                break

        # Scope enforcement (optional allow-list)
        if allowed_scope:
            in_scope = any(rel.startswith(s) for s in allowed_scope)
            if not in_scope:
                findings.append(Finding(
                    scanner="drift",
                    severity="medium",
                    description=f"File outside allowed scope: {rel}",
                    evidence=rel,
                ))

    return findings


# ── Quarantine Engine ────────────────────────────────────────────────────────

_DEFAULT_QUARANTINE_DIR = Path.home() / ".repociv" / "quarantine"


def quarantine_file(
    file_path: str,
    quarantine_dir: str | Path | None = None,
    reason: str = "",
) -> str:
    """Atomically move a file to quarantine with path-traversal protection.

    Returns the quarantine destination path.
    Raises ValueError on path-traversal attempt.
    """
    qdir = Path(quarantine_dir or _DEFAULT_QUARANTINE_DIR).resolve()
    qdir.mkdir(parents=True, exist_ok=True)

    src = Path(file_path).resolve()
    if not src.exists():
        raise FileNotFoundError(f"Cannot quarantine: {file_path} does not exist")

    # Generate safe destination name (no directory traversal possible)
    safe_name = re.sub(r"[^\w.\-]", "_", src.name)
    ts = time.strftime("%Y%m%d_%H%M%S")
    dest_name = f"{ts}_{safe_name}"
    dest = qdir / dest_name

    # Verify destination is truly under quarantine dir (defense in depth)
    if not str(dest.resolve()).startswith(str(qdir)):
        raise ValueError(f"Path traversal in quarantine destination: {dest}")

    shutil.move(str(src), str(dest))
    logger.warning("Quarantined %s → %s (reason: %s)", src, dest, reason)
    return str(dest)


# ── Alert System ─────────────────────────────────────────────────────────────

_DEDUP_WINDOW_S = 1800  # 30 minutes
_HMAC_KEY = os.environ.get("REPOCIV_HMAC_KEY", "repociv-audit-default-key").encode()


class AlertSystem:
    """Security alert system with dedup and HMAC audit log.

    Features:
      - Dedup: identical alerts within 30m window are suppressed.
      - HMAC: each log entry has an HMAC tag for tamper evidence.
      - Thread-safe: all operations are locked.
    """

    def __init__(self, log_dir: str | Path | None = None) -> None:
        self._log_dir = Path(log_dir or Path.home() / ".repociv" / "security_logs")
        self._log_dir.mkdir(parents=True, exist_ok=True)
        self._log_file = self._log_dir / "security_audit.jsonl"
        self._lock = threading.Lock()
        self._recent: dict[str, float] = {}  # fingerprint → timestamp

    def _fingerprint(self, finding: Finding) -> str:
        raw = f"{finding.scanner}:{finding.severity}:{finding.description}"
        return hashlib.sha256(raw.encode()).hexdigest()[:16]

    def _is_dedup(self, fingerprint: str) -> bool:
        now = time.time()
        with self._lock:
            # Prune expired entries
            expired = [k for k, t in self._recent.items() if now - t > _DEDUP_WINDOW_S]
            for k in expired:
                del self._recent[k]
            if fingerprint in self._recent:
                return True
            self._recent[fingerprint] = now
        return False

    def _hmac_tag(self, data: str) -> str:
        return hmac.new(_HMAC_KEY, data.encode(), hashlib.sha256).hexdigest()[:32]

    def alert(self, finding: Finding, context: dict[str, Any] | None = None) -> bool:
        """Record a security alert. Returns True if recorded (not deduped).

        Deduped alerts return False (already seen within 30m window).
        """
        fp = self._fingerprint(finding)
        if self._is_dedup(fp):
            return False

        entry = {
            "id": str(uuid.uuid4())[:12],
            "timestamp": time.time(),
            "iso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "scanner": finding.scanner,
            "severity": finding.severity,
            "description": finding.description,
            "evidence": finding.evidence,
            "context": context or {},
            "fingerprint": fp,
        }
        line = json.dumps(entry, ensure_ascii=False)
        entry["hmac"] = self._hmac_tag(line)
        signed_line = json.dumps(entry, ensure_ascii=False) + "\n"

        with self._lock:
            try:
                with self._log_file.open("a", encoding="utf-8") as f:
                    f.write(signed_line)
            except Exception:
                logger.error("Failed to write security audit log")

        logger.warning(
            "SECURITY ALERT [%s/%s]: %s — %s",
            finding.scanner, finding.severity, finding.description, finding.evidence,
        )
        return True

    def get_recent_alerts(self, limit: int = 50) -> list[dict[str, Any]]:
        """Read recent alerts from the audit log."""
        if not self._log_file.exists():
            return []
        try:
            lines = self._log_file.read_text(encoding="utf-8").strip().splitlines()
        except Exception:
            return []
        results = []
        for line in lines[-limit:]:
            try:
                results.append(json.loads(line))
            except Exception:
                continue
        return results


# ── SecurityHarness (main class) ─────────────────────────────────────────────


class SecurityHarness:
    """3-layer security harness for RepoCiv Agent OS.

    Usage::

        harness = SecurityHarness()

        # Layer 1: Pre-dispatch gate
        gate = harness.pre_dispatch_gate(mission_text, artifacts=[])
        if gate.blocked:
            # Do not dispatch agent
            ...

        # Layer 2: Post-execution audit
        audit = harness.post_execution_audit("/path/to/repo", changed_files)
        if not audit.clean:
            # Review findings, quarantine files if needed
            ...

        # Layer 3: Runtime enforcement (placeholder for Fase 5 Docker)
        harness.runtime_enforce(agent_pid=12345)
    """

    def __init__(
        self,
        alert_log_dir: str | Path | None = None,
        quarantine_dir: str | Path | None = None,
    ) -> None:
        self.alerts = AlertSystem(log_dir=alert_log_dir)
        self._quarantine_dir = quarantine_dir

    # ── Layer 1: Pre-dispatch Gate ────────────────────────────────────────

    def pre_dispatch_gate(
        self,
        mission_text: str,
        artifacts: list[str] | None = None,
    ) -> GateResult:
        """Scan mission text and artifact paths before dispatching to agent.

        Blocks if any high/critical findings are detected (secrets, injections, IOCs).
        """
        all_findings: list[Finding] = []

        # 1. Secrets detection
        all_findings.extend(scan_text_for_secrets(mission_text))

        # 2. Prompt injection detection
        all_findings.extend(scan_text_for_injections(mission_text))

        # 3. IOC check
        all_findings.extend(scan_text_for_iocs(mission_text))

        # 4. Scan artifact file contents if provided
        if artifacts:
            all_findings.extend(scan_files_for_secrets(artifacts))

        # Determine incident level
        has_critical = any(f.severity == "critical" for f in all_findings)
        has_high = any(f.severity == "high" for f in all_findings)
        multi_scanner = len({f.scanner for f in all_findings}) >= 2

        if has_critical or (has_high and multi_scanner):
            level = INCIDENT_L2_HIGH_RISK
        elif has_high or all_findings:
            level = INCIDENT_L1_SUSPICIOUS
        else:
            level = INCIDENT_L0_CLEAN

        blocked = level >= INCIDENT_L2_HIGH_RISK

        # Record alerts
        for finding in all_findings:
            self.alerts.alert(finding, context={"phase": "pre_dispatch"})

        reason = ""
        if blocked:
            reasons = [f.description for f in all_findings if f.severity in ("high", "critical")]
            reason = "; ".join(reasons[:5])

        return GateResult(
            blocked=blocked,
            findings=all_findings,
            incident_level=level,
            reason=reason,
        )

    # ── Layer 2: Post-execution Audit ─────────────────────────────────────

    def post_execution_audit(
        self,
        repo_root: str,
        changed_files: list[str],
        allowed_scope: list[str] | None = None,
        auto_quarantine: bool = False,
    ) -> AuditResult:
        """Verify agent output after execution.

        Checks for:
          - Secrets in modified files
          - Drift (modifications outside scope or in protected areas)
        """
        all_findings: list[Finding] = []
        quarantined: list[str] = []

        # 1. Drift detection
        all_findings.extend(detect_drift(repo_root, changed_files, allowed_scope))

        # 2. Secrets in output files
        abs_paths = []
        root = Path(repo_root).resolve()
        for f in changed_files:
            fp = Path(f) if Path(f).is_absolute() else root / f
            if fp.exists():
                abs_paths.append(str(fp))
        all_findings.extend(scan_files_for_secrets(abs_paths))

        # Determine incident level
        has_critical = any(f.severity == "critical" for f in all_findings)
        has_high = any(f.severity == "high" for f in all_findings)
        multi_scanner = len({f.scanner for f in all_findings}) >= 2

        if has_critical or (has_high and multi_scanner):
            level = INCIDENT_L2_HIGH_RISK
        elif has_high or all_findings:
            level = INCIDENT_L1_SUSPICIOUS
        else:
            level = INCIDENT_L0_CLEAN

        # Auto-quarantine if requested and high-risk
        if auto_quarantine and level >= INCIDENT_L2_HIGH_RISK:
            for finding in all_findings:
                if finding.scanner == "secrets" and finding.severity in ("high", "critical"):
                    # Try to extract filename from evidence
                    parts = finding.evidence.split(":")
                    if len(parts) >= 1:
                        fname = parts[0].strip()
                        full = root / fname
                        if full.exists():
                            try:
                                dest = quarantine_file(
                                    str(full),
                                    quarantine_dir=self._quarantine_dir,
                                    reason=finding.description,
                                )
                                quarantined.append(dest)
                            except Exception as e:
                                logger.error("Quarantine failed for %s: %s", full, e)

        # Record alerts
        for finding in all_findings:
            self.alerts.alert(finding, context={"phase": "post_execution"})

        return AuditResult(
            clean=level == INCIDENT_L0_CLEAN,
            findings=all_findings,
            incident_level=level,
            quarantined_files=quarantined,
        )

    # ── Layer 3: Runtime Enforcement (placeholder for Fase 5) ─────────────

    def pre_launch_gate(
        self,
        mission_text: str,
        *,
        container_command: list[str] | None = None,
    ) -> GateResult:
        """Gate immediately before launching a process/container.

        For Docker execution this enforces the Fase 5 launch policy:
        ``--network none``, read-only repo bind mount, and no host secret mounts.
        """
        base = self.pre_dispatch_gate(mission_text)
        findings = list(base.findings)

        if container_command is not None:
            findings.extend(self._validate_container_command(container_command))

        level = self._incident_level(findings)
        blocked = level >= INCIDENT_L2_HIGH_RISK
        for finding in findings:
            self.alerts.alert(finding, context={"phase": "pre_launch"})
        return GateResult(
            blocked=blocked,
            findings=findings,
            incident_level=level,
            reason="; ".join(f.description for f in findings if f.severity in {"high", "critical"})[:500],
        )

    def post_container_exit_audit(
        self,
        repo_root: str,
        output: str,
        *,
        changed_files: list[str] | None = None,
        allowed_scope: list[str] | None = None,
    ) -> AuditResult:
        """Audit container output and declared file changes before applying."""
        from . import container_runtime as _container_runtime

        files = changed_files or _container_runtime.parse_changed_files(output)
        audit = self.post_execution_audit(repo_root, files, allowed_scope=allowed_scope)
        findings = list(audit.findings)
        findings.extend(scan_text_for_secrets(output))
        findings.extend(scan_text_for_injections(output))
        findings.extend(scan_text_for_iocs(output))

        level = self._incident_level(findings)
        for finding in findings:
            self.alerts.alert(finding, context={"phase": "post_container_exit"})
        return AuditResult(
            clean=level == INCIDENT_L0_CLEAN,
            findings=findings,
            incident_level=level,
            quarantined_files=audit.quarantined_files,
        )

    def runtime_enforce(
        self,
        agent_pid: int | None = None,
        *,
        container_command: list[str] | None = None,
    ) -> GateResult:
        """Enforce runtime policy for local processes or Docker containers."""
        findings: list[Finding] = []
        if container_command is not None:
            findings.extend(self._validate_container_command(container_command))
        level = self._incident_level(findings)
        for finding in findings:
            self.alerts.alert(finding, context={"phase": "runtime"})
        logger.debug(
            "SecurityHarness.runtime_enforce(pid=%s, container=%s) findings=%d",
            agent_pid,
            container_command is not None,
            len(findings),
        )
        return GateResult(
            blocked=level >= INCIDENT_L2_HIGH_RISK,
            findings=findings,
            incident_level=level,
            reason="; ".join(f.description for f in findings if f.severity in {"high", "critical"})[:500],
        )

    @staticmethod
    def _incident_level(findings: list[Finding]) -> int:
        has_critical = any(f.severity == "critical" for f in findings)
        has_high = any(f.severity == "high" for f in findings)
        multi_scanner = len({f.scanner for f in findings}) >= 2
        if has_critical or (has_high and multi_scanner):
            return INCIDENT_L2_HIGH_RISK
        if has_high or findings:
            return INCIDENT_L1_SUSPICIOUS
        return INCIDENT_L0_CLEAN

    @staticmethod
    def _validate_container_command(command: list[str]) -> list[Finding]:
        findings: list[Finding] = []
        joined = " ".join(command)
        if "--network none" not in joined:
            findings.append(Finding(
                scanner="runtime",
                severity="critical",
                description="Docker container must run with --network none",
                evidence=joined[:160],
            ))
        if "readonly" not in joined and ":ro" not in joined:
            findings.append(Finding(
                scanner="runtime",
                severity="high",
                description="Docker repo mount must be read-only",
                evidence=joined[:160],
            ))
        for secret_path in (".env", "/.ssh", "~/.ssh", "/root/.ssh"):
            if secret_path in joined:
                findings.append(Finding(
                    scanner="runtime",
                    severity="critical",
                    description=f"Host secret path must not be mounted: {secret_path}",
                    evidence=secret_path,
                ))
        return findings


# ── Module-level singleton ────────────────────────────────────────────────────

_singleton: SecurityHarness | None = None
_singleton_lock = threading.Lock()


def get_harness() -> SecurityHarness:
    """Return the module-level singleton SecurityHarness."""
    global _singleton
    if _singleton is None:
        with _singleton_lock:
            if _singleton is None:
                _singleton = SecurityHarness()
    return _singleton
