import { describe, it, expect, vi, beforeEach } from 'vitest';
import { markProcessing, markComplete, markFailed } from '../src/reactions.js';

// Mock the api module
vi.mock('../src/api.js', () => ({
  reactToMessage: vi.fn().mockResolvedValue({ success: true }),
}));

import { reactToMessage } from '../src/api.js';

const config = {
  url: 'https://chat.example.com',
  authToken: 'token',
  userId: 'user-1',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('reactions', () => {
  describe('markProcessing', () => {
    it('adds hourglass reaction', async () => {
      await markProcessing(config, 'msg-1');

      expect(reactToMessage).toHaveBeenCalledWith(config, 'msg-1', 'hourglass', true);
      expect(reactToMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe('markComplete', () => {
    it('removes hourglass and adds checkmark', async () => {
      await markComplete(config, 'msg-1');

      expect(reactToMessage).toHaveBeenCalledTimes(2);
      expect(reactToMessage).toHaveBeenNthCalledWith(1, config, 'msg-1', 'hourglass', false);
      expect(reactToMessage).toHaveBeenNthCalledWith(2, config, 'msg-1', 'white_check_mark', true);
    });
  });

  describe('markFailed', () => {
    it('removes hourglass and adds x', async () => {
      await markFailed(config, 'msg-1');

      expect(reactToMessage).toHaveBeenCalledTimes(2);
      expect(reactToMessage).toHaveBeenNthCalledWith(1, config, 'msg-1', 'hourglass', false);
      expect(reactToMessage).toHaveBeenNthCalledWith(2, config, 'msg-1', 'x', true);
    });
  });

  describe('error resilience', () => {
    it('markProcessing does not throw on reaction failure', async () => {
      reactToMessage.mockRejectedValueOnce(new Error('network error'));

      await expect(markProcessing(config, 'msg-1')).resolves.toBeUndefined();
    });

    it('markComplete continues to add checkmark even if hourglass removal fails', async () => {
      reactToMessage
        .mockRejectedValueOnce(new Error('network error'))
        .mockResolvedValueOnce({ success: true });

      await markComplete(config, 'msg-1');

      expect(reactToMessage).toHaveBeenCalledTimes(2);
      expect(reactToMessage).toHaveBeenNthCalledWith(2, config, 'msg-1', 'white_check_mark', true);
    });

    it('markFailed continues to add x even if hourglass removal fails', async () => {
      reactToMessage
        .mockRejectedValueOnce(new Error('network error'))
        .mockResolvedValueOnce({ success: true });

      await markFailed(config, 'msg-1');

      expect(reactToMessage).toHaveBeenCalledTimes(2);
      expect(reactToMessage).toHaveBeenNthCalledWith(2, config, 'msg-1', 'x', true);
    });
  });
});
