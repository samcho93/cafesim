import { Emitter, sleep } from '../util/Emitter.js';
import { runCodes, splitCodes, ingredientsForCode, CODE_INGREDIENT, CLEAN_MAP, wash as washPart, WASH_LABEL } from './euro.js';
import { buildCancelTelegram } from './clients.js';

/**
 * The kiosk app's machine-side logic (makeDrinks / euro / wash / inventory / remote commands),
 * driven by the menu and settings of a (virtual) Mailbean backend.
 *
 *   const engine = new KioskEngine({ machine, api });   // api(method, path, body) -> json
 *   await engine.load();
 *   await engine.makeDrinks([goods, goods], { personalCup: false });
 *
 * Events: 'progress' { index, total, goods, phase, text }, 'data' (backend data changed),
 *         'remote' { title, data, status }, 'notice' { level, text }
 */
export class KioskEngine extends Emitter {
  constructor({ machine, api }) {
    super();
    this.machine = machine;
    this.api = api;
    this.data = null;
    this.washing = null;
  }

  get settings() {
    return this.data?.settings ?? {};
  }
  get mac() {
    return this.settings.MacAddr;
  }

  async get(path) {
    return this.api('GET', `mailbean/${path}`);
  }
  async post(path, body) {
    return this.api('POST', `mailbean/${path}`, body);
  }

  /** Pull everything the kiosk app pulls on start (get_settings, goods, categories, store ...). */
  async load() {
    const settings = await this.get(`get_settings/${this.mac ?? 'SIM-M400-0001'}`);
    const [goods, categories, ptGoods, store, ingredients, perSec] = await Promise.all([
      this.get(`goods_list/${settings.admin}`),
      this.get(`goods_category_list/${settings.admin}`),
      this.get(`pt_goods_list/${settings.MacAddr}`),
      this.get(`store_detail_list/${settings.admin}`),
      this.get(`ingredient_list/${settings.MacAddr}/`),
      this.get(`get_ingr_amount_per_once/${settings.MacAddr}/`),
    ]);
    this.data = { settings, goods, categories, ptGoods, store, ingredients, perSec };
    this.emit('data', this.data);
    return this.data;
  }

  async refreshIngredients() {
    this.data.ingredients = await this.get(`ingredient_list/${this.mac}/`);
    this.emit('data', this.data);
    return this.data.ingredients;
  }

  // ------------------------------------------------------------------ sold out (uiHandlerer.js)
  soldOutReasons(goods) {
    const reasons = [];
    if (goods.gds_status === 'sold_out') reasons.push('server');
    const st = this.data?.store ?? {};
    const ing = this.data?.ingredients ?? {};
    const mode = st.st_dtl_auto_soldout_status ?? 'N';
    if (goods.gds_type !== 'goods-drink') return reasons;
    if (mode === 'ingredient' || mode === 'both') {
      for (const [code, item] of Object.entries(CODE_INGREDIENT)) if (String(goods.gds_recipe?.dataCodes ?? '').includes(code) && Number(ing[`${item}_now`]) <= 0) reasons.push(item);
    }
    if ((mode === 'cup' || mode === 'both') && this.machine.cup) {
      const cup = isIce(goods) ? 'cup2' : 'cup1';
      if (Number(ing[`${cup}_now`]) <= 0) reasons.push(cup);
    }
    return [...new Set(reasons)];
  }

  // ------------------------------------------------------------------ inventory
  async consume(item, amount) {
    const ing = this.data.ingredients;
    const now = Math.max(0, Number(ing[`${item}_now`] ?? 0) - amount);
    ing[`${item}_now`] = Math.round(now * 100) / 100;
    await this.post(`consume_ingr/${this.mac}/`, { [`${item}_now`]: ing[`${item}_now`] });
    await this.#checkNotification(item);
    this.emit('data', this.data);
  }

  async #checkNotification(item) {
    const ing = this.data.ingredients;
    const max = Number(ing[`${item}_max`]) || 1;
    const per = (Number(ing[`${item}_now`]) / max) * 100;
    if (per >= Number(ing[`${item}_notification_per`] ?? 30) || ing[`${item}_notification_status`] !== 'N') return;
    ing[`${item}_notification_status`] = 'Y';
    await this.get(`update_notification_status_toY/${this.mac}/${item}`);
    const tpl = await this.get(`get_template_info/${this.mac}/CM_INGR_REMAINING_NOTIFICATION/${item}`);
    const msg = String(tpl.template_detail ?? '')
      .replaceAll('#{매장명}', tpl.store_name)
      .replaceAll('#{물품명}', tpl.ingr_nick_name)
      .replaceAll('#{물품위치}', item)
      .replaceAll('#{알림기준}', ing[`${item}_notification_per`]);
    const res = await this.api('POST', 'alimtalk', { template_code: tpl.template_code, phn: tpl.owner_tel, msg });
    await this.post(`save_alimtalk_log/${this.mac}/${tpl.template_code}/`, { talk_send_msg: msg, talk_send_res_data: res });
    this.emit('notice', { level: 'warn', text: `재고 알림톡(가상): ${msg}` });
  }

  // ------------------------------------------------------------------ production (makeDrinks)
  /**
   * @param list   goods objects, one per cup (a cart of 2 x americano = 2 entries)
   * @param personalCup  true: customer's tumbler, no cup is dispensed
   */
  async makeDrinks(list, { personalCup = false } = {}) {
    if (!this.data) await this.load();
    const drinks = list.filter((g) => g.gds_type === 'goods-drink');
    const total = drinks.length;
    const usedCodes = new Set();
    await this.machine.exclusive('주문', async () => {
      for (let i = 0; i < drinks.length; i++) {
        const goods = drinks[i];
        const p = (phase, text) => this.emit('progress', { index: i, total, goods: { gds_id: goods.gds_id, gds_name: goods.gds_name }, phase, text });
        const ice = isIce(goods);
        const r = goods.gds_recipe;
        const spout = Number(goods.gds_spout_num ?? r.gds_spout_num ?? 1);
        const m = this.machine;

        if (!personalCup && m.cup && this.settings.multiDevice?.cupDispenser?.useState !== 'N') {
          p('cup', `${ice ? 'ICE' : 'HOT'} 컵을 꺼내 주세요`);
          await this.consume(ice ? 'cup2' : 'cup1', 1);
          await m.cup.dispense(ice ? 'ice' : 'hot');
        }
        if (ice && m.ice && this.settings.multiDevice?.iceDispenser?.useState !== 'N') {
          p('ice', '제빙기에서 얼음을 받아 주세요');
          await m.ice.dispense(Number(r.iceGenIce) || 0, Number(r.iceGenWater) || 0);
        }
        if (String(r.dataCodes).includes('S200')) {
          p('done', '얼음물 완료 - 컵을 가져가세요');
          await sleep(1500);
          continue;
        }
        const main = m.main;
        await main.menuMode(true);
        await main.lamp(spout, 2);
        p('place', `${spout}번 추출구로 컵을 옮겨 주세요`);
        await main.waitCup(spout);
        await main.lamp(spout, 1);
        p('brew', `${goods.gds_name.replace(/\n/g, ' ')} 제조 중입니다`);
        await runCodes(main, goods, { feed: this.settings.feed, onStep: (code, warn) => warn && this.emit('notice', { level: 'warn', text: warn }) });
        for (const code of splitCodes(r.dataCodes)) {
          usedCodes.add(code);
          for (const [item, field] of ingredientsForCode(code)) await this.consume(item, (Number(this.data.perSec[item]) || 0) * (Number(r[field]) || 0));
        }
        await main.lamp(spout, 2);
        p('take', i === total - 1 ? '주문하신 음료가 완성되었습니다. 컵을 가져가세요' : '음료를 픽업해 주세요. 다음 음료를 준비합니다');
        await main.waitCupRemoved(spout);
        await main.lamp(spout, 0);
        await main.menuMode(false);
        if (this.data.store?.st_dtl_auto_clean_status === 'drink') await this.#autoClean(splitCodes(r.dataCodes));
      }
      if (this.data.store?.st_dtl_auto_clean_status === 'order') await this.#autoClean([...usedCodes]);
    });
    this.emit('progress', { index: total, total, phase: 'finish', text: '주문이 완료되었습니다' });
  }

  async #autoClean(codes) {
    const lines = this.data.store?.st_dtl_auto_clean_line ?? {};
    const parts = [...new Set(codes.map((c) => CLEAN_MAP[c]).filter(([line] = []) => line && lines[line] === 'Y').map(([, part]) => part))];
    for (const part of parts) {
      this.emit('progress', { phase: 'wash', text: `고온 세척 중 (${WASH_LABEL[part]})` });
      await washPart(this.machine.main, part, this.settings);
    }
  }

  // ------------------------------------------------------------------ admin / maintenance
  async wash(part, times = 1) {
    return this.machine.exclusive('세척', async () => {
      this.washing = part;
      this.emit('progress', { phase: 'wash', text: `세척 중: ${WASH_LABEL[part] ?? part}` });
      try {
        for (let i = 0; i < Math.max(1, Number(times) || 1); i++) await washPart(this.machine.main, part, this.settings);
      } finally {
        this.washing = null;
        this.emit('progress', { phase: 'wash-done', text: '세척 완료' });
      }
    });
  }

  async cupOut(type) {
    return this.machine.exclusive('컵 배출', async () => {
      await this.consume(type === 'ice' ? 'cup2' : 'cup1', 1);
      await this.machine.cup.dispense(type);
    });
  }

  async iceOut(ice, water) {
    return this.machine.exclusive('출빙', () => this.machine.ice.dispense(Number(ice) || 0, Number(water) || 0));
  }

  async resetIce() {
    await this.machine.ice.reboot();
    await sleep(2500);
    await this.machine.ice.init();
  }

  async refill(item) {
    await this.get(`ingredient_fill/${this.mac}/${item}/`);
    await this.refreshIngredients();
  }

  async setTemperatures(t) {
    await this.post(`update_temp_set/${this.mac}/`, t);
    await this.machine.main.setTemperatures({ coffeeReady: t.coffeeReady, hotWaterReady: t.hotWaterReady, coffeeUse: t.coffeeUse, hotWaterUse: t.hotWaterUse, coffeeExtract: t.coffeeExtraction, hotWaterExtract: t.hotWaterExtraction });
    await this.machine.main.write('S016', [Number(t.coffeeOffset) || 0, Number(t.hotWaterOffset) || 0]);
    await this.load();
  }

  // ------------------------------------------------------------------ remote commands (SSE)
  async handleRemote({ title, data = {} }) {
    const report = (status, extra = {}) => this.emit('remote', { title, data, status, ...extra });
    try {
      report('start');
      switch (title) {
        case 'remote-refill':
          await this.load();
          break;
        case 'remote-wash':
          await this.wash(data.wash_part ?? 'all', data.wash_num ?? 1);
          break;
        case 'remote-cup':
          await this.cupOut(data.cup_out_num === 'cup1-out' ? 'hot' : 'ice');
          break;
        case 'remote-ice':
          await this.iceOut(data.ice_out_time, data.water_out_time);
          break;
        case 'remote-extraction': {
          if (!this.data) await this.load();
          const goods = this.data.goods.find((g) => g.gds_name.replace(/\n/g, ' ') === data.made_gds_name || g.gds_id === data.made_gds_id);
          if (!goods) throw new Error(`메뉴 없음: ${data.made_gds_name}`);
          const methods = String(data.made_method_ids ?? 'cup-extract,ice-extract,drink-extract').split(',');
          const g = structuredClone(goods);
          if (!methods.includes('ice-extract')) g.gds_recipe.iceGenIce = g.gds_recipe.iceGenWater = '0';
          if (!methods.includes('drink-extract')) g.gds_recipe.dataCodes = 'S200';
          await this.makeDrinks([g], { personalCup: !methods.includes('cup-extract') });
          break;
        }
        case 'remote-refund':
          await this.refund(data);
          break;
        case 'remote-restart':
        case 'remote-exit':
        case 'remote-reboot':
          await this.machine.init();
          break;
        case 'remote-loadLog':
          await this.api('POST', `mailbean/upload_log/${this.mac}/`, 'cafeSim web kiosk log');
          break;
        default:
          throw new Error(`unknown remote command ${title}`);
      }
      report('done');
    } catch (e) {
      report('error', { error: e.message });
    }
  }

  /** Card refund (KSCatCanc). Barcode refunds (MI/PC) need the customer's code and are done in the kiosk UI. */
  async refund(req) {
    const d = req.data ?? req;
    const trade = d.TRADEFLAG ?? 'IC';
    const res = await this.machine.pay_.send(buildCancelTelegram({ trade, amount: Number(d.totalAmount ?? req.total_price ?? 0), approvalNo: d.APPROVALNO, tradeTime: d.TRADETIME, tid: this.settings.multiDevice?.cardReader?.TID ?? this.settings.tid }));
    if (res.RES !== '0000') throw new Error(res.MSG ?? '환불 실패');
    await this.post('refund_success/', { ...req, response: res });
    return res;
  }
}

export const isIce = (goods) => {
  const r = goods.gds_recipe ?? {};
  return (r.iceGenIce && r.iceGenIce !== '0') || (r.iceGenWater && r.iceGenWater !== '0');
};
