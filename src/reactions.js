/**
 * Reaction lifecycle management.
 * Wraps api.reactToMessage() with the hourglass/check/x pattern.
 * All operations are best-effort — errors are caught and logged, never thrown.
 */

import { reactToMessage } from './api.js';

export async function markProcessing(config, messageId, log) {
  try {
    await reactToMessage(config, messageId, 'hourglass', true);
  } catch (err) {
    log?.warn?.(`Failed to add hourglass reaction to ${messageId}: ${err.message}`);
  }
}

export async function markComplete(config, messageId, log) {
  try {
    await reactToMessage(config, messageId, 'hourglass', false);
  } catch (err) {
    log?.warn?.(`Failed to remove hourglass from ${messageId}: ${err.message}`);
  }
  try {
    await reactToMessage(config, messageId, 'white_check_mark', true);
  } catch (err) {
    log?.warn?.(`Failed to add checkmark to ${messageId}: ${err.message}`);
  }
}

export async function markFailed(config, messageId, log) {
  try {
    await reactToMessage(config, messageId, 'hourglass', false);
  } catch (err) {
    log?.warn?.(`Failed to remove hourglass from ${messageId}: ${err.message}`);
  }
  try {
    await reactToMessage(config, messageId, 'x', true);
  } catch (err) {
    log?.warn?.(`Failed to add x reaction to ${messageId}: ${err.message}`);
  }
}
