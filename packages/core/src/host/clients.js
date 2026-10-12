/**
 * Host-side drivers ("SDK"). They speak the real wire protocols over any transport
 * with { write(bytes), onData(fn) }, so the same program can drive:
 *   - the in-browser simulator      platform.connect('main')
 *   - the simulator server over TCP  createTcpTransport(7001)       (@cafesim/server)
 *   - real hardware on a COM port    createSerialTransport('COM1')   (@cafesim/server)
 */
import { encodeWrite, encodeRead, ResponseParser, parseAddress } from '../protocol/mailbean.js';
import { encodeIce, IceParser, ICE, D1, D2, secondsToIceByte, ICE_ERRORS } from '../protocol/ice.js';
import { COMMAND_BY_KEY, COMMANDS, S, M, ACTUATORS, ERRORS, encodeRecipe, pressureCountToBar } from '../devices/mainboardMap.js';
import { sleep } from '../util/Emitter.js';

const C0 = 0x30;
const C1 = 0x31;
const C2 = 0x32;

export class TimeoutError extends Error {}

/** Serialises request/response exchanges on one line. */
class Line {
  #chain = Promise.resolve();
  run(fn) {
    const next = this.#chain.then(fn, fn);
    this.#chain = next.catch(() => {});
    return next;
  }
}

// ======================================================================== Mailbean (main board / cup)
export class MailbeanClient {
  constructor(transport, { id = '01', timeoutMs = 1500, retries = 3, pollMs = 200, frameFormat = 'long' } = {}) {
    this.transport = transport;
    this.id = id;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.pollMs = pollMs;
    this.line = new Line();
    this.waiter = null;
    this.parser = new ResponseParser((f) => {
      if (f.id !== this.id) return;
      const w = this.waiter;
      if (w) {
        this.waiter = null;
        w(f);
      }
    }, frameFormat);
    this.unsubscribe = transport.onData((d) => this.parser.push(d));
  }

  #exchange(bytes) {
    return this.line.run(async () => {
      for (let attempt = 0; attempt <= this.retries; attempt++) {
        const reply = await new Promise((resolve) => {
          const timer = setTimeout(() => {
            this.waiter = null;
            resolve(null);
          }, this.timeoutMs);
          this.waiter = (f) => {
            clearTimeout(timer);
            resolve(f);
          };
          this.transport.write(bytes);
        });
        if (reply && reply.ok && reply.type !== 'nak') return reply;
      }
      throw new TimeoutError(`No valid reply from station ${this.id}`);
    });
  }

  /** Write bytes (array) or ASCII string to an S address. */
  async write(addr, data) {
    await this.#exchange(encodeWrite(this.id, addr, data));
  }

  /** Read `len` bytes from an address, returns number[] */
  async read(addr, len) {
    const f = await this.#exchange(encodeRead(this.id, addr, len));
    return f.data;
  }

  async set(sIndex, value) {
    return this.write(`S${String(sIndex).padStart(3, '0')}`, typeof value === 'boolean' ? (value ? '1' : '0') : String(value));
  }

  /** Poll `M[index]` until it equals value ('0'/'1'/'2' or byte). */
  async waitM(index, value, { timeoutMs = 120000, length = 149 } = {}) {
    const want = typeof value === 'string' ? value.charCodeAt(0) : value;
    const end = Date.now() + timeoutMs;
    for (;;) {
      const mem = await this.read('M000', Math.max(length, index + 1));
      if (mem[index] === want) return mem;
      if (Date.now() > end) throw new TimeoutError(`M${String(index).padStart(3, '0')} did not become ${value}`);
      await sleep(this.pollMs);
    }
  }

  close() {
    this.unsubscribe?.();
  }
}

export class MainBoardClient extends MailbeanClient {
  constructor(transport, opts = {}) {
    super(transport, { id: '01', ...opts });
  }

  menuMode(on) {
    return this.set(S.MENU_MODE, on);
  }

  manualMode(on) {
    return this.set(S.MANUAL_MODE, on);
  }

  async reset() {
    await this.set(S.RESET, '1');
    await this.set(S.CLEAR_ERROR, '1');
  }

  emergencyStop() {
    return this.set(S.EMERGENCY_STOP, '1');
  }

  /** Boiler temperatures in °C: { coffeeReady, hotWaterReady, coffeeUse, hotWaterUse, coffeeExtract, hotWaterExtract } */
  setTemperatures(t) {
    const v = [t.coffeeReady, t.hotWaterReady, t.coffeeUse, t.hotWaterUse, t.coffeeExtract, t.hotWaterExtract].map((x) => Number(x) || 0);
    return this.write('S001', v);
  }

  /** Recipe registers S080..S139: { grinderTime1 (s), coffeeAmount (cc), hotWaterAmount (cc), powderAmount1..6, ... } */
  setRecipe(recipe) {
    return this.write('S080', encodeRecipe(recipe));
  }

  /** Manual actuator by key, e.g. actuator('mainPump', true). Requires manualMode(true). */
  actuator(key, on) {
    const entry = Object.entries(ACTUATORS).find(([, a]) => a.key === key);
    if (!entry) throw new Error(`Unknown actuator ${key}. Known: ${Object.values(ACTUATORS).map((a) => a.key).join(', ')}`);
    return this.set(Number(entry[0]), on);
  }

  /** Outlet lamp 1..3: 0 off, 1 on, 2 blink */
  lamp(spout, mode) {
    return this.set(164 + spout, String(mode));
  }

  selectOutlet2(on) {
    return this.set(S.SELECT_OUTLET, on);
  }

  /** Run one menu command (key like 'coffee' or S index 153) and wait until it reports done. */
  async command(key, { timeoutMs = 180000 } = {}) {
    const cmd = typeof key === 'number' ? { ...COMMANDS[key], s: key } : COMMAND_BY_KEY[key];
    if (!cmd) throw new Error(`Unknown command ${key}. Known: ${Object.keys(COMMAND_BY_KEY).join(', ')}`);
    await this.set(cmd.s, '1');
    await this.waitM(cmd.m, C2, { timeoutMs });
    const errors = await this.errors();
    if (errors.length) throw Object.assign(new Error(`${cmd.label}: ${errors.map((e) => e.label).join(', ')}`), { errors });
  }

  /** Write '0' to every menu command (Clear15 + Clear05 in the original app). */
  async clearCommands() {
    await this.write('S150', '000000000000000');
    await this.write('S168', '00000');
  }

  /** Enable cup sensing and wait until a cup stands on the outlet. */
  async waitCup(spout, { timeoutMs = 600000 } = {}) {
    await this.set(S.CUP_SENSOR_USE, '1');
    await this.waitM(M.CUP_SENSOR[spout - 1], C1, { timeoutMs });
  }

  /** Disable cup sensing and wait until the cup has been taken away. */
  async waitCupRemoved(spout, { timeoutMs = 600000 } = {}) {
    await this.set(S.CUP_SENSOR_USE, '0');
    await this.waitM(M.CUP_SENSOR[spout - 1], C0, { timeoutMs });
  }

  async errors() {
    const m = await this.read('M000', 149);
    return Object.entries(ERRORS)
      .filter(([i]) => m[i] === C1)
      .map(([i, label]) => ({ index: Number(i), label }));
  }

  /** Decoded status block. */
  async status() {
    const m = await this.read('M000', 149);
    const ch = (i) => String.fromCharCode(m[i]);
    const digits = (i) => Number(String.fromCharCode(...m.slice(i, i + 4)));
    return {
      temps: { coffee: m[M.COFFEE_TEMP], hotWater: m[M.HOTWATER_TEMP] },
      brew: m[M.BREW_UPPER] === C1 ? 'upper' : m[M.BREW_LOWER] === C1 ? 'lower' : m[M.BREW_MIDDLE] === C1 ? 'middle' : 'moving',
      cupSensors: M.CUP_SENSOR.map((i) => m[i] === C1),
      waterOk: m[M.WATER_LEVEL] === C1,
      beans: M.BEAN.map((i) => m[i] === C1),
      canisters: M.CANISTER.map((i) => m[i] === C1),
      commands: Object.fromEntries(Object.values(COMMANDS).map((c) => [c.key, ch(c.m)])),
      pressureBar: +pressureCountToBar(digits(M.PRESSURE)).toFixed(1),
      flowCount: digits(M.FLOW),
      firmware: m[M.FIRMWARE],
      errors: Object.entries(ERRORS)
        .filter(([i]) => m[i] === C1)
        .map(([i, label]) => ({ index: Number(i), label })),
      raw: m,
    };
  }
}

export class CupClient extends MailbeanClient {
  constructor(transport, opts = {}) {
    super(transport, { id: '02', frameFormat: 'short', ...opts });
  }

  async reset() {
    await this.set(10, '1');
    await this.set(11, '1');
    await this.set(0, '0');
  }

  /** Drop one cup: 'hot' | 'ice'. Resolves when the cup is in the window. */
  async dispense(type, { timeoutMs = 30000 } = {}) {
    const s = type === 'ice' ? 1 : 2;
    const m = type === 'ice' ? 17 : 18;
    await this.set(0, '1');
    await this.set(s, '1');
    try {
      await this.waitM(m, C2, { timeoutMs, length: 30 });
    } finally {
      await this.set(s, '0');
      await this.set(0, '0');
    }
  }

  async status() {
    const m = await this.read('M000', 28);
    return { iceStock: m[7] === C0, hotStock: m[10] === C0, iceOut: String.fromCharCode(m[17]), hotOut: String.fromCharCode(m[18]) };
  }
}

// ======================================================================== Ice maker
export class IceClient {
  constructor(transport, { timeoutMs = 1500, pollMs = 350 } = {}) {
    this.transport = transport;
    this.timeoutMs = timeoutMs;
    this.pollMs = pollMs;
    this.line = new Line();
    this.waiter = null;
    this.parser = new IceParser((f) => {
      const w = this.waiter;
      this.waiter = null;
      w?.(f);
    });
    this.unsubscribe = transport.onData((d) => this.parser.push(d));
  }

  send(cmd, d1 = 0, d2 = 0) {
    return this.line.run(
      () =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            this.waiter = null;
            reject(new TimeoutError('Ice maker did not answer'));
          }, this.timeoutMs);
          this.waiter = (f) => {
            clearTimeout(timer);
            resolve(f);
          };
          this.transport.write(encodeIce(cmd, d1, d2));
        }),
    );
  }

  /** Communication mode + ignore cup leave + dispense timeout (as the kiosk app does on boot). */
  async init({ timeoutMin = 9, timeoutSec = 59 } = {}) {
    await this.send(ICE.MODE, 1, 1);
    await this.send(ICE.TIMEOUT, timeoutMin, timeoutSec);
  }

  reboot() {
    return this.send(ICE.REBOOT);
  }

  async status() {
    const f = await this.send(ICE.STATUS);
    const err = f.d2 & D2.ERROR_MASK;
    return {
      full: !!(f.d1 & D1.FULL),
      commMode: !!(f.d1 & D1.COMM_MODE),
      cupLever: !!(f.d1 & D1.CUP_LEVER),
      dispensing: !!(f.d1 & D1.DISPENSE_SOL),
      compressor: !!(f.d1 & D1.COMPRESSOR),
      waiting: !!(f.d2 & D2.WAITING),
      error: err ? ICE_ERRORS[err] : null,
      d1: f.d1,
      d2: f.d2,
    };
  }

  /** Arm a dispense (ice / water seconds) and wait until the customer has received it. */
  async dispense(iceSec, waterSec = 0, { timeoutMs = 600000 } = {}) {
    await this.send(ICE.DISPENSE, secondsToIceByte(iceSec), secondsToIceByte(waterSec));
    const end = Date.now() + timeoutMs;
    for (;;) {
      await sleep(this.pollMs);
      const s = await this.status();
      if (s.error) throw new Error(`제빙기 에러: ${s.error}`);
      if (!s.waiting) return s;
      if (Date.now() > end) throw new TimeoutError('Ice dispense timed out');
    }
  }

  close() {
    this.unsubscribe?.();
  }
}

// ======================================================================== Payment (KSCAT)
/** Builds the KSCAT credit approval telegram exactly like the kiosk app (KSCatAppr). */
export function buildApprovalTelegram(amount, tid = 'DPT0TEST03') {
  const amountOrg = Math.floor((amount / 11) * 10);
  const tax = amount - amountOrg;
  let m = '\x02' + 'IC' + '01' + '0200' + 'N' + tid.padEnd(10).slice(0, 10) + '    ' + '000000000000' + ' ' + ' '.repeat(20) + ' '.repeat(20) + ' ' + ' '.repeat(16) + ' '.repeat(16) + ' '.repeat(40) + ' '.repeat(37);
  m += '\x1c' + '00' + String(amount).padStart(12, '0') + '000000000000' + String(tax).padStart(12, '0') + String(amountOrg).padStart(12, '0') + '000000000000';
  m += '  ' + ' '.repeat(16) + ' '.repeat(12) + ' '.repeat(6) + ' '.repeat(163) + (amount >= 50000 ? 'T' : 'X') + '\x03\r';
  return 'AP' + String(m.length).padStart(4, '0') + m;
}

export class PaymentClient {
  /** @param send (telegram:string) => Promise<object>  e.g. terminal.request.bind(terminal) or an HTTP call */
  constructor(send, { tid = 'DPT0TEST03' } = {}) {
    this.send = send;
    this.tid = tid;
  }

  async approve(amount) {
    const res = await this.send(buildApprovalTelegram(amount, this.tid));
    if (res.RES !== '0000') throw Object.assign(new Error(res.MSG || res.MESSAGE1 || '결제 실패'), { response: res });
    return res;
  }

  /** Wait until the card has been taken out of the reader. */
  async waitCardRemoved({ pollMs = 500, timeoutMs = 120000 } = {}) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const r = await this.send('AP\x020007S4   \x03\r');
      if (r.STATUS === 'DEL') return;
      if (Date.now() > end) throw new TimeoutError('card not removed');
      await sleep(pollMs);
    }
  }
}

export { parseAddress };
