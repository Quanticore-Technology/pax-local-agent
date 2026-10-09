// Exercise the packaged runtime, with no salon config, terminal, service or cloud access.
const { spawn } = require('node:child_process');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');

(async () => {
  const port = await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
  const dir = mkdtempSync(join(tmpdir(), 'pax installer smoke '));
  const config = join(dir, 'config with spaces.json');
  writeFileSync(config, JSON.stringify({
    office_id: 'smoke', agent_id: 'smoke', token: 'pat_smoke',
    wss_url: 'ws://127.0.0.1:1', health_port: port,
    devices: [{ device_id: 'smoke', ip: '127.0.0.1', port: 1 }],
  }));
  const [command, ...args] = process.argv.slice(2);
  let output = '';
  const child = spawn(command, [...args, config], {
    env: { ...process.env, PAX_AGENT_LOG_DIR: join(dir, 'logs') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let spawnError;
  child.on('error', error => { spawnError = error; });
  child.stdout.on('data', chunk => { output = (output + chunk).slice(-4000); });
  child.stderr.on('data', chunk => { output = (output + chunk).slice(-4000); });
  const exited = new Promise(resolve => child.once('close', resolve));
  try {
    for (let attempt = 0; attempt < 40; attempt++) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Agent exited: ${output}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
        const health = await response.json();
        assert.equal(health.version, require('../package.json').version);
        console.log(`Packaged agent ${health.version} started successfully`);
        return;
      } catch (error) {
        if (error.code === 'ERR_ASSERTION') throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error(`Agent health check timed out: ${output}`);
  } finally {
    child.kill();
    await exited;
    rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
