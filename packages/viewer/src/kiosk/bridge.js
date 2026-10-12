import { KioskEngine, backendSeed, euro } from '@cafesim/core';

/**
 * postMessage bridge between the kiosk iframe (any URL) and the simulator.
 *
 * Kiosk -> viewer : { cafesim: 'call', id, method, args }
 * Viewer -> kiosk : { cafesim: 'result', id, result | error }   and   { cafesim: 'event', type, data }
 *
 * Simple API (custom kiosks): getMenu, getPlatform, getState, pay(amount), order(itemId, temp)
 * Full API (the bundled M400 kiosk, same features as the original app):
 *   catalog, api, payCard, payBarcode, waitCardRemoved, cancelPayment, insertPayment,
 *   makeDrinks, wash, cupOut, resetCup, resetIce, setTemperatures, refill, reload, saveGoods, meta
 * Events: step, guide, progress, remote, notice, data
 * See public/cafesim-kiosk-sdk.js for the client side.
 */
export class KioskBridge {
  constructor({ machine, definition, link, backend, toast }) {
    this.machine = machine;
    this.definition = definition;
    this.link = link;
    this.backend = backend;
    this.toast = toast;
    this.sources = new Set();
    this.initialized = null;
    this.engine = new KioskEngine({ machine, api: backend.api });

    window.addEventListener('message', (ev) => this.#onMessage(ev));
    machine.on('step', (s) => this.#broadcast('step', s));
    for (const t of ['progress', 'remote', 'notice']) this.engine.on(t, (e) => this.#broadcast(t, e));
    this.engine.on('notice', (n) => toast(n.text, n.level));
    backend.onChange?.((w) => ['goods', 'categories', 'store', 'settings', 'ptGoods', 'all', 'ingredients'].includes(w) && this.#broadcast('data', { what: w }));
    backend.onNotify((cmd) => {
      if (backend.executesRemote) this.engine.handleRemote(cmd);
      else this.#broadcast('remote', { ...cmd, status: 'start', by: 'server' });
    });
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
    for (const src of this.sources) src.postMessage({ cafesim: 'event', type, data: JSON.parse(JSON.stringify(data ?? null)) }, '*');
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
    this.initialized ??= this.machine.init(await this.#temps()).catch((e) => {
      this.initialized = null;
      throw e;
    });
    return this.initialized;
  }

  async #temps() {
    try {
      const s = await this.backend.api('GET', 'mailbean/get_settings/x');
      const t = s.multiDevice?.mainDevice ?? s;
      return { coffeeReady: t.coffeeReady, hotWaterReady: t.hotWaterReady, coffeeUse: t.coffeeUse, hotWaterUse: t.hotWaterUse, coffeeExtract: t.coffeeExtraction, hotWaterExtract: t.hotWaterExtraction };
    } catch {
      return this.definition.temperatures;
    }
  }

  async catalog() {
    const d = await this.engine.load();
    const withImg = async (list, key) => Promise.all(list.map(async (g) => ({ ...g, img_url: await this.backend.mediaUrlAsync(g[key]) })));
    const snap = this.link.snapshot;
    const main = Object.values(snap?.devices ?? {}).find((x) => x.type === 'mailbean-mainboard');
    return {
      settings: d.settings,
      store: { ...d.store, logo_url: d.store.st_logo ? await this.backend.mediaUrlAsync(`/media/${d.store.st_logo}`.replace('/media//media/', '/media/')) : '' },
      categories: d.categories,
      goods: (await withImg(d.goods, 'gds_img')).map((g) => ({ ...g, soldOut: this.engine.soldOutReasons(g) })),
      ptGoods: await withImg(d.ptGoods, 'pt_gds_img'),
      ingredients: d.ingredients,
      temps: main?.temps ?? null,
      devices: { cup: !!this.machine.cup, ice: !!this.machine.ice },
    };
  }

  goodsById(id) {
    const g = this.engine.data?.goods.find((x) => x.gds_id === id);
    if (!g) throw new Error(`메뉴 없음: ${id}`);
    return g;
  }

  async call(method, ...args) {
    const d = this.definition;
    switch (method) {
      // ---------------------------------------------------------- simple API
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
      case 'order': {
        await this.ensureInit();
        const item = d.menu.find((x) => x.id === args[0]);
        if (!item) throw new Error(`메뉴 없음: ${args[0]}`);
        await this.machine.order(item, { temp: args[1] ?? item.temps?.[0] });
        return true;
      }
      // ---------------------------------------------------------- full kiosk API
      case 'meta':
        return { dataCodes: backendSeed.DATA_CODES, recipeFields: backendSeed.RECIPE_FIELDS, washParts: euro.WASH_PARTS, washLabel: euro.WASH_LABEL, ingredients: backendSeed.INGREDIENTS, ingredientLabel: backendSeed.INGREDIENT_LABEL, mode: this.link.mode };
      case 'catalog':
        return this.catalog();
      case 'api':
        return this.backend.api(args[0], args[1], args[2]);
      case 'payCard':
        await this.ensureInit();
        return this.machine.pay(Number(args[0]));
      case 'payBarcode':
        return this.machine.pay_.approveBarcode(args[0], Number(args[1]), args[2]);
      case 'waitCardRemoved':
        return this.machine.pay_.waitCardRemoved({ timeoutMs: 120000 });
      case 'cancelPayment': {
        const pay = d.devices.find((x) => x.type === 'kscat-terminal');
        return pay && this.link.interact({ type: 'device', device: pay.key, action: { type: 'cancel' } });
      }
      case 'insertPayment': {
        const res = await this.backend.api('POST', 'mailbean/payment_data_insert/', args[0]);
        return { ...res, receipt: await this.backend.receiptUrl(res.recipt_url) };
      }
      case 'makeDrinks':
        await this.ensureInit();
        await this.engine.makeDrinks(args[0].map((id) => this.goodsById(id)), args[1] ?? {});
        return true;
      case 'wash':
        await this.ensureInit();
        return this.engine.wash(args[0]);
      case 'cupOut':
        return this.engine.cupOut(args[0]);
      case 'resetCup':
        await this.machine.cup.reset();
        return this.engine.refill(args[0] === 'ice' ? 'cup2' : 'cup1');
      case 'resetIce':
        return this.engine.resetIce();
      case 'setTemperatures':
        return this.engine.setTemperatures(args[0]);
      case 'refill':
        return this.engine.refill(args[0]);
      case 'reload':
        return this.catalog();
      case 'saveGoods':
        return this.backend.api('PUT', 'cafesim-admin/goods', args[0]);
      default:
        throw new Error(`Unknown kiosk method: ${method}`);
    }
  }
}
