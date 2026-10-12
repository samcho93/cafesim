/**
 * Minimal 'serialport' compatible class backed by a TCP connection to the cafeSim server.
 *
 *   CAFESIM_HOST   default 127.0.0.1
 *   CAFESIM_PORTS  default "COM1=7001,COM2=7002,COM3=7003"  (path=tcpPort, comma separated)
 *
 * Unknown paths fall back to the real 'serialport' package when it is installed,
 * so card readers or other real devices keep working.
 */
'use strict';
const net = require('node:net');
const { EventEmitter } = require('node:events');

function portMap() {
  const spec = process.env.CAFESIM_PORTS || 'COM1=7001,COM2=7002,COM3=7003';
  return Object.fromEntries(
    spec
      .split(',')
      .filter(Boolean)
      .map((p) => p.split('=').map((s) => s.trim()))
      .map(([k, v]) => [k.toUpperCase(), Number(v)]),
  );
}

class SerialPort extends EventEmitter {
  constructor(options, openCallback) {
    super();
    this.path = options.path;
    this.baudRate = options.baudRate;
    this.settings = { ...options };
    this.isOpen = false;
    this.pending = [];
    const tcp = portMap()[String(options.path).toUpperCase()];
    if (!tcp) {
      const real = loadReal();
      if (real) return new real.SerialPort(options, openCallback);
      process.nextTick(() => this.emit('error', new Error(`cafesim: no TCP mapping for ${options.path} (CAFESIM_PORTS)`)));
      return;
    }
    if (options.autoOpen === false) this._tcp = tcp;
    else this._connect(tcp, openCallback);
  }

  _connect(tcp, cb) {
    const host = process.env.CAFESIM_HOST || '127.0.0.1';
    const socket = (this.socket = net.connect({ host, port: tcp }));
    socket.setNoDelay(true);
    socket.on('connect', () => {
      this.isOpen = true;
      for (const [d, c] of this.pending.splice(0)) socket.write(d, c);
      this.emit('open');
      cb && cb(null);
    });
    socket.on('data', (d) => this.emit('data', d));
    socket.on('error', (e) => {
      this.emit('error', new Error(`cafesim ${this.path} -> ${host}:${tcp}: ${e.message}`));
      cb && cb(e);
      cb = null;
    });
    socket.on('close', () => {
      if (this.isOpen) this.emit('close');
      this.isOpen = false;
    });
  }

  open(cb) {
    if (this._tcp) this._connect(this._tcp, cb);
  }

  write(data, encoding, cb) {
    if (typeof encoding === 'function') cb = encoding;
    const buf = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.from(data) : Buffer.from(data, typeof encoding === 'string' ? encoding : undefined);
    if (this.isOpen) this.socket.write(buf, () => cb && cb(null));
    else this.pending.push([buf, () => cb && cb(null)]);
    return true;
  }

  drain(cb) {
    cb && process.nextTick(cb, null);
  }

  flush(cb) {
    cb && process.nextTick(cb, null);
  }

  set(_opts, cb) {
    cb && process.nextTick(cb, null);
  }

  get(cb) {
    cb && process.nextTick(cb, null, { cts: true, dsr: true, dcd: true });
  }

  update(opts, cb) {
    Object.assign(this.settings, opts);
    cb && process.nextTick(cb, null);
  }

  close(cb) {
    this.isOpen = false;
    if (this.socket) this.socket.end();
    cb && process.nextTick(cb, null);
  }

  pipe(dest) {
    this.on('data', (d) => dest.write(d));
    return dest;
  }

  static async list() {
    const host = process.env.CAFESIM_HOST || '127.0.0.1';
    return Object.keys(portMap()).map((path) => ({ path, manufacturer: `cafeSim (${host})` }));
  }
}

let realCache;
function loadReal() {
  if (realCache !== undefined) return realCache;
  try {
    const Module = require('node:module');
    realCache = Module.__cafesimOriginalResolve ? require(Module.__cafesimOriginalResolve('serialport', module)) : null;
  } catch {
    realCache = null;
  }
  return realCache;
}

module.exports = { SerialPort };
