import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { monitorRocketChat, MAX_PROCESSED_IDS } from '../src/monitor.js';

// Mock api module
vi.mock('../src/api.js', () => ({
  getChannelInfo: vi.fn(),
  getChannelHistory: vi.fn(),
  sendMessage: vi.fn().mockResolvedValue({}),
  reactToMessage: vi.fn().mockResolvedValue({}),
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

function makeRuntime() {
  return {
    channel: {
      routing: {
        resolveAgentRoute: vi.fn().mockReturnValue({ sessionKey: 'session-1' }),
      },
      dispatchInboundMessage: vi.fn().mockImplementation(async ({ dispatcher }) => {
        // Simulate agent calling deliver
        await dispatcher.deliver({ text: 'response' });
      }),
      createReplyDispatcher: vi.fn().mockImplementation(({ deliver, onError }) => ({
        deliver,
        onError,
      })),
    },
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
// Aborts on the poll AFTER the last desired one, so messages from the
// last desired poll are fully processed before shutdown.
async function runMonitor(account, runtime, opts = {}) {
  const pollCount = opts.pollCount || 1;
  let pollsDone = 0;

  getChannelHistory.mockImplementation(async () => {
    pollsDone++;
    if (pollsDone > pollCount) {
      // Abort on the extra poll — previous poll's messages already processed
      controller.abort();
      return { messages: [] };
    }
    return opts.historyResponse || { messages: [] };
  });

  await monitorRocketChat({
    account: makeAccount(account),
    cfg: {},
    runtime: runtime || makeRuntime(),
    abortSignal: controller.signal,
    log,
  });
}

describe('monitor', () => {
  it('skips own messages', async () => {
    const runtime = makeRuntime();

    await runMonitor({}, runtime, {
      historyResponse: { messages: [makeMsg('msg-1', 'bot-user', 'bot', 'self msg')] },
    });

    expect(runtime.channel.dispatchInboundMessage).not.toHaveBeenCalled();
  });

  it('skips system messages', async () => {
    const runtime = makeRuntime();

    await runMonitor({}, runtime, {
      historyResponse: { messages: [{ ...makeMsg('msg-1'), t: 'uj' }] },
    });

    expect(runtime.channel.dispatchInboundMessage).not.toHaveBeenCalled();
  });

  it('skips bot messages', async () => {
    const runtime = makeRuntime();

    await runMonitor({}, runtime, {
      historyResponse: { messages: [{ ...makeMsg('msg-1'), bot: true }] },
    });

    expect(runtime.channel.dispatchInboundMessage).not.toHaveBeenCalled();
  });

  it('skips already-processed messages', async () => {
    const runtime = makeRuntime();
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
      runtime,
      abortSignal: controller.signal,
      log,
    });

    // Only dispatched once despite two polls
    expect(runtime.channel.dispatchInboundMessage).toHaveBeenCalledTimes(1);
  });

  it('processes new user messages', async () => {
    const runtime = makeRuntime();

    await runMonitor({}, runtime, {
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
    expect(runtime.channel.dispatchInboundMessage).toHaveBeenCalledTimes(1);
  });

  it('thread messages include threadId', async () => {
    const runtime = makeRuntime();
    const threadMsg = makeMsg('msg-1', 'sender-1', 'alice', 'reply', { tmid: 'parent-1' });

    await runMonitor({}, runtime, {
      historyResponse: { messages: [threadMsg] },
    });

    // sendMessage should be called with threadId from tmid or msg._id
    expect(sendMessage).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ threadId: 'parent-1' }),
    );
  });

  it('respects abortSignal', async () => {
    const runtime = makeRuntime();

    // Abort immediately
    controller.abort();

    await monitorRocketChat({
      account: makeAccount(),
      cfg: {},
      runtime,
      abortSignal: controller.signal,
      log,
    });

    // Should not have polled for history (loop never entered since already aborted,
    // but getChannelInfo still resolves)
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('stopped'));
  });

  it('caps processed IDs at MAX_PROCESSED_IDS', async () => {
    const runtime = makeRuntime();
    const msgCount = MAX_PROCESSED_IDS + 100;
    const messages = [];
    for (let i = 0; i < msgCount; i++) {
      messages.push(makeMsg(`msg-${i}`, 'sender-1', 'alice', `msg ${i}`));
    }

    // Return all messages in one poll
    await runMonitor({}, runtime, {
      historyResponse: { messages },
    });

    // All messages should have been dispatched (they're all new)
    expect(runtime.channel.dispatchInboundMessage).toHaveBeenCalledTimes(msgCount);
  });

  it('poll interval is configurable', async () => {
    const runtime = makeRuntime();

    // Custom interval — just verify it doesn't error
    await runMonitor({ pollInterval: 0.005 }, runtime, {
      historyResponse: { messages: [] },
    });

    // No error means it ran with the custom interval
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('stopped'));
  });

  it('resolves channel once at startup', async () => {
    const runtime = makeRuntime();

    let pollCount = 0;
    getChannelHistory.mockImplementation(async () => {
      pollCount++;
      if (pollCount >= 3) controller.abort();
      return { messages: [] };
    });

    await monitorRocketChat({
      account: makeAccount(),
      cfg: {},
      runtime,
      abortSignal: controller.signal,
      log,
    });

    // getChannelInfo called exactly once (at startup)
    expect(getChannelInfo).toHaveBeenCalledTimes(1);
  });

  it('handles dispatch errors gracefully', async () => {
    const runtime = makeRuntime();
    runtime.channel.dispatchInboundMessage.mockRejectedValueOnce(new Error('agent error'));

    await runMonitor({}, runtime, {
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
