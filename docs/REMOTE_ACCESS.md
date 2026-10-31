# Remote Access via Tailscale

RepoCiv can be accessed from any device on your Tailscale network. This is
useful for checking the dashboard from a phone, tablet, or another laptop
without exposing anything to the public internet.

There are two ways to do it:

- **Tailscale Serve (recommended):** the UI stays bound to `127.0.0.1` and
  Serve forwards tailnet HTTPS to it. RepoCiv authenticates the user by the
  `Tailscale-User-Login` identity header that Serve injects (and cannot be
  spoofed through the tailnet). This is the setup described in SECURITY.md.
- **`REPOCIV_REMOTE` (alternative):** binds the UI, bridge and WebSocket on
  `0.0.0.0` inside the tailnet and requires `REPOCIV_TOKEN`. Heavier and only
  reasonable when Serve cannot be used.

## Prerequisites

1. **Tailscale** installed on the host machine running RepoCiv:
   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   ```

2. **Tailscale** installed on the client device (phone, another laptop, etc.):
   - iOS/Android: App Store / Google Play
   - macOS/Linux: `brew install tailscale` or `apt install tailscale`
   - Windows: [tailscale.com/download](https://tailscale.com/download)

3. **Python 3.11+** with websockets (Phase 1):
   ```bash
   pip install websockets>=12.0
   ```

## Recommended setup: Tailscale Serve

### 1. Configure `.env`

```ini
REPOCIV_TOKEN=<64-hex-character-token>
REPOCIV_TAILNET_USERS=you@example.com
REPOCIV_CORS_ORIGINS=https://<host>.<tailnet>.ts.net:5273
REPOCIV_TERMINAL_ORIGINS=https://<host>.<tailnet>.ts.net:5273
```

- Generate the token with
  `python3 -c "import secrets; print(secrets.token_hex(32))"`.
- `REPOCIV_TAILNET_USERS` lists the tailnet logins allowed in (comma-separated,
  case-insensitive). Without it, every tailnet device that passes
  `allowedHosts` is treated as the operator — set it.
- `REPOCIV_TERMINAL_ORIGINS` is separate on purpose: the agent terminal is a
  shell on this machine, so `REPOCIV_CORS_ORIGINS` alone does not grant it.

### 2. Publish the UI port through Serve

```bash
tailscale serve --bg --https=5273 http://127.0.0.1:5273
tailscale serve status
```

The ts.net hostname must also pass Vite's `allowedHosts`. The systemd
`tailscale` drop-in appends it via `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS`;
without systemd, export that variable before starting RepoCiv.

### 3. Start RepoCiv in production mode

```bash
REPOCIV_MODE=production ./scripts/dev-start.sh
```

Production serves the built `dist/` behind the same loopback bind, the access
gate and the proxies — no dev server and no HMR socket.

Then open `https://<host>.<tailnet>.ts.net:5273` from any device in your
tailnet. Devices without a listed login get 403 on HTTP and WebSocket.

## Alternative: `REPOCIV_REMOTE` (bind 0.0.0.0)

### 1. Configure `.env`

```ini
REPOCIV_TOKEN=<64-hex-character-token>
REPOCIV_REMOTE=true
```

**Warning:** `REPOCIV_REMOTE=true` without `REPOCIV_TOKEN` will cause the bridge
to refuse startup. This is intentional — remote mode requires authentication.

`REPOCIV_REMOTE_ORIGIN` restricts CORS to a specific origin; omitting it allows
localhost only. Do NOT leave it blank in production remote mode.

### 2. Start RepoCiv in remote mode

```bash
./scripts/remote-start.sh
```

### Connecting from Another Device

Once RepoCiv is running on the host, find its Tailscale IP:

```bash
tailscale ip -4
# Example: <tailscale-ip>
```

On any device connected to the same Tailscale network, open:

```
http://<tailscale-ip>:5273
```

The WebSocket transport (port 5275) is also accessible via the same IP.

### API Access

The bridge API is at:

```
http://<tailscale-ip>:5274/health
```

All requests require the `X-RepoCiv-Token` header:

```bash
curl -H "X-RepoCiv-Token: <your-token>" http://<tailscale-ip>:5274/health
```

## Architecture

Tailscale Serve (recommended):

```
┌─────────────────────────────────────────────────────────┐
│                    Tailscale Network                      │
│   ┌──────────────┐        ┌─────────────────────────┐   │
│   │ Client Device │─HTTPS─►│ Host                    │   │
│   │ (phone/laptop)│        │  Tailscale Serve (:443/ │   │
│   │              │        │   :5273, identity hdr)   │   │
│   │              │        │     ↓ 127.0.0.1          │   │
│   │              │        │  Vite UI (127.0.0.1:5273)│   │
│   │              │        │  Bridge (127.0.0.1:5274) │   │
│   │              │        │  WS (127.0.0.1:5275)     │   │
│   └──────────────┘        └─────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
                        │
                        ▼
                    Internet
                (no open ports)
```

`REPOCIV_REMOTE` alternative: all ports bind to `0.0.0.0` inside the tailnet.
Tailscale encrypts traffic between devices. No ports are exposed to the public
internet.

## Security

- **Token auth required:** All non-GET requests (and GET /events) require
  `X-RepoCiv-Token` header matching `REPOCIV_TOKEN`
- **Tailnet identity:** with `REPOCIV_TAILNET_USERS` set, only listed tailnet
  logins reach the UI; Serve strips client-supplied identity headers, so the
  check cannot be spoofed through the tailnet
- **WebSocket auth:** WS connections require sending `{"type":"auth","token":"..."}`
  within 5 seconds of connecting
- **Tailscale encryption:** All traffic between devices is encrypted by Tailscale
  (WireGuard). Serve also terminates TLS, so the browser sees HTTPS
- **Public internet:** RepoCiv never binds to a public interface unless
  `REPOCIV_REMOTE=true` is explicitly set. Default is `127.0.0.1` only
- **Token rotation:** Change the token anytime by updating `.env` and restarting
- **Minimum token length:** 32 characters (256 bits)

## Comparing setups

| Feature | Local (dev) | Tailscale Serve | `REPOCIV_REMOTE` |
|---------|-------------|-----------------|-------------------|
| Default | ✅ | ❌ (opt-in) | ❌ (opt-in) |
| UI bind address | 127.0.0.1 | 127.0.0.1 | 0.0.0.0 |
| Auth | — | `Tailscale-User-Login` + allowlist | `REPOCIV_TOKEN` |
| TLS | — | Serve (HTTPS) | none (WireGuard) |
| CORS | localhost only | localhost + listed origins | configured origin |
| WS transport | ✅ | ✅ | ✅ |
| Token required | No | Yes (proxy attaches it) | Yes (REPOCIV_TOKEN) |

## Troubleshooting

### "Bridge no respondió en 10s"

Check the logs:

```bash
cat ~/.repociv/logs/bridge-remote.log
```

Common causes:
- Port 5274 or 5273 already in use
- `.venv` missing dependencies (run `pip install -r requirements.txt`)
- `REPOCIV_TOKEN` not set or too short

### 403 over Tailscale Serve

- The login is not in `REPOCIV_TAILNET_USERS`, or the request carries no
  `Tailscale-User-Login` header (tagged device, or not actually going through
  Serve). Check `tailscale serve status` and `tailscale whois` for the login
  Serve reports.

### Cannot reach the UI from another device

1. Verify both devices are on the same Tailscale network:
   ```bash
   tailscale status
   ```
2. With Serve: verify the rule and that the hostname passes `allowedHosts`
   (`__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS`).
3. With `REPOCIV_REMOTE`: verify the host's Tailscale IP (`tailscale ip -4`)
   and that services listen on 0.0.0.0:
   ```bash
   ss -tlnp | grep -E '527[345]'
   ```

### WebSocket connection fails from remote

The frontend auto-discovers the WS URL via the `/ws` HTTP endpoint.
If the WS URL is wrong (e.g. `ws://localhost:5275` instead of
`ws://<tailscale-ip>:5275`), set `VITE_BRIDGE_URL` in `.env`:

```ini
VITE_BRIDGE_URL=http://<tailscale-ip>:5274
```

The frontend will derive the WS URL from this base.
