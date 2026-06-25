# macOS Installer — GoNails PAX Agent

Single-file `.pkg` that installs a signed-style native binary, registers a
LaunchDaemon, and prompts the salon for the agent token + PAX device IP.

---

## What gets installed

| Path | Purpose |
|------|---------|
| `/usr/local/bin/pax-agent` | Single Node binary (built with `@yao-pkg/pkg`) |
| `/Library/LaunchDaemons/com.gonails.paxagent.plist` | LaunchDaemon — runs at boot, restarts on crash |
| `/Library/Application Support/GoNails/PaxAgent/config.json` | Token + PAX device list (`chmod 600`, owner `nobody`) |
| `/Library/Logs/GoNails/PaxAgent/{agent.log,stdout.log,stderr.log}` | Logs |
| `/usr/local/share/pax-agent/uninstall.sh` | Clean uninstaller |

---

## Building the installer (developer)

Requires macOS host (Apple-signed `pkgbuild` / `productbuild` are macOS-only).

```bash
cd agents/pax-agent
yarn install
yarn installer:macos
# → installer/macos/dist/GoNailsPaxAgent-<version>.pkg
```

Build picks the host arch automatically:
- Apple Silicon (M1/M2/M3) → `node20-macos-arm64`
- Intel → `node20-macos-x64`

To build the other arch on the same machine, edit `build.sh` and override `PKG_TARGET`.

---

## Installing at the salon

1. Owner downloads `GoNailsPaxAgent-<version>.pkg` from the dashboard
   (Settings → Payment Device → PAX Agent → Download Installer).
2. Owner generates a token in the dashboard. Three values appear:
   `office_id`, `agent_id`, `token` (starts with `pat_`). They are shown ONCE.
3. Double-click the `.pkg`. macOS may show "unidentified developer" — see
   [Notarization](#notarization-not-yet-done) below.
4. Wizard: Welcome → License → Install (admin password).
5. After file copy, a sequence of GUI prompts asks for:
   - WSS URL (default `wss://api.your-domain.com/ws/pax-agent`)
   - Office ID, Agent ID, Token
   - PAX device IP (default `192.168.1.200`), port (always `10009`)
6. Service starts. Notification: "Agent is running. Verify status in dashboard."
7. Dashboard should show **Online** within ~5 s.

### Re-running setup (e.g. PAX got a new DHCP IP)

```bash
sudo /usr/local/bin/pax-agent setup
sudo launchctl kickstart -k system/com.gonails.paxagent
```

### Verify locally

```bash
curl http://127.0.0.1:9876/health | python3 -m json.tool
```

Expect `"status": "ok", "ws_connected": true`.

### Logs

```bash
tail -f /Library/Logs/GoNails/PaxAgent/agent.log
```

### Service control

```bash
sudo launchctl kickstart -k system/com.gonails.paxagent  # restart
sudo launchctl unload /Library/LaunchDaemons/com.gonails.paxagent.plist  # stop
sudo launchctl load   /Library/LaunchDaemons/com.gonails.paxagent.plist  # start
```

### Uninstall

```bash
sudo bash /usr/local/share/pax-agent/uninstall.sh
```

---

## Notarization (NOT YET DONE)

Until the `.pkg` is notarized, macOS Gatekeeper warns "unidentified developer"
and the salon owner has to right-click → Open → Open. For pilot, this is
acceptable. For wide rollout:

1. Apple Developer Program membership (~$99/yr).
2. Get a "Developer ID Installer" certificate.
3. Update `build.sh`:
   ```bash
   pkgbuild ... --sign "Developer ID Installer: Your Company"
   productbuild ... --sign "Developer ID Installer: Your Company"
   ```
4. Notarize:
   ```bash
   xcrun notarytool submit "$FINAL_PKG" \
     --apple-id you@company.com --team-id ABC1234567 --password app-spec-pass --wait
   xcrun stapler staple "$FINAL_PKG"
   ```

Defer until pilot is proven.

---

## CI distribution

Use the included upload script — it reads `DO_SPACES_*` from
`nail-salon-api/.env` and pushes to `s3://salons-bucket/pax-agent/v<version>/`
with public-read ACL + immutable cache headers.

```bash
brew install awscli   # one-time
cd agents/pax-agent
yarn installer:macos          # build the .pkg
bash installer/upload-installer.sh mac
```

The script prints the final CDN URL — paste it into the frontend env:

```
# nail-salon-app/.env.local (and production env)
NEXT_PUBLIC_PAX_AGENT_INSTALLER_URL=https://salons-bucket.syd1.cdn.digitaloceanspaces.com/pax-agent/v<version>/GoNailsPaxAgent-<version>.pkg
```

The `PaxAgentSection` UI reads this env var and renders the "Download
Installer (Windows)" button. (Button label is generic — same env serves
either platform once Windows is built.)

### Versioning

The CDN path includes `v<version>` (from `package.json`). A new version =
new path = no cache invalidation needed. Bump `package.json` version,
rebuild, re-upload, update the env var.
