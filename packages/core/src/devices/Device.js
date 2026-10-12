import { Emitter, toBytes } from '../util/Emitter.js';

/**
 * Base class of every virtual device.
 *
 * A device is reached through "connections" (one per host program / transport).
 * The host writes raw bytes with `connection.write()`; the device answers through
 * the same connection's data listeners, exactly like a serial line.
 *
 * Subclasses implement:
 *   createParser(onFrame)   stream parser for this protocol
 *   handleFrame(frame, reply)  answer one decoded request
 *   update(dt)              advance the simulation by dt seconds
 *   snapshot()              serialisable state for viewers
 *   describe(raw)           one-line text for the traffic log
 */
export class Device extends Emitter {
  static type = 'device';
  static label = 'Device';

  constructor({ key, platform, options = {} }) {
    super();
    this.key = key;
    this.platform = platform;
    this.options = options;
    this.connections = new Set();
    this.faults = {};
  }

  get world() {
    return this.platform.world;
  }

  log(level, message, extra = {}) {
    this.platform.emit('log', { device: this.key, level, message, ...extra, t: this.platform.time });
  }

  /** Open a host-side endpoint. */
  connect(name = 'host') {
    const listeners = new Set();
    const device = this;
    const conn = {
      name,
      device: this.key,
      open: true,
      write(data) {
        if (!conn.open) return;
        const bytes = toBytes(data);
        device.platform.emit('traffic', { device: device.key, conn: name, dir: 'host→dev', bytes, text: device.describe(bytes) });
        conn.parser.push(bytes);
      },
      onData(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      close() {
        conn.open = false;
        listeners.clear();
        device.connections.delete(conn);
      },
    };
    const reply = (bytes) => {
      if (!conn.open) return;
      device.platform.emit('traffic', { device: device.key, conn: name, dir: 'dev→host', bytes, text: device.describe(bytes) });
      for (const fn of listeners) fn(Uint8Array.from(bytes));
    };
    conn.parser = this.createParser((frame) => {
      // answer asynchronously, like real hardware turnaround
      const delay = this.options.latencyMs ?? 5;
      setTimeout(() => this.handleFrame(frame, reply, conn), delay);
    });
    this.connections.add(conn);
    return conn;
  }

  setFault(name, on = true) {
    if (on) this.faults[name] = true;
    else delete this.faults[name];
    this.emit('change');
  }

  createParser() {
    throw new Error('not implemented');
  }
  handleFrame() {}
  update() {}
  interact() {
    return false;
  }
  snapshot() {
    return {};
  }
  describe(raw) {
    return Array.from(raw)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ');
  }
}
