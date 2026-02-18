/**
 * Rocket.Chat ChannelPlugin definition for OpenClaw.
 */

import { sendMessage, getChannelInfo, probe } from './api.js';
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
    listAccountIds(cfg) {
      const rc = cfg?.channels?.rocketchat;
      if (!rc) return [];
      // Single-account shorthand (url directly on the object)
      if (rc.url) return ['default'];
      // Multi-account (accounts sub-object)
      if (rc.accounts) return Object.keys(rc.accounts);
      return [];
    },

    resolveAccount(cfg, accountId) {
      const rc = cfg?.channels?.rocketchat;
      if (!rc) return null;
      // Single-account shorthand
      if (rc.url) {
        return accountId === 'default' ? { accountId: 'default', ...rc } : null;
      }
      // Multi-account
      const acct = rc.accounts?.[accountId];
      return acct ? { accountId, ...acct } : null;
    },

    isConfigured(account) {
      return !!(account?.url && account?.authToken && account?.userId);
    },

    describeAccount(account) {
      return {
        accountId: account?.accountId ?? 'default',
        name: account?.channel ?? 'Rocket.Chat',
        enabled: account?.enabled !== false,
        configured: !!(account?.url && account?.authToken && account?.userId),
      };
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
      const info = await getChannelInfo(config, ctx.account.channel);
      await sendMessage(config, {
        roomId: info.channel._id,
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
