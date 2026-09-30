/**
 * Single-file HTML config UI served at GET /.
 * No build step, no framework — vanilla JS so the agent stays self-contained
 * (no need to bundle React or ship static assets via the .pkg).
 *
 * Hosted on http://127.0.0.1:9876/ (loopback only) — never exposed to the LAN.
 */
export const CONFIG_UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>GoNails PAX Agent</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root { color-scheme: light dark; }
  body { font: 14px -apple-system, BlinkMacSystemFont, sans-serif; max-width: 560px; margin: 24px auto; padding: 0 16px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #888; font-size: 13px; margin-bottom: 24px; }
  .card { border: 1px solid #ddd; border-radius: 10px; padding: 16px; margin-bottom: 16px; background: #fff; }
  @media (prefers-color-scheme: dark) {
    .card { background: #1c1c1e; border-color: #2c2c2e; }
    body { background: #000; color: #f5f5f7; }
  }
  .status { display: flex; align-items: center; gap: 10px; }
  .dot { width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0; }
  .dot.online { background: #34c759; box-shadow: 0 0 0 3px rgba(52,199,89,.18); }
  .dot.offline { background: #ff3b30; box-shadow: 0 0 0 3px rgba(255,59,48,.18); }
  .dot.unknown { background: #8e8e93; }
  label { display: block; margin-top: 12px; font-weight: 500; font-size: 13px; }
  input { display: block; width: 100%; box-sizing: border-box; padding: 8px 10px; border: 1px solid #ccc; border-radius: 6px; font: 13px monospace; margin-top: 4px; background: inherit; color: inherit; }
  @media (prefers-color-scheme: dark) { input { border-color: #3a3a3c; } }
  input:focus { outline: 2px solid #007aff; outline-offset: -2px; }
  .row { display: grid; grid-template-columns: 2fr 1fr; gap: 12px; }
  .actions { display: flex; gap: 8px; margin-top: 18px; }
  button { padding: 8px 16px; border: 0; border-radius: 6px; font: 500 13px -apple-system; cursor: pointer; }
  .primary { background: #007aff; color: #fff; }
  .primary:hover { background: #006ae6; }
  .primary:disabled { opacity: .5; cursor: default; }
  .secondary { background: #e5e5ea; color: #000; }
  @media (prefers-color-scheme: dark) { .secondary { background: #3a3a3c; color: #fff; } }
  .muted { color: #888; font-size: 12px; margin-top: 4px; }
  .toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); padding: 10px 16px; border-radius: 8px; color: #fff; box-shadow: 0 4px 12px rgba(0,0,0,.18); display: none; }
  .toast.ok { background: #34c759; }
  .toast.err { background: #ff3b30; }
  .toast.show { display: block; }
  .secret-row { display: flex; gap: 6px; }
  .secret-row input { flex: 1; }
  .small { padding: 8px 10px; }
  /* Version sits in the title so "which build is actually running?" is
     answerable at a glance — an upgrade that silently failed to replace the
     binary looks identical to a successful one everywhere else. */
  .version {
    font-size: 13px; font-weight: 600; vertical-align: middle;
    padding: 3px 8px; border-radius: 999px; margin-left: 8px;
    background: #eceff4; color: #4a5260; font-family: ui-monospace, Menlo, Consolas, monospace;
  }
  .version.stale { background: #ffe8e6; color: #b3261e; }
</style>
</head>
<body>
  <h1>GoNails PAX Agent <span class="version" id="version-badge" title="Installed agent version">v…</span></h1>
  <p class="sub">On-prem relay between the cloud POS and your PAX A920 terminal.</p>

  <div class="card">
    <div class="status">
      <div class="dot unknown" id="status-dot"></div>
      <div>
        <div id="status-text">Loading…</div>
        <div class="muted" id="status-detail"></div>
      </div>
    </div>
  </div>

  <!-- Shown only while the agent is in pairing mode (no config yet). -->
  <div class="card pair-card" id="pair-card" style="display:none; text-align:center;">
    <div class="muted" style="margin-bottom:6px;">Pairing code — enter this in the dashboard</div>
    <div id="pair-code" style="font: 700 36px/1.1 'SF Mono', ui-monospace, monospace; letter-spacing: 8px; padding: 8px 0;">------</div>
    <div class="muted" id="pair-hint">Open the cloud dashboard → Settings → Payment Device → PAX Agent → "Add Agent".</div>
  </div>

  <div class="card form-card">
    <h2 style="font-size:15px; margin:0 0 4px;">Connection</h2>
    <p class="muted" style="margin:0 0 8px;">Values from the cloud dashboard (Settings → Payment Device → PAX Agent → Generate Token).</p>

    <label for="wss_url">Backend WebSocket URL</label>
    <input id="wss_url" type="text" placeholder="wss://api.your-domain.com/ws/pax-agent" autocomplete="off" spellcheck="false">

    <label for="office_id">Office ID</label>
    <input id="office_id" type="text" placeholder="UUID" autocomplete="off" spellcheck="false">

    <label for="agent_id">Agent ID</label>
    <input id="agent_id" type="text" placeholder="UUID" autocomplete="off" spellcheck="false">

    <label for="token">Agent Token</label>
    <div class="secret-row">
      <input id="token" type="password" placeholder="pat_..." autocomplete="off" spellcheck="false">
      <button class="secondary small" type="button" id="show-token">Show</button>
    </div>
    <div class="muted" id="token-hint">Leave blank to keep current token.</div>
  </div>

  <div class="card form-card">
    <h2 style="font-size:15px; margin:0 0 4px;">PAX Device</h2>
    <p class="muted" style="margin:0 0 8px;">IP and port of the A920 on the salon LAN.</p>
    <div class="row">
      <div>
        <label for="device_ip">Device IP</label>
        <input id="device_ip" type="text" placeholder="192.168.1.200" autocomplete="off">
      </div>
      <div>
        <label for="device_port">Port</label>
        <input id="device_port" type="text" placeholder="10009" autocomplete="off">
      </div>
    </div>
    <div class="row" style="margin-top:8px;">
      <div class="muted">
        <strong>On the PAX terminal:</strong> tap the four screen corners
        (top-left → top-right → bottom-right → bottom-left), enter password
        <code>1</code> or today's date as MMDDYYYY, then open
        <strong>ECR Comm Settings</strong> and set
        <strong>Comm Type = Ethernet</strong> and
        <strong>Protocol Type = HTTP GET</strong>.
      </div>
    </div>
  </div>

  <div class="actions form-card">
    <button class="primary" id="save">Save &amp; Reconnect</button>
    <button class="secondary" id="refresh">Refresh status</button>
    <button class="secondary" id="repair" style="margin-left:auto; color:#c0392b;">Re-pair this agent</button>
  </div>

  <div class="toast" id="toast"></div>

<script>
const $ = (id) => document.getElementById(id);
const setStatus = (s) => {
  // Version first: it must survive every other branch below, including the
  // not-yet-paired one, because that is exactly when someone is checking
  // whether the installer actually replaced the binary.
  $('version-badge').textContent = 'v' + (s.version || '?');
  $('version-badge').classList.remove('stale');
  $('status-dot').className = 'dot ' + (s.ws_connected ? 'online' : (s.has_config ? 'offline' : 'unknown'));
  if (s.ws_connected) {
    $('status-text').textContent = 'Online — connected to backend';
  } else if (!s.has_config) {
    $('status-text').textContent = 'Waiting to be paired';
  } else {
    $('status-text').textContent = 'Offline — not connected';
  }
  // Version moved to the title badge — keep this line for the volatile bits.
  $('status-detail').textContent = 'Uptime ' + s.uptime_s + 's' + (s.last_command_at ? ' · last cmd ' + new Date(s.last_command_at).toLocaleTimeString() : '');

  // Pairing card: visible only while no config + we have a code to show.
  const pairCard = $('pair-card');
  if (!s.has_config && s.pairing_code) {
    pairCard.style.display = '';
    $('pair-code').textContent = s.pairing_code;
  } else {
    pairCard.style.display = 'none';
  }

  // Once paired, the form sections are useful for inspection / changing the
  // PAX device IP — until then hide them to keep the screen focused on the code.
  const formCards = document.querySelectorAll('.form-card');
  formCards.forEach((c) => { c.style.display = s.has_config ? '' : 'none'; });
};

async function fetchStatus() {
  try {
    const r = await fetch('/health');
    setStatus(await r.json());
  } catch (e) {
    $('status-dot').className = 'dot offline';
    $('status-text').textContent = 'Cannot reach agent';
    // Flag the badge rather than leaving a version on screen that we can no
    // longer vouch for — a stale number here would be worse than none.
    $('version-badge').textContent = 'v?';
    $('version-badge').classList.add('stale');
  }
}
async function fetchConfig() {
  try {
    const r = await fetch('/api/config');
    if (!r.ok) return;
    const c = await r.json();
    $('wss_url').value = c.wss_url || '';
    $('office_id').value = c.office_id || '';
    $('agent_id').value = c.agent_id || '';
    if (c.has_token) {
      $('token').placeholder = c.token_preview || 'pat_••••';
      $('token-hint').textContent = 'Leave blank to keep current token.';
    } else {
      $('token').placeholder = 'pat_...';
      $('token-hint').textContent = 'Required.';
    }
    const d = (c.devices && c.devices[0]) || {};
    $('device_ip').value = d.ip || '';
    $('device_port').value = d.port || 10009;
  } catch (e) {}
}

function toast(msg, kind) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show ' + (kind || 'ok');
  setTimeout(() => t.className = 'toast', 3000);
}

$('show-token').addEventListener('click', () => {
  const i = $('token');
  i.type = i.type === 'password' ? 'text' : 'password';
  $('show-token').textContent = i.type === 'password' ? 'Show' : 'Hide';
});

$('refresh').addEventListener('click', fetchStatus);

$('repair').addEventListener('click', async () => {
  if (!confirm('Disconnect this agent and pair a new one?\\n\\nYou will see a new pairing code to enter in the cloud dashboard.')) return;
  try {
    const r = await fetch('/api/forget-pairing', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    if (!r.ok) throw new Error('Failed');
    toast('Pairing forgotten — generating new code...', 'ok');
    setTimeout(() => { fetchConfig(); fetchStatus(); }, 1500);
  } catch (e) {
    toast('Could not reset pairing', 'err');
  }
});

$('save').addEventListener('click', async () => {
  const btn = $('save');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const body = {
      wss_url: $('wss_url').value.trim(),
      office_id: $('office_id').value.trim(),
      agent_id: $('agent_id').value.trim(),
      token: $('token').value.trim(), // empty → backend keeps existing
      devices: [{
        device_id: 'default',
        ip: $('device_ip').value.trim(),
        port: parseInt($('device_port').value.trim(), 10) || 10009,
      }],
    };
    const r = await fetch('/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Save failed');
    toast('Saved. Reconnecting…', 'ok');
    setTimeout(() => { fetchStatus(); fetchConfig(); }, 1200);
  } catch (e) {
    toast(e.message || 'Save failed', 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save & Reconnect';
  }
});

fetchConfig();
fetchStatus();
setInterval(fetchStatus, 3000);
</script>
</body>
</html>
`;
