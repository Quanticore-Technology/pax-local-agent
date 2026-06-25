#!/usr/bin/env node
import { tryLoadConfig, writeConfig, deleteConfig, AgentConfig, DeviceEntry } from './config';
import { getLogger } from './logger';
import { startWsClient, WsClientHandle } from './ws-client';
import { startWebServer, AgentState } from './web-server';
import { runSetup } from './setup-cli';
import { startPairingClient, PairingHandle } from './pairing-client';

const VERSION = process.env.PAX_AGENT_VERSION || require('../package.json').version;
const DEFAULT_HEALTH_PORT = 9876;
const logger = getLogger();

async function main(): Promise<void> {
  const subcommand = process.argv[2];

  // `pax-agent setup` — interactive prompt that writes config.json then exits.
  if (subcommand === 'setup') {
    await runSetup();
    return;
  }

  const configPath = subcommand && !subcommand.startsWith('-') ? subcommand : undefined;
  const loaded = tryLoadConfig(configPath);

  if (loaded.config) {
    logger.info(
      { version: VERSION, office_id: loaded.config.office_id, devices: loaded.config.devices.length },
      'pax-agent starting',
    );
  } else {
    logger.warn(
      { version: VERSION, error: loaded.error },
      'pax-agent starting WITHOUT valid config — entering pairing mode',
    );
  }

  // Orchestrator owns ws-client + pairing-client lifecycles. Saving a new
  // config (via web UI manually OR via pairing claim) tears down the old
  // ws-client and starts a fresh one.
  let wsClient: WsClientHandle | null = null;
  let pairing: PairingHandle | null = null;

  const startPairing = (previousDevices?: DeviceEntry[]): void => {
    if (pairing) return; // already pairing
    const bootstrapUrl = process.env.PAX_AGENT_BOOTSTRAP_URL || 'http://localhost:8000';
    pairing = startPairingClient({
      bootstrap_url: bootstrapUrl,
      previous_devices: previousDevices,
      onClaimed: (cfg) => onConfigReady(cfg),
    });
    setInterval(() => {
      state.pairing_code = pairing?.getCode() ?? null;
    }, 500).unref?.();
  };

  // Triggered when the gateway repeatedly rejects our token (consecutive 4003
  // closes). Most likely cause: the dashboard "Revoke" button. Auto-recover
  // by deleting config + entering pairing mode again so the salon just sees
  // a new pairing code.
  const onTokenRevoked = (count: number): void => {
    logger.warn({ count }, 'auth-fail recovery — deleting config + entering pairing mode');
    // Snapshot LAN devices BEFORE deleting the config so the new pairing
    // can restore them — otherwise every re-pair would reset PAX IP to the
    // bogus placeholder and break Test Connection until staff re-enter it.
    const previousDevices = state.config?.devices;
    try { deleteConfig(); } catch (e) {
      logger.warn({ err: (e as Error).message }, 'deleteConfig failed (non-fatal)');
    }
    if (wsClient) {
      try { wsClient.stop(); } catch { /* ignore */ }
      wsClient = null;
    }
    state.config = null;
    startPairing(previousDevices);
  };

  const startWs = (cfg: AgentConfig): void => {
    if (wsClient) {
      try { wsClient.stop(); } catch { /* ignore */ }
    }
    wsClient = startWsClient(cfg, VERSION, { onAuthFail: onTokenRevoked });
  };

  const onConfigReady = (cfg: AgentConfig): void => {
    // Validate + persist BEFORE accepting the config. If the cloud handed us
    // a malformed wss_url (production env not configured correctly), reject
    // and immediately re-enter pairing mode rather than thrashing connect
    // attempts with an invalid URL.
    try {
      writeConfig(cfg);
    } catch (e) {
      logger.error(
        { err: (e as Error).message },
        'rejecting paired config — invalid (likely backend missing PAX_AGENT_WSS_URL env). Re-announcing.',
      );
      // Stay in pairing mode and let the salon try again.
      return;
    }
    state.config = cfg;
    state.pairing_code = null;
    pairing?.stop();
    pairing = null;
    startWs(cfg);
  };

  const state: AgentState = {
    config: loaded.config,
    ws_connected: false,
    last_command_at: null,
    pairing_code: null,
    onConfigChanged: onConfigReady,
    onForgetPairing: () => onTokenRevoked(0),
  };

  if (loaded.config) {
    startWs(loaded.config);
  } else {
    // First-time setup: announce a pairing code, poll until claimed.
    startPairing();
  }

  // Poll WS state into the snapshot — cheap + decouples web server from ws-client internals.
  setInterval(() => {
    state.ws_connected = wsClient?.isConnected() ?? false;
  }, 1_000);

  const healthPort = loaded.config?.health_port ?? DEFAULT_HEALTH_PORT;
  const httpServer = startWebServer(healthPort, VERSION, state);

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutdown');
    pairing?.stop();
    wsClient?.stop();
    httpServer.close();
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('uncaughtException', (err) => {
    logger.error({ err: err.message, stack: err.stack }, 'uncaught exception');
  });
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason: String(reason) }, 'unhandled rejection');
  });
}

main().catch((err) => {
  logger.fatal({ err: err.message, stack: err.stack }, 'fatal startup error');
  process.exit(1);
});
