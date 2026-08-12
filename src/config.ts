import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir, platform } from 'os';

export interface DeviceEntry {
  device_id: string;
  ip: string;
  port: number;
}

export interface AgentConfig {
  /** wss://api.host/ws/pax-agent */
  wss_url: string;
  /** opaque token issued by dashboard, format `pat_<base64url>` */
  token: string;
  /** office uuid (passed in WS upgrade query) */
  office_id: string;
  /** server-issued agent uuid */
  agent_id: string;
  /** one or more PAX A920 devices on the LAN */
  devices: DeviceEntry[];
  /** local health endpoint port (127.0.0.1) */
  health_port?: number;
  /** override location of agent log file */
  log_dir?: string;
}

const DEFAULT_HEALTH_PORT = 9876;

/** Resolve the platform-specific config file path.
 * Search order:
 *   1. PAX_AGENT_CONFIG env var (set by launchd plist / Windows Service)
 *   2. system-wide install (/Library/Application Support on macOS, %ProgramData% on Windows)
 *   3. user-local fallback (~/.config) — primarily for dev
 */
export function defaultConfigPath(): string {
  if (process.env.PAX_AGENT_CONFIG) return process.env.PAX_AGENT_CONFIG;
  if (platform() === 'win32') {
    const programData = process.env.PROGRAMDATA || 'C:\\ProgramData';
    return join(programData, 'GoNails', 'PaxAgent', 'config.json');
  }
  if (platform() === 'darwin') {
    const systemPath = '/Library/Application Support/GoNails/PaxAgent/config.json';
    if (existsSync(systemPath)) return systemPath;
  }
  // Dev / Linux fallback
  return join(homedir(), '.config', 'nail-salon-pax-agent', 'config.json');
}

/** Strict load — throws if config is missing or invalid. Used by `setup` CLI. */
export function loadConfig(path: string = defaultConfigPath()): AgentConfig {
  if (!existsSync(path)) {
    throw new Error(
      `PAX Agent config file not found: ${path}\n` +
        `Run the installer or place a config.json with { wss_url, token, office_id, agent_id, devices: [...] }.`,
    );
  }
  const raw = readFileSync(path, 'utf8');
  let parsed: AgentConfig;
  try {
    parsed = JSON.parse(raw) as AgentConfig;
  } catch (e) {
    throw new Error(`Invalid JSON in ${path}: ${(e as Error).message}`);
  }
  validateConfig(parsed, path);
  return {
    health_port: DEFAULT_HEALTH_PORT,
    ...parsed,
  };
}

/** Lenient load — returns null if config is missing/invalid (rather than throw),
 * so the agent can still start its web UI for the user to fill in setup. */
export function tryLoadConfig(path: string = defaultConfigPath()):
  | { config: AgentConfig; path: string }
  | { config: null; path: string; error: string } {
  try {
    return { config: loadConfig(path), path };
  } catch (e) {
    return { config: null, path, error: (e as Error).message };
  }
}

/** Atomic write: write to .tmp then rename. Preserves 0600 permissions. */
export function writeConfig(config: AgentConfig, path: string = defaultConfigPath()): void {
  validateConfig(config, path);
  ensureDir(dirname(path));
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

/** Remove the config file. Used when the dashboard revokes the agent's token —
 *  the agent re-enters pairing mode automatically and won't reload the bad
 *  config on next service restart / reboot. */
export function deleteConfig(path: string = defaultConfigPath()): void {
  if (existsSync(path)) unlinkSync(path);
}

function validateConfig(c: AgentConfig, path: string): void {
  const required: Array<keyof AgentConfig> = ['wss_url', 'token', 'office_id', 'agent_id', 'devices'];
  for (const key of required) {
    if (!c[key]) throw new Error(`Missing required field "${key}" in ${path}`);
  }
  if (!c.wss_url.startsWith('wss://') && !c.wss_url.startsWith('ws://')) {
    throw new Error(`wss_url must start with wss:// (or ws:// for dev) — got "${c.wss_url}"`);
  }
  if (!c.token.startsWith('pat_')) {
    throw new Error(`token must start with "pat_" (got prefix "${c.token.slice(0, 4)}")`);
  }
  if (!Array.isArray(c.devices) || c.devices.length === 0) {
    throw new Error('devices must be a non-empty array');
  }
  const ids = new Set<string>();
  for (const d of c.devices) {
    if (!d.device_id || !d.ip || !d.port) {
      throw new Error(`Each device requires { device_id, ip, port }`);
    }
    if (ids.has(d.device_id)) throw new Error(`Duplicate device_id "${d.device_id}"`);
    ids.add(d.device_id);
  }
}

/** Default log directory (created on demand). */
export function defaultLogDir(): string {
  if (process.env.PAX_AGENT_LOG_DIR) return process.env.PAX_AGENT_LOG_DIR;
  if (platform() === 'win32') {
    const programData = process.env.PROGRAMDATA || 'C:\\ProgramData';
    return join(programData, 'GoNails', 'PaxAgent', 'logs');
  }
  if (platform() === 'darwin') {
    return '/Library/Logs/GoNails/PaxAgent';
  }
  return join(homedir(), '.config', 'nail-salon-pax-agent', 'logs');
}

export function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}
