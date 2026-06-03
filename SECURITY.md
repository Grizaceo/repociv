# Security Policy

RepoCiv is a single-user alpha dashboard designed for local workspaces.

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
