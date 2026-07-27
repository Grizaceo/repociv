# RepoCiv — Remote Access Cheatsheet

How to expose the RepoCiv dev server to other devices on the tailnet
(Android, iPhone, another laptop) so you can dogfood from anywhere.

## TL;DR

```
tailscale serve --bg 5273            # expose Vite (default port)
```

Then open: `https://<hostname>.tail<hash>.ts.net/`

`tailscale serve status` shows the current URL.

## Why not netsh portproxy?

`netsh interface portproxy add ...` requires **Administrator elevation**
on Windows. The portproxy rules also vanish on every WSL/Windows restart,
forcing you to re-add them from an elevated prompt. `tailscale serve`
needs no admin and survives restarts.

## Port layout

| Service            | Localhost port | Tailnet access                |
| ------------------ | -------------- | ----------------------------- |
| Vite dev (Repociv) | 5273           | tailnet HTTPS via tailscale   |
| Bridge HTTP (Python)| 5274          | proxied under `/bridge/*`     |
| Bridge WebSocket   | 5275 (internal)| upgraded through Vite proxy  |
| Hermes Gateway     | 8742           | direct (PID 1946, `0.0.0.0`)  |

The browser never talks to the bridge directly — it talks to Vite, and
Vite's `/bridge/*` proxy rewrites the path and forwards to `localhost:5274`
(or wherever `BRIDGE_PORT` env says). The WebSocket upgrade is also
proxied (`ws: true` in `vite.config.ts`).

## One-time setup per WSL instance

1. Bridge must run from WSL repo root so relative imports resolve:
   ```
   cd /home/gris/.hermes/workspace/ACTIVE/repociv
   bash scripts/dev-start.sh
   ```
   This starts both Vite (5273) and the Python bridge (5274).

2. Expose Vite to the tailnet:
   ```
   tailscale serve --bg 5273
   ```

3. Verify:
   ```
   tailscale serve status
   curl -sfk https://<hostname>.tail<hash>.ts.net/bridge/health
   ```

## Hermes reachability — known landmines

`server/hermes_status.py` probes `HERMES_URL` from `.env`. If that URL
points at a port where Hermes is **not** listening, the banner reads
"Hermes degraded — Connection refused".

Current correct values (Hermes Gateway runs as PID 1946 on `0.0.0.0:8742`):

```
HERMES_URL=http://localhost:8742/v1/chat/completions
HERMES_KEY=<see ~/.repociv or running config>
```

If the gateway gets restarted on a new port, update `.env` and restart
the bridge (`bash scripts/dev-start.sh`).

## Adding a new device

`tailscale serve` makes the URL available to **any device on your
tailnet**. Just `tailscale up` on the new device, open Safari/Chrome
on it, paste the URL — that's it.

## Stopping

```
pkill -f "vite.*5273"               # stop Vite
pkill -f "server/bridge.py"        # stop bridge
tailscale serve reset              # remove the tailnet proxy
```

## Troubleshooting

| Symptom                                               | Fix                                                   |
| ----------------------------------------------------- | ----------------------------------------------------- |
| "Blocked request. This host is not allowed"           | Add the hostname to `allowedHosts` in `vite.config.ts` |
| "Connection refused" on `/bridge/health`              | Bridge Python not running (`bash scripts/dev-start.sh`) |
| Banner "Hermes degraded" despite Hermes being up      | `HERMES_URL` in `.env` points at wrong port            |
| Page loads but agents don't respond                   | See `docs/AGENT-COMMUNICATION.md` (TBD) for debugging |
