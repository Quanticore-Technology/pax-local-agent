# PAX Agent

On-prem relay between the GoNails cloud backend (DigitalOcean) and a PAX A920 / A920 Pro on the salon LAN.

```
Browser ──HTTPS──→ Backend (DO) ──WSS──→ this agent ──HTTP POSLink──→ PAX A920
```

The agent opens a single outbound `wss://` connection to the backend (port 443, no inbound firewall hole required) and forwards `pax.sale | void | refund | tip_adjust | batch_close | ping` commands to the device.

## Install (macOS, prod) — pairing-code flow

1. Salon downloads `GoNailsPaxAgent-<version>.pkg` from the cloud
   dashboard (Settings → Payment Device → PAX Agent → "Download Installer")
   and double-clicks it. Wizard prompts admin password.
2. After install, the **GoNails PAX Agent** app opens automatically. It
   shows a 6-character pairing code, e.g. `ABCD-12`.
3. In the cloud dashboard, salon clicks **"Add Agent"** → enters the code →
   Submit.
4. Within ~2 s the agent receives a token over the public pairing channel,
   writes its config, and connects. Dashboard flips to "Online".
5. (Optional) The salon enters the PAX A920's LAN IP in the same web UI so
   sales can route to the device. Default `192.168.1.200:10009` works for
   most installs out of the box.

The salon never sees a token, UUID, or URL — just a single 6-char code.

Build the installer locally: `yarn installer:macos`. See
[`installer/macos/README.md`](installer/macos/README.md) for full build / sign /
distribute notes.

## Install (Windows, prod) — TODO

Same UX target as macOS but via Inno Setup + node-windows service. Pending
implementation.

## Install (dev / macOS)

```bash
cd agents/pax-agent
npm install
mkdir -p ~/.config/nail-salon-pax-agent
cat > ~/.config/nail-salon-pax-agent/config.json <<'JSON'
{
  "wss_url": "ws://localhost:8000/ws/pax-agent",
  "token": "pat_your_token_here",
  "office_id": "00000000-0000-0000-0000-000000000000",
  "agent_id": "00000000-0000-0000-0000-000000000000",
  "devices": [
    { "device_id": "default", "ip": "192.168.1.200", "port": 10009 }
  ]
}
JSON
npm run dev
```

## Verify

```bash
curl http://127.0.0.1:9876/health
# → { "status": "ok", "ws_connected": true, ... }
```

## Config schema

| Field | Required | Notes |
|---|---|---|
| `wss_url` | yes | `wss://api.your-domain/ws/pax-agent` (`ws://` ok in dev) |
| `token` | yes | Issued by dashboard, format `pat_<base64url>` |
| `office_id` | yes | Salon UUID |
| `agent_id` | yes | Server-generated UUID returned at token issuance |
| `devices` | yes | Array of `{ device_id, ip, port }` |
| `health_port` | no | Default `9876` |
| `log_dir` | no | Default `%PROGRAMDATA%\GoNails\PaxAgent\logs` |

## Logs

- Local: `%PROGRAMDATA%\GoNails\PaxAgent\logs\agent.log` (Windows) or `~/.config/nail-salon-pax-agent/logs/agent.log` (Unix dev).
- Remote: `warn`/`error` lines are mirrored to the cloud backend (rate-limited 60/min) and persisted in `device_payment_logs` with `source: 'agent'`.

## Wire protocol

See `src/protocol/messages.ts` (vendored from `nail-salon-api/src/modules/pax-agent-gateway/protocol/messages.ts`). Keep both files in sync when changing.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `ws_connected: false` in `/health` | Wrong token, revoked token, wrong `wss_url`, or no internet from salon |
| `DEVICE_UNREACHABLE` errors | PAX powered off, IP changed (DHCP), or POSLink TCP not enabled on terminal |
| `POSLINK_ERROR` errors | XML format mismatch — check PAX firmware version |
| Service installed but not running | Open `services.msc`, find `GoNailsPaxAgent`, click Start; check Event Viewer for crash details |
