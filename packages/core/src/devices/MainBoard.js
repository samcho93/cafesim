import { Device } from './Device.js';
import { RequestParser, encodeAck, encodeNak, encodeReadResponse, describe } from '../protocol/mailbean.js';
import { S, M, ACTUATORS, BREW_MANUAL, COMMANDS, LAMPS, ERRORS, decodeRecipe, barToPressureCount } from './mainboardMap.js';

const C0 = 0x30; // '0'
const C1 = 0x31; // '1'
const C2 = 0x32; // '2'

const FLOW = { coffee: 5, hotWater: 15, powder: 12, ade: 15, syrup: 6, manual: 15 }; // cc per second

/**
 * Virtual Mailbean main board: grinders, brew mechanism, boilers, pumps, valves,
 * powder feeders/mixers, ade pumps, outlet lamps and cup sensors.
 */
export class MainBoard extends Device {
  static type = 'mailbean-mainboard';
  static label = '메인보드 (커피머신)';
  static slots = (def) => Array.from({ length: def.options?.spouts ?? 3 }, (_, i) => `spout${i + 1}`);

  constructor(args) {
    super(args);
    const o = (this.options = {
      id: '01',
      spouts: 3,
      firmware: 23,
      routing: { coffee: [1, 2], hotWater: 1, ade: [2, 3, 3], powder: [3, 3, 3, 3, 3, 3] },
      temps: { coffeeReady: 92, hotWaterReady: 85, coffeeUse: 90, hotWaterUse: 85, coffeeExtract: 93, hotWaterExtract: 88 },
      stock: { bean: [1000, 1000], powder: [800, 800, 800, 800, 800, 800], ade: [2000, 2000, 2000], water: 20000 },
      ...this.options,
    });
    this.S = new Array(200).fill(C0);
    this.M = new Array(200).fill(C0);
    for (let i = S.RECIPE; i < S.RECIPE + 60; i++) this.S[i] = 0;
    const t = o.temps;
    [t.coffeeReady, t.hotWaterReady, t.coffeeUse, t.hotWaterUse, t.coffeeExtract, t.hotWaterExtract].forEach((v, i) => (this.S[S.COFFEE_READY + i] = v));
    this.S[S.COFFEE_OFFSET] = 0;
    this.S[S.HOTWATER_OFFSET] = 0;

    this.temps = { coffee: t.coffeeReady - 1, hotWater: t.hotWaterReady - 1 };
    this.brew = { position: 'middle', target: null, remaining: 0 };
    this.actuators = {};
    this.ops = new Map(); // key -> op
    this.lamps = new Array(o.spouts).fill(0);
    this.stock = structuredClone(o.stock);
    this.chamber = { grounds: 0, spent: false };
    this.cakeBin = 0;
    this.flowCount = 0;
    this.pressure = 0;
    this.streams = [];
    this.emergency = false;
    this.M[M.FIRMWARE] = o.firmware;
    this.M[M.FIRMWARE - 1] = 1;
    this.M[M.BOILER_USE] = C1;
    this.M[M.BREW_MOUNTED] = C1;
    this.M[M.DOOR] = C1;
    this.M[M.WATER_LEVEL] = C1;
    this.#syncSensors();
  }

  // ------------------------------------------------------------------ protocol
  createParser(onFrame) {
    return new RequestParser(onFrame);
  }

  describe(raw) {
    return describe(raw);
  }

  handleFrame(f, reply) {
    if (f.id !== this.options.id) return; // other station on the bus
    if (!f.ok) {
      this.log('warn', `checksum error: ${describe(f.raw)}`);
      return reply(encodeNak(f.id, f.cmd, f.addr, '02'));
    }
    if (f.cmd === 'BR') {
      const mem = f.area === 'M' ? this.M : this.S;
      this.#syncSensors();
      const data = mem.slice(f.index, f.index + f.length);
      while (data.length < f.length) data.push(C0);
      return reply(encodeReadResponse(f.id, f.addr, data));
    }
    if (f.area !== 'S') return reply(encodeNak(f.id, f.cmd, f.addr, '03'));
    f.data.forEach((b, k) => this.writeS(f.index + k, b));
    reply(encodeAck(f.id, f.cmd, f.addr));
  }

  // ------------------------------------------------------------------ S writes
  writeS(i, value) {
    const prev = this.S[i];
    this.S[i] = value;
    const on = value === C1;

    if (i === S.MENU_MODE) return this.log('info', `메뉴모드 ${on ? 'ON' : 'OFF'}`);
    if (i === S.MANUAL_MODE) {
      this.M[M.MANUAL_MODE] = value;
      if (!on) this.#allActuatorsOff();
      return this.log('info', `수동모드 ${on ? 'ON' : 'OFF'}`);
    }
    if (i === S.CUP_SENSOR_USE) return;
    if (i === S.RESET && on) return this.reset();
    if (i === S.CLEAR_ERROR && on) return this.clearErrors();
    if (i === S.EMERGENCY_STOP) {
      if (on) this.emergencyStop();
      return;
    }
    if (ACTUATORS[i]) {
      const a = ACTUATORS[i];
      if (a.key.startsWith('lamp')) {
        this.lamps[Number(a.key.slice(4)) - 1] = value - C0;
        this.M[a.m] = value;
        return;
      }
      this.actuators[a.key] = on;
      if (a.m != null) this.M[a.m] = on ? C1 : C0;
      return;
    }
    if (BREW_MANUAL[i]) {
      if (on) this.#moveBrew(BREW_MANUAL[i]);
      return;
    }
    if (i === S.SELECT_OUTLET) {
      this.actuators.selectOutlet = on;
      this.M[113] = value;
      return;
    }
    if (LAMPS[i]) {
      const n = LAMPS[i];
      if (n <= this.options.spouts) {
        this.lamps[n - 1] = value - C0;
        this.M[M.LAMP[n - 1]] = value;
      }
      return;
    }
    const cmd = COMMANDS[i];
    if (cmd) {
      if (value === C0) {
        if (this.ops.has(cmd.key)) this.#finishOp(this.ops.get(cmd.key), true);
        this.M[cmd.m] = C0;
      } else if (on && prev !== C1 && this.M[cmd.m] !== C2) {
        this.startCommand(cmd.key, i, cmd);
      } else if (on && this.M[cmd.m] === C0 && !this.ops.has(cmd.key)) {
        this.startCommand(cmd.key, i, cmd);
      }
    }
  }

  get cupSensorUse() {
    return this.S[S.CUP_SENSOR_USE] === C1;
  }

  get recipe() {
    return decodeRecipe(this.S.slice(S.RECIPE, S.RECIPE + 60));
  }

  // ------------------------------------------------------------------ commands
  startCommand(key, s, cmd) {
    if (this.emergency) {
      this.log('warn', `비상정지 상태 - ${cmd.label} 무시`);
      return;
    }
    const r = this.recipe;
    const op = { key, s, m: cmd.m, label: cmd.label, elapsed: 0, duration: 1.5, tick: null, done: null, error: null };
    const n = Number(key.slice(-1));
    const outletForCoffee = () => this.#outlet('coffee');

    switch (key) {
      case 'grinder1':
      case 'grinder2': {
        const idx = key === 'grinder1' ? 0 : 1;
        op.duration = (idx ? r.grinderTime2 : r.grinderTime1) || 2.5;
        op.actuator = key;
        op.tick = (dt) => {
          if (this.stock.bean[idx] <= 0) return (op.error = idx ? 85 : 84);
          const g = Math.min(this.stock.bean[idx], dt * 4);
          this.stock.bean[idx] -= g;
          this.chamber.grounds += g;
          this.chamber.spent = false;
        };
        break;
      }
      case 'brewUpper':
      case 'brewLower':
      case 'brewMiddle': {
        const target = { brewUpper: 'upper', brewLower: 'lower', brewMiddle: 'middle' }[key];
        op.duration = this.brew.position === target ? 0.2 : 1.5;
        op.actuator = 'brewMotor';
        op.done = () => this.#setBrewPosition(target);
        if (target === 'lower' && this.chamber.spent) op.done = () => (this.#setBrewPosition('lower'), this.#ejectCake());
        break;
      }
      case 'preInfusion':
        op.duration = 1.5;
        op.actuator = 'mainPump';
        break;
      case 'coffee': {
        const amount = r.coffeeAmount || 40;
        op.duration = amount / FLOW.coffee;
        op.actuator = 'mainPump';
        op.start = () => {
          if (this.brew.position !== 'upper') op.error = 93;
          if (this.chamber.grounds < 4) this.log('warn', '분쇄된 원두 없이 커피 추출 (물만 나옵니다)');
        };
        op.tick = (dt) => {
          if (op.error) return;
          if (!this.#water(dt * FLOW.coffee)) return (op.error = 89);
          const kind = this.chamber.grounds >= 4 ? 'coffee' : 'water';
          this.#pour(outletForCoffee(), kind, dt * FLOW.coffee);
          this.temps.coffee -= dt * FLOW.coffee * 0.04;
          this.pressure = 9 + Math.sin(op.elapsed * 3) * 0.4;
        };
        op.done = () => {
          this.pressure = 0;
          if (this.chamber.grounds > 0) this.chamber.spent = true;
        };
        break;
      }
      case 'hotWater': {
        const amount = r.hotWaterAmount || 120;
        op.duration = amount / FLOW.hotWater;
        op.actuator = 'mainPump';
        op.tick = (dt) => {
          if (!this.#water(dt * FLOW.hotWater)) return (op.error = 89);
          this.#pour(this.#outlet('hotWater'), 'water', dt * FLOW.hotWater);
          this.temps.hotWater -= dt * FLOW.hotWater * 0.02;
        };
        break;
      }
      case 'powder1':
      case 'powder2':
      case 'powder3':
      case 'powder4':
      case 'powder5':
      case 'powder6': {
        const i = n - 1;
        const water = r[`powderAmount${n}`] || 100;
        const feed = r[`powderFeedTime${n}`] || 1.5;
        op.duration = Math.max(water / FLOW.powder, feed) + 0.5;
        op.actuator = `mixer${n}`;
        op.tick = (dt) => {
          if (op.elapsed < feed) {
            this.actuators[`feeder${n}`] = true;
            const g = Math.min(this.stock.powder[i], dt * 6);
            if (this.stock.powder[i] <= 0) return (op.error = 95 + i);
            this.stock.powder[i] -= g;
          } else this.actuators[`feeder${n}`] = false;
          const cc = Math.min(dt * FLOW.powder, water - (op.poured ?? 0));
          if (cc > 0) {
            if (!this.#water(cc)) return (op.error = 89);
            op.poured = (op.poured ?? 0) + cc;
            this.#pour(this.#outlet('powder', n), 'powder', cc, n);
          }
        };
        op.done = () => (this.actuators[`feeder${n}`] = false);
        break;
      }
      case 'ade1':
      case 'ade2':
      case 'ade3': {
        const i = n - 1;
        const water = r[`adeWaterAmount${n}`] || r[`adeIceWaterAmount${n}`] || 0;
        const pump = r[`adePumpTime${n}`] || 0;
        op.duration = Math.max(water / FLOW.ade, pump, 0.5);
        op.actuator = `adePump${n}`;
        op.tick = (dt) => {
          const spout = this.#outlet('ade', n);
          const syrup = Math.min(this.stock.ade[i], dt * FLOW.syrup, pump * FLOW.syrup - (op.syrup ?? 0));
          if (syrup > 0) {
            if (this.stock.ade[i] <= 0) return (op.error = 101 + i);
            this.stock.ade[i] -= syrup;
            op.syrup = (op.syrup ?? 0) + syrup;
            this.#pour(spout, 'ade', syrup, n);
          }
          const cc = Math.min(dt * FLOW.ade, water - (op.poured ?? 0));
          if (cc > 0) {
            if (!this.#water(cc)) return (op.error = 89);
            op.poured = (op.poured ?? 0) + cc;
            this.#pour(spout, 'water', cc);
          }
        };
        break;
      }
      case 'cake':
        op.done = () => this.#ejectCake();
        break;
      default:
        break;
    }
    this.ops.set(key, op);
    this.M[cmd.m] = C1;
    op.start?.();
    if (op.actuator) this.#setActuator(op.actuator, true);
    this.log('info', `▶ ${cmd.label} (S${String(s).padStart(3, '0')}) ${op.duration.toFixed(1)}s`);
    this.emit('command', { key, label: cmd.label, phase: 'start' });
  }

  #finishOp(op, aborted = false) {
    this.ops.delete(op.key);
    if (op.actuator && ![...this.ops.values()].some((o) => o.actuator === op.actuator)) this.#setActuator(op.actuator, false);
    if (aborted) return;
    op.done?.();
    if (op.error) this.#raise(op.error);
    this.M[op.m] = C2;
    this.log(op.error ? 'error' : 'info', `■ ${op.label} 완료${op.error ? ` - ${ERRORS[op.error]}` : ''}`);
    this.emit('command', { key: op.key, label: op.label, phase: 'done', error: op.error ? ERRORS[op.error] : null });
  }

  // ------------------------------------------------------------------ helpers
  #setActuator(key, on) {
    this.actuators[key] = on;
    const entry = Object.values(ACTUATORS).find((a) => a.key === key);
    if (entry?.m != null) this.M[entry.m] = on ? C1 : C0;
    if (key === 'brewMotor') this.M[51] = on ? C1 : C0;
  }

  #allActuatorsOff() {
    for (const k of Object.keys(this.actuators)) if (k !== 'selectOutlet') this.#setActuator(k, false);
  }

  #moveBrew(target) {
    if (this.brew.position === target) return;
    this.brew.target = target;
    this.brew.remaining = 1.5;
    this.#setActuator('brewMotor', true);
    for (const idx of [M.BREW_UPPER, M.BREW_MIDDLE, M.BREW_LOWER]) this.M[idx] = C0;
  }

  #setBrewPosition(pos) {
    this.brew.position = pos;
    this.brew.target = null;
    this.M[M.BREW_UPPER] = pos === 'upper' ? C1 : C0;
    this.M[M.BREW_MIDDLE] = pos === 'middle' ? C1 : C0;
    this.M[M.BREW_LOWER] = pos === 'lower' ? C1 : C0;
  }

  #ejectCake() {
    if (this.chamber.grounds > 0) this.cakeBin += 1;
    this.chamber = { grounds: 0, spent: false };
  }

  #water(cc) {
    if (this.faults.waterShortage || this.stock.water <= 0) return false;
    this.stock.water -= cc;
    return true;
  }

  /**
   * Outlet for a liquid path. With options.followLamp the outlet whose lamp the host lit
   * (S165..S167, the kiosk lights the menu's gds_spout_num) receives the drink, otherwise the
   * static routing table is used.
   */
  #outlet(path, n = 1) {
    if (this.options.followLamp) {
      const lit = this.lamps.findIndex((l) => l === 1);
      const blink = this.lamps.findIndex((l) => l === 2);
      const i = lit >= 0 ? lit : blink;
      if (i >= 0) return i + 1;
    }
    const r = this.options.routing;
    if (path === 'coffee') return r.coffee[this.actuators.selectOutlet ? 1 : 0];
    if (path === 'hotWater') return r.hotWater;
    if (path === 'ade') return r.ade[n - 1];
    return r.powder[n - 1];
  }

  #pour(spout, kind, cc, sub) {
    this.flowCount = (this.flowCount + Math.round(cc * 2)) % 10000;
    const slot = `${this.key}:spout${spout}`;
    this.world.pour(slot, kind, cc, sub);
    this.streams.push({ spout, kind, sub });
  }

  #raise(index) {
    this.M[index] = C1;
    this.M[M.ERROR_ANY] = C1;
  }

  #syncSensors() {
    const w = this.platform?.world;
    this.M[M.CUP_SENSOR_USE] = this.S[S.CUP_SENSOR_USE];
    for (let i = 0; i < this.options.spouts; i++) this.M[M.CUP_SENSOR[i]] = w?.cupAt(`${this.key}:spout${i + 1}`) ? C1 : C0;
    this.M[M.COFFEE_TEMP] = Math.max(0, Math.min(255, Math.round(this.temps.coffee)));
    this.M[M.HOTWATER_TEMP] = Math.max(0, Math.min(255, Math.round(this.temps.hotWater)));
    this.stock.bean.forEach((g, i) => (this.M[M.BEAN[i]] = g > 0 ? C1 : C0));
    this.stock.powder.forEach((g, i) => (this.M[M.CANISTER[i]] = g > 0 ? C1 : C0));
    this.M[M.WATER_LEVEL] = this.faults.waterShortage || this.stock.water <= 0 ? C0 : C1;
    if (this.M[M.WATER_LEVEL] === C0) this.#raise(89);
    this.M[M.BREW_MOUNTED] = this.faults.brewRemoved ? C0 : C1;
    this.M[M.DOOR] = this.faults.doorOpen ? C0 : C1;
    const digits = (n) => [...String(Math.max(0, Math.round(n))).padStart(4, '0').slice(-4)].map((c) => c.charCodeAt(0));
    digits(this.flowCount).forEach((b, k) => (this.M[M.FLOW + k] = b));
    digits(barToPressureCount(this.pressure)).forEach((b, k) => (this.M[M.PRESSURE + k] = b));
    this.M[75] = C0;
  }

  // ------------------------------------------------------------------ public controls
  reset() {
    for (const op of [...this.ops.values()]) this.#finishOp(op, true);
    for (const c of Object.values(COMMANDS)) this.M[c.m] = C0;
    this.#allActuatorsOff();
    this.emergency = false;
    this.pressure = 0;
    this.log('info', '리셋');
  }

  clearErrors() {
    for (let i = 83; i <= 103; i++) this.M[i] = C0;
    this.log('info', '에러 해제');
  }

  emergencyStop() {
    for (const op of [...this.ops.values()]) this.#finishOp(op, true);
    this.#allActuatorsOff();
    this.emergency = true;
    this.log('error', '비상정지');
  }

  update(dt) {
    this.streams = [];
    // boilers (thermostat)
    const tick = (name, readyIdx, heater) => {
      const target = this.S[readyIdx] || 0;
      const cold = this.temps[name] < target - 0.5;
      this.#setActuator(heater, cold && !this.emergency);
      this.temps[name] += cold && !this.emergency ? dt * 1.2 : -dt * 0.02;
      if (this.temps[name] < 15) this.temps[name] = 15;
    };
    tick('coffee', S.COFFEE_READY, 'coffeeHeater');
    tick('hotWater', S.HOTWATER_READY, 'hotWaterHeater');

    // manual brew movement
    if (this.brew.target) {
      this.brew.remaining -= dt;
      if (this.brew.remaining <= 0) {
        this.#setBrewPosition(this.brew.target);
        this.#setActuator('brewMotor', false);
      }
    }

    // manual mode water paths (cleaning / service)
    if (this.actuators.mainPump && !this.ops.size && this.#water(0)) {
      // one water path at a time: powder mixer > ade line > hot water line, coffee line separately
      const a = this.actuators;
      const r = this.options.routing;
      const cc = dt * FLOW.manual;
      if (a.solCoffee1 || a.solCoffee2) this.#pour(r.coffee[a.selectOutlet ? 1 : 0], 'water', cc);
      const powder = [1, 2, 3, 4, 5, 6].find((n) => a[`solPowder${n}`]);
      const ade = [1, 2, 3].find((n) => a[`solAde${n}`]) ?? (a.solAdeHotWater ? 1 : null);
      if (powder) this.#pour(r.powder[powder - 1], 'water', cc);
      else if (ade) this.#pour(r.ade[ade - 1], 'water', cc);
      else if (a.solHotWater1 || a.solHotWater2 || a.solHotWater3) this.#pour(r.hotWater, 'water', cc);
      this.#water(cc);
    }

    for (const op of [...this.ops.values()]) {
      const step = Math.min(dt, op.duration - op.elapsed);
      op.elapsed += step;
      op.tick?.(step);
      if (op.elapsed >= op.duration - 1e-9) this.#finishOp(op);
    }
    this.#syncSensors();
  }

  interact(action) {
    switch (action.type) {
      case 'refill':
        this.stock = structuredClone(this.options.stock);
        this.cakeBin = 0;
        return true;
      case 'fault':
        this.setFault(action.name, action.on);
        return true;
      case 'coldStart':
        this.temps = { coffee: 20, hotWater: 20 };
        return true;
      default:
        return false;
    }
  }

  snapshot() {
    const errors = Object.entries(ERRORS)
      .filter(([i]) => this.M[i] === C1)
      .map(([i, label]) => ({ index: Number(i), label }));
    return {
      type: MainBoard.type,
      menuMode: this.S[S.MENU_MODE] === C1,
      manualMode: this.S[S.MANUAL_MODE] === C1,
      emergency: this.emergency,
      temps: { coffee: +this.temps.coffee.toFixed(1), hotWater: +this.temps.hotWater.toFixed(1), coffeeTarget: this.S[S.COFFEE_READY], hotWaterTarget: this.S[S.HOTWATER_READY] },
      brew: { position: this.brew.position, moving: !!this.brew.target || [...this.ops.values()].some((o) => o.actuator === 'brewMotor'), grounds: +this.chamber.grounds.toFixed(1), cakeBin: this.cakeBin },
      actuators: Object.keys(this.actuators).filter((k) => this.actuators[k]),
      ops: [...this.ops.values()].map((o) => ({ key: o.key, label: o.label, progress: o.duration ? o.elapsed / o.duration : 1 })),
      lamps: [...this.lamps],
      cupSensorUse: this.S[S.CUP_SENSOR_USE] === C1,
      cupSensors: this.M.slice(M.CUP_SENSOR[0], M.CUP_SENSOR[0] + this.options.spouts).map((b) => b === C1),
      pressure: +this.pressure.toFixed(1),
      streams: this.streams,
      errors,
      faults: Object.keys(this.faults),
      stock: { bean: this.stock.bean.map(Math.round), powder: this.stock.powder.map(Math.round), ade: this.stock.ade.map(Math.round), water: Math.round(this.stock.water) },
      recipe: this.recipe,
      S: [...this.S],
      M: [...this.M],
    };
  }
}
