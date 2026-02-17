/**
 * Rocket.Chat ChannelPlugin definition for OpenClaw.
 */

import { sendMessage, probe } from './api.js';
import { monitorRocketChat } from './monitor.js';

export const rocketchatPlugin = {
  id: 'rocketchat',

  meta: {
    label: 'Rocket.Chat',
    blurb: 'Connect to Rocket.Chat channels and respond to messages',
    docsPath: 'channels/rocketchat',
  },

  capabilities: {
    chatTypes: ['group', 'channel'],
    reactions: true,
    threads: true,
  },

  config: {
    listAccounts(cfg) {
      const rc = cfg?.channels?.rocketchat;
      if (!rc) return [];
      // Support single-account shorthand (url directly on the object)
      if (rc.url) {
        return [{ accountId: 'default', ...rc }];
      }
      // Support multi-account (accounts sub-object)
      if (rc.accounts) {
        return Object.entries(rc.accounts).map(([id, acct]) => ({
          accountId: id,
          ...acct,
        }));
      }
      return [];
    },

    resolveAccount(cfg, accountId) {
      const accounts = rocketchatPlugin.config.listAccounts(cfg);
      return accounts.find((a) => a.accountId === accountId) || null;
    },
  },

  gateway: {
    startAccount(ctx) {
      const account = rocketchatPlugin.config.resolveAccount(ctx.cfg, ctx.accountId);
      if (!account) {
        ctx.log?.error?.(`No Rocket.Chat account found for id: ${ctx.accountId}`);
        return;
      }
      monitorRocketChat({
        account,
        cfg: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        log: ctx.log,
      });
    },
  },

  outbound: {
    deliveryMode: 'direct',
    textChunkLimit: 4000,

    async sendText(ctx) {
      const config = {
        url: ctx.account.url,
        authToken: ctx.account.authToken,
        userId: ctx.account.userId,
      };
      await sendMessage(config, {
        channel: ctx.account.channel,
        text: ctx.text,
        threadId: ctx.threadId || null,
      });
    },
  },

  status: {
    async probe(ctx) {
      const config = {
        url: ctx.account.url,
        authToken: ctx.account.authToken,
        userId: ctx.account.userId,
      };
      const result = await probe(config);
      return {
        ok: result.ok,
        detail: result.ok
          ? `Connected as ${result.username}`
          : 'Failed to connect to Rocket.Chat',
      };
    },
  },
};
