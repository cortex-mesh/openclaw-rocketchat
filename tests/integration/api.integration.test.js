/**
 * Integration tests — real Rocket.Chat API smoke tests.
 * Requires ROCKETCHAT_URL, ROCKETCHAT_AUTH_TOKEN, ROCKETCHAT_USER_ID, ROCKETCHAT_CHANNEL.
 */

import { it, expect, afterAll } from 'vitest';
import {
  probe,
  getMe,
  getChannelInfo,
  sendMessage,
  getChannelHistory,
  reactToMessage,
} from '../../src/api.js';
import { skipUnlessConfigured, config, channelName, uniqueTag } from './setup.js';

const { describe } = skipUnlessConfigured();

/** Message IDs to clean up after all tests. */
const cleanup = [];

afterAll(async () => {
  // Best-effort cleanup — delete test messages if API supports it
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

describe('api integration', () => {
  it('probe returns ok', async () => {
    const result = await probe(config);
    expect(result.ok).toBe(true);
    expect(result.username).toBeTruthy();
    expect(result.userId).toBeTruthy();
  });

  it('getMe returns user info', async () => {
    const me = await getMe(config);
    expect(me._id).toBeTruthy();
    expect(me.username).toBeTruthy();
  });

  it('getChannelInfo resolves channel', async () => {
    const info = await getChannelInfo(config, channelName);
    expect(info.channel._id).toBeTruthy();
    expect(info.channel.name).toBe(channelName);
  });

  it('send and retrieve message', async () => {
    const tag = uniqueTag();
    const text = `integration-test: send-retrieve ${tag}`;

    const sent = await sendMessage(config, { channel: channelName, text });
    expect(sent.message._id).toBeTruthy();
    cleanup.push(sent.message._id);

    // Retrieve recent history and find our message
    const info = await getChannelInfo(config, channelName);
    const history = await getChannelHistory(config, info.channel._id, 10);
    const found = history.messages.find((m) => m._id === sent.message._id);

    expect(found).toBeDefined();
    expect(found.msg).toBe(text);
  });

  it('react and unreact', async () => {
    const tag = uniqueTag();
    const sent = await sendMessage(config, {
      channel: channelName,
      text: `integration-test: reactions ${tag}`,
    });
    cleanup.push(sent.message._id);

    // Add hourglass
    await reactToMessage(config, sent.message._id, 'hourglass', true);

    // Remove hourglass
    await reactToMessage(config, sent.message._id, 'hourglass', false);

    // Add checkmark
    await reactToMessage(config, sent.message._id, 'white_check_mark', true);

    // Verify final state — checkmark present, no hourglass
    const info = await getChannelInfo(config, channelName);
    const history = await getChannelHistory(config, info.channel._id, 10);
    const msg = history.messages.find((m) => m._id === sent.message._id);

    expect(msg).toBeDefined();
    const reactionKeys = Object.keys(msg.reactions || {});
    expect(reactionKeys).toContain(':white_check_mark:');
    expect(reactionKeys).not.toContain(':hourglass:');
  });

  it('invalid credentials fail gracefully', async () => {
    const badConfig = { ...config, authToken: 'totally-invalid-token-abc123' };
    const result = await probe(badConfig);
    expect(result.ok).toBe(false);
  });
});
