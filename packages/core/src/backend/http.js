import { MailbeanBackend } from './MailbeanBackend.js';

/** Paths served by the virtual Mailbean cloud (same URL layout as {webMode}.mailbean.kr). */
export const isBackendPath = (pathname) => /^\/(mailbean|media\/sim|cafesim-admin|receipt|alimtalk)(\/|$)/.test(pathname) || pathname.startsWith('/notifications/');

export const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS' };

export function parseBody(text, contentType = '') {
  if (!text) return null;
  if (contentType.includes('json')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  if (contentType.includes('x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text));
  try {
    return JSON.parse(text);
  } catch {
    return text; // multipart (upload_log) or plain text
  }
}

/** One REST request -> { status, headers, body (string) } */
export async function handleBackendHttp(backend, { method, pathname, query = {}, bodyText = '', contentType = '' }) {
  if (method === 'OPTIONS') return { status: 204, headers: CORS, body: '' };
  const r = await backend.handle(method, pathname, { query, body: parseBody(bodyText, contentType) });
  const type = r.type ?? 'application/json; charset=utf-8';
  return { status: r.status, headers: { ...CORS, 'content-type': type }, body: typeof r.body === 'string' ? r.body : JSON.stringify(r.body) };
}

/**
 * Server-sent events for /notifications/{mac}/ : calls write(chunk) for every remote command.
 * Returns an unsubscribe function.
 */
export function subscribeNotifications(backend, write) {
  write(`data: ${JSON.stringify({ message: 'connected' })}\n\n`);
  const off = backend.on('notify', (cmd) => write(MailbeanBackend.sseFrame(cmd)));
  const keepAlive = setInterval(() => write(': keep-alive\n\n'), 25000);
  return () => {
    off();
    clearInterval(keepAlive);
  };
}
