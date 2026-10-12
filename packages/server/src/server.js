import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { Platform, attachBridge, MailbeanBackend, isBackendPath, handleBackendHttp, subscribeNotifications, attachRemoteExecutor } from '@cafesim/core';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '../../..');

/** Load a platform definition by id (platforms/<id>/platform.js) or by file path. */
export async function loadPlatform(idOrPath = 'm400') {
  const file = /\.m?js$/.test(idOrPath) ? path.resolve(idOrPath) : path.join(repoRoot, 'platforms', idOrPath, 'platform.js');
  if (!fs.existsSync(file)) throw new Error(`Platform not found: ${file}`);
  const mod = await import(pathToFileURL(file).href + `?t=${Date.now()}`);
  return mod.default;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.mp3': 'audio/mpeg', '.woff2': 'font/woff2' };

/**
 * Start the virtual hardware service.
 *
 * @param {object} o
 * @param {string|object} o.platform   id, path or definition object
 * @param {number} o.port              HTTP + WebSocket (viewer, REST API)        default 8700
 * @param {boolean} o.tcp              expose each serial device on its TCP port  default true
 * @param {object} o.serial            { main: 'COM11', ... } attach devices to real/virtual COM ports (com0com)
 * @param {number|false} o.kscat       KSCAT HTTP emulator port                   default from platform (27098)
 * @param {string} o.staticDir         built viewer to serve                      default packages/viewer/dist
 */
export async function startServer(o = {}) {
  const definition = typeof o.platform === 'object' ? o.platform : await loadPlatform(o.platform ?? 'm400');
  const platform = new Platform(definition, { speed: o.speed ?? 1, autoAssist: o.autoAssist ?? false }).start();
  const log = o.log ?? ((...a) => console.log('[cafesim]', ...a));
  const closers = [];
  const info = { platform: definition.id, http: null, tcp: {}, serial: {}, kscat: null };

  // ---------------------------------------------------------------- virtual Mailbean cloud (menus, settings, payments, SSE)
  const dataFile = o.data === false ? null : path.resolve(o.data ?? path.join(repoRoot, '.cafesim-data', `backend-${definition.id}.json`));
  let saved = null;
  if (dataFile && fs.existsSync(dataFile)) {
    try {
      saved = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    } catch {}
  }
  const backend = new MailbeanBackend({
    state: saved ?? undefined,
    save: (state) => {
      if (!dataFile) return;
      fs.mkdirSync(path.dirname(dataFile), { recursive: true });
      fs.writeFileSync(dataFile, JSON.stringify(state, null, 1));
    },
  });
  if (!saved) backend.save(backend.state);
  const executor = attachRemoteExecutor(platform, backend);
  closers.push(() => executor.close());

  // ---------------------------------------------------------------- TCP ports per serial device
  if (o.tcp !== false) {
    for (const d of definition.devices) {
      if (!d.port?.tcp) continue;
      const tcpPort = (o.tcpPorts?.[d.key] ?? d.port.tcp) + (o.tcpOffset ?? 0);
      const srv = net.createServer((socket) => {
        socket.setNoDelay(true);
        const conn = platform.connect(d.key, `tcp:${socket.remotePort}`);
        conn.onData((b) => socket.write(Buffer.from(b)));
        socket.on('data', (b) => conn.write(b));
        socket.on('close', () => conn.close());
        socket.on('error', () => conn.close());
      });
      await new Promise((resolve, reject) => srv.once('error', reject).listen(tcpPort, '127.0.0.1', resolve));
      info.tcp[d.key] = tcpPort;
      closers.push(() => srv.close());
    }
  }

  // ---------------------------------------------------------------- COM ports (com0com / real null-modem)
  if (o.serial && Object.keys(o.serial).length) {
    let SerialPort;
    try {
      ({ SerialPort } = await import('serialport'));
    } catch {
      throw new Error('The optional "serialport" package is not installed: npm i serialport -w @cafesim/server');
    }
    for (const [key, comPath] of Object.entries(o.serial)) {
      const d = definition.devices.find((x) => x.key === key);
      if (!d) throw new Error(`No device "${key}" in platform ${definition.id}`);
      const port = new SerialPort({ path: comPath, baudRate: d.port?.baudRate ?? 9600, dataBits: 8, stopBits: 1, parity: 'none' });
      await new Promise((resolve, reject) => {
        port.once('open', resolve);
        port.once('error', reject);
      });
      const conn = platform.connect(key, `serial:${comPath}`);
      conn.onData((b) => port.write(Buffer.from(b)));
      port.on('data', (b) => conn.write(b));
      info.serial[key] = comPath;
      closers.push(() => (conn.close(), port.close()));
    }
  }

  // ---------------------------------------------------------------- KSCAT agent emulator (JSONP like the real agent)
  const payDev = definition.devices.find((d) => d.type === 'kscat-terminal');
  const kscatPort = o.kscat === false ? null : (o.kscat ?? payDev?.port?.http);
  if (payDev && kscatPort) {
    const srv = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://x');
      let body = '';
      for await (const c of req) body += c;
      const form = new URLSearchParams(body);
      const telegram = url.searchParams.get('REQ') ?? form.get('REQ') ?? '';
      const callback = url.searchParams.get('callback') ?? form.get('callback');
      const result = await platform.device(payDev.key).request(telegram);
      res.setHeader('access-control-allow-origin', '*');
      if (callback) {
        res.setHeader('content-type', 'application/javascript; charset=utf-8');
        res.end(`${callback.replace(/[^\w$.]/g, '')}(${JSON.stringify(result)});`);
      } else {
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(result));
      }
    });
    await new Promise((resolve, reject) => srv.once('error', reject).listen(kscatPort, '127.0.0.1', resolve));
    info.kscat = kscatPort;
    closers.push(() => srv.close());
  }

  // ---------------------------------------------------------------- HTTP: viewer + REST + WebSocket
  const staticDir = o.staticDir ?? path.join(repoRoot, 'packages/viewer/dist');
  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type');
    if (req.method === 'OPTIONS') return res.end();
    if (url.pathname.startsWith('/notifications/')) {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', 'access-control-allow-origin': '*' });
      const off = subscribeNotifications(backend, (chunk) => res.write(chunk));
      req.on('close', off);
      return;
    }
    if (isBackendPath(url.pathname)) {
      const r = await handleBackendHttp(backend, { method: req.method, pathname: url.pathname, query: Object.fromEntries(url.searchParams), bodyText: await readBody(req), contentType: req.headers['content-type'] ?? '' });
      res.writeHead(r.status, r.headers);
      return res.end(r.body);
    }
    if (url.pathname === '/api/state') return json(res, platform.snapshot());
    if (url.pathname === '/api/info') return json(res, { ...info, definition: { id: definition.id, name: definition.name, devices: definition.devices } });
    if (url.pathname === '/api/interact' && req.method === 'POST') {
      try {
        return json(res, { ok: true, result: platform.interact(JSON.parse(await readBody(req))) });
      } catch (e) {
        res.statusCode = 400;
        return json(res, { ok: false, error: e.message });
      }
    }
    // static viewer
    let file = path.join(staticDir, decodeURIComponent(url.pathname));
    if (!file.startsWith(staticDir)) return (res.statusCode = 403), res.end();
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) {
      res.statusCode = 404;
      return res.end(fs.existsSync(staticDir) ? 'Not found' : 'Viewer is not built yet. Run "npm run build", or use "npm run dev" and open the Vite URL with ?server=ws://localhost:8700/ws');
    }
    res.setHeader('content-type', MIME[path.extname(file)] ?? 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });

  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  wss.on('connection', (ws) => {
    const bridge = attachBridge(platform, (m) => ws.readyState === 1 && ws.send(JSON.stringify(m)), info);
    ws.on('message', (raw) => {
      try {
        bridge.receive(JSON.parse(raw));
      } catch {}
    });
    ws.on('close', () => bridge.close());
  });

  const httpPort = o.port ?? 8700;
  await new Promise((resolve, reject) => httpServer.once('error', reject).listen(httpPort, o.host ?? '127.0.0.1', resolve));
  info.http = httpPort;
  closers.push(() => (wss.close(), httpServer.close()));

  log(`platform "${definition.id}" - ${definition.name}`);
  log(`viewer / REST / WebSocket : http://localhost:${httpPort}  (ws://localhost:${httpPort}/ws)`);
  for (const [k, p] of Object.entries(info.tcp)) log(`device ${k.padEnd(5)} TCP 127.0.0.1:${p}`);
  for (const [k, p] of Object.entries(info.serial)) log(`device ${k.padEnd(5)} ${p}`);
  if (info.kscat) log(`KSCAT emulator            http://127.0.0.1:${info.kscat}`);

  if (dataFile) log(`Mailbean 가상 서버          http://localhost:${httpPort}/mailbean/  (데이터 ${dataFile})`);

  return {
    platform,
    backend,
    info,
    async close() {
      platform.stop();
      for (const c of closers) await c();
    },
  };
}

function json(res, data) {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  let s = '';
  for await (const c of req) s += c;
  return s;
}
