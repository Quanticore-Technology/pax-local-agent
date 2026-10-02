import { dispatch } from '../src/command-router';
import { RequestMessage, ERROR_CODES, PaxResult } from '../src/protocol/messages';
import { AgentConfig } from '../src/config';
import { startPoslinkMock } from './poslink-mock-server';

describe('CommandRouter.dispatch', () => {
  let baseConfig: AgentConfig;
  let closeServer: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    const mock = await startPoslinkMock();
    closeServer = mock.close;

    baseConfig = {
      wss_url: 'wss://localhost:443/ws/pax-agent',
      token: 'pat_test',
      office_id: 'office-001',
      agent_id: 'agent-123',
      devices: [
        {
          device_id: 'default',
          ip: '127.0.0.1',
          port: mock.port,
        },
      ],
    };
  });

  afterAll(async () => {
    if (closeServer) {
      await closeServer();
    }
  });

  describe('healthy POSLink responses', () => {
    it('should return success response for valid pax.sale', async () => {
      const req: RequestMessage = {
        type: 'request',
        id: 'req-001',
        command: 'pax.sale',
        payload: {
          device_id: 'default',
          amount_cents: 5000,
          external_id: 'ext-123',
        },
      };

      const response = await dispatch(baseConfig, req);

      expect(response.type).toBe('response');
      expect(response.id).toBe('req-001');
      expect(response.success).toBe(true);
      if (response.success) {
        expect(response.result).toBeDefined();
        expect((response.result as PaxResult).result_code).toBe('000000');
      }
    });

    it('should return success response for pax.void', async () => {
      const req: RequestMessage = {
        type: 'request',
        id: 'req-002',
        command: 'pax.void',
        payload: {
          device_id: 'default',
          orig_ref_num: '000123',
        },
      };

      const response = await dispatch(baseConfig, req);

      expect(response.type).toBe('response');
      expect(response.success).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should return error response for unknown device_id', async () => {
      const req: RequestMessage = {
        type: 'request',
        id: 'req-unknown-device',
        command: 'pax.sale',
        payload: {
          device_id: 'unknown-device',
          amount_cents: 5000,
          external_id: 'ext-123',
        },
      };

      const response = await dispatch(baseConfig, req);

      expect(response.type).toBe('response');
      expect(response.success).toBe(false);
      if (!response.success) {
        expect(response.error.code).toBe(ERROR_CODES.INVALID_DEVICE_ID);
      }
    });

    it('should return error response for unknown command', async () => {
      const req: RequestMessage = {
        type: 'request',
        id: 'req-unknown-cmd',
        command: 'unknown.command' as any,
        payload: { device_id: 'default' },
      };

      const response = await dispatch(baseConfig, req);

      expect(response.type).toBe('response');
      expect(response.success).toBe(false);
      if (!response.success) {
        expect(response.error.code).toBe(ERROR_CODES.PROTOCOL_ERROR);
      }
    });
  });

  describe('dispatch resilience', () => {
    it('should never throw unhandled rejection', async () => {
      const reqs: RequestMessage[] = [
        {
          type: 'request',
          id: 'good-1',
          command: 'pax.sale',
          payload: { device_id: 'default', amount_cents: 5000, external_id: 'ext-1' },
        },
        {
          type: 'request',
          id: 'bad-1',
          command: 'pax.void',
          payload: { device_id: 'bad-device', orig_ref_num: '123' },
        },
      ];

      const responses = await Promise.all(reqs.map((r) => dispatch(baseConfig, r)));

      expect(responses).toHaveLength(2);
      responses.forEach((res) => {
        expect(res.type).toBe('response');
        expect(res.id).toBeDefined();
        expect(res.success).toBeDefined();
      });
    });
  });
});
