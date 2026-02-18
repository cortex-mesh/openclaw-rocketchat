import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getMe,
  getChannelInfo,
  getChannelHistory,
  sendMessage,
  reactToMessage,
  probe,
} from '../src/api.js';

const config = {
  url: 'https://chat.example.com',
  authToken: 'test-token-123',
  userId: 'user-456',
};

function mockFetch(data, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('api', () => {
  describe('getMe', () => {
    it('returns user info', async () => {
      const data = { _id: 'user-456', username: 'bot' };
      globalThis.fetch = mockFetch(data);

      const result = await getMe(config);

      expect(result).toEqual(data);
      expect(fetch).toHaveBeenCalledWith(
        'https://chat.example.com/api/v1/me',
        expect.objectContaining({ method: 'GET' }),
      );
    });
  });

  describe('getChannelInfo', () => {
    it('returns channel data', async () => {
      const data = { channel: { _id: 'room-1', name: 'general' } };
      globalThis.fetch = mockFetch(data);

      const result = await getChannelInfo(config, 'general');

      expect(result).toEqual(data);
      expect(fetch).toHaveBeenCalledWith(
        'https://chat.example.com/api/v1/channels.info?roomName=general',
        expect.any(Object),
      );
    });
  });

  describe('getChannelHistory', () => {
    it('returns messages', async () => {
      const data = { messages: [{ _id: 'msg-1', msg: 'hello' }] };
      globalThis.fetch = mockFetch(data);

      const result = await getChannelHistory(config, 'room-1', 10);

      expect(result).toEqual(data);
      expect(fetch).toHaveBeenCalledWith(
        'https://chat.example.com/api/v1/channels.history?roomId=room-1&count=10',
        expect.any(Object),
      );
    });
  });

  describe('sendMessage', () => {
    it('posts to correct endpoint with thread', async () => {
      const data = { message: { _id: 'msg-2' } };
      globalThis.fetch = mockFetch(data);

      await sendMessage(config, { roomId: 'room-1', text: 'hi', threadId: 'thread-1' });

      expect(fetch).toHaveBeenCalledWith(
        'https://chat.example.com/api/v1/chat.postMessage',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ roomId: 'room-1', text: 'hi', tmid: 'thread-1' }),
        }),
      );
    });

    it('omits tmid when no threadId', async () => {
      globalThis.fetch = mockFetch({ message: {} });

      await sendMessage(config, { roomId: 'room-1', text: 'hi' });

      const body = JSON.parse(fetch.mock.calls[0][1].body);
      expect(body).not.toHaveProperty('tmid');
    });
  });

  describe('reactToMessage', () => {
    it('toggles reactions', async () => {
      globalThis.fetch = mockFetch({ success: true });

      await reactToMessage(config, 'msg-1', 'hourglass', true);

      expect(fetch).toHaveBeenCalledWith(
        'https://chat.example.com/api/v1/chat.react',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            messageId: 'msg-1',
            emoji: 'hourglass',
            shouldReact: true,
          }),
        }),
      );
    });
  });

  describe('error handling', () => {
    it('throws on API error', async () => {
      globalThis.fetch = mockFetch({ error: 'Unauthorized' }, 401);

      await expect(getMe(config)).rejects.toThrow('Rocket.Chat API GET /api/v1/me failed (401)');
    });
  });

  describe('auth headers', () => {
    it('includes X-Auth-Token and X-User-Id on all requests', async () => {
      globalThis.fetch = mockFetch({});

      await getMe(config);

      const headers = fetch.mock.calls[0][1].headers;
      expect(headers['X-Auth-Token']).toBe('test-token-123');
      expect(headers['X-User-Id']).toBe('user-456');
    });
  });

  describe('probe', () => {
    it('returns ok when API succeeds', async () => {
      globalThis.fetch = mockFetch({ _id: 'user-456', username: 'bot' });

      const result = await probe(config);

      expect(result).toEqual({ ok: true, username: 'bot', userId: 'user-456' });
    });

    it('returns not ok when API fails', async () => {
      globalThis.fetch = mockFetch({}, 500);

      const result = await probe(config);

      expect(result).toEqual({ ok: false, username: null, userId: null });
    });
  });
});
