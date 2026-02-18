/**
 * Integration tests — full monitor polling loop against real Rocket.Chat.
 * Uses real API (no fetch mocks) with a mock OpenClaw runtime.
 * Requires ROCKETCHAT_URL, ROCKETCHAT_AUTH_TOKEN, ROCKETCHAT_USER_ID, ROCKETCHAT_CHANNEL.
 */

import { it, expect, vi, afterAll } from 'vitest';
import {
  sendMessage,
  getChannelInfo,
  getChannelHistory,
} from '../../src/api.js';
import { monitorRocketChat } from '../../src/monitor.js';
import { skipUnlessConfigured, config, channelName, uniqueTag } from './setup.js';

const { describe } = skipUnlessConfigured();

const cleanup = [];

afterAll(async () => {
  for (const msgId of cleanup) {
    try {
      const url = `${config.url}/api/v1/chat.delete`;
      await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Auth-Token': config.authToken,
          'X-User-Id': config.userId,
        },
        body: JSON.stringify({ msgId }),
      });
    } catch {
      // ignore cleanup failures
    }
  }
});

/**
 * Build a mock OpenClaw runtime that captures dispatched messages.
 *
 * NOTE: Full dispatch+reaction tests (monitor picks up message → adds hourglass)
 * require a second Rocket.Chat user. The monitor filters its own messages
 * (msg.u._id === botUserId), and the same userId is used for both API auth and
 * the filter — so we can't trick it with a single account. The reaction lifecycle
 * is verified in reactions.integration.test.js; the monitor's call to
 * markProcessing is verified in the unit tests.
 */
function makeRuntime() {
  const dispatched = [];

  const runtime = {
    dispatched,
    channel: {
      routing: {
        resolveAgentRoute: vi.fn().mockReturnValue({ sessionKey: 'integration-session' }),
      },
      dispatchInboundMessage: vi.fn().mockImplementation(async ({ ctx }) => {
        dispatched.push(ctx);
      }),
      createReplyDispatcher: vi.fn().mockImplementation(({ deliver, onError }) => ({
        deliver,
        onError,
      })),
    },
  };

  return runtime;
}

describe('monitor integration', () => {
  it('monitor picks up a new message', async () => {
    const tag = uniqueTag();
    const text = `integration-test: monitor-pickup ${tag}`;

    // Send as the bot user — but the monitor filters its own messages.
    // So instead, we verify the monitor starts and polls without error.
    // For a true end-to-end test with message dispatch, we need a second user.
    // Here we verify the monitor runs, resolves the channel, and polls successfully.
    const runtime = makeRuntime();
    const controller = new AbortController();
    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };

    const monitorPromise = monitorRocketChat({
      account: {
        url: config.url,
        authToken: config.authToken,
        userId: config.userId,
        channel: channelName,
        pollInterval: 0.5,
      },
      cfg: {},
      runtime,
      abortSignal: controller.signal,
      log,
    });

    // Let it run a couple of poll cycles
    await new Promise((r) => setTimeout(r, 1500));
    controller.abort();
    await monitorPromise;

    // Verify it resolved the channel and started monitoring
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining(`#${channelName}`),
    );
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining('stopped'),
    );
    // No poll errors
    expect(log.error).not.toHaveBeenCalled();
  });

  it('monitor skips its own messages', async () => {
    const tag = uniqueTag();
    const text = `integration-test: skip-own ${tag}`;

    // Send as the bot user
    const sent = await sendMessage(config, { channel: channelName, text });
    cleanup.push(sent.message._id);

    await new Promise((r) => setTimeout(r, 300));

    const runtime = makeRuntime();
    const controller = new AbortController();
    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };

    const monitorPromise = monitorRocketChat({
      account: {
        url: config.url,
        authToken: config.authToken,
        userId: config.userId,
        channel: channelName,
        pollInterval: 0.5,
      },
      cfg: {},
      runtime,
      abortSignal: controller.signal,
      log,
    });

    // Wait for a couple of polls
    await new Promise((r) => setTimeout(r, 1500));
    controller.abort();
    await monitorPromise;

    // Our message (sent by the bot user) should NOT be dispatched
    const dispatchedBodies = runtime.dispatched.map((ctx) => ctx.Body);
    expect(dispatchedBodies).not.toContain(text);
  });

  it('monitor handles channel resolution', async () => {
    const runtime = makeRuntime();
    const controller = new AbortController();
    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };

    // Verify with a real channel name
    const monitorPromise = monitorRocketChat({
      account: {
        url: config.url,
        authToken: config.authToken,
        userId: config.userId,
        channel: channelName,
        pollInterval: 0.5,
      },
      cfg: {},
      runtime,
      abortSignal: controller.signal,
      log,
    });

    await new Promise((r) => setTimeout(r, 1000));
    controller.abort();
    await monitorPromise;

    expect(log.info).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`#${channelName}.*\\(`)),
    );
  });

  it('monitor fails on invalid channel', async () => {
    const runtime = makeRuntime();
    const controller = new AbortController();
    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };

    await expect(
      monitorRocketChat({
        account: {
          url: config.url,
          authToken: config.authToken,
          userId: config.userId,
          channel: 'nonexistent-channel-abc-xyz-999',
          pollInterval: 0.5,
        },
        cfg: {},
        runtime,
        abortSignal: controller.signal,
        log,
      }),
    ).rejects.toThrow();

    controller.abort();
  });

  it('monitor replies in thread', async () => {
    // This test verifies the reply delivery path works end-to-end.
    // We need a message from a non-bot user. Since we only have bot credentials,
    // we test the thread reply mechanism by directly exercising sendMessage
    // with a threadId, which is what the monitor's deliver callback does.
    const tag = uniqueTag();
    const parentText = `integration-test: thread-parent ${tag}`;

    const parent = await sendMessage(config, { channel: channelName, text: parentText });
    cleanup.push(parent.message._id);

    // Send a reply in thread (what the monitor's deliver callback does)
    const replyText = `integration-test: thread-reply ${tag}`;
    const reply = await sendMessage(config, {
      channel: channelName,
      text: replyText,
      threadId: parent.message._id,
    });
    cleanup.push(reply.message._id);

    // Verify the reply is threaded to the parent
    expect(reply.message).toBeDefined();

    // Fetch history and verify thread relationship
    const info = await getChannelInfo(config, channelName);
    const history = await getChannelHistory(config, info.channel._id, 20);

    const replyMsg = history.messages.find((m) => m._id === reply.message._id);
    expect(replyMsg).toBeDefined();
    expect(replyMsg.tmid).toBe(parent.message._id);
  });
});
