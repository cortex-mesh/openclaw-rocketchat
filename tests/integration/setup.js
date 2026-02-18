/**
 * Shared config loader and skip logic for integration tests.
 * Tests require these env vars (skip if any missing):
 *   ROCKETCHAT_URL, ROCKETCHAT_AUTH_TOKEN, ROCKETCHAT_USER_ID, ROCKETCHAT_CHANNEL
 */

import { describe as vitestDescribe } from 'vitest';

const REQUIRED_VARS = [
  'ROCKETCHAT_URL',
  'ROCKETCHAT_AUTH_TOKEN',
  'ROCKETCHAT_USER_ID',
  'ROCKETCHAT_CHANNEL',
];

const missing = REQUIRED_VARS.filter((v) => !process.env[v]);

export const isConfigured = missing.length === 0;

export const config = isConfigured
  ? {
      url: process.env.ROCKETCHAT_URL,
      authToken: process.env.ROCKETCHAT_AUTH_TOKEN,
      userId: process.env.ROCKETCHAT_USER_ID,
    }
  : {};

export const channelName = process.env.ROCKETCHAT_CHANNEL || '';

/**
 * Call at the top of each describe block:
 *   const { describe: d } = skipUnlessConfigured();
 *   d('suite name', () => { ... });
 *
 * Returns describe (runs tests) or describe.skip (skips cleanly).
 */
export function skipUnlessConfigured() {
  if (!isConfigured) {
    console.log(
      `Skipping integration tests — missing env vars: ${missing.join(', ')}`,
    );
  }
  return { describe: isConfigured ? vitestDescribe : vitestDescribe.skip };
}

/** Generate a unique tag for test messages to avoid collisions. */
export function uniqueTag() {
  return `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
