/**
 * Find a terminal whose DHCP address changed.
 *
 * Scans the agent host's own IPv4 subnets for the POSLink port, then asks each
 * host that answers to identify itself (A00). Deliberately small: the salon
 * LAN is a /24 almost everywhere, and a wrong guess is worse than no guess.
 */
import { Socket } from 'net';
import { networkInterfaces } from 'os';
import { initialize } from './commands/ping';
import { SUCCESS_CODE } from './poslink-protocol';

const CONNECT_TIMEOUT_MS = 400;
const IDENTIFY_TIMEOUT_MS = 3_000;
const CONCURRENCY = 64;

export interface FoundTerminal {
  ip: string;
  serial: string;
  model: string;
}

type Interfaces = ReturnType<typeof networkInterfaces>;

const toInt = (ip: string): number => ip.split('.').reduce((n, part) => n * 256 + Number(part), 0);
const toIp = (n: number): string => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');

/**
 * Every host address on this machine's IPv4 subnets, own address excluded.
 * The prefix is clamped to /22–/24: never wider than 1022 hosts, and a tiny
 * point-to-point netmask still gets its surrounding /24 looked at.
 */
export function subnetHosts(ifaces: Interfaces = networkInterfaces()): string[] {
  const hosts = new Set<string>();
  const own = new Set<string>();
  for (const addrs of Object.values(ifaces)) {
    for (const a of addrs ?? []) {
      if (a.internal || (a.family !== 'IPv4' && (a.family as unknown) !== 4)) continue;
      own.add(a.address);
      const maskBits = toInt(a.netmask).toString(2).replace(/0/g, '').length;
      const prefix = Math.min(24, Math.max(22, maskBits));
      const size = 2 ** (32 - prefix);
      const network = toInt(a.address) - (toInt(a.address) % size);
      for (let i = 1; i < size - 1; i++) hosts.add(toIp(network + i));
    }
  }
  for (const ip of own) hosts.delete(ip);
  return [...hosts];
}

function portOpen(ip: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    const done = (open: boolean): void => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.connect(port, ip);
  });
}

/** Run `fn` over `items` with at most `limit` in flight. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Returns the terminal to switch to, or null when there is no safe answer:
 * with a known serial only that terminal counts; without one, only a single
 * unambiguous responder does. `exclude` holds addresses of the other
 * configured terminals — never poke those, they may be mid-sale.
 */
export async function discoverTerminal(opts: {
  hosts: string[];
  port: number;
  serial?: string;
  exclude?: string[];
}): Promise<FoundTerminal | null> {
  const hosts = opts.hosts.filter((ip) => !opts.exclude?.includes(ip));
  const open = await mapLimit(hosts, CONCURRENCY, (ip) => portOpen(ip, opts.port));
  const found: FoundTerminal[] = [];
  for (const ip of hosts.filter((_, i) => open[i])) {
    try {
      const id = await initialize(ip, opts.port, IDENTIFY_TIMEOUT_MS);
      if (id.resultCode === SUCCESS_CODE) found.push({ ip, serial: id.serial, model: id.model });
    } catch {
      // Something else listens on that port; not a terminal.
    }
  }
  if (opts.serial) return found.find((t) => t.serial === opts.serial) ?? null;
  return found.length === 1 ? found[0] : null;
}
