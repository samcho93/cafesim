import { Emitter, Platform, Machine, MainBoardClient, CupClient, IceClient, PaymentClient } from '@cafesim/core';

/**
 * The viewer never touches devices directly; it talks to a "link":
 *   LocalLink  - the simulator runs inside this browser tab (default, also on GitHub Pages)
 *   RemoteLink - mirrors a `cafesim start` server over WebSocket (?server=ws://localhost:8700/ws)
 *
 * Both expose: snapshot, on('snap'|'log'|'traffic'|'event'), interact(), openTransport(), pay()
 */
export class LocalLink extends Emitter {
  mode = 'local';

  constructor(definition, opts = {}) {
    super();
    this.definition = definition;
    this.platform = new Platform(definition, opts).start();
    this.snapshot = this.platform.snapshot();
    for (const t of ['log', 'traffic', 'event', 'guide']) this.platform.on(t, (e) => this.emit(t, e));
    this.platform.on('tick', () => {
      this.snapshot = this.platform.snapshot();
      this.emit('snap', this.snapshot);
    });
  }

  async interact(action) {
    return this.platform.interact(action);
  }

  openTransport(device, name = 'viewer') {
    return this.platform.connect(device, name);
  }

  pay(device, req) {
    return this.platform.device(device).request(req);
  }
}

export class RemoteLink extends Emitter {
  mode = 'remote';
  #seq = 0;
  #pending = new Map();
  #rx = new Map();

  constructor(url) {
    super();
    this.url = url;
    this.snapshot = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = (this.ws = new WebSocket(this.url));
      ws.onerror = () => reject(new Error(`WebSocket 연결 실패: ${this.url}`));
      ws.onclose = () => this.emit('disconnected');
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.t === 'hello') {
          this.info = m.info;
          this.platformId = m.platform;
          this.snapshot = m.snapshot;
          resolve(this);
        } else if (m.t === 'snap') {
          this.snapshot = m.s;
          this.emit('snap', m.s);
        } else if (m.t === 'log' || m.t === 'event') this.emit(m.t, m.e);
        else if (m.t === 'traffic') this.emit('traffic', { ...m.e, bytes: Uint8Array.from(m.e.bytes) });
        else if (m.t === 'rx') this.#rx.get(m.conn)?.forEach((fn) => fn(Uint8Array.from(m.bytes)));
        else if (m.t === 'ack' || m.t === 'payres' || m.t === 'error') {
          const p = this.#pending.get(m.id);
          this.#pending.delete(m.id);
          if (m.t === 'error') p?.reject(new Error(m.error));
          else p?.resolve(m.t === 'ack' ? m.result : m.res);
        }
      };
    });
  }

  #call(msg) {
    const id = ++this.#seq;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ ...msg, id }));
    });
  }

  interact(action) {
    return this.#call({ t: 'interact', action });
  }

  pay(device, req) {
    return this.#call({ t: 'pay', device, req });
  }

  openTransport(device, name = 'viewer') {
    const conn = `${name}-${++this.#seq}`;
    const listeners = new Set();
    this.#rx.set(conn, listeners);
    this.ws.send(JSON.stringify({ t: 'open', device, conn }));
    return {
      write: (bytes) => this.ws.send(JSON.stringify({ t: 'tx', conn, bytes: [...bytes] })),
      onData: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
      close: () => {
        this.ws.send(JSON.stringify({ t: 'close', conn }));
        this.#rx.delete(conn);
      },
    };
  }
}

/** Build the high-level SDK Machine on top of a link (works for local and remote). */
export function createMachine(link, definition) {
  const has = (type) => definition.devices.find((d) => d.type === type);
  const main = has('mailbean-mainboard');
  const cup = has('cup-dispenser');
  const ice = has('ice-maker');
  const pay = has('kscat-terminal');
  return new Machine({
    main: main && new MainBoardClient(link.openTransport(main.key, 'sdk')),
    cup: cup && new CupClient(link.openTransport(cup.key, 'sdk')),
    ice: ice && new IceClient(link.openTransport(ice.key, 'sdk')),
    pay: pay && new PaymentClient((req) => link.pay(pay.key, req)),
    definition,
  });
}
