import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { monitorRocketChat, MAX_PROCESSED_IDS } from '../src/monitor.js';

// Mock api module
vi.mock('../src/api.js', () => ({
  getChannelInfo: vi.fn(),
  getChannelHistory: vi.fn(),
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

import { getChannelInfo, getChannelHistory, sendMessage, reactToMessage } from '../src/api.js';

function makeMsg(id, userId = 'sender-1', username = 'alice', text = 'hello', extra = {}) {
  return { _id: id, msg: text, u: { _id: userId, username }, ...extra };
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
});
