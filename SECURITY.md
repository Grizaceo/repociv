# Security Policy

RepoCiv is a single-user alpha dashboard designed for local workspaces.

> ⚠️ **Single-operator model — DO NOT share your instance.**
>
> RepoCiv is designed for **one operator on one machine**. The bridge
> trusts any request that presents a valid `REPOCIV_TOKEN`, and the
> agent runner launches harnesses with `--dangerously-skip-permissions`,
> meaning **whoever holds the token can execute arbitrary commands on
> the host** (mitigated by the approval queue for `risk: "high"`
> commands, but not eliminated).
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
