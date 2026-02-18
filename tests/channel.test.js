import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rocketchatPlugin } from '../src/channel.js';

// Mock dependencies
vi.mock('../src/api.js', () => ({
  sendMessage: vi.fn().mockResolvedValue({}),
  getChannelInfo: vi.fn().mockResolvedValue({ channel: { _id: 'room-1' } }),
  probe: vi.fn().mockResolvedValue({ ok: true, username: 'bot', userId: 'u1' }),
}));

vi.mock('../src/monitor.js', () => ({
  monitorRocketChat: vi.fn(),
}));

import { sendMessage, getChannelInfo, probe } from '../src/api.js';
import { monitorRocketChat } from '../src/monitor.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('channel plugin', () => {
  it('has required id', () => {
    expect(rocketchatPlugin.id).toBe('rocketchat');
  });

  it('has meta with label and blurb', () => {
    expect(rocketchatPlugin.meta.label).toBe('Rocket.Chat');
    expect(rocketchatPlugin.meta.blurb).toBeTruthy();
  });

  it('has capabilities', () => {
    expect(rocketchatPlugin.capabilities.chatTypes).toContain('group');
    expect(rocketchatPlugin.capabilities.chatTypes).toContain('channel');
    expect(rocketchatPlugin.capabilities.reactions).toBe(true);
    expect(rocketchatPlugin.capabilities.threads).toBe(true);
  });

  describe('config', () => {
    it('lists single account id from shorthand config', () => {
      const cfg = {
        channels: {
          rocketchat: {
            url: 'https://chat.example.com',
            authToken: 'token',
            userId: 'user-1',
            channel: 'general',
          },
        },
      };

      const ids = rocketchatPlugin.config.listAccountIds(cfg);

      expect(ids).toEqual(['default']);
    });

    it('lists multiple account ids', () => {
      const cfg = {
        channels: {
          rocketchat: {
            accounts: {
              work: { url: 'https://work.chat', authToken: 't1', userId: 'u1', channel: 'dev' },
              home: { url: 'https://home.chat', authToken: 't2', userId: 'u2', channel: 'general' },
            },
          },
        },
      };

      const ids = rocketchatPlugin.config.listAccountIds(cfg);

      expect(ids).toEqual(['work', 'home']);
    });

    it('returns empty array when no config', () => {
      expect(rocketchatPlugin.config.listAccountIds({})).toEqual([]);
      expect(rocketchatPlugin.config.listAccountIds({ channels: {} })).toEqual([]);
    });

    it('isConfigured checks required fields', () => {
      expect(rocketchatPlugin.config.isConfigured({ url: 'x', authToken: 'y', userId: 'z' })).toBe(true);
      expect(rocketchatPlugin.config.isConfigured({ url: 'x' })).toBe(false);
      expect(rocketchatPlugin.config.isConfigured(null)).toBe(false);
    });

    it('describeAccount returns account summary', () => {
      const desc = rocketchatPlugin.config.describeAccount({
        accountId: 'default',
        url: 'x',
        authToken: 'y',
        userId: 'z',
        channel: 'general',
      });
      expect(desc.accountId).toBe('default');
      expect(desc.name).toBe('general');
      expect(desc.configured).toBe(true);
    });

    it('resolves account by id', () => {
      const cfg = {
        channels: {
          rocketchat: {
            url: 'https://chat.example.com',
            authToken: 'token',
            userId: 'user-1',
            channel: 'general',
          },
        },
      };

      const account = rocketchatPlugin.config.resolveAccount(cfg, 'default');
      expect(account).toBeTruthy();
      expect(account.url).toBe('https://chat.example.com');
    });

    it('returns null for unknown account id', () => {
      const account = rocketchatPlugin.config.resolveAccount({}, 'nonexistent');
      expect(account).toBeNull();
    });
  });

  describe('outbound', () => {
    it('sendText calls sendMessage API', async () => {
      const ctx = {
        account: {
          url: 'https://chat.example.com',
          authToken: 'token',
          userId: 'user-1',
          channel: 'general',
        },
        text: 'hello world',
        threadId: 'thread-1',
      };

      await rocketchatPlugin.outbound.sendText(ctx);

      expect(getChannelInfo).toHaveBeenCalledWith(
        { url: 'https://chat.example.com', authToken: 'token', userId: 'user-1' },
        'general',
      );
      expect(sendMessage).toHaveBeenCalledWith(
        { url: 'https://chat.example.com', authToken: 'token', userId: 'user-1' },
        { roomId: 'room-1', text: 'hello world', threadId: 'thread-1' },
      );
    });

    it('has delivery mode and chunk limit', () => {
      expect(rocketchatPlugin.outbound.deliveryMode).toBe('direct');
      expect(rocketchatPlugin.outbound.textChunkLimit).toBe(4000);
    });
  });

  describe('gateway', () => {
    it('startAccount calls monitor with config', () => {
      const ctx = {
        cfg: {
          channels: {
            rocketchat: {
              url: 'https://chat.example.com',
              authToken: 'token',
              userId: 'user-1',
              channel: 'general',
            },
          },
        },
        accountId: 'default',
        abortSignal: new AbortController().signal,
        log: { info: vi.fn(), error: vi.fn() },
      };

      rocketchatPlugin.gateway.startAccount(ctx);

      expect(monitorRocketChat).toHaveBeenCalledWith(
        expect.objectContaining({
          account: expect.objectContaining({ url: 'https://chat.example.com' }),
          abortSignal: ctx.abortSignal,
          log: ctx.log,
        }),
      );
    });

    it('logs error when account not found', () => {
      const log = { error: vi.fn(), info: vi.fn() };
      const ctx = { cfg: {}, accountId: 'nonexistent', log };

      rocketchatPlugin.gateway.startAccount(ctx);

      expect(monitorRocketChat).not.toHaveBeenCalled();
      expect(log.error).toHaveBeenCalledWith(expect.stringContaining('nonexistent'));
    });
  });

  describe('status', () => {
    it('probe returns ok when connected', async () => {
      probe.mockResolvedValueOnce({ ok: true, username: 'bot', userId: 'u1' });

      const result = await rocketchatPlugin.status.probe({
        account: { url: 'https://chat.example.com', authToken: 'token', userId: 'u1' },
      });

      expect(result.ok).toBe(true);
      expect(result.detail).toContain('bot');
    });

    it('probe returns not ok when disconnected', async () => {
      probe.mockResolvedValueOnce({ ok: false, username: null, userId: null });

      const result = await rocketchatPlugin.status.probe({
        account: { url: 'https://chat.example.com', authToken: 'token', userId: 'u1' },
      });

      expect(result.ok).toBe(false);
      expect(result.detail).toContain('Failed');
    });
  });
});

describe('plugin entry point', () => {
  it('register stores runtime and registers channel', async () => {
    // Reset runtime module state
    vi.resetModules();
    const { default: plugin } = await import('../index.js');

    const api = {
      runtime: { some: 'runtime' },
      registerChannel: vi.fn(),
    };

    plugin.register(api);

    expect(api.registerChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        plugin: expect.objectContaining({ id: 'rocketchat' }),
      }),
    );
  });

  it('has required id field', async () => {
    vi.resetModules();
    const { default: plugin } = await import('../index.js');

    expect(plugin.id).toBe('rocketchat');
    expect(plugin.name).toBe('Rocket.Chat');
  });
});
