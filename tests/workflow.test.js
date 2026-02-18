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
  getThreadMessages: vi.fn().mockResolvedValue({ messages: [] }),
  sendMessage: vi.fn().mockResolvedValue({}),
  reactToMessage: vi.fn().mockResolvedValue({}),
  downloadFile: vi.fn().mockResolvedValue(undefined),
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

import { getChannelInfo, getChannelHistory, getThreadMessages, sendMessage, reactToMessage, downloadFile } from '../src/api.js';

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

    // 1. Hourglass added on receipt (no ❌ removal — message has no prior failure)
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

describe('workflow: thread-only reply — hourglass → deliver → checkmark', () => {
  it('processes a thread-only reply with full reaction lifecycle and thread context', async () => {
    // Parent message with a thread (already processed, has checkmark)
    const parentMsg = {
      ...makeMsg('parent-1', 'sender-1', 'alice', 'start thread'),
      tcount: 1,
      reactions: { ':white_check_mark:': { usernames: ['bot'] } },
    };

    // Thread-only reply (not in channel history, only in thread poll)
    const threadReply = makeMsg('reply-1', 'sender-2', 'bob', 'thread question', { tmid: 'parent-1' });

    // Full thread history for context
    const threadHistory = [
      makeMsg('parent-1', 'sender-1', 'alice', 'start thread'),
      makeMsg('bot-resp-1', 'bot-user', 'bot', 'bot response'),
      makeMsg('reply-1', 'sender-2', 'bob', 'thread question'),
    ];

    // First call: offset-based poll returns the new reply
    // Second call: context fetch returns full thread history
    getThreadMessages
      .mockResolvedValueOnce({ messages: [threadReply], total: 3 })
      .mockResolvedValueOnce({ messages: threadHistory });

    // Agent responds to the thread reply
    mockDispatch.mockImplementationOnce(async ({ ctx, dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: 'Thread answer!' });
    });

    await runMonitor({}, {
      historyResponse: { messages: [parentMsg] },
    });

    const reactions = reactionCalls();

    // Parent skipped (has checkmark), only thread reply processed
    // 1. Hourglass added to thread reply
    expect(reactions[0]).toEqual(['reply-1', 'hourglass', true]);

    // 2. Response sent in the parent thread
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://chat.example.com' }),
      { roomId: 'room-1', text: 'Thread answer!', threadId: 'parent-1' },
    );

    // 3. Hourglass removed from thread reply
    expect(reactions[1]).toEqual(['reply-1', 'hourglass', false]);

    // 4. Checkmark added to thread reply
    expect(reactions[2]).toEqual(['reply-1', 'white_check_mark', true]);

    expect(reactions).toHaveLength(3);
    expect(mockDispatch).toHaveBeenCalledTimes(1);

    // Verify thread context was populated
    const ctx = mockDispatch.mock.calls[0][0].ctx;
    expect(ctx.InboundHistory).toBeDefined();
    expect(ctx.InboundHistory.length).toBeGreaterThan(0);
    expect(ctx.ThreadStarterBody).toBe('start thread');
    expect(ctx.MessageThreadId).toBe('parent-1');
  });
});

describe('workflow: retry after failure — stale ❌ cleared before processing', () => {
  it('removes ❌ when message has a prior failure reaction', async () => {
    mockDispatch.mockImplementationOnce(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: 'Success on retry!' });
    });

    // Message that previously failed (has ❌ reaction from prior attempt)
    const retriedMsg = makeMsg('msg-retry-1', 'sender-1', 'alice', 'try again', {
      reactions: { ':x:': { usernames: ['bot'] } },
    });

    await runMonitor({}, {
      historyResponse: { messages: [retriedMsg] },
    });

    const reactions = reactionCalls();

    // 1. ❌ removed (stale failure cleared because msg.reactions has :x:)
    expect(reactions[0]).toEqual(['msg-retry-1', 'x', false]);

    // 2. Hourglass added
    expect(reactions[1]).toEqual(['msg-retry-1', 'hourglass', true]);

    // 3. Hourglass removed
    expect(reactions[2]).toEqual(['msg-retry-1', 'hourglass', false]);

    // 4. Checkmark added
    expect(reactions[3]).toEqual(['msg-retry-1', 'white_check_mark', true]);

    expect(reactions).toHaveLength(4);
  });
});

describe('workflow: file attachment — MediaPath/MediaType populated', () => {
  it('populates MediaPath and MediaType for a single file upload', async () => {
    mockDispatch.mockImplementationOnce(async ({ ctx, dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: 'Got it!' });
    });

    const fileMsg = makeMsg('msg-file-1', 'sender-1', 'alice', 'here is a file', {
      file: { _id: 'file-abc', name: 'report.pdf', type: 'application/pdf' },
      attachments: [{ type: 'file', title: 'report.pdf', title_link: '/file-upload/file-abc/report.pdf' }],
    });

    await runMonitor({}, {
      historyResponse: { messages: [fileMsg] },
    });

    // downloadFile should have been called
    expect(downloadFile).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://chat.example.com' }),
      '/file-upload/file-abc/report.pdf',
      expect.stringContaining('report.pdf'),
    );

    // Verify context has MediaPath and MediaType
    const ctx = mockDispatch.mock.calls[0][0].ctx;
    expect(ctx.MediaPath).toEqual(expect.stringContaining('report.pdf'));
    expect(ctx.MediaType).toBe('application/pdf');
    expect(ctx.MediaPaths).toBeUndefined();
  });

  it('skips attachments without msg.file (URL previews/unfurls)', async () => {
    mockDispatch.mockImplementationOnce(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: 'response' });
    });

    // URL unfurl — has attachments but no msg.file
    const unfurlMsg = makeMsg('msg-unfurl-1', 'sender-1', 'alice', 'https://example.com', {
      attachments: [{ type: 'image', image_url: 'https://example.com/preview.png' }],
    });

    await runMonitor({}, {
      historyResponse: { messages: [unfurlMsg] },
    });

    expect(downloadFile).not.toHaveBeenCalled();

    const ctx = mockDispatch.mock.calls[0][0].ctx;
    expect(ctx.MediaPath).toBeUndefined();
    expect(ctx.MediaPaths).toBeUndefined();
  });

  it('logs warning and continues when download fails', async () => {
    downloadFile.mockRejectedValueOnce(new Error('404 Not Found'));

    mockDispatch.mockImplementationOnce(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: 'Got it anyway!' });
    });

    const fileMsg = makeMsg('msg-file-fail', 'sender-1', 'alice', 'broken file', {
      file: { _id: 'file-xyz', name: 'missing.pdf', type: 'application/pdf' },
      attachments: [{ type: 'file', title: 'missing.pdf', title_link: '/file-upload/file-xyz/missing.pdf' }],
    });

    await runMonitor({}, {
      historyResponse: { messages: [fileMsg] },
    });

    // Download was attempted
    expect(downloadFile).toHaveBeenCalled();

    // Warning logged about failure
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Attachment download failed'));

    // Message still processed as text-only (no media context)
    const ctx = mockDispatch.mock.calls[0][0].ctx;
    expect(ctx.MediaPath).toBeUndefined();
    expect(ctx.Body).toBe('broken file');

    // Still marked complete
    const reactions = reactionCalls();
    expect(reactions[reactions.length - 1]).toEqual(['msg-file-fail', 'white_check_mark', true]);
  });
});
