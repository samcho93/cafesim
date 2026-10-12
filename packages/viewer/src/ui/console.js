import { backendSeed, euro } from '@cafesim/core';

const { DATA_CODES, INGREDIENTS, INGREDIENT_LABEL, emptyRecipe } = backendSeed;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const CATEGORY_NAME_OK = /^[0-9A-Za-z가-힣ㄱ-ㅎ·\-_ ]+$/; // the kiosk builds jQuery id selectors from category names

const RECIPE_GROUPS = [
  ['커피', [['coffee', '커피량 cc'], ['water', '온수량 cc'], ['grinderTime1', '그라인더1 초'], ['grinderTime2', '그라인더2 초']]],
  ...[1, 2, 3, 4, 5, 6].map((n) => [`파우더${n} (S${155 + n})`, [[`powder${n}`, '파우더 추출량 cc'], [`powderFeedTime${n}`, '피더 시간 초'], [`powderHotWaterAmount${n}`, '온수량 cc (에이드1 라인)'], [`powderMixTime${n}`, '믹서 시간 초 (미사용)']]]),
  ...[1, 2, 3].map((n) => [`에이드${n} (S${161 + n})`, [[`adeWater${n}`, '물량 cc'], [`adePumpTime${n}`, '시럽 펌프 초']]]),
  ['얼음 / 기타', [['iceGenIce', '제빙기 얼음 초'], ['iceGenWater', '제빙기 물 초'], ['teaBagHotWater', '티백 온수 cc (S188)'], ['soak', '불림 (미사용)'], ['soakWater', '불림 물 (미사용)'], ['dumping', '덤핑 (미사용)']]],
];

const TABS = [
  ['goods', '메뉴·레시피'],
  ['categories', '카테고리'],
  ['store', '매장 설정'],
  ['settings', '장비 설정'],
  ['stock', '재고'],
  ['customers', '고객·포인트·RFID'],
  ['payments', '결제·환불'],
  ['remote', '원격 제어'],
  ['logs', '알림·데이터'],
];

/**
 * Admin console of the virtual Mailbean cloud: everything the real server lets an operator
 * configure for the kiosk (menus/recipes, categories, store & device settings, stock, customers,
 * payments/refunds) plus the SSE remote commands.
 */
export class AdminConsole {
  tab = 'goods';
  selected = null;

  constructor({ backend, bridge, definition, toast }) {
    Object.assign(this, { backend, bridge, definition, toast });
    this.root = document.createElement('div');
    this.root.className = 'console-overlay';
    this.root.hidden = true;
    document.body.append(this.root);
    backend.onChange?.(() => this.visible && this.tab !== 'goods' && this.refresh(false));
  }

  get visible() {
    return !this.root.hidden;
  }

  async open(tab) {
    if (tab) this.tab = tab;
    this.root.hidden = false;
    await this.refresh();
  }

  close() {
    this.root.hidden = true;
  }

  async api(method, path, body) {
    return this.backend.api(method, path, body);
  }

  async refresh(full = true) {
    this.state = await this.api('GET', 'cafesim-admin/state');
    if (!full && document.activeElement && this.root.contains(document.activeElement) && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
    this.render();
  }

  async save(what, body, msg = '저장했습니다') {
    await this.api('PUT', `cafesim-admin/${what}`, body);
    this.toast(msg);
    await this.refresh();
  }

  render() {
    const s = this.state;
    this.root.innerHTML = `
      <div class="adm-console">
        <header class="console-head">
          <b>가상 메일빈 서버</b>
          <span class="muted">${esc(s.store.st_name)} · 장비 ${esc(s.settings.MacAddr)} · ${this.backend.mode === 'local' ? '이 브라우저에 저장' : `서버 ${esc(this.backend.base)}${this.backend.room ? ` (room ${esc(this.backend.room)})` : ''}`}</span>
          <button class="console-close" data-close>✕ 닫기</button>
        </header>
        <nav class="console-tabs">${TABS.map(([id, label]) => `<button data-tab="${id}" class="${id === this.tab ? 'active' : ''}">${label}</button>`).join('')}</nav>
        <section class="console-body">${this[`tab_${this.tab}`]()}</section>
      </div>`;
    this.root.querySelector('[data-close]').onclick = () => this.close();
    this.root.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => ((this.tab = b.dataset.tab), this.render())));
    this[`bind_${this.tab}`]?.();
  }

  // ================================================================== 메뉴·레시피
  tab_goods() {
    const s = this.state;
    const g = this.selected ? s.goods.find((x) => x.gds_id === this.selected) ?? this.draft : null;
    const rows = s.goods
      .slice()
      .sort((a, b) => a.gds_seq - b.gds_seq)
      .map(
        (x) => `<tr data-gid="${x.gds_id}" class="${x.gds_id === this.selected ? 'sel' : ''}"><td>${x.gds_seq}</td><td><span class="swatch" style="background:${esc(x.sim_color ?? '#888')}"></span>${esc(x.gds_name)}</td><td>${Number(x.gds_price).toLocaleString()}</td>
        <td><code>${esc(x.gds_recipe?.dataCodes || '-')}</code></td><td>${esc(x.gds_spout_num)}</td><td>${x.gds_recipe?.ice_YN === 'Y' ? 'ICE' : x.gds_type === 'goods-etc' ? '기타' : 'HOT'}</td><td class="st-${x.gds_status}">${statusLabel(x.gds_status)}</td></tr>`,
      )
      .join('');
    return `<div class="split">
      <div class="list-pane"><div class="btn-row"><button data-act="new" class="primary">+ 새 메뉴</button></div>
        <table class="grid"><thead><tr><th>#</th><th>메뉴</th><th>가격</th><th>dataCodes</th><th>투출구</th><th>구분</th><th>상태</th></tr></thead><tbody>${rows}</tbody></table>
        <p class="muted">메뉴는 키오스크(웹·원본 앱)가 서버에서 받아 표시합니다. 저장하면 키오스크에 원격 새로고침(remote-refill)을 보냅니다.</p></div>
      <div class="edit-pane">${g ? this.goodsForm(g) : '<p class="muted">왼쪽에서 메뉴를 선택하거나 새 메뉴를 만드세요.</p>'}</div></div>`;
  }

  goodsForm(g) {
    const r = { ...emptyRecipe(), ...g.gds_recipe };
    const cats = this.state.categories.map((c) => c.gds_cat_name);
    const myCats = String(r.categoryList || '').split('_').filter(Boolean);
    const codes = euro.splitCodes(r.dataCodes).map((c) => ({ S184: 'S150', S185: 'S171' })[c] ?? c);
    const usedFields = new Set(codes.flatMap((c) => DATA_CODES.find((d) => d.code === c)?.uses ?? []));
    return `<form class="goods-form" autocomplete="off">
      <div class="form-grid">
        <label>메뉴명<input name="gds_name" value="${esc(g.gds_name)}" required></label>
        <label>가격(원)<input name="gds_price" type="number" min="0" step="100" value="${esc(g.gds_price)}"></label>
        <label>순서<input name="gds_seq" type="number" value="${esc(g.gds_seq)}"></label>
        <label>유형<select name="gds_type"><option value="goods-drink" ${g.gds_type === 'goods-drink' ? 'selected' : ''}>음료 (제조)</option><option value="goods-etc" ${g.gds_type === 'goods-etc' ? 'selected' : ''}>기타 상품 (제조 없음)</option></select></label>
        <label>상태<select name="gds_status">${['displayed', 'not_displayed', 'sold_out', 'deleted'].map((v) => `<option value="${v}" ${g.gds_status === v ? 'selected' : ''}>${statusLabel(v)}</option>`).join('')}</select></label>
        <label>투출구<select name="gds_spout_num">${['1', '2', '3'].map((v) => `<option ${String(g.gds_spout_num) === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label>ICE 표시(ice_YN)<select name="ice_YN"><option value="N">HOT</option><option value="Y" ${r.ice_YN === 'Y' ? 'selected' : ''}>ICE</option></select></label>
        <label>색상(시뮬레이터)<input name="sim_color" type="color" value="${esc(g.sim_color ?? '#6b4226')}"></label>
        <label>BEST<select name="gds_best_tag_status"><option>N</option><option ${g.gds_best_tag_status === 'Y' ? 'selected' : ''}>Y</option></select></label>
        <label>NEW<select name="gds_new_tag_status"><option>N</option><option ${g.gds_new_tag_status === 'Y' ? 'selected' : ''}>Y</option></select></label>
        <label>포인트 적립률 %<input name="gds_point_rate" type="number" value="${esc(g.gds_point_rate ?? 0)}"></label>
      </div>
      <div class="field-row"><b>카테고리</b> ${cats.map((c) => `<label class="chk"><input type="checkbox" name="cat" value="${esc(c)}" ${myCats.includes(c) ? 'checked' : ''}> ${esc(c)}</label>`).join('')}</div>
      <div class="seq-box">
        <b>제조 순서 (dataCodes)</b> <span class="muted">왼쪽부터 차례로 실행 · 클릭해서 추가, 칩의 ✕로 삭제</span>
        <div class="seq" id="seqList">${codes.map((c, i) => `<span class="chip seq-chip" data-i="${i}">${esc(c)} ${esc(DATA_CODES.find((d) => d.code === c)?.label ?? '?')} <a data-del="${i}">✕</a></span>`).join('') || '<span class="muted">비어 있음 (기타 상품)</span>'}</div>
        <div class="btn-row">${DATA_CODES.map((d) => `<button type="button" data-add="${d.code}" title="${esc(d.uses.join(', '))}">${d.code} ${esc(d.label)}</button>`).join('')}</div>
      </div>
      <div class="recipe-groups">${RECIPE_GROUPS.map(
        ([title, fields]) => `<fieldset class="${fields.some(([k]) => usedFields.has(k) || Number(r[k])) ? 'used' : ''}"><legend>${title}</legend>${fields
          .map(([k, label]) => `<label class="${usedFields.has(k) ? 'hl' : ''}">${label}<input name="r_${k}" type="number" step="0.1" min="0" value="${esc(r[k])}"></label>`)
          .join('')}</fieldset>`,
      ).join('')}</div>
      <div class="btn-row sticky">
        <button type="submit" class="primary">저장</button>
        <button type="button" data-act="test">▶ 시뮬레이터에서 제조 테스트</button>
        <button type="button" data-act="dup">복제</button>
        <button type="button" data-act="delete" class="danger">삭제</button>
        <span class="muted">${esc(g.gds_id)}</span>
      </div>
    </form>`;
  }

  bind_goods() {
    const root = this.root;
    root.querySelectorAll('[data-gid]').forEach((tr) => (tr.onclick = () => ((this.selected = tr.dataset.gid), (this.draft = null), this.render())));
    root.querySelector('[data-act="new"]').onclick = () => {
      this.draft = { gds_id: '', gds_name: '새 메뉴', gds_seq: Math.max(0, ...this.state.goods.map((x) => x.gds_seq)) + 1, gds_price: 2000, gds_status: 'displayed', gds_spout_num: '1', gds_type: 'goods-drink', gds_recipe: emptyRecipe({ dataCodes: 'S150', coffee: '40', water: '150', grinderTime1: '2.5' }), gds_option: {}, gds_point_status: 'None', gds_point_rate: 0, gds_best_tag_status: 'N', gds_new_tag_status: 'N', sim_color: '#6b4226' };
      this.selected = '__new';
      this.render();
    };
    const form = root.querySelector('.goods-form');
    if (!form) return;
    const current = () => (this.selected === '__new' ? this.draft : this.state.goods.find((x) => x.gds_id === this.selected));
    const collect = () => {
      const base = structuredClone(current());
      const fd = new FormData(form);
      for (const k of ['gds_name', 'gds_type', 'gds_status', 'gds_spout_num', 'sim_color', 'gds_best_tag_status', 'gds_new_tag_status']) base[k] = fd.get(k);
      base.gds_price = Number(fd.get('gds_price')) || 0;
      base.gds_seq = Number(fd.get('gds_seq')) || 0;
      base.gds_point_rate = Number(fd.get('gds_point_rate')) || 0;
      const r = { ...emptyRecipe(), ...base.gds_recipe };
      for (const [k, v] of fd.entries()) if (k.startsWith('r_')) r[k.slice(2)] = String(v || '0');
      r.ice_YN = fd.get('ice_YN');
      r.categoryList = fd.getAll('cat').join('_');
      r.gdsList = base.gds_name;
      r.gds_spout_num = base.gds_spout_num;
      r.gds_status_show = base.gds_status === 'displayed';
      r.gds_status_soldout = base.gds_status === 'sold_out';
      r.best_gds = base.gds_best_tag_status === 'Y';
      r.new_gds = base.gds_new_tag_status === 'Y';
      r.dataCodes = this.codes ?? r.dataCodes;
      base.gds_recipe = r;
      return base;
    };
    this.codes = current()?.gds_recipe?.dataCodes ?? '';
    const redrawSeq = () => {
      const g = collect();
      if (this.selected === '__new') this.draft = g;
      else Object.assign(this.state.goods.find((x) => x.gds_id === this.selected), g);
      this.render();
    };
    form.querySelectorAll('[data-add]').forEach((b) => (b.onclick = () => ((this.codes += b.dataset.add), redrawSeq())));
    form.querySelectorAll('[data-del]').forEach(
      (a) =>
        (a.onclick = () => {
          const list = String(this.codes).match(/S\d{3}/g) ?? [];
          list.splice(Number(a.dataset.del), 1);
          this.codes = list.join('');
          redrawSeq();
        }),
    );
    form.onsubmit = async (e) => {
      e.preventDefault();
      const g = collect();
      if (!g.gds_recipe.categoryList) return this.toast('카테고리를 하나 이상 선택하세요', 'warn');
      if (g.gds_type === 'goods-drink' && !g.gds_recipe.dataCodes) return this.toast('음료는 제조 순서(dataCodes)가 필요합니다', 'warn');
      const res = await this.api('PUT', 'cafesim-admin/goods', g);
      this.selected = res.goods.find((x) => x.gds_name === g.gds_name && (x.gds_id === g.gds_id || !g.gds_id))?.gds_id ?? this.selected;
      this.draft = null;
      this.toast(`'${g.gds_name}' 저장`);
      await this.refresh();
    };
    form.querySelector('[data-act="delete"]').onclick = async () => {
      const g = current();
      if (!g?.gds_id) return;
      if (!confirm(`'${g.gds_name}' 메뉴를 삭제할까요?`)) return;
      await this.api('DELETE', `cafesim-admin/goods/${g.gds_id}`);
      this.selected = null;
      await this.refresh();
    };
    form.querySelector('[data-act="dup"]').onclick = () => {
      this.draft = { ...collect(), gds_id: '', gds_name: `${collect().gds_name} 복사`, gds_seq: Math.max(...this.state.goods.map((x) => x.gds_seq)) + 1 };
      this.selected = '__new';
      this.render();
    };
    form.querySelector('[data-act="test"]').onclick = async () => {
      const g = collect();
      this.toast(`'${g.gds_name}' 저장 후 제조 테스트 - 3D 화면의 안내를 따르거나 '자동 진행'을 켜세요`);
      const res = await this.api('PUT', 'cafesim-admin/goods', g);
      const saved = res.goods.find((x) => x.gds_name === g.gds_name);
      this.close();
      try {
        await this.bridge.engine.load();
        await this.bridge.call('makeDrinks', [saved.gds_id], {});
        this.toast(`'${g.gds_name}' 제조 완료`);
      } catch (err) {
        this.toast(`제조 실패: ${err.message}`, 'error');
      }
    };
  }

  // ================================================================== 카테고리
  tab_categories() {
    const rows = this.state.categories
      .map((c, i) => `<tr><td><input name="seq" type="number" value="${c.gds_cat_seq}" data-i="${i}"></td><td><input name="name" value="${esc(c.gds_cat_name)}" data-i="${i}"></td>
      <td><select name="status" data-i="${i}"><option value="displayed">표시</option><option value="not_displayed" ${c.gds_cat_status !== 'displayed' ? 'selected' : ''}>숨김</option></select></td><td><button data-del="${i}">삭제</button></td></tr>`)
      .join('');
    return `<table class="grid narrow"><thead><tr><th>순서</th><th>이름</th><th>표시</th><th></th></tr></thead><tbody>${rows}</tbody></table>
      <div class="btn-row"><button data-act="add">+ 카테고리</button><button data-act="save" class="primary">저장</button></div>
      <p class="muted">'전체메뉴' 카테고리가 있으면 키오스크에 전체 탭이 생깁니다. 이름에는 / . # 같은 특수문자를 쓸 수 없습니다 (원본 키오스크가 이름으로 화면 요소를 찾습니다).</p>`;
  }

  bind_categories() {
    const list = structuredClone(this.state.categories);
    const read = () =>
      this.root.querySelectorAll('[data-i]').forEach((el) => {
        const c = list[el.dataset.i];
        if (el.name === 'seq') c.gds_cat_seq = Number(el.value);
        if (el.name === 'name') c.gds_cat_name = el.value.trim();
        if (el.name === 'status') c.gds_cat_status = el.value;
      });
    this.root.querySelector('[data-act="add"]').onclick = async () => {
      read();
      list.push({ gds_cat_name: '새카테고리', gds_cat_seq: list.length + 1, gds_cat_status: 'displayed' });
      await this.save('categories', list, '카테고리 추가');
    };
    this.root.querySelectorAll('[data-del]').forEach(
      (b) =>
        (b.onclick = async () => {
          read();
          list.splice(Number(b.dataset.del), 1);
          await this.save('categories', list, '삭제했습니다');
        }),
    );
    this.root.querySelector('[data-act="save"]').onclick = async () => {
      read();
      const bad = list.find((c) => !CATEGORY_NAME_OK.test(c.gds_cat_name));
      if (bad) return this.toast(`카테고리 이름 '${bad.gds_cat_name}'에 쓸 수 없는 문자가 있습니다`, 'error');
      await this.save('categories', list);
    };
  }

  // ================================================================== 매장 설정
  tab_store() {
    const st = this.state.store;
    const tag = st.st_dtl_display_goods_tag ?? {};
    const line = st.st_dtl_auto_clean_line ?? {};
    return `<form class="kv-form" data-form="store">
      ${field('매장명', 'st_name', st.st_name)}
      ${select('테마', 'st_theme', st.st_theme, [['light', '라이트'], ['dark', '다크']])}
      ${select('영수증 QR', 'st_qr_recipt_status', st.st_qr_recipt_status, YN)}
      ${select('개인컵 할인', 'st_dtl_pcup_discount_status', st.st_dtl_pcup_discount_status, YN)}
      ${field('개인컵 할인액(원)', 'st_dtl_pcup_discount', st.st_dtl_pcup_discount, 'number')}
      ${select('자동 세척', 'st_dtl_auto_clean_status', st.st_dtl_auto_clean_status, [['N', '안 함'], ['drink', '음료마다'], ['order', '주문마다']])}
      <div class="field-row"><b>세척 라인</b> ${Object.keys(line).map((k) => `<label class="chk"><input type="checkbox" data-line="${k}" ${line[k] === 'Y' ? 'checked' : ''}> ${k}</label>`).join('')}</div>
      ${select('자동 품절', 'st_dtl_auto_soldout_status', st.st_dtl_auto_soldout_status, [['N', '안 함'], ['cup', '컵'], ['ingredient', '원재료'], ['both', '컵+원재료']])}
      ${select('자동 리필 (컵 뒷줄)', 'st_dtl_auto_refill_status', st.st_dtl_auto_refill_status, [['N', '안 함'], ['cup', '컵']])}
      ${select('포인트', 'st_dtl_point_status', st.st_dtl_point_status, YN)}
      ${field('적립률 %', 'st_dtl_point_rate', st.st_dtl_point_rate, 'number')}
      ${field('포인트 사용 최소 금액', 'st_dtl_point_min_price', st.st_dtl_point_min_price, 'number')}
      ${field('장바구니 최대 수량', 'st_dtl_max_cart_quantity', st.st_dtl_max_cart_quantity, 'number')}
      <div class="field-row"><b>메뉴 표시 태그</b> ${['new', 'best', 'hotice'].map((k) => `<label class="chk"><input type="checkbox" data-tag="${k}" ${tag[k] === 'true' ? 'checked' : ''}> ${k}</label>`).join('')}</div>
      ${select('대기 화면', 'st_standby_screen_status', st.st_standby_screen_status, YN)}
      ${field('대기 화면 이미지/영상 URL', 'st_standby_screen', st.st_standby_screen)}
      <div class="btn-row"><button class="primary">저장</button></div></form>`;
  }

  bind_store() {
    const form = this.root.querySelector('[data-form="store"]');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const body = formValues(form);
      body.st_dtl_auto_clean_line = Object.fromEntries([...form.querySelectorAll('[data-line]')].map((c) => [c.dataset.line, c.checked ? 'Y' : 'N']));
      body.st_dtl_display_goods_tag = Object.fromEntries([...form.querySelectorAll('[data-tag]')].map((c) => [c.dataset.tag, c.checked ? 'true' : 'false']));
      await this.save('store', body);
    };
  }

  // ================================================================== 장비 설정
  tab_settings() {
    const s = this.state.settings;
    const md = s.multiDevice ?? {};
    const temps = ['coffeeReady', 'coffeeUse', 'coffeeExtraction', 'hotWaterReady', 'hotWaterUse', 'hotWaterExtraction', 'coffeeOffset', 'hotWaterOffset'];
    const tl = { coffeeReady: '커피 대기', coffeeUse: '커피 사용', coffeeExtraction: '커피 추출', hotWaterReady: '온수 대기', hotWaterUse: '온수 사용', hotWaterExtraction: '온수 추출', coffeeOffset: '커피 오프셋', hotWaterOffset: '온수 오프셋' };
    return `<form class="kv-form" data-form="settings">
      ${field('관리자 비밀번호 (키오스크 관리자 모드)', 'login_password', s.login_password)}
      ${select('결제 모드', 'payMode', s.payMode, [['on', '실결제'], ['off', '테스트 (결제 생략)']])}
      ${select('RFID 결제 전용', 'rfid', s.rfid, [['off', '사용 안 함'], ['on', '사용 (카드·간편결제 숨김)']])}
      ${field('단말기 TID', 'tid', md.cardReader?.TID ?? s.tid)}
      ${field('세척 시간 (ms)', 'washTime', s.washTime, 'number')}
      ${field('세척 밸브 간격 (ms)', 'washAirTime', s.washAirTime, 'number')}
      ${field('파우더 믹스값 feed (raw)', 'feed', s.feed, 'number')}
      ${field('음료당 감시 시간 (분)', 'idleWaitTime', s.idleWaitTime, 'number')}
      ${select('시작 시 브로멕 원점', 'reset', s.reset, ONOFF)}
      ${select('컵센서 1↔3 반전', 'cupInverse', s.cupInverse, ONOFF)}
      ${select('개발 모드', 'developeMode', s.developeMode, ONOFF)}
      ${select('원격 명령 실행 (서버의 가상 키오스크)', 'sim_remote_executor', s.sim_remote_executor ?? 'server', [['server', '시뮬레이터가 실행'], ['off', '실행 안 함 (원본 앱이 실행)']])}
      <h4>보일러 온도 (°C)</h4><div class="form-grid">${temps.map((k) => `<label>${tl[k]}<input name="t_${k}" type="number" value="${esc(md.mainDevice?.[k] ?? s[k])}"></label>`).join('')}</div>
      <h4>장치 사용 / 포트</h4><div class="form-grid">${['mainDevice', 'cardReader', 'iceDispenser', 'cupDispenser']
        .map((k) => `<label>${({ mainDevice: '메인보드', cardReader: '카드 단말기', iceDispenser: '제빙기', cupDispenser: '컵 디스펜서' })[k]}<select name="use_${k}"><option>Y</option><option ${md[k]?.useState === 'N' ? 'selected' : ''}>N</option></select></label><label>포트<input name="port_${k}" value="${esc(md[k]?.comPort ?? '')}"></label>`)
        .join('')}</div>
      <div class="btn-row"><button class="primary">저장</button><button type="button" data-act="apply">온도를 지금 장비에 적용</button></div>
      <p class="muted">키오스크는 시작할 때 이 설정을 받아옵니다. 웹 키오스크는 관리자 모드 → 재시작, 원본 앱은 재시작하면 반영됩니다.</p></form>`;
  }

  bind_settings() {
    const form = this.root.querySelector('[data-form="settings"]');
    const build = () => {
      const v = formValues(form);
      const s = structuredClone(this.state.settings);
      for (const k of ['login_password', 'payMode', 'rfid', 'tid', 'reset', 'cupInverse', 'developeMode', 'sim_remote_executor']) s[k] = v[k];
      for (const k of ['washTime', 'washAirTime', 'feed', 'idleWaitTime']) s[k] = Number(v[k]) || 0;
      s.multiDevice ??= {};
      for (const k of ['mainDevice', 'cardReader', 'iceDispenser', 'cupDispenser']) s.multiDevice[k] = { ...(s.multiDevice[k] ?? {}), useState: v[`use_${k}`], comPort: v[`port_${k}`] };
      s.multiDevice.cardReader.TID = v.tid;
      for (const [k, val] of Object.entries(v)) if (k.startsWith('t_')) s[k.slice(2)] = s.multiDevice.mainDevice[k.slice(2)] = String(val);
      return s;
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      await this.save('settings', build());
    };
    form.querySelector('[data-act="apply"]').onclick = async () => {
      const s = build();
      await this.save('settings', s);
      await this.bridge.engine.setTemperatures(s.multiDevice.mainDevice);
      this.toast('보일러 온도를 장비(S001~S006, S016~S017)에 적용했습니다');
    };
  }

  // ================================================================== 재고
  tab_stock() {
    const ing = this.state.ingredients;
    const per = this.state.perSec;
    const rows = INGREDIENTS.map((k) => {
      const now = Number(ing[`${k}_now`]);
      const max = Number(ing[`${k}_max`]) || 1;
      return `<tr><td>${esc(INGREDIENT_LABEL[k])}</td><td><div class="bar"><i style="width:${Math.min(100, (now / max) * 100)}%"></i></div></td>
        <td><input data-k="${k}_now" type="number" value="${now}"></td><td><input data-k="${k}_max" type="number" value="${max}"></td>
        <td><input data-k="${k}_notification_per" type="number" value="${ing[`${k}_notification_per`]}"></td><td>${ing[`${k}_notification_status`] === 'Y' ? '발송됨' : '-'}</td>
        <td><input data-p="${k}" type="number" step="0.1" value="${per[k]}"></td><td><button data-fill="${k}">채우기</button></td></tr>`;
    }).join('');
    return `<table class="grid"><thead><tr><th>재료</th><th></th><th>현재</th><th>최대</th><th>알림 %</th><th>알림</th><th>1초당 소모</th><th></th></tr></thead><tbody>${rows}</tbody></table>
      <p>컵 뒷줄: HOT ${ing.cup1_backline_exist_status} · ICE ${ing.cup2_backline_exist_status}</p>
      <div class="btn-row"><button data-act="save" class="primary">저장</button><button data-act="fillAll">전부 채우기</button></div>
      <p class="muted">키오스크는 음료마다 (1초당 소모 × 레시피 시간)만큼 차감하고, 알림 % 아래로 내려가면 알림톡(가상)을 보냅니다. 0이 되면 매장 설정의 자동 품절에 따라 품절 처리됩니다.</p>`;
  }

  bind_stock() {
    this.root.querySelector('[data-act="save"]').onclick = async () => {
      const ing = { ...this.state.ingredients };
      this.root.querySelectorAll('[data-k]').forEach((i) => (ing[i.dataset.k] = Number(i.value)));
      const per = Object.fromEntries([...this.root.querySelectorAll('[data-p]')].map((i) => [i.dataset.p, Number(i.value)]));
      await this.api('PUT', 'cafesim-admin/ingredients', ing);
      await this.save('persec', per);
    };
    this.root.querySelectorAll('[data-fill]').forEach((b) => (b.onclick = async () => (await this.api('GET', `mailbean/ingredient_fill/${this.state.settings.MacAddr}/${b.dataset.fill}/`), this.refresh())));
    this.root.querySelector('[data-act="fillAll"]').onclick = async () => {
      for (const k of INGREDIENTS) await this.api('GET', `mailbean/ingredient_fill/${this.state.settings.MacAddr}/${k}/`);
      await this.refresh();
    };
  }

  // ================================================================== 고객·포인트·RFID
  tab_customers() {
    const rows = Object.entries(this.state.customers)
      .map(([tel, c]) => `<tr><td>${esc(tel)}</td><td><input data-pt="${esc(tel)}" type="number" value="${c.point}"></td><td><input data-pw="${esc(tel)}" value="${esc(c.pw)}" maxlength="4"></td><td><button data-delc="${esc(tel)}">삭제</button></td></tr>`)
      .join('');
    return `<h4>포인트 회원</h4><table class="grid narrow"><thead><tr><th>전화번호</th><th>포인트</th><th>비밀번호(4)</th><th></th></tr></thead><tbody>${rows}</tbody></table>
      <div class="btn-row"><input id="newTel" placeholder="010-0000-0000"><button data-act="addc">+ 회원</button><button data-act="savec" class="primary">저장</button></div>
      <h4>RFID 카드 (사원증·출입카드 결제)</h4><p>${this.state.rfid.map((u) => `<span class="chip">${esc(u)} <a data-delr="${esc(u)}">✕</a></span>`).join(' ') || '-'}</p>
      <div class="btn-row"><input id="newRfid" placeholder="UID (16진수, 예: 00A1B2C3D4)"><button data-act="addr">+ 카드</button></div>
      <p class="muted">RFID 결제는 장비 설정의 'RFID 결제 전용'을 켜면 키오스크에 나타납니다. 키오스크의 RFID 리더는 10자리 10진수를 읽어 16진수로 바꿔 조회합니다.</p>`;
  }

  bind_customers() {
    const cust = structuredClone(this.state.customers);
    const read = () => {
      this.root.querySelectorAll('[data-pt]').forEach((i) => (cust[i.dataset.pt].point = Number(i.value)));
      this.root.querySelectorAll('[data-pw]').forEach((i) => (cust[i.dataset.pw].pw = i.value));
    };
    const put = (body, msg) => this.save('customers', body, msg);
    this.root.querySelector('[data-act="savec"]').onclick = async () => (read(), put(cust));
    this.root.querySelector('[data-act="addc"]').onclick = async () => {
      read();
      const tel = this.root.querySelector('#newTel').value.trim();
      if (!/^01\d-\d{3,4}-\d{4}$/.test(tel)) return this.toast('전화번호 형식: 010-1234-5678', 'warn');
      cust[tel] = { point: 0, pw: '' };
      await put(cust, '회원 추가');
    };
    this.root.querySelectorAll('[data-delc]').forEach((b) => (b.onclick = async () => (read(), delete cust[b.dataset.delc], put(cust, '삭제했습니다'))));
    const rf = [...this.state.rfid];
    this.root.querySelector('[data-act="addr"]').onclick = async () => {
      const v = this.root.querySelector('#newRfid').value.trim().toUpperCase();
      if (!/^[0-9A-F]{4,16}$/.test(v)) return this.toast('16진수 UID를 입력하세요', 'warn');
      await this.save('rfid', [...rf, v], 'RFID 추가');
    };
    this.root.querySelectorAll('[data-delr]').forEach((a) => (a.onclick = async () => this.save('rfid', rf.filter((u) => u !== a.dataset.delr), '삭제했습니다')));
  }

  // ================================================================== 결제·환불
  tab_payments() {
    const rows = this.state.payments
      .slice(0, 100)
      .map(
        (p) => `<tr><td>${esc(new Date(p.at).toLocaleString())}</td><td>${esc(p.pay_method)}</td><td>${Number(p.pay_card_dtl_price || 0).toLocaleString()}</td>
        <td>${(p.pay_goods_detail ?? []).map((g) => `${esc(g.gds_name)}×${esc(g.pay_gds_stock)}`).join(', ')}</td><td>${esc(p.pay_card_dtl_auth_num ?? '')}</td><td>${esc(p.cust_tel ?? '')}</td>
        <td>${p.refund_status ? '<span class="chip err">환불됨</span>' : p.pay_method === 'TEST' || p.pay_method === 'ETC' || p.pay_method === 'RF' ? '-' : `<button data-refund="${p.pay_id}">환불 요청</button>`} <button data-receipt="${esc(p.pay_id)}">영수증</button></td></tr>`,
      )
      .join('');
    return `<table class="grid"><thead><tr><th>시각</th><th>수단</th><th>금액</th><th>상품</th><th>승인번호</th><th>고객</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="7" class="muted">결제 내역이 없습니다</td></tr>'}</tbody></table>
      <p class="muted">'환불 요청'은 실제 서버처럼 키오스크에 remote-refund 원격 명령을 보냅니다. 카드는 키오스크가 단말기로 취소(0420) 후 refund_success를 보고합니다.</p>`;
  }

  bind_payments() {
    this.root.querySelectorAll('[data-refund]').forEach(
      (b) =>
        (b.onclick = async () => {
          const p = this.state.payments.find((x) => x.pay_id === b.dataset.refund);
          const auth = p.pay_card_dtl_auth_data ?? {};
          await this.api('POST', 'cafesim-admin/remote', {
            title: 'remote-refund',
            data: { title: 'remote-refund', pay_id: p.pay_id, total_price: Number(p.pay_card_dtl_price), refund_method: p.pay_method, refund_memo: '관리 콘솔 환불', data: { APPROVALNO: p.pay_card_dtl_auth_num, totalAmount: Number(p.pay_card_dtl_price), installment: '00', TRADETIME: auth.TRADETIME ?? p.pay_card_dtl_auth_date ?? '', TRADEFLAG: auth.TRADEFLAG ?? 'IC' } },
          });
          this.toast('환불 요청을 키오스크에 보냈습니다');
          setTimeout(() => this.refresh(), 2500);
        }),
    );
    this.root.querySelectorAll('[data-receipt]').forEach((b) => (b.onclick = async () => window.open(await this.backend.receiptUrl(`/receipt/${b.dataset.receipt}`), '_blank')));
  }

  // ================================================================== 원격 제어
  tab_remote() {
    const goods = this.state.goods.filter((g) => g.gds_type === 'goods-drink');
    const hist = this.state.remote
      .slice(0, 20)
      .map((r) => `<tr><td>${esc(new Date(r.at).toLocaleTimeString())}</td><td>${esc(r.title)}</td><td><code>${esc(JSON.stringify(r.data)).slice(0, 120)}</code></td><td>${esc(r.status ?? '전송됨')}${r.error ? ` - ${esc(r.error)}` : ''}</td></tr>`)
      .join('');
    return `<div class="remote-grid">
      <fieldset><legend>원격 세척</legend><select id="washPart">${euro.WASH_PARTS.map((p) => `<option value="${p}">${esc(euro.WASH_LABEL[p])}</option>`).join('')}</select> 횟수 <input id="washNum" type="number" value="1" min="1" style="width:60px"><button data-r="wash">실행</button></fieldset>
      <fieldset><legend>원격 컵 배출</legend><button data-r="cup1">HOT 컵</button><button data-r="cup2">ICE 컵</button></fieldset>
      <fieldset><legend>원격 출빙</legend>얼음 <input id="iceSec" type="number" value="3" step="0.5" style="width:60px">초 물 <input id="waterSec" type="number" value="0" step="0.5" style="width:60px">초 <button data-r="ice">실행</button></fieldset>
      <fieldset><legend>원격 제조</legend><select id="exGoods">${goods.map((g) => `<option>${esc(g.gds_name)}</option>`).join('')}</select>
        <label class="chk"><input type="checkbox" id="exCup" checked> 컵</label><label class="chk"><input type="checkbox" id="exIce" checked> 얼음</label><label class="chk"><input type="checkbox" id="exDrink" checked> 음료</label><button data-r="extraction">실행</button></fieldset>
      <fieldset><legend>기타</legend><button data-r="refill">재고 다시 읽기 (remote-refill)</button><button data-r="loadLog">로그 업로드 요청</button><button data-r="restart">재시작</button></fieldset></div>
      <h4>전송 내역</h4><table class="grid"><thead><tr><th>시각</th><th>명령</th><th>데이터</th><th>상태</th></tr></thead><tbody>${hist || '<tr><td colspan="4" class="muted">-</td></tr>'}</tbody></table>
      <p class="muted">실제 메일빈 서버의 SSE 원격 명령과 같은 형식입니다. 웹 키오스크(또는 서버의 가상 키오스크, 원본 앱)가 받아서 실행합니다. 주문 처리 중에는 원본 앱처럼 무시될 수 있습니다.</p>`;
  }

  bind_remote() {
    const v = (id) => this.root.querySelector(`#${id}`);
    const send = async (title, data = {}) => {
      await this.api('POST', 'cafesim-admin/remote', { title, data });
      this.toast(`원격 명령 전송: ${title}`);
      setTimeout(() => this.visible && this.tab === 'remote' && this.refresh(), 1500);
    };
    const actions = {
      wash: () => send('remote-wash', { wash_part: v('washPart').value, wash_num: Number(v('washNum').value) }),
      cup1: () => send('remote-cup', { cup_out_num: 'cup1-out' }),
      cup2: () => send('remote-cup', { cup_out_num: 'cup2-out' }),
      ice: () => send('remote-ice', { ice_out_time: Number(v('iceSec').value), water_out_time: Number(v('waterSec').value) }),
      extraction: () =>
        send('remote-extraction', {
          made_gds_name: v('exGoods').value,
          made_method_ids: [v('exCup').checked && 'cup-extract', v('exIce').checked && 'ice-extract', v('exDrink').checked && 'drink-extract'].filter(Boolean).join(','),
        }),
      refill: () => send('remote-refill'),
      loadLog: () => send('remote-loadLog', { date: new Date().toISOString().slice(2, 10).replace(/-/g, '') }),
      restart: () => send('remote-restart'),
    };
    this.root.querySelectorAll('[data-r]').forEach((b) => (b.onclick = actions[b.dataset.r]));
  }

  // ================================================================== 알림·데이터
  tab_logs() {
    const s = this.state;
    const talk = s.alimtalk.slice(0, 30).map((a) => `<tr><td>${esc(new Date(a.at).toLocaleString())}</td><td>${esc(a.template ?? '')}</td><td>${esc(a.talk_send_msg ?? a.msg ?? '')}</td></tr>`).join('');
    return `<h4>장비 정보</h4><dl class="kv"><dt>SW 버전</dt><dd>${esc(s.machine.sw || '-')}</dd><dt>FW 버전</dt><dd>${esc(s.machine.fw || '-')}</dd><dt>마지막 접속</dt><dd>${esc(s.machine.lastSeen ? new Date(s.machine.lastSeen).toLocaleString() : '-')}</dd><dt>로그 업로드</dt><dd>${s.uploads.length}건</dd></dl>
      <h4>알림톡 (가상 발송, 실제로 보내지 않음)</h4><table class="grid"><thead><tr><th>시각</th><th>템플릿</th><th>내용</th></tr></thead><tbody>${talk || '<tr><td colspan="3" class="muted">-</td></tr>'}</tbody></table>
      <h4>재고 알림 템플릿</h4><textarea id="tpl" class="code" style="min-height:60px">${esc(s.templates.CM_INGR_REMAINING_NOTIFICATION)}</textarea><div class="btn-row"><button data-act="tpl">템플릿 저장</button></div>
      <h4>데이터</h4><div class="btn-row"><button data-act="export">내보내기 (JSON)</button><label class="file-btn">가져오기<input type="file" id="importFile" accept=".json" hidden></label><button data-act="reset" class="danger">초기 데이터로 되돌리기</button></div>`;
  }

  bind_logs() {
    this.root.querySelector('[data-act="tpl"]').onclick = () => this.save('templates', { CM_INGR_REMAINING_NOTIFICATION: this.root.querySelector('#tpl').value });
    this.root.querySelector('[data-act="export"]').onclick = () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(this.state, null, 1)], { type: 'application/json' }));
      a.download = `cafesim-mailbean-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
    };
    this.root.querySelector('#importFile').onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const data = JSON.parse(await file.text());
      for (const [k, route] of [['goods', null], ['categories', 'categories'], ['ptGoods', 'ptgoods'], ['store', 'store'], ['settings', 'settings'], ['ingredients', 'ingredients'], ['perSec', 'persec'], ['customers', 'customers'], ['rfid', 'rfid']]) {
        if (!data[k]) continue;
        if (k === 'goods') for (const g of data.goods) await this.api('PUT', 'cafesim-admin/goods', g);
        else await this.api('PUT', `cafesim-admin/${route}`, data[k]);
      }
      this.toast('가져왔습니다');
      this.refresh();
    };
    this.root.querySelector('[data-act="reset"]').onclick = async () => {
      if (!confirm('메뉴·설정·결제 내역을 모두 초기 데이터로 되돌릴까요?')) return;
      await this.api('POST', 'cafesim-admin/reset');
      this.toast('초기화했습니다');
      this.refresh();
    };
  }
}

const YN = [['Y', '사용'], ['N', '사용 안 함']];
const ONOFF = [['on', 'on'], ['off', 'off']];

function statusLabel(s) {
  return { displayed: '판매중', not_displayed: '숨김', sold_out: '품절', deleted: '삭제' }[s] ?? s;
}

function field(label, name, value, type = 'text') {
  return `<label>${esc(label)}<input name="${name}" type="${type}" value="${esc(value ?? '')}"></label>`;
}

function select(label, name, value, options) {
  return `<label>${esc(label)}<select name="${name}">${options.map(([v, l]) => `<option value="${esc(v)}" ${String(value) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
}

function formValues(form) {
  const out = {};
  for (const el of form.querySelectorAll('input[name], select[name]')) out[el.name] = el.type === 'number' ? Number(el.value) : el.value;
  return out;
}
