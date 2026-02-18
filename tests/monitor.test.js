import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { monitorRocketChat, MAX_PROCESSED_IDS, buildInboundHistory } from '../src/monitor.js';

// Mock api module
vi.mock('../src/api.js', () => ({
  getChannelInfo: vi.fn(),
  getChannelHistory: vi.fn(),
  getThreadMessages: vi.fn().mockResolvedValue({ messages: [] }),
  sendMessage: vi.fn().mockResolvedValue({}),
  reactToMessage: vi.fn().mockResolvedValue({}),
}));

// Mock runtime module — getRuntime returns the pluginRuntime
const mockDispatch = vi.fn().mockResolvedValue({});
const mockResolveAgentRoute = vi.fn().mockReturnValue({ sessionKey: 'session-1' });

vi.mock('../src/runtime.js', () => ({
  getRuntime: vi.fn(() => ({
    channel: {
      routing: {
        resolveAgentRoute: mockResolveAgentRoute,
      },
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: mockDispatch,
      },
    },
  })),
  setRuntime: vi.fn(),
}));

import { getChannelInfo, getChannelHistory, getThreadMessages, sendMessage, reactToMessage } from '../src/api.js';

function makeMsg(id, userId = 'sender-1', username = 'alice', text = 'hello', extra = {}) {
  return { _id: id, msg: text, u: { _id: userId, username }, ts: '2026-02-17T00:00:00Z', ...extra };
}

function makeAccount(overrides = {}) {
  return {
    url: 'https://chat.example.com',
    authToken: 'token',
    userId: 'bot-user',
    channel: 'general',
    pollInterval: 0.01, // 10ms for fast tests
    ...overrides,
  };
}

let controller;
let log;

beforeEach(() => {
  vi.clearAllMocks();
  controller = new AbortController();
  log = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };

  getChannelInfo.mockResolvedValue({ channel: { _id: 'room-1' } });
  getChannelHistory.mockResolvedValue({ messages: [] });
});

afterEach(() => {
  controller.abort();
});

// Helper: run monitor for a limited number of poll cycles.
async function runMonitor(account, opts = {}) {
  const pollCount = opts.pollCount || 1;
  let pollsDone = 0;

  getChannelHistory.mockImplementation(async () => {
    pollsDone++;
    if (pollsDone > pollCount) {
      controller.abort();
      return { messages: [] };
    }
    return opts.historyResponse || { messages: [] };
  });

  await monitorRocketChat({
    account: makeAccount(account),
    cfg: {},
    abortSignal: controller.signal,
    log,
  });
}

describe('monitor', () => {
  it('skips own messages', async () => {
    await runMonitor({}, {
      historyResponse: { messages: [makeMsg('msg-1', 'bot-user', 'bot', 'self msg')] },
    });

    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('skips system messages', async () => {
    await runMonitor({}, {
      historyResponse: { messages: [{ ...makeMsg('msg-1'), t: 'uj' }] },
    });

    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('skips bot messages', async () => {
    await runMonitor({}, {
      historyResponse: { messages: [{ ...makeMsg('msg-1'), bot: true }] },
    });

    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('skips messages already marked with checkmark', async () => {
    const completedMsg = {
      ...makeMsg('msg-1'),
      reactions: { ':white_check_mark:': { usernames: ['forgeclaw'] } },
    };

    await runMonitor({}, {
      historyResponse: { messages: [completedMsg] },
    });

    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('processes messages with x reaction (failed, needs retry)', async () => {
    const failedMsg = {
      ...makeMsg('msg-1'),
      reactions: { ':x:': { usernames: ['forgeclaw'] } },
    };

    await runMonitor({}, {
      historyResponse: { messages: [failedMsg] },
    });

    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  it('skips already-processed messages', async () => {
    const msg = makeMsg('msg-1');
    let pollCount = 0;

    getChannelHistory.mockImplementation(async () => {
      pollCount++;
      if (pollCount >= 2) controller.abort();
      return { messages: [msg] };
    });

    await monitorRocketChat({
      account: makeAccount(),
      cfg: {},
      abortSignal: controller.signal,
      log,
    });

    // Only dispatched once despite two polls
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  it('processes new user messages', async () => {
    await runMonitor({}, {
      historyResponse: { messages: [makeMsg('msg-1', 'sender-1', 'alice', 'hello')] },
    });

    // Hourglass added
    expect(reactToMessage).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://chat.example.com' }),
      'msg-1',
      'hourglass',
      true,
    );

    // Message dispatched
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          Body: 'hello',
          SessionKey: 'session-1',
          Provider: 'rocketchat',
          SenderId: 'sender-1',
          SenderUsername: 'alice',
        }),
      }),
    );
  });

  it('thread messages include threadId in deliver callback', async () => {
    const threadMsg = makeMsg('msg-1', 'sender-1', 'alice', 'reply', { tmid: 'parent-1' });

    // Make dispatch call the deliver callback
    mockDispatch.mockImplementationOnce(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: 'response' });
    });

    await runMonitor({}, {
      historyResponse: { messages: [threadMsg] },
    });

    // sendMessage should be called with roomId and threadId from tmid
    expect(sendMessage).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ roomId: 'room-1', threadId: 'parent-1' }),
    );
  });

  it('respects abortSignal', async () => {
    // Abort immediately
    controller.abort();

    await monitorRocketChat({
      account: makeAccount(),
      cfg: {},
      abortSignal: controller.signal,
      log,
    });

    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('stopped'));
  });

  it('caps processed IDs at MAX_PROCESSED_IDS', async () => {
    const msgCount = MAX_PROCESSED_IDS + 100;
    const messages = [];
    for (let i = 0; i < msgCount; i++) {
      messages.push(makeMsg(`msg-${i}`, 'sender-1', 'alice', `msg ${i}`));
    }

    await runMonitor({}, {
      historyResponse: { messages },
    });

    // All messages should have been dispatched (they're all new)
    expect(mockDispatch).toHaveBeenCalledTimes(msgCount);
  });

  it('poll interval is configurable', async () => {
    await runMonitor({ pollInterval: 0.005 }, {
      historyResponse: { messages: [] },
    });

    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('stopped'));
  });

  it('resolves channel once at startup', async () => {
    let pollCount = 0;
    getChannelHistory.mockImplementation(async () => {
      pollCount++;
      if (pollCount >= 3) controller.abort();
      return { messages: [] };
    });

    await monitorRocketChat({
      account: makeAccount(),
      cfg: {},
      abortSignal: controller.signal,
      log,
    });

    expect(getChannelInfo).toHaveBeenCalledTimes(1);
  });

  it('handles dispatch errors gracefully', async () => {
    mockDispatch.mockRejectedValueOnce(new Error('agent error'));

    await runMonitor({}, {
      historyResponse: { messages: [makeMsg('msg-1')] },
    });

    // markFailed should be called
    expect(reactToMessage).toHaveBeenCalledWith(
      expect.any(Object),
      'msg-1',
      'x',
      true,
    );
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('msg-1'));
  });

  describe('thread polling', () => {
    it('discovers threads from tcount > 0 in history and polls them', async () => {
      const parentMsg = makeMsg('parent-1', 'sender-1', 'alice', 'start thread', { tcount: 2 });
      const threadReply = makeMsg('reply-1', 'sender-2', 'bob', 'thread reply');

      getThreadMessages.mockResolvedValueOnce({ messages: [threadReply] });

      await runMonitor({}, {
        historyResponse: { messages: [parentMsg] },
      });

      // Thread was polled with offset 0 (first poll)
      expect(getThreadMessages).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'https://chat.example.com' }),
        'parent-1',
        { count: 50, offset: 0 },
      );

      // Both parent and thread reply dispatched
      expect(mockDispatch).toHaveBeenCalledTimes(2);
    });

    it('dispatches thread-only replies with correct threadId', async () => {
      const parentMsg = makeMsg('parent-1', 'sender-1', 'alice', 'start', { tcount: 1 });
      const threadReply = makeMsg('reply-1', 'sender-2', 'bob', 'in-thread');

      getThreadMessages.mockResolvedValueOnce({ messages: [threadReply] });

      mockDispatch.mockImplementation(async ({ ctx, dispatcherOptions }) => {
        if (ctx.MessageSid === 'reply-1') {
          await dispatcherOptions.deliver({ text: 'response' });
        }
      });

      await runMonitor({}, {
        historyResponse: { messages: [parentMsg] },
      });

      // Reply should be sent to the parent thread
      expect(sendMessage).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ roomId: 'room-1', threadId: 'parent-1' }),
      );
    });

    it('skips already-processed thread replies', async () => {
      const parentMsg = makeMsg('parent-1', 'sender-1', 'alice', 'start', { tcount: 1 });
      // The parent also appears in thread messages (RC includes it)
      const threadParent = makeMsg('parent-1', 'sender-1', 'alice', 'start');

      getThreadMessages.mockResolvedValueOnce({ messages: [threadParent] });

      await runMonitor({}, {
        historyResponse: { messages: [parentMsg] },
      });

      // Only dispatched once (parent from history), not again from thread poll
      expect(mockDispatch).toHaveBeenCalledTimes(1);
    });

    it('skips thread replies with checkmark', async () => {
      const parentMsg = makeMsg('parent-1', 'sender-1', 'alice', 'start', { tcount: 1 });
      const completedReply = {
        ...makeMsg('reply-1', 'sender-2', 'bob', 'done'),
        reactions: { ':white_check_mark:': { usernames: ['bot'] } },
      };

      getThreadMessages.mockResolvedValueOnce({ messages: [completedReply] });

      await runMonitor({}, {
        historyResponse: { messages: [parentMsg] },
      });

      // Only parent dispatched, completed reply skipped
      expect(mockDispatch).toHaveBeenCalledTimes(1);
    });

    it('handles thread poll errors gracefully', async () => {
      const parentMsg = makeMsg('parent-1', 'sender-1', 'alice', 'start', { tcount: 1 });

      getThreadMessages.mockRejectedValueOnce(new Error('RC API 500'));

      await runMonitor({}, {
        historyResponse: { messages: [parentMsg] },
      });

      // Parent still dispatched
      expect(mockDispatch).toHaveBeenCalledTimes(1);

      // Error logged but monitor did not crash
      expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Thread poll error'));
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining('stopped'));
    });

    it('does not poll threads without tcount > 0', async () => {
      const regularMsg = makeMsg('msg-1', 'sender-1', 'alice', 'no thread');

      await runMonitor({}, {
        historyResponse: { messages: [regularMsg] },
      });

      expect(getThreadMessages).not.toHaveBeenCalled();
    });

    it('thread reply includes InboundHistory in dispatched context', async () => {
      const parentMsg = makeMsg('parent-1', 'sender-1', 'alice', 'start thread', { tcount: 2 });
      const threadReply = makeMsg('reply-1', 'sender-2', 'bob', 'thread reply');

      const threadHistory = [
        makeMsg('parent-1', 'sender-1', 'alice', 'start thread'),
        makeMsg('bot-msg-1', 'bot-user', 'bot', 'bot response'),
        makeMsg('reply-1', 'sender-2', 'bob', 'thread reply'),
      ];

      // First call: offset-based poll returns the new reply
      // Second call: context fetch returns full thread history
      getThreadMessages
        .mockResolvedValueOnce({ messages: [threadReply], total: 3 })
        .mockResolvedValueOnce({ messages: threadHistory });

      await runMonitor({}, {
        historyResponse: { messages: [parentMsg] },
      });

      // Thread reply should have InboundHistory (excluding current msg, excluding bot)
      const dispatchCall = mockDispatch.mock.calls.find(
        ([arg]) => arg.ctx.MessageSid === 'reply-1'
      );
      expect(dispatchCall).toBeDefined();
      const ctx = dispatchCall[0].ctx;
      expect(ctx.InboundHistory).toBeDefined();
      expect(ctx.InboundHistory.length).toBeGreaterThan(0);
      // InboundHistory should not include the current message
      expect(ctx.InboundHistory.every(e => e.body !== 'thread reply')).toBe(true);
    });

    it('ThreadStarterBody is set to the first message in the thread', async () => {
      const parentMsg = makeMsg('parent-1', 'sender-1', 'alice', 'thread starter body', { tcount: 1 });
      const threadReply = makeMsg('reply-1', 'sender-2', 'bob', 'follow up');

      const threadHistory = [
        makeMsg('parent-1', 'sender-1', 'alice', 'thread starter body'),
        makeMsg('reply-1', 'sender-2', 'bob', 'follow up'),
      ];

      getThreadMessages
        .mockResolvedValueOnce({ messages: [threadReply], total: 2 })
        .mockResolvedValueOnce({ messages: threadHistory });

      await runMonitor({}, {
        historyResponse: { messages: [parentMsg] },
      });

      const dispatchCall = mockDispatch.mock.calls.find(
        ([arg]) => arg.ctx.MessageSid === 'reply-1'
      );
      expect(dispatchCall[0].ctx.ThreadStarterBody).toBe('thread starter body');
    });

    it('MessageThreadId is set to the thread ID', async () => {
      const parentMsg = makeMsg('parent-1', 'sender-1', 'alice', 'start', { tcount: 1 });
      const threadReply = makeMsg('reply-1', 'sender-2', 'bob', 'reply');

      const threadHistory = [
        makeMsg('parent-1', 'sender-1', 'alice', 'start'),
        makeMsg('reply-1', 'sender-2', 'bob', 'reply'),
      ];

      getThreadMessages
        .mockResolvedValueOnce({ messages: [threadReply], total: 2 })
        .mockResolvedValueOnce({ messages: threadHistory });

      await runMonitor({}, {
        historyResponse: { messages: [parentMsg] },
      });

      const dispatchCall = mockDispatch.mock.calls.find(
        ([arg]) => arg.ctx.MessageSid === 'reply-1'
      );
      expect(dispatchCall[0].ctx.MessageThreadId).toBe('parent-1');
    });

    it('channel history message with tmid fetches thread context', async () => {
      const threadReply = makeMsg('reply-1', 'sender-2', 'bob', 'channel thread reply', { tmid: 'parent-1' });

      const threadHistory = [
        makeMsg('parent-1', 'sender-1', 'alice', 'original message'),
        makeMsg('reply-1', 'sender-2', 'bob', 'channel thread reply'),
      ];

      getThreadMessages.mockResolvedValueOnce({ messages: threadHistory });

      await runMonitor({}, {
        historyResponse: { messages: [threadReply] },
      });

      // getThreadMessages called for context fetch
      expect(getThreadMessages).toHaveBeenCalledWith(
        expect.any(Object),
        'parent-1',
        { count: 20 },
      );

      const dispatchCall = mockDispatch.mock.calls.find(
        ([arg]) => arg.ctx.MessageSid === 'reply-1'
      );
      expect(dispatchCall[0].ctx.InboundHistory).toBeDefined();
      expect(dispatchCall[0].ctx.ThreadStarterBody).toBe('original message');
      expect(dispatchCall[0].ctx.MessageThreadId).toBe('parent-1');
    });

    it('context fetch failure does not break message processing', async () => {
      const threadReply = makeMsg('reply-1', 'sender-2', 'bob', 'reply', { tmid: 'parent-1' });

      getThreadMessages.mockRejectedValueOnce(new Error('RC API 500'));

      await runMonitor({}, {
        historyResponse: { messages: [threadReply] },
      });

      // Message still dispatched without thread context
      expect(mockDispatch).toHaveBeenCalledTimes(1);
      const ctx = mockDispatch.mock.calls[0][0].ctx;
      expect(ctx.InboundHistory).toBeUndefined();
      expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Thread context fetch error'));
    });
  });

  describe('buildInboundHistory', () => {
    it('excludes the current message from history', () => {
      const messages = [
        makeMsg('msg-1', 'alice-id', 'alice', 'first'),
        makeMsg('msg-2', 'bob-id', 'bob', 'second'),
        makeMsg('msg-3', 'alice-id', 'alice', 'current'),
      ];

      const result = buildInboundHistory(messages, 'msg-3', 4000);
      expect(result).toHaveLength(2);
      expect(result.every(e => e.body !== 'current')).toBe(true);
    });

    it('truncates long messages to fit budget', () => {
      const longBody = 'x'.repeat(100);
      const messages = [
        makeMsg('msg-1', 'alice-id', 'alice', longBody),
        makeMsg('msg-2', 'bob-id', 'bob', 'short'),
        makeMsg('msg-3', 'alice-id', 'alice', 'current'),
      ];

      // Budget of 50: "short" (5 chars) fits fully, then 45 chars of longBody
      const result = buildInboundHistory(messages, 'msg-3', 50);
      expect(result).toHaveLength(2);
      // Newest message ("short") should be in full
      expect(result[1].body).toBe('short');
      // Oldest message should be truncated with ellipsis
      expect(result[0].body).toHaveLength(46); // 45 chars + ellipsis
      expect(result[0].body.endsWith('\u2026')).toBe(true);
    });

    it('stops including messages when budget is exhausted', () => {
      const messages = [
        makeMsg('msg-1', 'alice-id', 'alice', 'old message'),
        makeMsg('msg-2', 'bob-id', 'bob', 'newer message'),
        makeMsg('msg-3', 'charlie-id', 'charlie', 'newest'),
        makeMsg('msg-4', 'alice-id', 'alice', 'current'),
      ];

      // Budget only fits "newest" (6) + "newer message" (13) = 19
      const result = buildInboundHistory(messages, 'msg-4', 19);
      expect(result).toHaveLength(2);
      expect(result[0].body).toBe('newer message');
      expect(result[1].body).toBe('newest');
    });

    it('returns entries in chronological order', () => {
      const messages = [
        makeMsg('msg-1', 'alice-id', 'alice', 'first', { ts: '2026-02-17T00:01:00Z' }),
        makeMsg('msg-2', 'bob-id', 'bob', 'second', { ts: '2026-02-17T00:02:00Z' }),
        makeMsg('msg-3', 'alice-id', 'alice', 'current', { ts: '2026-02-17T00:03:00Z' }),
      ];

      const result = buildInboundHistory(messages, 'msg-3', 4000);
      expect(result[0].body).toBe('first');
      expect(result[1].body).toBe('second');
      expect(result[0].timestamp).toBeLessThan(result[1].timestamp);
    });

    it('includes sender and timestamp in entries', () => {
      const messages = [
        makeMsg('msg-1', 'alice-id', 'alice', 'hello', { ts: '2026-02-17T12:00:00Z' }),
        makeMsg('msg-2', 'bob-id', 'bob', 'current'),
      ];

      const result = buildInboundHistory(messages, 'msg-2', 4000);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        sender: 'alice',
        body: 'hello',
        timestamp: new Date('2026-02-17T12:00:00Z').getTime(),
      });
    });
  });
});
