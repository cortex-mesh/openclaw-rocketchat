/**
 * Workflow integration tests — verify the full message processing lifecycle.
 *
 * These tests exercise the complete flow through monitor → reactions → API
 * with mocked external calls, verifying:
 *   1. hourglass added on receipt
 *   2. agent dispatch + deliver callback
 *   3. response sent via sendMessage
 *   4. hourglass removed, checkmark added (or ❌ on error)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { monitorRocketChat } from '../src/monitor.js';

// Mock api module — track every call in order
vi.mock('../src/api.js', () => ({
  getChannelInfo: vi.fn(),
  getChannelHistory: vi.fn(),
  sendMessage: vi.fn().mockResolvedValue({}),
  reactToMessage: vi.fn().mockResolvedValue({}),
}));

const mockDispatch = vi.fn().mockResolvedValue({});
const mockResolveAgentRoute = vi.fn().mockReturnValue({ sessionKey: 'session-1' });

vi.mock('../src/runtime.js', () => ({
  getRuntime: vi.fn(() => ({
    channel: {
      routing: { resolveAgentRoute: mockResolveAgentRoute },
      reply: { dispatchReplyWithBufferedBlockDispatcher: mockDispatch },
    },
  })),
  setRuntime: vi.fn(),
}));

import { getChannelInfo, getChannelHistory, sendMessage, reactToMessage } from '../src/api.js';

function makeMsg(id, userId = 'sender-1', username = 'alice', text = 'hello', extra = {}) {
  return { _id: id, msg: text, u: { _id: userId, username }, ts: '2026-02-17T00:00:00Z', ...extra };
}

function makeAccount(overrides = {}) {
  return {
    url: 'https://chat.example.com',
    authToken: 'token',
    userId: 'bot-user',
    channel: 'general',
    pollInterval: 0.01,
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

async function runMonitor(account, opts = {}) {
  let pollsDone = 0;
  getChannelHistory.mockImplementation(async () => {
    pollsDone++;
    if (pollsDone > 1) {
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

/** Extract all reactToMessage calls as [messageId, emoji, shouldReact] tuples, in order. */
function reactionCalls() {
  return reactToMessage.mock.calls.map(([, msgId, emoji, shouldReact]) => [msgId, emoji, shouldReact]);
}

describe('workflow: happy path — message processed and response delivered', () => {
  it('follows hourglass → deliver → response sent → hourglass removed → checkmark', async () => {
    // Agent dispatch calls the deliver callback with a response
    mockDispatch.mockImplementationOnce(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: 'Hello back!' });
    });

    await runMonitor({}, {
      historyResponse: { messages: [makeMsg('msg-1')] },
    });

    const reactions = reactionCalls();

    // 1. Hourglass added on receipt
    expect(reactions[0]).toEqual(['msg-1', 'hourglass', true]);

    // 2. Response sent via sendMessage to the correct room and thread
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://chat.example.com' }),
      { roomId: 'room-1', text: 'Hello back!', threadId: 'msg-1' },
    );

    // 3. Hourglass removed
    expect(reactions[1]).toEqual(['msg-1', 'hourglass', false]);

    // 4. Checkmark added
    expect(reactions[2]).toEqual(['msg-1', 'white_check_mark', true]);

    // Exactly 3 reaction calls total
    expect(reactions).toHaveLength(3);
  });

  it('uses parent threadId for threaded messages', async () => {
    mockDispatch.mockImplementationOnce(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: 'Thread reply' });
    });

    await runMonitor({}, {
      historyResponse: { messages: [makeMsg('msg-2', 'sender-1', 'alice', 'reply', { tmid: 'parent-1' })] },
    });

    // Response should thread to the parent, not the reply message
    expect(sendMessage).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ threadId: 'parent-1' }),
    );

    // Checkmark should still be on the reply message
    const reactions = reactionCalls();
    expect(reactions[2]).toEqual(['msg-2', 'white_check_mark', true]);
  });
});

describe('workflow: error path — dispatch throws', () => {
  it('follows hourglass → dispatch error → hourglass removed → ❌ added', async () => {
    mockDispatch.mockRejectedValueOnce(new Error('Agent crashed'));

    await runMonitor({}, {
      historyResponse: { messages: [makeMsg('msg-err-1')] },
    });

    const reactions = reactionCalls();

    // 1. Hourglass added
    expect(reactions[0]).toEqual(['msg-err-1', 'hourglass', true]);

    // 2. Hourglass removed
    expect(reactions[1]).toEqual(['msg-err-1', 'hourglass', false]);

    // 3. ❌ added
    expect(reactions[2]).toEqual(['msg-err-1', 'x', true]);

    expect(reactions).toHaveLength(3);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('msg-err-1'));
  });
});

describe('workflow: error path — no reply delivered', () => {
  it('follows hourglass → dispatch returns without deliver → hourglass removed → ❌ added', async () => {
    // Dispatch resolves but never calls deliver (agent returned no content)
    mockDispatch.mockResolvedValueOnce({});

    await runMonitor({}, {
      historyResponse: { messages: [makeMsg('msg-noreply-1')] },
    });

    const reactions = reactionCalls();

    // 1. Hourglass added
    expect(reactions[0]).toEqual(['msg-noreply-1', 'hourglass', true]);

    // 2. Hourglass removed
    expect(reactions[1]).toEqual(['msg-noreply-1', 'hourglass', false]);

    // 3. ❌ added
    expect(reactions[2]).toEqual(['msg-noreply-1', 'x', true]);

    expect(reactions).toHaveLength(3);

    // No sendMessage called
    expect(sendMessage).not.toHaveBeenCalled();

    // Warning logged about no reply
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('msg-noreply-1'));
  });
});

describe('workflow: error path — delivery error via onError callback', () => {
  it('follows hourglass → deliver + onError → hourglass removed → ❌ added', async () => {
    // Dispatch calls deliver (which succeeds) but also calls onError
    mockDispatch.mockImplementationOnce(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: 'partial response' });
      dispatcherOptions.onError(new Error('Delivery timed out'));
    });

    await runMonitor({}, {
      historyResponse: { messages: [makeMsg('msg-delerr-1')] },
    });

    const reactions = reactionCalls();

    // 1. Hourglass added
    expect(reactions[0]).toEqual(['msg-delerr-1', 'hourglass', true]);

    // 2. Hourglass removed (markFailed)
    expect(reactions[1]).toEqual(['msg-delerr-1', 'hourglass', false]);

    // 3. ❌ added (delivery error overrides delivered=true)
    expect(reactions[2]).toEqual(['msg-delerr-1', 'x', true]);

    expect(reactions).toHaveLength(3);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('msg-delerr-1'));
  });
});

describe('workflow: error path — sendMessage fails in deliver callback', () => {
  it('follows hourglass → sendMessage throws → dispatch catches → ❌ added', async () => {
    // Deliver callback calls sendMessage which rejects
    sendMessage.mockRejectedValueOnce(new Error('RC API 500'));

    mockDispatch.mockImplementationOnce(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: 'response' });
    });

    await runMonitor({}, {
      historyResponse: { messages: [makeMsg('msg-sendfail-1')] },
    });

    const reactions = reactionCalls();

    // 1. Hourglass added
    expect(reactions[0]).toEqual(['msg-sendfail-1', 'hourglass', true]);

    // 2. Hourglass removed
    expect(reactions[1]).toEqual(['msg-sendfail-1', 'hourglass', false]);

    // 3. ❌ added (sendMessage failure propagates up)
    expect(reactions[2]).toEqual(['msg-sendfail-1', 'x', true]);

    expect(reactions).toHaveLength(3);
  });
});

describe('workflow: multiple messages in one poll', () => {
  it('processes each message independently with correct reactions', async () => {
    // First message: success. Second message: no reply.
    let callCount = 0;
    mockDispatch.mockImplementation(async ({ dispatcherOptions }) => {
      callCount++;
      if (callCount === 1) {
        await dispatcherOptions.deliver({ text: 'Response 1' });
      }
      // Second call: no deliver (agent returns nothing)
    });

    // RC API returns newest-first; monitor reverses to oldest-first
    await runMonitor({}, {
      historyResponse: {
        messages: [
          makeMsg('msg-b', 'sender-2', 'bob', 'second'),
          makeMsg('msg-a', 'sender-1', 'alice', 'first'),
        ],
      },
    });

    const reactions = reactionCalls();

    // msg-a: hourglass → hourglass removed → checkmark (success)
    expect(reactions[0]).toEqual(['msg-a', 'hourglass', true]);
    expect(reactions[1]).toEqual(['msg-a', 'hourglass', false]);
    expect(reactions[2]).toEqual(['msg-a', 'white_check_mark', true]);

    // msg-b: hourglass → hourglass removed → ❌ (no reply)
    expect(reactions[3]).toEqual(['msg-b', 'hourglass', true]);
    expect(reactions[4]).toEqual(['msg-b', 'hourglass', false]);
    expect(reactions[5]).toEqual(['msg-b', 'x', true]);

    expect(reactions).toHaveLength(6);

    // Only one sendMessage call (for msg-a)
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
