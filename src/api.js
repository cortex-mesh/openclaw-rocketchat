/**
 * Rocket.Chat REST API client.
 * Stateless — all functions take a config object with { url, authToken, userId }.
 * Uses Node 22 built-in fetch (no external HTTP dependencies).
 */

function headers(config) {
  return {
    'Content-Type': 'application/json',
    'X-Auth-Token': config.authToken,
    'X-User-Id': config.userId,
  };
}

async function request(config, method, path, body) {
  const url = `${config.url}${path}`;
  const opts = { method, headers: headers(config) };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Rocket.Chat API ${method} ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

export async function getMe(config) {
  return request(config, 'GET', '/api/v1/me');
}

export async function getChannelInfo(config, channelName) {
  return request(config, 'GET', `/api/v1/channels.info?roomName=${encodeURIComponent(channelName)}`);
}

export async function getChannelHistory(config, roomId, count = 20) {
  return request(config, 'GET', `/api/v1/channels.history?roomId=${encodeURIComponent(roomId)}&count=${count}`);
}

export async function getThreadMessages(config, threadId, { count = 50, offset = 0 } = {}) {
  return request(config, 'GET',
    `/api/v1/chat.getThreadMessages?tmid=${encodeURIComponent(threadId)}&count=${count}&offset=${offset}`);
}

export async function sendMessage(config, { roomId, text, threadId }) {
  const body = { roomId, text };
  if (threadId) body.tmid = threadId;
  return request(config, 'POST', '/api/v1/chat.postMessage', body);
}

export async function reactToMessage(config, messageId, emoji, shouldReact) {
  return request(config, 'POST', '/api/v1/chat.react', {
    messageId,
    emoji,
    shouldReact,
  });
}

export async function downloadFile(config, fileUrl, destPath) {
  const { writeFile } = await import('node:fs/promises');
  const url = `${config.url}${fileUrl}`;
  const res = await fetch(url, {
    headers: {
      'X-Auth-Token': config.authToken,
      'X-User-Id': config.userId,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`File download GET ${fileUrl} failed (${res.status}): ${text}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  await writeFile(destPath, buffer);
}

export async function probe(config) {
  try {
    const data = await getMe(config);
    return { ok: true, username: data.username, userId: data._id };
  } catch {
    return { ok: false, username: null, userId: null };
  }
}
