# Execution protection matrix (canonical route contract)

This describes supported execution paths, not proof of containment of arbitrary
agents. RepoCiv is single-operator, local alpha. Canvas 2D and WebGL 3D remain
supported official views; neither changes execution permissions.

## Common admission versus adapter capabilities

HTTP/WS commands use command validation, policy classification and persisted
fail-closed approvals before the scheduler. An approved command is not exempt
from schema/path validation. Pending approvals expire; restart/restoration does
not grant or renew permission. Calling a Python runner directly is **not** an
authorization boundary: the trusted embedding caller must supply permission.

The task step path scans mission text before dispatch and validates its result.
Runner entry scans again. Container configuration is checked immediately before
launch; `runtime_enforce` is a compatibility name for configuration validation,
**not** continuous process monitoring, network interception or enforcement of a
PID. Post-execution scanning is a separate mechanism; it does not make already
executed host code harmless.

| Adapter / route | Launch gates | Isolation / network | Mounts and secrets | Audit and limits |
| --- | --- | --- | --- | --- |
| `hermes` HTTP | Common runner mission scan; request to configured existing endpoint | Remote/previously running service; no RepoCiv-controlled sandbox or network isolation | Service owns environment, filesystem and credentials; request includes mission and allowed context | Output/events recorded; local client cannot attest remote process exit or provider filesystem audit |
| `hermes-cli` | Common mission gate, profile selection | Direct host process, network unrestricted by RepoCiv | Working directory; sanitized spawn environment with selected `HERMES_HOME`; profile may contain credentials | Mission/output events; no mandatory adapter-wide filesystem post-audit; not a sandbox |
| `claude-code` | Common mission gate | Direct host process; uses `--dangerously-skip-permissions`; no network boundary | Working directory + sanitized spawn environment; CLI may read host credential files | Mission/output events; skip-permissions is an explicit limitation, not isolation |
| `cursor` | Common mission gate | Direct host process; `--trust`; no network boundary | Working directory + sanitized spawn environment; CLI may read host credential files | Mission/output events; passive Task tracking is observation, not policy enforcement |
| `openclaw` | Common mission gate | Direct host process, no RepoCiv network isolation | Working directory + sanitized spawn environment; provider manages files/secrets | Mission/output events; not a sandbox |
| `codex` | Common mission gate | Direct host process; `--dangerously-bypass-approvals-and-sandbox` | Working directory + sanitized spawn environment; provider-managed host credentials remain accessible | Mission/output events; bypass flags do not bypass RepoCiv admission, but remove provider isolation |
| `container` | Common mission gate; mandatory `pre_launch_gate`; configuration recheck; public `run_agent_container` also checks before subprocess | Docker invocation with `--network none`; container is experimental/opt-in, not the host CLI default | Repository read-only bind; forbidden secret mounts rejected; explicit token may be passed into child environment by caller | `post_container_exit_audit` scans output/declared paths; configuration validation does not prove Docker/kernel isolation or monitor later runtime changes |

Environment redaction is not comprehensive prevention of secret discovery: host
CLIs can read files permitted to the operator. Container tokens are intentional
secret injection and must not appear in health diagnostics. Repository visibility
and tool permissions are not equivalent to a kernel sandbox.

`server/test_execution_protection_routes.py` exercises the **actual supported
runner route**, replacing the final Docker launch with a trap: host network,
writable repo and secret mount must be rejected before launch. It also tests the
public container helper and documents that PID-only `runtime_enforce` performs
no live process observation. Tests do not start Docker or a model provider.

## Lifecycle

Active: command bridge/scheduler, durable approval and task stores, runner
adapters, fail-closed expiry, supported agent-position hooks, 2D and 3D views.
Experimental: opt-in Docker agent route and selected planning/sandbox modules as
marked in SCOPE. Historical: architecture/spec review text and competitive
comparisons; they cannot retire or activate code. No eBPF, Landlock, continuous
host surveillance, new remote access or multi-user permission system is added.
