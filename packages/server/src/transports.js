import net from 'node:net';
import http from 'node:http';
import { MainBoardClient, CupClient, IceClient, PaymentClient, Machine } from '@cafesim/core';

/**
 * Byte transports with the { write, onData, close } shape used by the core SDK clients.
 */
export function createTcpTransport({ host = '127.0.0.1', port }) {
  const listeners = new Set();
  const socket = net.connect({ host, port });
  socket.setNoDelay(true);
  socket.on('data', (d) => listeners.forEach((fn) => fn(d)));
  const ready = new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  return {
    ready,
    write: (bytes) => socket.write(Buffer.from(bytes)),
    onData: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    close: () => socket.destroy(),
  };
}

/** Real COM port (needs the optional "serialport" dependency). */
export async function createSerialTransport(path, baudRate) {
  const { SerialPort } = await import('serialport');
  const listeners = new Set();
  const port = new SerialPort({ path, baudRate, dataBits: 8, stopBits: 1, parity: 'none' });
  port.on('data', (d) => listeners.forEach((fn) => fn(d)));
  await new Promise((resolve, reject) => {
    port.once('open', resolve);
    port.once('error', reject);
  });
  return {
    write: (bytes) => port.write(Buffer.from(bytes)),
    onData: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    close: () => port.close(),
  };
}

/** KSCAT request over HTTP (same call the kiosk app makes, JSON variant). */
export function kscatHttp({ host = '127.0.0.1', port = 27098 } = {}) {
  return (req) =>
    new Promise((resolve, reject) => {
      const body = new URLSearchParams({ REQ: req }).toString();
      const r = http.request({ host, port, method: 'POST', path: '/', headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) } }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(text));
          } catch (e) {
            reject(e);
          }
        });
      });
      r.on('error', reject);
      r.end(body);
    });
}

/**
 * Connect a Machine (high-level SDK) to a running simulator server — or to real hardware.
 *
 *   const machine = await connectMachine();                                  // sim on localhost
 *   const machine = await connectMachine({ serial: { main: 'COM1', ice: 'COM2', cup: 'COM3' } }); // real M400
 */
export async function connectMachine({ host = '127.0.0.1', tcp = { main: 7001, ice: 7002, cup: 7003 }, serial, kscat = { host, port: 27098 }, definition } = {}) {
  const t = {};
  if (serial) {
    const baud = { main: 38400, ice: 9600, cup: 9600 };
    for (const [k, path] of Object.entries(serial)) t[k] = await createSerialTransport(path, baud[k]);
  } else {
    for (const [k, port] of Object.entries(tcp)) {
      t[k] = createTcpTransport({ host, port });
      await t[k].ready;
    }
  }
  const machine = new Machine({
    main: t.main && new MainBoardClient(t.main),
    cup: t.cup && new CupClient(t.cup),
    ice: t.ice && new IceClient(t.ice),
    pay: kscat && new PaymentClient(kscatHttp(kscat)),
    definition,
  });
  const close = machine.close.bind(machine);
  machine.close = () => {
    close();
    Object.values(t).forEach((x) => x.close());
  };
  return machine;
}
