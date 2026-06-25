/**
 * Interactive `pax-agent setup` — prompts for token + PAX device IP/port and
 * writes config.json to the platform-default location. Used by:
 *  - The .pkg installer postinstall script (re-launches the binary with `setup`).
 *  - Salon staff re-configuring (e.g. PAX got a new DHCP IP) by running
 *    `sudo /usr/local/bin/pax-agent setup`.
 *
 * No external prompt deps — uses Node's readline so the binary stays small.
 */
import * as readline from 'readline';
import { writeFileSync, existsSync } from 'fs';
import { dirname } from 'path';
import { defaultConfigPath, ensureDir, AgentConfig } from './config';

interface PromptOpts {
  required?: boolean;
  default?: string;
  validate?: (v: string) => string | null;
}

function prompt(rl: readline.Interface, label: string, opts: PromptOpts = {}): Promise<string> {
  const hint = opts.default ? ` [${opts.default}]` : '';
  const required = opts.required ?? true;
  return new Promise((resolve) => {
    const ask = (): void => {
      rl.question(`${label}${hint}: `, (raw) => {
        const value = raw.trim() || opts.default || '';
        if (required && !value) {
          process.stdout.write('  → required\n');
          return ask();
        }
        const err = opts.validate?.(value);
        if (err) {
          process.stdout.write(`  → ${err}\n`);
          return ask();
        }
        resolve(value);
      });
    };
    ask();
  });
}

const isUuid = (v: string): string | null =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? null : 'must be a UUID';

const isToken = (v: string): string | null =>
  v.startsWith('pat_') ? null : 'token must start with "pat_"';

const isWss = (v: string): string | null =>
  /^wss?:\/\//.test(v) ? null : 'must start with wss:// (or ws:// for dev)';

const isIp = (v: string): string | null => {
  const parts = v.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return 'must be a valid IPv4 address (e.g. 192.168.1.200)';
  }
  return null;
};

const isPort = (v: string): string | null => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n < 65_536 ? null : 'port must be 1..65535';
};

export async function runSetup(): Promise<void> {
  const configPath = defaultConfigPath();
  const dir = dirname(configPath);
  ensureDir(dir);

  process.stdout.write(`\nGoNails PAX Agent — interactive setup\n`);
  process.stdout.write(`Config will be written to: ${configPath}\n`);
  if (existsSync(configPath)) {
    process.stdout.write(`(an existing config will be overwritten)\n`);
  }
  process.stdout.write(`\nPaste the values from the cloud dashboard:\n  Settings → Payment Device → PAX Agent → Generate Token\n\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    const wssUrl = await prompt(rl, 'WSS URL', {
      default: 'wss://api.your-domain.com/ws/pax-agent',
      validate: isWss,
    });
    const officeId = await prompt(rl, 'Office ID', { validate: isUuid });
    const agentId = await prompt(rl, 'Agent ID', { validate: isUuid });
    const token = await prompt(rl, 'Agent Token', { validate: isToken });

    process.stdout.write(`\nNow the PAX A920 device on the salon LAN:\n`);
    const deviceIp = await prompt(rl, 'PAX device IP', {
      default: '192.168.1.200',
      validate: isIp,
    });
    const devicePort = await prompt(rl, 'PAX device port', {
      default: '10009',
      validate: isPort,
    });

    const config: AgentConfig = {
      wss_url: wssUrl,
      token,
      office_id: officeId,
      agent_id: agentId,
      devices: [
        { device_id: 'default', ip: deviceIp, port: Number(devicePort) },
      ],
    };

    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    process.stdout.write(`\n✓ Config written to ${configPath}\n`);
    process.stdout.write(`\nNext: ensure the agent service is running.\n`);
    process.stdout.write(`  macOS:   sudo launchctl load /Library/LaunchDaemons/com.gonails.paxagent.plist\n`);
    process.stdout.write(`  Verify:  curl http://127.0.0.1:9876/health\n\n`);
  } finally {
    rl.close();
  }
}
