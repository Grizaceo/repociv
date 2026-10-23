# Security Policy

RepoCiv is a single-user alpha dashboard designed for local workspaces.

> ⚠️ **Single-operator model — DO NOT share your instance.**
>
> RepoCiv is designed for **one operator on one machine**. The bridge
> trusts any request that presents a valid `REPOCIV_TOKEN`, and the
> agent runner launches harnesses with `--dangerously-skip-permissions`,
> meaning **whoever holds the token can execute arbitrary commands on
> the host** (mitigated by the approval queue for `risk: "high"`
> commands and for the first launch of each bypassing harness per city,
> but not eliminated).
>
> **If you expose RepoCiv on a network:**
> - **Only you** should reach it. Sharing a public URL, deploying to
>   a multi-tenant host, or running it on a shared workstation is
>   out of scope and unsafe.
> - Use Tailscale / WireGuard / SSH tunnel — never expose the port
>   directly on the public internet.
> - Set `REPOCIV_TOKEN` to a **cryptographically random 32+ character
>   secret** (e.g. `python3 -c "import secrets; print(secrets.token_hex(32))"`).
> - The bridge refuses to start with `REPOCIV_REMOTE=true` and an
>   empty or short token.

## Threat model (what actually protects what)

| Boundary | Protection | Not a protection against |
|---|---|---|
| Local processes → bridge (`127.0.0.1:5274/5275`) | None beyond loopback when `REPOCIV_TOKEN` is empty; the token when set. | Any process running as you. Local processes are trusted by design. |
| Browser → UI server (`127.0.0.1:5273`) | Loopback bind, Vite `allowedHosts` (DNS rebinding), CSP (`script-src 'self'`), `X-Content-Type-Options`. | A malicious local process; an XSS in a baselined HTML sink (see `eslint.config.js`). |
| UI server → bridge | The `/bridge` and `/repociv-ws` proxies attach `X-RepoCiv-Token` **server-side**; the token is not in the bundle, `dist/` or the browser cache (unless `VITE_BRIDGE_URL` points at a remote bridge). | Whoever can reach the UI server can use the proxy: protect the UI server itself. |
| Tailnet → UI server (Tailscale Serve) | Serve's identity header. With `REPOCIV_TAILNET_USERS=you@example.com` only listed logins pass; tagged devices and shared-in users get 403 (HTTP and WebSocket). Without it, every tailnet device that passes `allowedHosts` is the operator. | Tailscale ACLs are still the outer wall: restrict who can reach the node. |
| Chat message → agent launch | `execute_agent` is one-step, **except** the first launch of a sandbox-bypassing harness (Claude Code `--dangerously-skip-permissions`, Codex `--dangerously-bypass-approvals-and-sandbox`, Cursor `--trust`) on each city, which goes through the approval queue (`server/launch_trust.py`; opt out with `REPOCIV_TRUST_BYPASS_HARNESSES=1`). | What the agent does once launched: host CLIs run with your permissions. See `docs/EXECUTION_PROTECTION_MATRIX.md`. |
| Audit log | HMAC per line with a persistent key (`REPOCIV_HMAC_KEY` or a 0600 key under the state root): verifiable across restarts. | An attacker with your file permissions (the key sits next to the log). |

Recommended remote setup: Tailscale Serve to the UI port, `REPOCIV_TAILNET_USERS`
set to your own login, a 32+ char `REPOCIV_TOKEN`, and the production mode of
`scripts/dev-start.sh` (`REPOCIV_MODE=production`, no dev server/HMR socket).

## Supported Versions

Only the current `main` branch is supported during alpha.

## Reporting a Vulnerability

Use GitHub Security Advisories when available. If this repository is mirrored
or forked, report vulnerabilities to the active maintainer of that public repo.

## Operational Notes

- Keep `.env` local. Do not commit real `REPOCIV_TOKEN`, provider keys, or local provider registries.
- Leave `REPOCIV_REMOTE` disabled unless you are exposing RepoCiv over a trusted network such as Tailscale.
- Remote mode requires a 32+ character `REPOCIV_TOKEN`.
- `shared/provider-registry.json` is intentionally ignored; commit only `shared/provider-registry.example.json`.
