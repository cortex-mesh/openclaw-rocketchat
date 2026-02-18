/**
 * Inbound polling loop for Rocket.Chat messages.
 * Polls channel history and active threads, dispatches new messages to the agent system.
 */

import { getChannelInfo, getChannelHistory, getThreadMessages, sendMessage, downloadFile, reactToMessage } from './api.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { markProcessing, markComplete, markFailed } from './reactions.js';
import { getRuntime } from './runtime.js';

export const MAX_PROCESSED_IDS = 500;
const DEFAULT_THREAD_TTL_HOURS = 24;
const DEFAULT_THREAD_CONTEXT_BUDGET = 16000;

/**
 * Build InboundHistory from thread messages, applying a character budget.
 * Walks newest-first so the most recent (most relevant) messages get priority.
 */
export function buildInboundHistory(threadHistory, currentMsgId, budget) {
  const prior = threadHistory
    .filter(m => m._id !== currentMsgId)
    .reverse(); // newest-first for budget allocation

  const entries = [];
  let remaining = budget;

  for (const m of prior) {
    if (remaining <= 0) break;
    const sender = m.u?.username || 'unknown';
    const body = m.msg || '';
    const timestamp = new Date(m.ts).getTime();

    if (body.length <= remaining) {
      entries.push({ sender, body, timestamp });
      remaining -= body.length;
    } else {
      entries.push({ sender, body: body.slice(0, remaining) + '\u2026', timestamp });
      remaining = 0;
    }
  }

  return entries.reverse(); // back to chronological order
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

async function processMessage(config, msg, roomId, replyThreadId, { account, cfg, botUserId, channelName, log, processedIds, threadHistory }) {
  // Skip filters
  if (msg.u?._id === botUserId) return false;
  if (msg.t) return false; // system message
  if (msg.bot) return false;
  if (msg.reactions?.[':white_check_mark:']) return false;

  if (processedIds.has(msg._id)) return false;
  processedIds.add(msg._id);

  // Cap processed IDs set size
  if (processedIds.size > MAX_PROCESSED_IDS) {
    const iter = processedIds.values();
    const excess = processedIds.size - MAX_PROCESSED_IDS;
    for (let i = 0; i < excess; i++) {
      processedIds.delete(iter.next().value);
    }
  }

  const senderId = msg.u?._id || 'unknown';
  const senderUsername = msg.u?.username || 'unknown';
  const text = msg.msg || '';

  // Clear stale ❌ from a previous failed attempt (only if present —
  // Rocket.Chat's chat.react toggles, so removing a non-existent reaction adds it)
  if (msg.reactions?.[':x:']) {
    try {
      await reactToMessage(config, msg._id, 'x', false);
    } catch (err) {
      log?.warn?.(`Failed to remove stale x from ${msg._id}: ${err.message}`);
    }
  }

  await markProcessing(config, msg._id, log);

  let tempDir = null;
  try {
    const pluginRuntime = getRuntime();
    const accountId = account.accountId || 'default';

    const route = pluginRuntime.channel.routing.resolveAgentRoute({
      cfg,
      channel: 'rocketchat',
      accountId,
      peer: { kind: 'group', id: senderId },
    });

    const sessionKey = route.sessionKey;
    const from = `rocketchat:${senderId}`;
    const to = `channel:${channelName}`;

    const ctx = {
      Body: text,
      BodyForAgent: text,
      RawBody: text,
      CommandBody: text,
      From: from,
      To: to,
      SessionKey: sessionKey,
      AccountId: accountId,
      ChatType: 'group',
      SenderName: senderUsername,
      SenderId: senderId,
      SenderUsername: senderUsername,
      Provider: 'rocketchat',
      Surface: 'rocketchat',
      WasMentioned: true,
      CommandAuthorized: true,
      CommandSource: 'text',
      MessageSid: msg._id,
      Timestamp: new Date(msg.ts).getTime(),
      OriginatingChannel: 'rocketchat',
      OriginatingTo: to,
    };

    if (threadHistory?.length) {
      const budget = account.threadContextBudget ?? DEFAULT_THREAD_CONTEXT_BUDGET;
      ctx.InboundHistory = buildInboundHistory(threadHistory, msg._id, budget);
      ctx.ThreadStarterBody = threadHistory[0]?.msg || '';
      ctx.MessageThreadId = replyThreadId;
    }

    // Download file attachments to temp dir for media context
    if (msg.file && msg.attachments?.length) {
      try {
        tempDir = await mkdtemp(join(tmpdir(), 'rc-attach-'));
        const paths = [];
        const types = [];
        for (const att of msg.attachments) {
          if (att.type !== 'file' || !att.title_link) continue;
          const filename = att.title || msg.file.name || 'attachment';
          const destPath = join(tempDir, filename);
          try {
            await downloadFile(config, att.title_link, destPath);
            paths.push(destPath);
            types.push(msg.file.type || att.image_type || 'application/octet-stream');
          } catch (dlErr) {
            log?.warn?.(`Attachment download failed for ${att.title_link}: ${dlErr.message}`);
          }
        }
        if (paths.length === 1) {
          ctx.MediaPath = paths[0];
          ctx.MediaType = types[0];
        } else if (paths.length > 1) {
          ctx.MediaPaths = paths;
          ctx.MediaTypes = types;
        }
      } catch (err) {
        log?.warn?.(`Attachment processing failed for ${msg._id}: ${err.message}`);
      }
    }

    let delivered = false;
    let deliveryError = null;

    await pluginRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx,
      cfg,
      replyOptions: {},
      dispatcherOptions: {
        deliver: async (payload) => {
          await sendMessage(config, {
            roomId,
            text: payload.text,
            threadId: replyThreadId,
          });
          delivered = true;
        },
        onError: (err) => {
          deliveryError = err;
          log?.error?.(`Reply delivery failed for ${msg._id}: ${err.message}`);
        },
      },
    });

    if (delivered && !deliveryError) {
      await markComplete(config, msg._id, log);
    } else {
      await markFailed(config, msg._id, log);
      if (!deliveryError) {
        log?.warn?.(`No reply delivered for message ${msg._id}`);
      }
    }
  } catch (err) {
    await markFailed(config, msg._id, log);
    log?.error?.(`Dispatch error for message ${msg._id}: ${err.message}`);
  } finally {
    if (tempDir) {
      rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  return true;
}

export async function monitorRocketChat({ account, cfg, abortSignal, log }) {
  const config = {
    url: account.url,
    authToken: account.authToken,
    userId: account.userId,
  };
  const channelName = account.channel;
  const botUserId = account.userId;
  const pollInterval = (account.pollInterval || 2) * 1000;
  const threadTtlMs = ((account.threadTtlHours ?? DEFAULT_THREAD_TTL_HOURS) * 60 * 60 * 1000);

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
  // threadId -> { lastSeen: timestamp, offset: number of messages already seen }
  const activeThreads = new Map();

  while (!abortSignal?.aborted) {
    try {
      const history = await getChannelHistory(config, roomId, 20);
      const messages = (history.messages || []).slice().reverse(); // oldest-first

      for (const msg of messages) {
        if (abortSignal?.aborted) break;

        // Track thread parents before processedIds skip — must discover threads
        // even for already-processed parent messages
        if (!msg.tmid && msg.tcount > 0) {
          if (!activeThreads.has(msg._id)) {
            activeThreads.set(msg._id, { lastSeen: Date.now(), offset: 0 });
          } else {
            activeThreads.get(msg._id).lastSeen = Date.now();
          }
        }

        const replyThreadId = msg.tmid || msg._id;

        // Fetch thread context for messages that are thread replies
        let threadHistory;
        if (msg.tmid) {
          try {
            const threadData = await getThreadMessages(config, msg.tmid, { count: 20 });
            threadHistory = threadData.messages || [];
          } catch (err) {
            log?.error?.(`Thread context fetch error for ${msg.tmid}: ${err.message}`);
          }
        }

        await processMessage(config, msg, roomId, replyThreadId, {
          account, cfg, botUserId, channelName, log, processedIds, threadHistory,
        });
      }

      // Prune stale threads
      const now = Date.now();
      for (const [threadId, state] of activeThreads) {
        if (now - state.lastSeen > threadTtlMs) {
          activeThreads.delete(threadId);
        }
      }

      // Poll active threads for new replies (offset skips already-seen messages)
      for (const [threadId, state] of activeThreads) {
        if (abortSignal?.aborted) break;
        try {
          const threadData = await getThreadMessages(config, threadId, {
            count: 50,
            offset: state.offset,
          });
          const newReplies = threadData.messages || [];

          if (newReplies.length > 0) {
            // Fetch last N messages for context (one extra API call per active thread with new activity)
            const total = threadData.total ?? (state.offset + newReplies.length);
            const contextCount = 20;
            const contextOffset = Math.max(0, total - contextCount);
            const contextData = await getThreadMessages(config, threadId, {
              count: contextCount, offset: contextOffset,
            });
            const threadHistory = contextData.messages || [];

            for (const reply of newReplies) {
              if (abortSignal?.aborted) break;
              await processMessage(config, reply, roomId, threadId, {
                account, cfg, botUserId, channelName, log, processedIds, threadHistory,
              });
            }

            state.offset += newReplies.length;
            state.lastSeen = Date.now();
          }
        } catch (err) {
          log?.error?.(`Thread poll error for ${threadId}: ${err.message}`);
        }
      }
    } catch (err) {
      log?.error?.(`Poll error: ${err.message}`);
    }

    await sleep(pollInterval, abortSignal);
  }

  log?.info?.('Rocket.Chat monitor stopped');
}
