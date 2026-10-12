/**
 * Mailbean ASCII frame protocol (main board "메일빈" ID 01, cup dispenser ID 02).
 *
 * Request  : ENQ(05) ID(2) CMD(2:"BW"|"BR") ADDR(4:"S000"|"M000") LEN(3) [DATA(LEN)] EOT(04) SUM(2)
 * ACK      : ACK(06) ID(2) CMD(2) ADDR(4) ETX(03) SUM(2)                      -> 12 bytes (main board)
 *            ACK(06) ID(2) CMD(2) NUM(3) SUM(2)                              -> 10 bytes (cup dispenser, "short")
 * NAK      : NAK(15) ID(2) CMD(2) ADDR(4) ERR(2) ETX(03) SUM(2)               -> 14 bytes (main board)
 *            NAK(15) ID(2) CMD(2) ERR(3) SUM(2)                              -> 10 bytes (cup dispenser, "short")
 * The frame lengths are what the kiosk app's receivers count (serialManager.js / serialManagerCup.js).
 * Read resp: STX(02) ID(2) CMD(2) ADDR(4) LEN(3) DATA(LEN) ETX(03) SUM(2)     -> 15 + LEN bytes
 *
 * SUM is the low byte of the sum of every preceding byte, written as two ASCII hex digits.
 * DATA is byte oriented: flags are ASCII '0'/'1'/'2', recipe/temperature registers are raw bytes.
 * The legacy host also sends a 3 character address ("007") for S007, which is accepted here.
 */
import { toBytes } from '../util/Emitter.js';

export const ENQ = 0x05;
export const EOT = 0x04;
export const ACK = 0x06;
export const NAK = 0x15;
export const STX = 0x02;
export const ETX = 0x03;

const nibble = (n) => (n <= 9 ? 0x30 + n : 0x41 + n - 10);

export function checksum(bytes) {
  const low = bytes.reduce((acc, b) => acc + b, 0) & 0xff;
  return [nibble(low >> 4), nibble(low & 0x0f)];
}

const withSum = (bytes) => [...bytes, ...checksum(bytes)];
const pad = (n, w) => String(n).padStart(w, '0');

/** Normalize "S7", "s007", "007" -> { area: 'S', index: 7, text: 'S007' } */
export function parseAddress(addr) {
  const m = /^([SMsm])?(\d{1,3})$/.exec(String(addr).trim());
  if (!m) throw new Error(`Invalid mailbean address: ${addr}`);
  const area = (m[1] ?? 'S').toUpperCase();
  const index = Number(m[2]);
  return { area, index, text: `${area}${pad(index, 3)}` };
}

// ---------------------------------------------------------------- host side (encode requests)

/**
 * @param {string} id     station id, e.g. '01'
 * @param {'BW'|'BR'} cmd
 * @param {string} addr   'S150' / 'M000'
 * @param {number|Array|string} data  for BW: array of bytes or ASCII string; for BR: length to read
 */
export function encodeRequest(id, cmd, addr, data) {
  const { text } = parseAddress(addr);
  const body = [ENQ, ...toBytes(id), ...toBytes(cmd), ...toBytes(text)];
  if (cmd === 'BR') {
    body.push(...toBytes(pad(data, 3)));
  } else {
    const payload = toBytes(data);
    body.push(...toBytes(pad(payload.length, 3)), ...payload);
  }
  body.push(EOT);
  return withSum(body);
}

export const encodeWrite = (id, addr, data) => encodeRequest(id, 'BW', addr, data);
export const encodeRead = (id, addr, len) => encodeRequest(id, 'BR', addr, len);

// ---------------------------------------------------------------- device side (encode responses)

export function encodeAck(id, cmd, addr, format = 'long') {
  const a = parseAddress(addr).text;
  if (format === 'short') return withSum([ACK, ...toBytes(id), ...toBytes(cmd), ...toBytes(a.slice(1))]);
  return withSum([ACK, ...toBytes(id), ...toBytes(cmd), ...toBytes(a), ETX]);
}

export function encodeNak(id, cmd, addr, code = '01', format = 'long') {
  if (format === 'short') return withSum([NAK, ...toBytes(id), ...toBytes(cmd), ...toBytes(code.padStart(3, '0'))]);
  return withSum([NAK, ...toBytes(id), ...toBytes(cmd), ...toBytes(parseAddress(addr).text), ...toBytes(code), ETX]);
}

export function encodeReadResponse(id, addr, data) {
  return withSum([STX, ...toBytes(id), ...toBytes('BR'), ...toBytes(parseAddress(addr).text), ...toBytes(pad(data.length, 3)), ...data, ETX]);
}

// ---------------------------------------------------------------- stream parsers

const isDigit = (b) => b >= 0x30 && b <= 0x39;
const isLetter = (b) => (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a);
const str = (bytes) => String.fromCharCode(...bytes);

/**
 * Device-side parser: feeds raw bytes, emits decoded requests.
 * onFrame({ id, cmd, addr, area, index, length, data, raw, ok })
 */
export class RequestParser {
  buf = [];

  constructor(onFrame) {
    this.onFrame = onFrame;
  }

  push(chunk) {
    for (const b of toBytes(chunk)) this.buf.push(b);
    for (;;) {
      const start = this.buf.indexOf(ENQ);
      if (start < 0) {
        this.buf = [];
        return;
      }
      if (start > 0) this.buf.splice(0, start);
      const frame = this.#tryParse();
      if (frame === null) return; // need more bytes
      if (frame === false) {
        this.buf.shift(); // garbage, resync
        continue;
      }
      this.buf.splice(0, frame.raw.length);
      this.onFrame(frame);
    }
  }

  #tryParse() {
    const b = this.buf;
    if (b.length < 6) return null;
    const id = str(b.slice(1, 3));
    const cmd = str(b.slice(3, 5));
    if (cmd !== 'BW' && cmd !== 'BR') return false;
    // address: letter + 3 digits, or legacy 3 digits (implicit S)
    let p = 5;
    let addrText;
    if (b.length < p + 4) return null;
    if (isLetter(b[p]) && isDigit(b[p + 1]) && isDigit(b[p + 2]) && isDigit(b[p + 3])) {
      addrText = str(b.slice(p, p + 4));
      p += 4;
    } else if (isDigit(b[p]) && isDigit(b[p + 1]) && isDigit(b[p + 2])) {
      addrText = 'S' + str(b.slice(p, p + 3));
      p += 3;
    } else return false;
    if (b.length < p + 3) return null;
    const lenBytes = b.slice(p, p + 3);
    if (!lenBytes.every(isDigit)) return false;
    const length = Number(str(lenBytes));
    p += 3;
    let data = [];
    if (cmd === 'BW') {
      if (b.length < p + length) return null;
      data = b.slice(p, p + length);
      p += length;
    }
    if (b.length < p + 3) return null;
    if (b[p] !== EOT) return false;
    const raw = b.slice(0, p + 3);
    const sum = checksum(raw.slice(0, -2));
    const ok = sum[0] === raw[raw.length - 2] && sum[1] === raw[raw.length - 1];
    const { area, index } = parseAddress(addrText);
    return { id, cmd, addr: addrText, area, index, length, data, raw, ok };
  }
}

/**
 * Host-side parser: decodes ACK / NAK / read responses.
 * onFrame({ type: 'ack'|'nak'|'data', id, cmd, addr, data, raw, ok })
 */
export class ResponseParser {
  buf = [];

  /** @param format 'long' (main board) | 'short' (cup dispenser) ACK/NAK lengths */
  constructor(onFrame, format = 'long') {
    this.onFrame = onFrame;
    this.ackLength = format === 'short' ? 10 : 12;
    this.nakLength = format === 'short' ? 10 : 14;
  }

  push(chunk) {
    for (const b of toBytes(chunk)) this.buf.push(b);
    for (;;) {
      while (this.buf.length && ![ACK, NAK, STX].includes(this.buf[0])) this.buf.shift();
      const b = this.buf;
      if (!b.length) return;
      let total;
      if (b[0] === ACK) total = this.ackLength;
      else if (b[0] === NAK) total = this.nakLength;
      else {
        if (b.length < 12) return;
        const len = Number(str(b.slice(9, 12)));
        if (Number.isNaN(len)) {
          b.shift();
          continue;
        }
        total = 15 + len;
      }
      if (b.length < total) return;
      const raw = b.splice(0, total);
      const sum = checksum(raw.slice(0, -2));
      const ok = sum[0] === raw[total - 2] && sum[1] === raw[total - 1];
      const frame = { id: str(raw.slice(1, 3)), cmd: str(raw.slice(3, 5)), addr: str(raw.slice(5, 9)), raw, ok };
      if (raw[0] === ACK) this.onFrame({ ...frame, type: 'ack' });
      else if (raw[0] === NAK) this.onFrame({ ...frame, type: 'nak', code: str(raw.slice(total === 10 ? 5 : 9, total === 10 ? 8 : 11)) });
      else this.onFrame({ ...frame, type: 'data', data: raw.slice(12, 12 + (total - 15)) });
    }
  }
}

/** Human readable one-liner for traffic logs. */
export function describe(raw) {
  const b = toBytes(raw);
  const head = { [ENQ]: 'ENQ', [ACK]: 'ACK', [NAK]: 'NAK', [STX]: 'STX' }[b[0]] ?? '??';
  const text = b
    .slice(1)
    .map((x) => (x >= 0x20 && x < 0x7f ? String.fromCharCode(x) : `<${x.toString(16).padStart(2, '0')}>`))
    .join('');
  return `${head} ${text}`;
}
