import { Emitter } from '../util/Emitter.js';
import { seedState, INGREDIENTS, INGREDIENT_LABEL } from './seed.js';

/**
 * Virtual Mailbean cloud (the kiosk app's server: http://{webMode}.mailbean.kr).
 *
 * Transport-agnostic: `handle(method, path, { query, body })` -> { status, body, type }
 *   - the Node server and the Cloudflare Durable Object mount it at /mailbean/*, /notifications/*, /media/*
 *   - in the browser (GitHub Pages) it runs in-process and persists to localStorage
 *
 * Remote commands (SSE) are emitted as 'notify' events: { title, data } and delivered to the
 * kiosk exactly like the real server: `data: {"data": "<JSON {title, data}>"}`.
 *
 * Admin console routes (ours): /cafesim-admin/*
 */
export class MailbeanBackend extends Emitter {
  constructor({ state, save, mac } = {}) {
    super();
    this.state = state ?? seedState(mac);
    this.save = save ?? (() => {});
    this.#saveTimer = null;
  }

  #saveTimer;

  changed(what) {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => this.save(this.state), 300);
    this.emit('change', what);
  }

  reset() {
    const mac = this.state.settings.MacAddr;
    this.state = seedState(mac);
    this.changed('all');
  }

  /** Push a remote command to the kiosk(s) (SSE). */
  notify(title, data = {}) {
    const msg = { title, data, at: new Date().toISOString() };
    this.state.remote.unshift(msg);
    this.state.remote.length = Math.min(this.state.remote.length, 50);
    this.changed('remote');
    this.emit('notify', { title, data });
    return msg;
  }

  /** SSE frame body for one command, as the kiosk parses it. */
  static sseFrame(cmd) {
    return `data: ${JSON.stringify({ data: JSON.stringify(cmd) })}\n\n`;
  }

  // ======================================================================== request handling
  async handle(method, rawPath, { query = {}, body = null } = {}) {
    try {
      const path = rawPath.replace(/\/+$/, '').replace(/^\/+/, '');
      const parts = path.split('/').map(decodeURIComponent);
      if (parts[0] === 'mailbean') return this.#api(method.toUpperCase(), parts.slice(1), body ?? {}, query);
      if (parts[0] === 'media' && parts[1] === 'sim') return this.#media(parts[2] ?? '');
      if (parts[0] === 'cafesim-admin') return this.#admin(method.toUpperCase(), parts.slice(1), body ?? {});
      if (parts[0] === 'receipt') return this.#receipt(parts[1]);
      if (parts[0] === 'alimtalk') return this.#alimtalk(body ?? {});
      return { status: 404, body: { error: 'not found' } };
    } catch (e) {
      return { status: 500, body: { error: e.message } };
    }
  }

  #ok(body) {
    return { status: 200, body };
  }

  #api(method, [name, ...args], body) {
    const s = this.state;
    s.machine.lastSeen = new Date().toISOString();
    const ing = s.ingredients;
    switch (name) {
      case 'get_settings':
        return this.#ok({ ...s.settings });
      case 'update_swfw_ver':
        s.machine.sw = body.cm_sw_version ?? s.machine.sw;
        s.machine.fw = body.cm_fw_version ?? s.machine.fw;
        this.changed('machine');
        return this.#ok({ message: 'ok' });
      case 'goods_list':
        return this.#ok(s.goods.filter((g) => g.gds_status !== 'deleted'));
      case 'goods_category_list':
        return this.#ok(s.categories);
      case 'pt_goods_list':
        return this.#ok(s.ptGoods);
      case 'store_detail_list':
        return this.#ok({ ...s.store });
      case 'coffeemachine_list':
        return this.#ok([{ cm_id: s.settings.MacAddr, cm_name: 'cafeSim M400' }]);
      case 'ingredient_list':
        return this.#ok({ ...ing });
      case 'get_ingr_amount_per_once':
        return this.#ok({ ...s.perSec });
      case 'consume_ingr':
        for (const [k, v] of Object.entries(body)) if (k.endsWith('_now') && k in ing) ing[k] = Math.max(0, Number(v));
        this.changed('ingredients');
        return this.#ok({ message: 'consumed' });
      case 'ingredient_fill': {
        const item = args[1];
        if (!INGREDIENTS.includes(item)) return { status: 400, body: { error: 'unknown item' } };
        ing[`${item}_now`] = ing[`${item}_max`];
        ing[`${item}_notification_status`] = 'N';
        if (item === 'cup1' || item === 'cup2') ing[`${item}_backline_exist_status`] = 'Y';
        this.changed('ingredients');
        return this.#ok({ message: `${item} filled` });
      }
      case 'update_backline_cup_toN':
        ing[`cup${args[1]}_backline_exist_status`] = 'N';
        this.changed('ingredients');
        return this.#ok({ message: 'ok' });
      case 'update_notification_status_toY':
        ing[`${args[1]}_notification_status`] = 'Y';
        this.changed('ingredients');
        return this.#ok({ message: 'ok' });
      case 'get_template_info': {
        const item = args[2];
        return this.#ok({
          store_name: s.store.st_name,
          template_code: args[1] || 'CM_INGR_REMAINING_NOTIFICATION',
          template_detail: s.templates.CM_INGR_REMAINING_NOTIFICATION,
          owner_tel: '010-0000-0000',
          ingr_nick_name: INGREDIENT_LABEL[item] ?? item,
        });
      }
      case 'save_alimtalk_log':
        s.alimtalk.unshift({ at: new Date().toISOString(), template: args[1], ...body });
        s.alimtalk.length = Math.min(s.alimtalk.length, 100);
        this.changed('alimtalk');
        return this.#ok({ message: 'saved' });
      case 'check_cust_tel': {
        const c = s.customers[args[1]];
        return this.#ok(c ? { st_customer: 'Y', point: c.point } : { st_customer: 'N', point: 0 });
      }
      case 'check_cust_before_use_pt': {
        const c = s.customers[args[1]];
        if (!c || c.pw !== args[2]) return this.#ok({ st_cust_pt: 0, message: 'invalid password' });
        return this.#ok({ st_cust_pt: c.point });
      }
      case 'check_rfid_card_uid': {
        const uid = String(args[1] ?? '').toUpperCase();
        if (!/^[0-9A-F]+$/.test(uid)) return this.#ok({ status: 'Invalid hexadecimal' });
        return this.#ok({ status: s.rfid.map((x) => x.toUpperCase()).includes(uid) ? 'RFID card exist' : "RFID card doesn't exist" });
      }
      case 'payment_data_insert':
        return this.#ok(this.recordPayment(body));
      case 'refund_success': {
        const pay = s.payments.find((p) => p.pay_id === body.pay_id);
        if (pay) pay.refund_status = 'refunded';
        s.refunds.unshift({ at: new Date().toISOString(), ...body });
        this.changed('payments');
        return this.#ok({ message: 'refund recorded' });
      }
      case 'update_temp_set': {
        const t = s.settings;
        for (const k of ['coffeeReady', 'coffeeUse', 'coffeeExtraction', 'hotWaterReady', 'hotWaterUse', 'hotWaterExtraction', 'coffeeOffset', 'hotWaterOffset']) {
          if (body[k] !== undefined) {
            t[k] = String(body[k]);
            t.multiDevice.mainDevice[k] = String(body[k]);
          }
        }
        this.changed('settings');
        return this.#ok({ message: 'ok' });
      }
      case 'update_err_state':
        s.machine.errors = body;
        this.changed('machine');
        return this.#ok({ message: 'ok' });
      case 'upload_log':
        s.uploads.unshift({ at: new Date().toISOString(), size: typeof body === 'string' ? body.length : 0 });
        s.uploads.length = Math.min(s.uploads.length, 20);
        this.changed('uploads');
        return this.#ok({ message: 'uploaded' });
      case 'update_recipe': {
        const g = s.goods.find((x) => x.gds_id === body.gds_id);
        if (g && body.gds_recipe) Object.assign(g.gds_recipe, body.gds_recipe);
        this.changed('goods');
        return this.#ok({ message: 'ok' });
      }
      default:
        return { status: 404, body: { error: `unknown api ${name}` } };
    }
  }

  /** payment_data_insert: store the sale, apply points, return the receipt URL. */
  recordPayment(p) {
    const s = this.state;
    const id = `PAY${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 1000)}`;
    const record = { pay_id: id, at: new Date().toISOString(), refund_status: null, ...p };
    s.payments.unshift(record);
    s.payments.length = Math.min(s.payments.length, 300);
    const tel = p.cust_tel;
    if (tel) {
      const c = (s.customers[tel] ??= { point: 0, pw: p.cust_point_pw || '' });
      if (!c.pw && p.cust_point_pw) c.pw = p.cust_point_pw;
      c.point = Math.max(0, c.point - Number(p.point_amount_use || 0) + Number(p.point_amount_accum || 0));
    }
    this.changed('payments');
    return { recipt_url: `/receipt/${id}`, pay_id: id };
  }

  // ======================================================================== media (menu images, logo)
  #media(file) {
    const id = file.replace(/\.svg$/, '');
    if (id === 'logo') return { status: 200, type: 'image/svg+xml', body: LOGO_SVG };
    if (id === 'coupon') return { status: 200, type: 'image/svg+xml', body: cupSvg('#e8b04a', false, '쿠폰') };
    const g = this.state.goods.find((x) => x.gds_id === id);
    return { status: 200, type: 'image/svg+xml', body: cupSvg(g?.sim_color ?? '#6b4226', g?.gds_recipe?.ice_YN === 'Y', g?.gds_type === 'goods-etc' ? '' : null) };
  }

  #receipt(id) {
    const p = this.state.payments.find((x) => x.pay_id === id);
    const esc = (v) => String(v ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
    const rows = (p?.pay_goods_detail ?? []).map((g) => `<tr><td>${esc(g.gds_name)}</td><td>${esc(g.pay_gds_stock)}</td><td>${Number(g.pay_price || 0).toLocaleString()}원</td></tr>`).join('');
    const html = p
      ? `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>영수증 ${esc(id)}</title>
<body style="font-family:system-ui,'Malgun Gothic';max-width:420px;margin:24px auto;padding:0 16px"><h2>${esc(this.state.store.st_name)}</h2>
<p>승인번호 ${esc(p.pay_card_dtl_auth_num)} · ${esc(p.pay_method)} · ${esc(p.at)}</p><table style="width:100%;border-collapse:collapse">${rows}</table>
<h3>합계 ${Number(p.pay_card_dtl_price || 0).toLocaleString()}원</h3>${p.refund_status ? '<p style="color:#c00">환불됨</p>' : ''}<p style="color:#888">cafeSim 가상 영수증</p></body>`
      : '<!doctype html><meta charset="utf-8"><p>영수증을 찾을 수 없습니다</p>';
    return { status: p ? 200 : 404, type: 'text/html; charset=utf-8', body: html };
  }

  /** Kakao alimtalk (sweettracker) stand-in: never sends anything, just logs. */
  #alimtalk(body) {
    const list = Array.isArray(body) ? body : [body];
    for (const m of list) this.state.alimtalk.unshift({ at: new Date().toISOString(), template: m.template_code ?? m.tmplId ?? '', to: m.phn ?? m.receiver ?? '', msg: m.msg ?? m.message ?? JSON.stringify(m).slice(0, 300), sim: true });
    this.changed('alimtalk');
    return this.#ok([{ result: 'Y', code: 'K000', error: '', msgid: `SIM${Date.now()}` }]);
  }

  // ======================================================================== admin console API
  #admin(method, [what, id], body) {
    const s = this.state;
    if (method === 'GET' && (what === 'state' || !what)) return this.#ok(s);
    if (method === 'POST' && what === 'reset') {
      this.reset();
      return this.#ok({ ok: true });
    }
    if (method === 'POST' && what === 'remote') return this.#ok(this.notify(body.title, body.data ?? {}));
    if (what === 'goods') {
      if (method === 'DELETE') {
        s.goods = s.goods.filter((g) => g.gds_id !== id);
      } else {
        const idx = s.goods.findIndex((g) => g.gds_id === body.gds_id);
        if (idx >= 0) s.goods[idx] = body;
        else {
          body.gds_id ||= `GdsSIM${String(Date.now()).slice(-6)}`;
          body.gds_seq ||= Math.max(0, ...s.goods.map((g) => g.gds_seq)) + 1;
          body.gds_img ||= `/media/sim/${body.gds_id}.svg`;
          s.goods.push(body);
        }
      }
      this.changed('goods');
      this.notify('remote-refill', {}); // let the kiosk reload (menus are pulled on reload/idle)
      return this.#ok({ ok: true, goods: s.goods });
    }
    const assign = { categories: 'categories', ptgoods: 'ptGoods', store: 'store', settings: 'settings', ingredients: 'ingredients', persec: 'perSec', customers: 'customers', rfid: 'rfid', templates: 'templates' }[what];
    if (assign && (method === 'PUT' || method === 'POST')) {
      const replace = ['categories', 'ptGoods', 'customers', 'rfid', 'perSec'].includes(assign) || Array.isArray(body) || typeof body !== 'object';
      s[assign] = replace ? body : { ...s[assign], ...body };
      this.changed(assign);
      return this.#ok({ ok: true, [assign]: s[assign] });
    }
    return { status: 404, body: { error: 'unknown admin route' } };
  }
}

const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 60"><rect width="160" height="60" rx="12" fill="#1d1f22"/><circle cx="30" cy="30" r="14" fill="#c8372b"/><text x="52" y="38" font-family="Arial" font-weight="700" font-size="22" fill="#fff">cafeSim</text></svg>`;

function cupSvg(color, ice, etc) {
  if (etc !== null && etc !== undefined) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect width="200" height="200" fill="#f7f4ef"/><circle cx="100" cy="100" r="58" fill="${color}"/><circle cx="80" cy="85" r="7" fill="#5a3522"/><circle cx="115" cy="80" r="6" fill="#5a3522"/><circle cx="105" cy="118" r="7" fill="#5a3522"/>${etc ? `<text x="100" y="185" text-anchor="middle" font-size="22" font-family="Arial" fill="#555">${etc}</text>` : ''}</svg>`;
  }
  const cubes = ice ? '<rect x="78" y="80" width="18" height="18" rx="3" fill="#fff" opacity=".7"/><rect x="104" y="96" width="18" height="18" rx="3" fill="#fff" opacity=".6"/><rect x="86" y="118" width="18" height="18" rx="3" fill="#fff" opacity=".6"/>' : '';
  const cup = ice ? '#e9f3fb' : '#ffffff';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect width="200" height="200" fill="#f7f4ef"/><path d="M58 50h84l-12 128H70z" fill="${cup}" stroke="#ddd"/><path d="M62 72h76l-9 104H71z" fill="${color}"/>${cubes}${ice ? '' : '<path d="M60 92h80l-3 38H63z" fill="#c8372b"/>'}<rect x="52" y="38" width="96" height="14" rx="6" fill="${ice ? '#e1e5e8' : '#3b3b3b'}"/></svg>`;
}
