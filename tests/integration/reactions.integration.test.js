/**
 * Integration tests — reaction lifecycle against real Rocket.Chat.
 * Requires ROCKETCHAT_URL, ROCKETCHAT_AUTH_TOKEN, ROCKETCHAT_USER_ID, ROCKETCHAT_CHANNEL.
 */

import { it, expect, afterAll } from 'vitest';
import { sendMessage, getChannelInfo, getChannelHistory } from '../../src/api.js';
import { markProcessing, markComplete, markFailed } from '../../src/reactions.js';
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

/** Fetch reactions for a specific message from channel history. */
async function getReactions(messageId) {
  const info = await getChannelInfo(config, channelName);
  const history = await getChannelHistory(config, info.channel._id, 10);
  const msg = history.messages.find((m) => m._id === messageId);
  return msg?.reactions || {};
}

describe('reactions integration', () => {
  it('markProcessing adds hourglass', async () => {
    const tag = uniqueTag();
    const sent = await sendMessage(config, {
      channel: channelName,
      text: `integration-test: markProcessing ${tag}`,
    });
    cleanup.push(sent.message._id);

    await markProcessing(config, sent.message._id);

    const reactions = await getReactions(sent.message._id);
    expect(Object.keys(reactions)).toContain(':hourglass:');
  });

  it('markComplete swaps hourglass for checkmark', async () => {
    const tag = uniqueTag();
    const sent = await sendMessage(config, {
      channel: channelName,
      text: `integration-test: markComplete ${tag}`,
    });
    cleanup.push(sent.message._id);

    // Start with hourglass
    await markProcessing(config, sent.message._id);

    // Complete — should remove hourglass, add checkmark
    await markComplete(config, sent.message._id);

    const reactions = await getReactions(sent.message._id);
    expect(Object.keys(reactions)).toContain(':white_check_mark:');
    expect(Object.keys(reactions)).not.toContain(':hourglass:');
  });

  it('markFailed swaps hourglass for x', async () => {
    const tag = uniqueTag();
    const sent = await sendMessage(config, {
      channel: channelName,
      text: `integration-test: markFailed ${tag}`,
    });
    cleanup.push(sent.message._id);

    // Start with hourglass
    await markProcessing(config, sent.message._id);

    // Fail — should remove hourglass, add x
    await markFailed(config, sent.message._id);

    const reactions = await getReactions(sent.message._id);
    expect(Object.keys(reactions)).toContain(':x:');
    expect(Object.keys(reactions)).not.toContain(':hourglass:');
  });
});
