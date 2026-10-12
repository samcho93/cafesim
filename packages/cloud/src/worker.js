/**
 * cafeSim on Cloudflare.
 *
 *   https://<worker>/                 3D viewer (static assets), mirrors room "main"
 *   https://<worker>/?room=team-a     another room = another independent machine
 *   wss://<worker>/ws?room=..         bridge protocol (viewer, `cafesim relay`, SDK)
 *   https://<worker>/api/state|info   GET     /api/interact  POST
 *   https://<worker>/kscat?REQ=..&callback=..   KSCAT agent emulator (JSONP)
 *
 * Each room is a Durable Object holding one running Platform. It keeps simulating while
 * someone is connected and pauses after IDLE_MS without clients.
 */
import { Platform, attachBridge, MailbeanBackend, isBackendPath, handleBackendHttp, subscribeNotifications, attachRemoteExecutor } from '@cafesim/core';
import m400 from '../../../platforms/m400/platform.js';

const PLATFORMS = { [m400.id]: m400 };
const IDLE_MS = 5 * 60 * 1000;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' } });

export class SimRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.platform = null;
    this.clients = new Set();
    this.idleTimer = null;
    this.lastUse = Date.now();
  }

  ensure(url) {
    if (!this.platform) {
      const def = PLATFORMS[url.searchParams.get('platform') ?? 'm400'] ?? m400;
      this.platform = new Platform(def);
      this.room = url.searchParams.get('room') ?? 'main';
    }
    if (!this.running) {
      this.platform.start();
      this.running = true;
    }
    this.lastUse = Date.now();
    this.#scheduleIdle();
    return this.platform;
  }

  #scheduleIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.clients.size === 0 && Date.now() - this.lastUse >= IDLE_MS) {
        this.platform?.stop();
        this.running = false;
      } else this.#scheduleIdle();
    }, IDLE_MS);
  }

  info() {
    return { cloud: true, room: this.room, platform: this.platform.definition.id, clients: this.clients.size, devices: this.platform.definition.devices.map(({ key, type, port }) => ({ key, type, port })) };
  }

  async backendFor() {
    if (!this.backend) {
      const saved = await this.state.storage.get('backend');
      this.backend = new MailbeanBackend({ state: saved ?? undefined, save: (st) => this.state.storage.put('backend', st) });
      if (!saved) await this.state.storage.put('backend', this.backend.state);
      this.executor = attachRemoteExecutor(this.platform, this.backend);
    }
    return this.backend;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const platform = this.ensure(url);

    if (url.pathname.startsWith('/notifications/')) {
      const backend = await this.backendFor();
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const enc = new TextEncoder();
      let off = () => {};
      const write = (chunk) => writer.write(enc.encode(chunk)).catch(() => off());
      off = subscribeNotifications(backend, write);
      writer.closed.catch(() => off());
      return new Response(readable, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'access-control-allow-origin': '*' } });
    }
    if (isBackendPath(url.pathname)) {
      const backend = await this.backendFor();
      const r = await handleBackendHttp(backend, { method: request.method, pathname: url.pathname, query: Object.fromEntries(url.searchParams), bodyText: request.method === 'GET' ? '' : await request.text(), contentType: request.headers.get('content-type') ?? '' });
      return new Response(r.status === 204 ? null : r.body, { status: r.status, headers: r.headers });
    }

    if (url.pathname === '/ws') {
      if (request.headers.get('upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
      const [client, server] = Object.values(new WebSocketPair());
      server.accept();
      this.clients.add(server);
      const bridge = attachBridge(platform, (m) => {
        try {
          server.send(JSON.stringify(m));
        } catch {}
      }, this.info());
      const close = () => {
        bridge.close();
        this.clients.delete(server);
        this.lastUse = Date.now();
      };
      server.addEventListener('message', (e) => {
        this.lastUse = Date.now();
        try {
          bridge.receive(JSON.parse(e.data));
        } catch {}
      });
      server.addEventListener('close', close);
      server.addEventListener('error', close);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === '/api/info') return json(this.info());
    if (url.pathname === '/api/state') return json(platform.snapshot());
    if (url.pathname === '/api/interact') {
      if (request.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);
      try {
        return json({ ok: true, result: platform.interact(await request.json()) ?? null });
      } catch (e) {
        return json({ ok: false, error: e.message }, 400);
      }
    }
    if (url.pathname === '/kscat') {
      const form = request.method === 'POST' ? new URLSearchParams(await request.text()) : new URLSearchParams();
      const telegram = url.searchParams.get('REQ') ?? form.get('REQ') ?? '';
      const cb = url.searchParams.get('callback') ?? form.get('callback');
      const pay = platform.definition.devices.find((d) => d.type === 'kscat-terminal');
      const res = await platform.device(pay.key).request(telegram);
      if (cb) return new Response(`${cb.replace(/[^\w$.]/g, '')}(${JSON.stringify(res)});`, { headers: { 'content-type': 'application/javascript; charset=utf-8', 'access-control-allow-origin': '*' } });
      return json(res);
    }
    return new Response('Not found', { status: 404 });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' } });
    if (url.pathname === '/ws' || url.pathname.startsWith('/api/') || url.pathname === '/kscat' || isBackendPath(url.pathname)) {
      const room = (url.searchParams.get('room') ?? 'main').slice(0, 64);
      const stub = env.SIM.get(env.SIM.idFromName(room));
      return stub.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
