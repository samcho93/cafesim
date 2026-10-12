/**
 * postMessage bridge between the kiosk iframe (any URL) and the simulator.
 *
 * Kiosk -> viewer : { cafesim: 'call', id, method, args }
 * Viewer -> kiosk : { cafesim: 'result', id, result | error }   and   { cafesim: 'event', type, data }
 *
 * Methods: getMenu, getPlatform, getState, pay(amount), order(itemId, temp), init(), cancelPayment()
 * Events : step (Machine progress), guide (customer prompts)
 * See public/cafesim-kiosk-sdk.js for the client side.
 */
export class KioskBridge {
  constructor({ machine, definition, link, toast }) {
    this.machine = machine;
    this.definition = definition;
    this.link = link;
    this.toast = toast;
    this.sources = new Set();
    this.initialized = null;

    window.addEventListener('message', (ev) => this.#onMessage(ev));
    machine.on('step', (s) => this.#broadcast('step', s));
    let lastGuide = '';
    link.on('snap', (s) => {
      const sig = JSON.stringify(s.guide ?? []);
      if (sig !== lastGuide) {
        lastGuide = sig;
        this.#broadcast('guide', s.guide ?? []);
      }
    });
  }

  #broadcast(type, data) {
    for (const src of this.sources) src.postMessage({ cafesim: 'event', type, data: JSON.parse(JSON.stringify(data)) }, '*');
  }

  async #onMessage(ev) {
    const m = ev.data;
    if (!m || m.cafesim !== 'call') return;
    this.sources.add(ev.source);
    const reply = (payload) => ev.source.postMessage({ cafesim: 'result', id: m.id, ...payload }, '*');
    try {
      const result = await this.call(m.method, ...(m.args ?? []));
      reply({ result: result === undefined ? null : JSON.parse(JSON.stringify(result)) });
    } catch (e) {
      reply({ error: e.message });
    }
  }

  async ensureInit() {
    this.initialized ??= this.machine.init().catch((e) => {
      this.initialized = null;
      throw e;
    });
    return this.initialized;
  }

  async call(method, ...args) {
    const d = this.definition;
    switch (method) {
      case 'getPlatform':
        return { id: d.id, name: d.name, description: d.description };
      case 'getMenu':
        return d.menu ?? [];
      case 'getState':
        return this.link.snapshot;
      case 'init':
        return this.ensureInit();
      case 'pay':
        await this.ensureInit();
        return this.machine.pay(Number(args[0]));
      case 'cancelPayment': {
        const pay = d.devices.find((x) => x.type === 'kscat-terminal');
        return pay && this.link.interact({ type: 'device', device: pay.key, action: { type: 'cancel' } });
      }
      case 'order': {
        await this.ensureInit();
        const item = d.menu.find((x) => x.id === args[0]);
        if (!item) throw new Error(`메뉴 없음: ${args[0]}`);
        await this.machine.order(item, { temp: args[1] ?? item.temps?.[0] });
        return true;
      }
      default:
        throw new Error(`Unknown kiosk method: ${method}`);
    }
  }
}
