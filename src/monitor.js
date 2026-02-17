/**
 * Inbound polling loop for Rocket.Chat messages.
 * Polls channel history and dispatches new messages to the agent system.
 */

import { getChannelInfo, getChannelHistory, sendMessage } from './api.js';
import { markProcessing, markComplete, markFailed } from './reactions.js';

export const MAX_PROCESSED_IDS = 500;

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export async function monitorRocketChat({ account, cfg, runtime, abortSignal, log }) {
  const config = {
    url: account.url,
    authToken: account.authToken,
    userId: account.userId,
  };
  const channelName = account.channel;
  const botUserId = account.userId;
  const pollInterval = (account.pollInterval || 2) * 1000;

  // Resolve channel -> roomId once at startup
  let roomId;
  try {
    const info = await getChannelInfo(config, channelName);
    roomId = info.channel._id;
    log?.info?.(`Monitoring Rocket.Chat channel #${channelName} (${roomId})`);
  } catch (err) {
    log?.error?.(`Failed to resolve channel #${channelName}: ${err.message}`);
    throw err;
  }

  const processedIds = new Set();

  while (!abortSignal?.aborted) {
    try {
      const history = await getChannelHistory(config, roomId, 20);
      const messages = (history.messages || []).slice().reverse(); // oldest-first

      for (const msg of messages) {
        if (abortSignal?.aborted) break;
        if (processedIds.has(msg._id)) continue;
        if (msg.u?._id === botUserId) continue;
        if (msg.t) continue; // system message
        if (msg.bot) continue;

        processedIds.add(msg._id);

        // Cap processed IDs set size
        if (processedIds.size > MAX_PROCESSED_IDS) {
          const iter = processedIds.values();
          const excess = processedIds.size - MAX_PROCESSED_IDS;
          for (let i = 0; i < excess; i++) {
            processedIds.delete(iter.next().value);
          }
        }

        const threadId = msg.tmid || null;
        const senderId = msg.u?._id || 'unknown';
        const senderUsername = msg.u?.username || 'unknown';
        const text = msg.msg || '';

        await markProcessing(config, msg._id, log);

        try {
          const route = runtime.channel.routing.resolveAgentRoute({
            cfg,
            channel: 'rocketchat',
            accountId: account.accountId || 'default',
            peer: { kind: 'user', id: senderId },
          });

          await runtime.channel.dispatchInboundMessage({
            ctx: {
              From: senderUsername,
              To: channelName,
              Body: text,
              SessionKey: route.sessionKey,
            },
            cfg,
            dispatcher: runtime.channel.createReplyDispatcher({
              deliver: async (payload) => {
                await sendMessage(config, {
                  channel: channelName,
                  text: payload.text,
                  threadId: threadId || msg._id,
                });
                await markComplete(config, msg._id, log);
              },
              onError: async (err) => {
                await markFailed(config, msg._id, log);
                log?.error?.(`Failed to process message ${msg._id}: ${err.message}`);
              },
            }),
          });
        } catch (err) {
          await markFailed(config, msg._id, log);
          log?.error?.(`Dispatch error for message ${msg._id}: ${err.message}`);
        }
      }
    } catch (err) {
      log?.error?.(`Poll error: ${err.message}`);
    }

    await sleep(pollInterval, abortSignal);
  }

  log?.info?.('Rocket.Chat monitor stopped');
}
