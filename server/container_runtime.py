"""Docker runtime for isolated RepoCiv agent execution."""
from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable


DEFAULT_IMAGE = os.environ.get("REPOCIV_AGENT_IMAGE", "repociv-agent:latest")
DEFAULT_TOKEN_ENV = "X_RepoCIV_Token"


@dataclass(frozen=True)
class ContainerPolicy:
    """Security policy for the agent container lifecycle."""

    network: str = "none"
    repo_mount: str = "/repo"
    workspace_mount: str = "/tmp/workspace"
    token_env_name: str = DEFAULT_TOKEN_ENV
    read_only_repo: bool = True
    tmpfs_options: str = "rw,noexec,nosuid,nodev"
    extra_env: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class ContainerResult:
    ok: bool
    command: list[str]
    output: str
    returncode: int
    changed_files: list[str] = field(default_factory=list)


def _safe_env_items(policy: ContainerPolicy, token: str | None) -> list[str]:
    env = {
        "REPOCIV_TARGET_REPO": policy.repo_mount,
        "REPOCIV_WORKSPACE": policy.workspace_mount,
        **policy.extra_env,
    }
    if token:
        env[policy.token_env_name] = token
    return [f"{key}={value}" for key, value in env.items()]


def build_docker_run_command(
    *,
    repo_root: str | Path,
    mission: str,
    image: str = DEFAULT_IMAGE,
    token: str | None = None,
    policy: ContainerPolicy | None = None,
    agent_command: Iterable[str] | None = None,
) -> list[str]:
    """Build a docker run command with F5 isolation defaults."""
    policy = policy or ContainerPolicy()
    repo = Path(repo_root).resolve()
    mount_mode = "readonly" if policy.read_only_repo else "rw"
    command = [
        "docker",
        "run",
        "--rm",
        "--network",
        policy.network,
        "--mount",
        f"type=bind,src={repo},dst={policy.repo_mount},{mount_mode}",
        "--tmpfs",
        f"{policy.workspace_mount}:{policy.tmpfs_options}",
        "--workdir",
        policy.workspace_mount,
    ]
    for item in _safe_env_items(policy, token):
        command.extend(["--env", item])
    command.extend([image])
    if agent_command is None:
        command.append(mission)
    else:
        command.extend(list(agent_command))
    return command


def run_agent_container(
    *,
    repo_root: str | Path,
    mission: str,
    image: str = DEFAULT_IMAGE,
    token: str | None = None,
    policy: ContainerPolicy | None = None,
    agent_command: Iterable[str] | None = None,
    timeout: int = 600,
) -> ContainerResult:
    """Execute an agent command inside Docker and capture output."""
    command = build_docker_run_command(
        repo_root=repo_root,
        mission=mission,
        image=image,
        token=token,
        policy=policy,
        agent_command=agent_command,
    )
    proc = subprocess.run(
        command,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    output = (proc.stdout or "") + (proc.stderr or "")
    return ContainerResult(
        ok=proc.returncode == 0,
        command=command,
        output=output,
        returncode=proc.returncode,
        changed_files=parse_changed_files(output),
    )


def parse_changed_files(output: str) -> list[str]:
    """Parse optional `REPOCIV_CHANGED_FILES=...` markers from container output."""
    changed: list[str] = []
    for line in output.splitlines():
        if not line.startswith("REPOCIV_CHANGED_FILES="):
            continue
        raw = line.split("=", 1)[1]
        changed.extend(part.strip() for part in raw.split(",") if part.strip())
    return changed
