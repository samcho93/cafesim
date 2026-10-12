/**
 * The WebSocket bridge protocol, shared by the Node server (`cafesim start`) and the
 * Cloudflare Durable Object, so viewers, relays and SDK clients work against either.
 *
 * server -> client
 *   { t:'hello', platform, info, snapshot }   { t:'snap', s }   { t:'log'|'event'|'traffic', e }
 *   { t:'rx', conn, bytes }                   { t:'ack'|'payres'|'error', id, ... }
 * client -> server
 *   { t:'interact', id, action }              physical/operator action (moveCup, insertCard ...)
 *   { t:'open', device, conn }                open a raw byte line to a device (like a serial cable)
 *   { t:'tx', conn, bytes }                   bytes to the device      { t:'close', conn }
 *   { t:'pay', id, device, req }              KSCAT telegram -> response
 *   { t:'lock', id, label }                  room-wide order lock: acks when the caller may drive the
 *   { t:'unlock', lock: <lock id> }           machine; every other lock request queues behind it
 *
 * @param platform  running Platform
 * @param send      (message object) => void
 * @param info      extra info for the hello message
 * @returns { receive(message object), close() }
 */
export function attachBridge(platform, send, info = {}, { snapshotMs = 100 } = {}) {
  const conns = new Map();
  const definition = platform.definition;
  const lock = (platform.orderLock ??= { holder: null, queue: [] });
  const me = {};
  const grantNext = () => {
    if (lock.holder) return;
    const next = lock.queue.shift();
    if (!next) return;
    lock.holder = next;
    next.grant();
  };
  const release = (id) => {
    const mine = (q) => q.owner === me && (id === undefined || q.id === id);
    if (lock.holder && mine(lock.holder)) lock.holder = null;
    lock.queue = lock.queue.filter((q) => !mine(q));
    grantNext();
  };
  send({
    t: 'hello',
    platform: definition.id,
    info: { ...info, devices: definition.devices.map(({ key, type, port }) => ({ key, type, port })) },
    snapshot: platform.snapshot(),
  });
  const offs = [
    platform.on('log', (e) => send({ t: 'log', e })),
    platform.on('event', (e) => send({ t: 'event', e })),
    platform.on('traffic', (e) => send({ t: 'traffic', e: { ...e, bytes: [...e.bytes] } })),
  ];
  const timer = setInterval(() => send({ t: 'snap', s: platform.snapshot() }), snapshotMs);

  return {
    async receive(m) {
      try {
        if (m.t === 'interact') send({ t: 'ack', id: m.id, result: platform.interact(m.action) ?? null });
        else if (m.t === 'open') {
          conns.get(m.conn)?.close();
          const conn = platform.connect(m.device, `ws:${m.conn}`);
          conn.onData((b) => send({ t: 'rx', conn: m.conn, bytes: [...b] }));
          conns.set(m.conn, conn);
        } else if (m.t === 'tx') conns.get(m.conn)?.write(m.bytes);
        else if (m.t === 'close') {
          conns.get(m.conn)?.close();
          conns.delete(m.conn);
        } else if (m.t === 'pay') send({ t: 'payres', id: m.id, res: await platform.device(m.device).request(m.req) });
        else if (m.t === 'ping') send({ t: 'pong', id: m.id });
        else if (m.t === 'lock') {
          lock.queue.push({ owner: me, id: m.id, label: m.label ?? '주문', grant: () => send({ t: 'ack', id: m.id, result: m.id }) });
          grantNext();
        } else if (m.t === 'unlock') release(m.lock);
      } catch (e) {
        send({ t: 'error', id: m.id, error: e.message });
      }
    },
    close() {
      clearInterval(timer);
      offs.forEach((f) => f());
      release();
      conns.forEach((c) => c.close());
      conns.clear();
    },
  };
}
