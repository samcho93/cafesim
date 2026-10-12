import net from 'node:net';
import http from 'node:http';
import { WebSocket } from 'ws';
import { Emitter } from '@cafesim/core';

/**
 * Node client for the bridge protocol (cloud room on Cloudflare, or another `cafesim start`).
 *   const link = await connectRemote('wss://cafesim.<you>.workers.dev/ws?room=main');
 */
export async function connectRemote(url) {
  const link = new Emitter();
  const ws = new WebSocket(url);
  const pending = new Map();
  const rx = new Map();
  let seq = 0;

  await new Promise((resolve, reject) => {
    ws.once('error', reject);
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.t === 'hello') {
        Object.assign(link, { info: m.info, platformId: m.platform, snapshot: m.snapshot });
        resolve();
      } else if (m.t === 'snap') {
        link.snapshot = m.s;
        link.emit('snap', m.s);
      } else if (m.t === 'rx') rx.get(m.conn)?.forEach((fn) => fn(Buffer.from(m.bytes)));
      else if (m.t === 'log' || m.t === 'event' || m.t === 'traffic') link.emit(m.t, m.e);
      else if (m.t === 'ack' || m.t === 'payres' || m.t === 'error') {
        const p = pending.get(m.id);
        pending.delete(m.id);
        if (m.t === 'error') p?.reject(new Error(m.error));
        else p?.resolve(m.t === 'ack' ? m.result : m.res);
      }
    });
  });
  ws.on('close', () => link.emit('close'));
  // keep the connection (and the Durable Object) alive behind proxies
  const keepAlive = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ t: 'ping', id: 0 })), 25000);

  const send = (m) => ws.readyState === 1 && ws.send(JSON.stringify(m));
  const call = (m) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      send({ ...m, id });
    });

  link.interact = (action) => call({ t: 'interact', action });
  link.pay = (device, req) => call({ t: 'pay', device, req });
  link.lock = async (label) => {
    const lock = await call({ t: 'lock', label });
    return () => send({ t: 'unlock', lock });
  };
  link.openTransport = (device, name = 'node') => {
    const conn = `${name}-${process.pid}-${++seq}`;
    const listeners = new Set();
    rx.set(conn, listeners);
    send({ t: 'open', device, conn });
    return {
      write: (bytes) => send({ t: 'tx', conn, bytes: [...bytes] }),
      onData: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
      close: () => {
        send({ t: 'close', conn });
        rx.delete(conn);
      },
    };
  };
  link.close = () => {
    clearInterval(keepAlive);
    ws.close();
  };
  return link;
}

/**
 * Re-expose a remote (cloud) simulator on this PC exactly like `cafesim start` does:
 * TCP 7001-7003 per serial device and the KSCAT agent on 27098, so the original kiosk app
 * (through the serialport shim / com0com) can drive a machine that runs in the cloud.
 */
export async function startRelay(url, { tcpOffset = 0, kscat = 27098, log = (...a) => console.log('[cafesim relay]', ...a) } = {}) {
  const link = await connectRemote(url);
  const closers = [];
  log(`connected: ${url}  (platform ${link.platformId}${link.info?.room ? `, room ${link.info.room}` : ''})`);
  for (const d of link.info.devices ?? []) {
    if (d.port?.tcp) {
      const port = d.port.tcp + tcpOffset;
      const srv = net.createServer((socket) => {
        socket.setNoDelay(true);
        const t = link.openTransport(d.key, `relay-${d.key}`);
        t.onData((b) => socket.write(b));
        socket.on('data', (b) => t.write(b));
        socket.on('close', () => t.close());
        socket.on('error', () => t.close());
      });
      await new Promise((resolve, reject) => srv.once('error', reject).listen(port, '127.0.0.1', resolve));
      closers.push(() => srv.close());
      log(`device ${d.key.padEnd(5)} 127.0.0.1:${port}  ->  cloud`);
    }
    if (d.type === 'kscat-terminal' && kscat) {
      const srv = http.createServer(async (req, res) => {
        const u = new URL(req.url, 'http://x');
        let body = '';
        for await (const c of req) body += c;
        const form = new URLSearchParams(body);
        const cb = u.searchParams.get('callback') ?? form.get('callback');
        try {
          const r = await link.pay(d.key, u.searchParams.get('REQ') ?? form.get('REQ') ?? '');
          res.setHeader('access-control-allow-origin', '*');
          if (cb) {
            res.setHeader('content-type', 'application/javascript; charset=utf-8');
            res.end(`${cb.replace(/[^\w$.]/g, '')}(${JSON.stringify(r)});`);
          } else {
            res.setHeader('content-type', 'application/json; charset=utf-8');
            res.end(JSON.stringify(r));
          }
        } catch (e) {
          res.statusCode = 502;
          res.end(e.message);
        }
      });
      await new Promise((resolve, reject) => srv.once('error', reject).listen(kscat, '127.0.0.1', resolve));
      closers.push(() => srv.close());
      log(`KSCAT        http://127.0.0.1:${kscat}  ->  cloud`);
    }
  }
  link.on('close', () => log('disconnected from cloud'));
  return {
    link,
    close() {
      closers.forEach((c) => c());
      link.close();
    },
  };
}
