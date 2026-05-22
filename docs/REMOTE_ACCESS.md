# Remote Access via Tailscale

RepoCiv can be accessed from any device on your Tailscale network. This is
useful for checking the dashboard from a phone, tablet, or another laptop
without exposing anything to the public internet.

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

3. **Python 3.13+** with websockets (Phase 1):
   ```bash
   pip install websockets>=12.0
   ```

## Setup

### 1. Generate an auth token

```bash
python3 -c "import secrets; print(secrets.token_hex(32))"
# Example output: a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1
```

### 2. Configure `.env`

```ini
REPOCIV_TOKEN=a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1
REPOCIV_REMOTE=true
```

**Warning:** `REPOCIV_REMOTE=true` without `REPOCIV_TOKEN` will cause the bridge
to refuse startup. This is intentional — remote mode requires authentication.

### 3. Verify Tailscale is connected

```bash
tailscale status
# Should show your machine with a 100.x.x.x IP
```

### 4. Start RepoCiv in remote mode

```bash
REPOCIV_TOKEN="<your-token>" ./scripts/remote-start.sh
```

Or set the token in `.env` and run:

```bash
./scripts/remote-start.sh
```

## Connecting from Another Device

### Web UI

Once RepoCiv is running on the host, find its Tailscale IP:

```bash
tailscale ip -4
# Example: 100.82.34.156
```

On any device connected to the same Tailscale network, open:

```
http://100.82.34.156:5273
```

Replace `100.82.34.156` with your host's actual Tailscale IP. The WebSocket
transport (port 5275) is also accessible via the same IP.

### API Access

The bridge API is at:

```
http://100.82.34.156:5274/health
```

All requests require the `X-RepoCiv-Token` header:

```bash
curl -H "X-RepoCiv-Token: <your-token>" http://100.82.34.156:5274/health
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Tailscale Network                      │
│   ┌──────────────┐        ┌─────────────────────────┐   │
│   │ Client Device │◄──────►│ Host (RepoCiv Server)   │   │
│   │ (phone/laptop)│        │                         │   │
│   │              │        │  Vite (5273) ← 0.0.0.0  │   │
│   │              │        │  Bridge (5274) ← 0.0.0.0│   │
│   │              │        │  WS (5275) ← 0.0.0.0    │   │
│   └──────────────┘        └─────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
                        │
                        ▼
                    Internet
                (no open ports)
```

All ports bind to `0.0.0.0` in remote mode. Tailscale encrypts traffic between
devices. No ports are exposed to the public internet.

## Security

- **Token auth required:** All non-GET requests (and GET /events) require
  `X-RepoCiv-Token` header matching `REPOCIV_TOKEN`
- **WebSocket auth:** WS connections require sending `{"type":"auth","token":"..."}`
  within 5 seconds of connecting
- **Tailscale encryption:** All traffic between devices is encrypted by Tailscale
  (WireGuard). No additional TLS needed for LAN/internal use
- **Public internet:** RepoCiv never binds to a public interface unless
  `REPOCIV_REMOTE=true` is explicitly set. Default is `127.0.0.1` only
- **Token rotation:** Change the token anytime by updating `.env` and restarting
- **Minimum token length:** 32 characters (256 bits)

## Comparing Local vs Remote

| Feature | Local (dev) | Remote (Tailscale) |
|---------|-------------|-------------------|
| Default | ✅ | ❌ (opt-in) |
| Bind address | 127.0.0.1 | 0.0.0.0 |
| Auth required | No | Yes |
| CORS | localhost only | All origins |
| WS transport | ✅ | ✅ |
| SSE fallback | ✅ | ✅ |
| Token required | No | Yes (REPOCIV_TOKEN) |

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

### Cannot reach the UI from another device

1. Verify both devices are on the same Tailscale network:
   ```bash
   tailscale status
   ```
2. Verify the host's Tailscale IP:
   ```bash
   tailscale ip -4
   ```
3. Check that services are listening on 0.0.0.0:
   ```bash
   ss -tlnp | grep -E '527[345]'
   ```
4. Try a direct ping:
   ```bash
   ping <tailscale-ip>
   ```

### WebSocket connection fails from remote

The frontend auto-discovers the WS URL via the `/ws` HTTP endpoint.
If the WS URL is wrong (e.g. `ws://localhost:5275` instead of
`ws://<tailscale-ip>:5275`), set `VITE_BRIDGE_URL` in `.env`:

```ini
VITE_BRIDGE_URL=http://100.82.34.156:5274
```

The frontend will derive the WS URL from this base.
