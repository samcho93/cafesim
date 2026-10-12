import { Device } from './Device.js';
import { RequestParser, encodeAck, encodeNak, encodeReadResponse, describe } from '../protocol/mailbean.js';

const C0 = 0x30;
const C1 = 0x31;
const C2 = 0x32;

/**
 * Virtual cup dispenser (same ASCII protocol as the main board, station ID 02).
 *   S000 menu mode   S001 ice cup out   S002 hot cup out   S010 reset   S011 clear error
 *   M007 ice line front sensor ('0' = cup present)   M010 hot line front sensor
 *   M017 ice cup out state ('1' running, '2' done)   M018 hot cup out state
 */
export class CupDispenser extends Device {
  static type = 'cup-dispenser';
  static label = '컵 디스펜서';
  static slots = () => ['hot', 'ice'];

  constructor(args) {
    super(args);
    this.options = { id: '02', stock: { hot: 50, ice: 50 }, dropTime: 1.6, ...this.options };
    this.S = new Array(40).fill(C0);
    this.M = new Array(40).fill(C0);
    this.stock = { ...this.options.stock };
    this.ops = [];
  }

  createParser(onFrame) {
    return new RequestParser(onFrame);
  }

  describe(raw) {
    return describe(raw);
  }

  handleFrame(f, reply) {
    if (f.id !== this.options.id) return;
    if (!f.ok) return reply(encodeNak(f.id, f.cmd, f.addr, '02', 'short'));
    if (f.cmd === 'BR') {
      this.#sync();
      const mem = f.area === 'M' ? this.M : this.S;
      const data = mem.slice(f.index, f.index + f.length);
      while (data.length < f.length) data.push(C0);
      return reply(encodeReadResponse(f.id, f.addr, data));
    }
    f.data.forEach((b, k) => this.writeS(f.index + k, b));
    reply(encodeAck(f.id, f.cmd, f.addr, 'short'));
  }

  writeS(i, value) {
    const prev = this.S[i];
    this.S[i] = value;
    if (i === 1 || i === 2) {
      const type = i === 1 ? 'ice' : 'hot';
      const m = i === 1 ? 17 : 18;
      if (value === C0) {
        this.M[m] = C0;
        this.ops = this.ops.filter((o) => o.type !== type);
      } else if (value === C1 && prev !== C1 && this.M[m] !== C2) {
        this.dispense(type);
      }
    }
    if (i === 10 && value === C1) {
      this.ops = [];
      this.M[17] = this.M[18] = C0;
      this.log('info', '리셋');
    }
    if (i === 11 && value === C1) this.faults = {};
  }

  /** Start dropping a cup ('hot' | 'ice'). Also callable directly from the viewer. */
  dispense(type) {
    const m = type === 'ice' ? 17 : 18;
    this.M[m] = C1;
    if (this.stock[type] <= 0 || this.faults.jam) {
      this.log('error', `${type.toUpperCase()} 컵 배출 실패 (${this.faults.jam ? '걸림' : '재고 없음'})`);
      return;
    }
    this.ops.push({ type, m, remaining: this.options.dropTime });
    this.log('info', `${type.toUpperCase()} 컵 배출 시작`);
  }

  #sync() {
    this.M[7] = this.stock.ice > 0 ? C0 : C1;
    this.M[10] = this.stock.hot > 0 ? C0 : C1;
  }

  update(dt) {
    for (const op of [...this.ops]) {
      op.remaining -= dt;
      if (op.remaining > 0) continue;
      this.ops.splice(this.ops.indexOf(op), 1);
      this.stock[op.type] -= 1;
      this.world.createCup(op.type, `${this.key}:${op.type}`);
      this.M[op.m] = C2;
      this.log('info', `${op.type.toUpperCase()} 컵 배출 완료 (남은 재고 ${this.stock[op.type]})`);
    }
    this.#sync();
  }

  interact(action) {
    if (action.type === 'refill') {
      this.stock = { ...this.options.stock };
      return true;
    }
    if (action.type === 'dispense') {
      this.dispense(action.cup);
      return true;
    }
    if (action.type === 'fault') {
      this.setFault(action.name, action.on);
      return true;
    }
    return false;
  }

  snapshot() {
    return {
      type: CupDispenser.type,
      menuMode: this.S[0] === C1,
      stock: { ...this.stock },
      dropping: this.ops.map((o) => ({ type: o.type, progress: 1 - o.remaining / this.options.dropTime })),
      state: { ice: String.fromCharCode(this.M[17]), hot: String.fromCharCode(this.M[18]) },
      faults: Object.keys(this.faults),
      S: [...this.S],
      M: [...this.M],
    };
  }
}
