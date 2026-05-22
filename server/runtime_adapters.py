"""RepoCiv — runtime adapter facade.

Thin adapter layer over the harness registry. This does not replace the concrete
execution functions yet; it centralizes runtime identity, capability checks,
health probing and recovery planning so bridge/agent code stop hardcoding these
concerns repeatedly.
"""
from __future__ import annotations

import subprocess
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import container_runtime as _container_runtime
from . import harness_registry as _hr
from . import recovery as _recovery


@dataclass(frozen=True)
class RuntimeAdapter:
    harness_id: str
    descriptor: dict[str, Any]

    @property
    def trust_level(self) -> str:
        return str(self.descriptor.get("trustLevel", "read_only"))

    def supports(self, command_type: str) -> bool:
        allowed = self.descriptor.get("allowedActions", [])
        blocked = self.descriptor.get("blockedActions", [])
        return command_type in allowed and command_type not in blocked

    def healthcheck(self) -> dict[str, Any]:
        health = self.descriptor.get("health", {})
        kind = str(health.get("kind", "static"))
        if kind == "static":
            return {"ok": health.get("status") not in {"unhealthy", "error"}, "kind": kind, "status": health.get("status", "unknown")}
        if kind == "command":
            command = str(health.get("command", "")).strip()
            if not command:
                return {"ok": False, "kind": kind, "status": "missing-command"}
            proc = subprocess.run(command, shell=True, capture_output=True, text=True, timeout=5)
            return {"ok": proc.returncode == 0, "kind": kind, "status": "healthy" if proc.returncode == 0 else "failed", "output": (proc.stdout or proc.stderr).strip()[:200]}
        if kind == "http":
            url = str(health.get("url", "")).strip()
            if not url:
                return {"ok": False, "kind": kind, "status": "missing-url"}
            try:
                with urllib.request.urlopen(url, timeout=5) as resp:
                    return {"ok": 200 <= getattr(resp, "status", 200) < 300, "kind": kind, "status": getattr(resp, "status", 200), "url": url}
            except Exception as exc:
                return {"ok": False, "kind": kind, "status": "error", "error": str(exc)[:200], "url": url}
        return {"ok": False, "kind": kind, "status": "unknown-kind"}

    def build_recovery(self, failure_context: dict[str, Any]) -> dict[str, Any]:
        return _recovery.build_recovery_plan(self.descriptor, failure_context)


@dataclass(frozen=True)
class DockerAdapter(RuntimeAdapter):
    """Runtime adapter for Fase 5 Docker-isolated agent execution."""

    def build_command(
        self,
        *,
        repo_root: str | Path,
        mission: str,
        token: str | None = None,
    ) -> list[str]:
        return _container_runtime.build_docker_run_command(
            repo_root=repo_root,
            mission=mission,
            token=token,
        )


_DOCKER_DESCRIPTOR: dict[str, Any] = {
    "id": "docker-agent",
    "name": "Docker isolated agent",
    "trustLevel": "sandboxed",
    "allowedActions": ["execute_agent", "run_tests", "edit_file"],
    "blockedActions": [],
    "health": {"kind": "command", "command": "docker --version"},
}


def get_adapter(harness_id: str) -> RuntimeAdapter | None:
    if harness_id == "docker-agent":
        return DockerAdapter(harness_id=harness_id, descriptor=_DOCKER_DESCRIPTOR)
    descriptor = _hr.get_harness(harness_id)
    if descriptor is None:
        return None
    return RuntimeAdapter(harness_id=harness_id, descriptor=descriptor)


def infer_adapter_for_command(command_type: str, harness_id: str | None = None) -> RuntimeAdapter | None:
    if harness_id:
        adapter = get_adapter(harness_id)
        if adapter and adapter.supports(command_type):
            return adapter
        return adapter
    descriptor = _hr.infer_harness_for_command(command_type)
    if descriptor is None:
        return None
    return RuntimeAdapter(harness_id=str(descriptor.get("id", "unknown")), descriptor=descriptor)


def default_agent_runtime(unit_id: str) -> RuntimeAdapter:
    import os

    if os.environ.get("REPOCIV_AGENT_CONTAINER", "").lower() in {"1", "true", "yes"}:
        return DockerAdapter(harness_id="docker-agent", descriptor=_DOCKER_DESCRIPTOR)
    base = unit_id.split("-")[0].upper()
    harness_id = "openclaw-local" if base == "OPENCLAW" else "claude-code-local" if base == "CLAUDE" else "codex-local" if base == "CODEX" else "hermes-local"
    adapter = get_adapter(harness_id)
    if adapter is None:
        raise RuntimeError(f"Default runtime adapter '{harness_id}' not found")
    return adapter
