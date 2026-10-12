import { Emitter, sleep } from '../util/Emitter.js';
import { MainBoardClient, CupClient, IceClient, PaymentClient } from './clients.js';

/**
 * High-level machine API built on the protocol clients.
 *
 *   const machine = Machine.local(platform);      // in-process simulator
 *   machine.on('step', (s) => console.log(s.text));
 *   await machine.init();
 *   await machine.pay(3000);
 *   await machine.order(platform.definition.menu[0], { temp: 'ice' });
 *
 * Every call goes through the real wire protocol, so swapping the transports
 * (TCP to the sim server, or COM ports to the real machine) needs no code change.
 */
export class Machine extends Emitter {
  /**
   * @param lock optional (label) => Promise<release()>  exclusive access when several clients
   *             share one machine (cloud rooms). Local simulators do not need it.
   */
  constructor({ main, cup, ice, pay, definition = {}, lock = null }) {
    super();
    this.lock = lock;
    this.main = main;
    this.cup = cup;
    this.ice = ice;
    this.pay_ = pay;
    this.definition = definition;
    this.busy = false;
  }

  /** Connect to an in-process Platform. */
  static local(platform, keys = {}) {
    const k = { main: 'main', cup: 'cup', ice: 'ice', pay: 'pay', ...keys };
    const has = (key) => key in platform.devices;
    return new Machine({
      main: has(k.main) ? new MainBoardClient(platform.connect(k.main, 'sdk')) : null,
      cup: has(k.cup) ? new CupClient(platform.connect(k.cup, 'sdk')) : null,
      ice: has(k.ice) ? new IceClient(platform.connect(k.ice, 'sdk')) : null,
      pay: has(k.pay) ? new PaymentClient((req) => platform.device(k.pay).request(req)) : null,
      definition: platform.definition,
    });
  }

  step(id, text, extra = {}) {
    const s = { id, text, ...extra, at: Date.now() };
    this.emit('step', s);
    return s;
  }

  /** Boot sequence of the kiosk app: reset, clear errors, temperatures, cup + ice init. */
  #chain = Promise.resolve();

  /**
   * Run fn exclusively: operations of this Machine run one after another (e.g. a kiosk
   * init never resets the board in the middle of an order), and, when the machine is shared
   * (cloud room), also after other clients' operations.
   */
  async exclusive(label, fn) {
    const prev = this.#chain;
    let done;
    this.#chain = new Promise((r) => (done = r));
    let granted = false;
    const notice = setTimeout(() => !granted && this.step('queue', '다른 주문이 끝나기를 기다리는 중...'), 400);
    let release = null;
    try {
      await prev;
      if (this.lock) release = await this.lock(label);
      granted = true;
      clearTimeout(notice);
      return await fn();
    } finally {
      clearTimeout(notice);
      release?.();
      done();
    }
  }

  async init(temps = this.definition.temperatures) {
    return this.exclusive('초기화', () => this.#init(temps));
  }

  async #init(temps) {
    this.step('init', '장치 초기화 중...');
    if (this.main) {
      await this.main.reset();
      if (temps) await this.main.setTemperatures(temps);
      await this.main.clearCommands();
      await this.main.menuMode(false);
    }
    if (this.cup) await this.cup.reset();
    if (this.ice) await this.ice.init();
    this.step('ready', '준비 완료');
  }

  async pay(amount) {
    if (!this.pay_) return { RES: '0000', STATUS: 'X' };
    this.step('pay', `${amount.toLocaleString()}원 결제 - 카드를 넣어 주세요`, { amount });
    const res = await this.pay_.approve(amount);
    this.step('paid', `결제 완료 (승인번호 ${res.APPROVALNO})`, { response: res });
    return res;
  }

  /** Resolve a menu item's recipe/sequence for a temperature. */
  resolveItem(item, temp) {
    const variant = item.variants?.[temp] ?? {};
    const sequences = this.definition.sequences ?? {};
    const seqName = variant.sequence ?? item.sequence;
    const sequence = Array.isArray(seqName) ? seqName : sequences[seqName];
    if (!sequence) throw new Error(`Menu "${item.name}" has no sequence "${seqName}"`);
    return {
      recipe: { ...(item.recipe ?? {}), ...(variant.recipe ?? {}) },
      sequence,
      spout: variant.spout ?? item.spout ?? 1,
      ice: temp === 'ice' ? (variant.ice ?? item.ice ?? { ice: 5, water: 0 }) : null,
    };
  }

  /** Run a list of steps: command keys, { select: bool }, { wait: ms }, { command, ... } */
  async runSequence(sequence) {
    for (const s of sequence) {
      if (typeof s === 'string') await this.main.command(s);
      else if (s.select !== undefined) await this.main.selectOutlet2(s.select);
      else if (s.wait) await sleep(s.wait);
      else if (s.command) await this.main.command(s.command);
      else if (s.actuator) await this.main.actuator(s.actuator, s.on);
    }
  }

  /**
   * Make one drink: cup → (ice) → place on outlet → extraction → take away.
   * Emits 'step' events with customer instructions while waiting for physical actions.
   */
  async order(item, opts = {}) {
    return this.exclusive(item.name, () => this.#order(item, opts));
  }

  async #order(item, { temp = item.temps?.[0] ?? 'hot', spout } = {}) {
    if (this.busy) throw new Error('Machine is busy');
    this.busy = true;
    try {
      const plan = this.resolveItem(item, temp);
      const outlet = spout ?? plan.spout;
      const label = `${temp === 'ice' ? 'ICE' : 'HOT'} ${item.name}`;

      if (this.cup) {
        this.step('cup', `${label} - 컵을 배출합니다`, { target: `cup:${temp}` });
        await this.cup.dispense(temp);
      }
      if (plan.ice && this.ice) {
        this.step('ice', '컵을 꺼내 제빙기에 대고 얼음을 받아 주세요', { target: 'ice:tray' });
        await this.ice.dispense(plan.ice.ice, plan.ice.water ?? 0);
      }

      const m = this.main;
      await m.menuMode(true);
      await m.lamp(outlet, 2);
      this.step('place', `${outlet}번 투출구에 컵을 놓아 주세요`, { target: `main:spout${outlet}` });
      await m.waitCup(outlet);
      await m.lamp(outlet, 1);

      this.step('brew', `${label} 제조 중...`, { target: `main:spout${outlet}` });
      await m.menuMode(false);
      await m.setRecipe(plan.recipe);
      await m.menuMode(true);
      try {
        await this.runSequence(plan.sequence);
      } finally {
        await m.clearCommands();
      }

      await m.lamp(outlet, 2);
      this.step('take', '음료가 완성되었습니다. 컵을 가져가세요', { target: `main:spout${outlet}` });
      await m.waitCupRemoved(outlet);
      await m.lamp(outlet, 0);
      await m.menuMode(false);
      this.step('done', `${label} 완료`);
    } catch (err) {
      this.step('error', `오류: ${err.message}`, { error: err.message });
      throw err;
    } finally {
      this.busy = false;
    }
  }

  /** Cleaning: rinse an outlet with hot water through the manual valves. */
  async rinse({ seconds = 4, path = 'hotWater' } = {}) {
    const m = this.main;
    const valves = path === 'coffee' ? ['solCoffee1', 'solCoffee2'] : ['solHotWater1', 'solHotWater2', 'solHotWater3'];
    this.step('wash', `${path === 'coffee' ? '커피' : '온수'} 라인 세척 중...`);
    await m.manualMode(true);
    for (const v of valves) await m.actuator(v, true);
    await m.actuator('mainPump', true);
    await sleep(seconds * 1000);
    await m.actuator('mainPump', false);
    for (const v of valves) await m.actuator(v, false);
    await m.manualMode(false);
    this.step('wash-done', '세척 완료');
  }

  close() {
    for (const c of [this.main, this.cup, this.ice]) c?.close();
  }
}
