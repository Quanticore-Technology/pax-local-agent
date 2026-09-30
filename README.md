# PAX Agent

On-prem relay between the GoNails cloud backend (DigitalOcean) and a PAX A920 / A920 Pro on the salon LAN.

```
Browser ──HTTPS──→ Backend (DO) ──WSS──→ this agent ──POSLink HTTP GET──→ PAX A920
```

The agent opens a single outbound `wss://` connection to the backend (port 443, no inbound firewall hole required) and forwards `pax.sale | void | refund | tip_adjust | ping` commands to the device.

Device communication uses the **POSLink Low Level Specification** — a framed
byte protocol (`STX │ command │ FS │ … │ ETX │ LRC`) base64-encoded into an HTTP
GET query string. PAX's POSLink SDK is only a wrapper around this protocol and
exists solely for .NET / Java / iOS; platforms without an SDK build the packets
directly. See [`src/poslink-protocol.ts`](src/poslink-protocol.ts).

**The terminal must be set to `Comm Type = Ethernet` and `Protocol Type = HTTP GET`**
(ECR Comm Settings — tap the four screen corners, password `1` or MMDDYYYY).

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
| `devices` | yes | Array of `{ device_id, ip, port }`. The agent adds `serial` itself and may rewrite `ip` (see below) |
| `health_port` | no | Default `9876` |
| `log_dir` | no | Default `%PROGRAMDATA%\GoNails\PaxAgent\logs` |

## Reliability

- **One command at a time per terminal.** Commands for the same terminal queue,
  but none waits more than 5 s: after that it is dropped with `DEVICE_BUSY`
  without touching the terminal (the API may already have given up on it). A
  sale while a different sale is on the terminal gets `DEVICE_BUSY` at once.
  `pax.cancel` skips the queue (secondary port); given an `external_id` it only
  aborts that sale (otherwise result_code `NOT_RUNNING`). `pax.ping` answers `DEVICE_BUSY`
  while a real command runs.
- **Unknown outcome.** A timeout or reset after a sale/void/refund/tip adjust/
  batch close reached the terminal is `TERMINAL_NO_RESPONSE`, not
  `DEVICE_UNREACHABLE`: the card may have been charged, so check before retrying.
- **A sale is charged once per `external_id`.** A duplicate while it runs joins
  it; after an approval the stored result is returned.
- **Sale journal.** Every finished sale is written to `sale-journal.json` next to
  `config.json` (mode 0600) before the response is sent, and re-sent as
  `sale_result_replay` after every reconnect until the cloud answers
  `replay_ack`. Entries are dropped after 7 days.
- **Terminal status.** Every 30 s each terminal gets an A00 Initialize (skipped
  while it is busy); `terminal_status` goes to the cloud after `hello`, on any
  change, and at least every 60 s.
- **Auto-discovery.** After two failed checks the agent scans its own subnet
  (/24, at most /22) for port 10009, confirms with A00, and switches only to the
  terminal with the remembered serial — never when no serial is known. A
  different terminal answering at the configured IP counts as unreachable. The
  new IP is saved to config and reported with `discovered: true`.
- **Receipts.** With `print_receipt`, an approved sale prints a customer receipt
  on the terminal (A60). A print failure is reported as `receipt_error` and never
  fails the sale.

## Logs

- Local: `%PROGRAMDATA%\GoNails\PaxAgent\logs\agent.log` (Windows) or `~/.config/nail-salon-pax-agent/logs/agent.log` (Unix dev).
- Remote: `warn`/`error` lines are mirrored to the cloud backend (rate-limited 60/min) and persisted in `device_payment_logs` with `source: 'agent'`.

## Wire protocol

See `src/protocol/messages.ts` (vendored from `nail-salon-api/src/modules/pax-agent-gateway/protocol/messages.ts`). Keep both files in sync when changing.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `ws_connected: false` in `/health` | Wrong token, revoked token, wrong `wss_url`, or no internet from salon |
| `DEVICE_UNREACHABLE` errors | PAX powered off, IP changed (DHCP), agent host on a different subnet, or ECR server not enabled on the terminal |
| Connects but never answers | `Protocol Type` is not `HTTP GET` in ECR Comm Settings |
| `POSLINK_ERROR` errors | Terminal replied with a malformed packet — check the BroadPOS log at `sdcard/Android/data/<broadpos.package>/files/broadpos_logYYYYMMDD.log` |
| Service installed but not running | Open `services.msc`, find `GoNailsPaxAgent`, click Start; check Event Viewer for crash details |
