/**
 * Web version of the M400 kiosk app. It follows the original Electron app's flows
 * (menu/cart, personal cup, points, card/Samsung/Kakao/Naver/RFID payment, test mode, production
 * progress, end screen with receipt, admin mode with stock/wash/test/menu/machine/cup/ice tabs,
 * remote commands, standby screen) using the virtual Mailbean server data through window.CafeSim.
 */
const S = window.CafeSim;
const call = (m, ...a) => S.call(m, ...a);
const $ = (id) => document.getElementById(id);
const won = (n) => `${Math.round(n).toLocaleString()}원`;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PER_PAGE = 10;
const IDLE_MS = 5 * 60 * 1000;
const STEP_ORDER = ['cup', 'ice', 'place', 'brew', 'take'];
const STEP_LABEL = { cup: '컵', ice: '얼음', place: '투출구', brew: '제조', take: '픽업' };

const st = {
  catalog: null,
  meta: null,
  cat: null,
  page: 0,
  cart: new Map(), // gds_id -> qty
  testMode: false,
  busy: false,
  voice: true,
  taps: [],
  progress: null,
};

// ====================================================================== helpers
function speak(text) {
  if (!st.voice || !('speechSynthesis' in window)) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ko-KR';
    u.rate = 1.05;
    speechSynthesis.speak(u);
  } catch {}
}

function modal(html, { onBind } = {}) {
  $('modalBody').innerHTML = html;
  $('modal').hidden = false;
  onBind?.($('modalBody'));
  return $('modalBody');
}
const closeModal = () => ($('modal').hidden = true);

function ask(title, text, buttons) {
  return new Promise((resolve) => {
    modal(`<h3>${title}</h3>${text ? `<p>${text}</p>` : ''}<div class="k-actions">${buttons.map((b, i) => `<button data-i="${i}" class="${b.primary ? 'primary' : ''}">${b.label}</button>`).join('')}</div>`, {
      onBind: (el) =>
        el.querySelectorAll('[data-i]').forEach(
          (b) =>
            (b.onclick = () => {
              closeModal();
              resolve(buttons[b.dataset.i].value);
            }),
        ),
    });
  });
}

const notice = (title, text = '') => ask(title, text, [{ label: '확인', value: true, primary: true }]);

function banner(text, ms = 0) {
  $('banner').textContent = text;
  $('banner').hidden = !text;
  clearTimeout(banner.t);
  if (ms) banner.t = setTimeout(() => ($('banner').hidden = true), ms);
}

function screen(html) {
  $('screen').innerHTML = html;
  $('screen').hidden = false;
  return $('screen');
}
const closeScreen = () => ($('screen').hidden = true);

/** Number keypad. Resolves with the entered string or null (cancel). */
function keypad({ title, text = '', format = (v) => v, maxLen = 11, prefix = '', mask = false, validate = () => true }) {
  return new Promise((resolve) => {
    let v = prefix;
    const body = modal(
      `<h3>${title}</h3><p>${text}</p><div class="key-display" id="kd"></div><div class="keypad">${[1, 2, 3, 4, 5, 6, 7, 8, 9, 'C', 0, '←'].map((k) => `<button data-k="${k}">${k}</button>`).join('')}</div>
       <div class="k-actions"><button data-x="cancel">취소</button><button data-x="ok" class="primary">확인</button></div>`,
    );
    const draw = () => (body.querySelector('#kd').textContent = mask ? '●'.repeat(v.length) || ' ' : format(v) || ' ');
    draw();
    body.querySelectorAll('[data-k]').forEach(
      (b) =>
        (b.onclick = () => {
          const k = b.dataset.k;
          if (k === 'C') v = prefix;
          else if (k === '←') v = v.length > prefix.length ? v.slice(0, -1) : v;
          else if (v.length < maxLen) v += k;
          draw();
        }),
    );
    body.querySelector('[data-x="cancel"]').onclick = () => (closeModal(), resolve(null));
    body.querySelector('[data-x="ok"]').onclick = () => {
      if (!validate(v)) return;
      closeModal();
      resolve(v);
    };
  });
}

const telFormat = (v) => v.replace(/^(\d{3})(\d{0,4})(\d{0,4}).*/, (m, a, b, c) => [a, b, c].filter(Boolean).join('-'));

// ====================================================================== catalog
async function loadCatalog() {
  st.catalog = await call('catalog');
  const { store, settings } = st.catalog;
  document.body.dataset.theme = store.st_theme === 'dark' ? 'dark' : 'light';
  $('brand').style.backgroundImage = store.logo_url ? `url("${store.logo_url}")` : '';
  const tid = settings.multiDevice?.cardReader?.TID ?? settings.tid;
  $('footVer').textContent = `${settings.serialNumber ?? ''}${tid === 'DPT0TEST03' ? ' · 가상 TID (실제 매출 없음)' : ''}`;
  renderCats();
  renderGrid();
  renderCart();
  renderFoot();
}

function displayedCats() {
  return st.catalog.categories.filter((c) => c.gds_cat_status === 'displayed').sort((a, b) => a.gds_cat_seq - b.gds_cat_seq);
}

function goodsVisible(g) {
  return g.gds_status === 'displayed' || g.gds_status === 'sold_out';
}

function goodsOfCat(cat) {
  const cats = displayedCats().map((c) => c.gds_cat_name);
  return st.catalog.goods
    .filter(goodsVisible)
    .filter((g) => {
      const mine = String(g.gds_recipe?.categoryList ?? '').split('_');
      return cat === 'total' ? mine.some((c) => cats.includes(c)) : mine.includes(cat);
    })
    .sort((a, b) => a.gds_seq - b.gds_seq);
}

function renderCats() {
  const cats = displayedCats().map((c) => c.gds_cat_name);
  const hasTotal = cats.includes('전체메뉴');
  const tabs = [...(hasTotal ? [['total', '전체 메뉴']] : []), ...cats.filter((c) => c !== '전체메뉴').map((c) => [c, c]), ...(st.catalog.store.st_dtl_point_status === 'Y' && st.catalog.ptGoods.length ? [['point', '포인트']] : [])];
  if (!tabs.some(([k]) => k === st.cat)) st.cat = tabs[0]?.[0];
  $('cats').innerHTML = tabs.map(([k, l]) => `<button data-cat="${esc(k)}" class="${k === st.cat ? 'on' : ''}">${esc(l)}</button>`).join('');
  $('cats').querySelectorAll('[data-cat]').forEach((b) => (b.onclick = () => ((st.cat = b.dataset.cat), (st.page = 0), renderCats(), renderGrid())));
}

function isSold(g) {
  return g.gds_status === 'sold_out' || (g.soldOut ?? []).length > 0;
}

function renderGrid() {
  if (st.cat === 'point') return renderPointGoods();
  const list = goodsOfCat(st.cat);
  const tag = st.catalog.store.st_dtl_display_goods_tag ?? {};
  const pages = Math.max(1, Math.ceil(list.length / PER_PAGE));
  st.page = Math.min(st.page, pages - 1);
  $('grid').innerHTML = list
    .slice(st.page * PER_PAGE, (st.page + 1) * PER_PAGE)
    .map((g) => {
      const ice = g.gds_recipe?.ice_YN === 'Y';
      const best = tag.best === 'true' && g.gds_best_tag_status === 'Y';
      const isNew = tag.new === 'true' && g.gds_new_tag_status === 'Y';
      const hot = tag.hotice === 'true' && g.gds_type === 'goods-drink';
      return `<button class="k-item ${best ? 'best' : isNew ? 'new' : ''} ${isSold(g) ? 'sold' : ''}" data-id="${g.gds_id}">
        ${best ? '<span class="ribbon">BEST</span>' : isNew ? '<span class="ribbon">NEW</span>' : ''}${hot ? `<span class="tag ${ice ? 'ice' : ''}">${ice ? 'ICE' : 'HOT'}</span>` : ''}
        <img src="${esc(g.img_url)}" alt=""><h4>${esc(g.gds_name).replace(/\n/g, '<br>')}</h4><div class="price">${won(g.gds_price)}</div></button>`;
    })
    .join('');
  $('dots').innerHTML = pages > 1 ? Array.from({ length: pages }, (_, i) => `<button data-p="${i}" class="${i === st.page ? 'on' : ''}"></button>`).join('') : '';
  $('dots').querySelectorAll('[data-p]').forEach((b) => (b.onclick = () => ((st.page = Number(b.dataset.p)), renderGrid())));
  $('grid').querySelectorAll('[data-id]').forEach((b) => (b.onclick = () => addToCart(b.dataset.id)));
}

function renderPointGoods() {
  $('grid').innerHTML = st.catalog.ptGoods
    .filter((p) => p.pt_gds_status === 'displayed')
    .map((p) => `<button class="k-item" data-pt="${p.pt_gds_id}"><img src="${esc(p.img_url)}" alt=""><h4>${esc(p.pt_gds_name)}</h4><div class="price">${p.pt_gds_price.toLocaleString()}P</div></button>`)
    .join('');
  $('dots').innerHTML = '';
  $('grid').querySelectorAll('[data-pt]').forEach((b) => (b.onclick = () => buyPointGoods(st.catalog.ptGoods.find((p) => p.pt_gds_id === b.dataset.pt))));
}

function renderFoot() {
  const ing = st.catalog?.ingredients ?? {};
  $('footCups').textContent = st.catalog?.devices.cup ? `HOT 컵 ${ing.cup1_now ?? '-'} · ICE 컵 ${ing.cup2_now ?? '-'}` : '';
  const t = st.catalog?.temps;
  $('footTemps').textContent = t ? `커피 ${Math.round(t.coffee)}°C · 온수 ${Math.round(t.hotWater)}°C` : '';
  $('footTest').hidden = !st.testMode;
}

// ====================================================================== cart
const goodsById = (id) => st.catalog.goods.find((g) => g.gds_id === id);
const cartQty = () => [...st.cart.values()].reduce((a, b) => a + b, 0);
const maxCart = () => Number(st.catalog.store.st_dtl_max_cart_quantity) || 10;

function addToCart(id) {
  const g = goodsById(id);
  if (isSold(g)) return notice('품절된 상품입니다', '다른 메뉴를 선택해 주세요.');
  if (cartQty() >= maxCart()) return notice(`최대 ${maxCart()}개까지 주문할 수 있습니다`);
  st.cart.set(id, (st.cart.get(id) ?? 0) + 1);
  renderCart();
}

function renderCart() {
  const lines = [...st.cart.entries()].map(([id, qty]) => [goodsById(id), qty]).filter(([g]) => g);
  $('cartList').innerHTML = lines
    .map(([g, q]) => `<li><span>${esc(g.gds_name)}</span><button data-d="-1" data-id="${g.gds_id}">−</button><b>${q}</b><button data-d="1" data-id="${g.gds_id}" ${cartQty() >= maxCart() ? 'disabled' : ''}>+</button></li>`)
    .join('');
  $('cartList').querySelectorAll('[data-d]').forEach(
    (b) =>
      (b.onclick = () => {
        const q = (st.cart.get(b.dataset.id) ?? 0) + Number(b.dataset.d);
        if (q <= 0) st.cart.delete(b.dataset.id);
        else st.cart.set(b.dataset.id, q);
        renderCart();
      }),
  );
  $('cartCount').textContent = `${cartQty()}개`;
  $('total').textContent = won(lines.reduce((a, [g, q]) => a + g.gds_price * q, 0));
}

$('clearBtn').onclick = () => {
  st.cart.clear();
  renderCart();
};

// ====================================================================== order flow
$('payBtn').onclick = () => startOrder().catch((e) => notice('처리하지 못했습니다', esc(e.message)));

async function startOrder() {
  if (st.busy) return;
  if (!cartQty()) {
    speak('장바구니에 상품을 추가해 주세요');
    return notice('장바구니에 상품을 추가해 주세요');
  }
  const { store, settings, devices } = st.catalog;
  const lines = [...st.cart.entries()].map(([id, qty]) => ({ g: goodsById(id), qty }));
  const drinks = lines.filter((l) => l.g.gds_type === 'goods-drink');
  const single = drinks.length === 1 && drinks[0].qty === 1 && lines.length === 1;

  // personal cup (tumbler) discount
  let personalCup = false;
  if (store.st_dtl_pcup_discount_status === 'Y' && devices.cup && single) {
    speak('개인컵을 사용하시나요?');
    personalCup = await ask('개인컵을 사용하시나요?', `개인컵(텀블러) 사용 시 ${won(store.st_dtl_pcup_discount)} 할인됩니다. 컵이 나오지 않습니다.`, [
      { label: '아니오', value: false },
      { label: '예', value: true, primary: true },
    ]);
  }
  const discount = personalCup ? Number(store.st_dtl_pcup_discount) || 0 : 0;
  const priced = lines.map((l) => ({ ...l, unit: l.g.gds_type === 'goods-drink' ? Math.max(0, l.g.gds_price - discount) : l.g.gds_price }));
  const drinksTotal = priced.filter((l) => l.g.gds_type === 'goods-drink').reduce((a, l) => a + l.unit * l.qty, 0);
  const total = priced.reduce((a, l) => a + l.unit * l.qty, 0);

  // points
  let pt = { tel: '', pw: '', use: 0, accum: 0, status: 'skip' };
  if (store.st_dtl_point_status === 'Y' && drinksTotal > 0) {
    const r = await pointsFlow(drinksTotal);
    if (r === null) return;
    pt = r;
  }
  const amount = Math.max(0, total - pt.use);

  // payment
  st.busy = true;
  try {
    let pay;
    if (st.testMode || settings.payMode === 'off') pay = { method: 'TEST', res: null };
    else if (amount === 0) pay = { method: 'ETC', res: null };
    else pay = await paymentFlow(amount);
    if (!pay) return;
    const rec = await call('insertPayment', paymentData({ pay, amount, pt, priced }));
    await produce(priced, personalCup, rec);
  } finally {
    st.busy = false;
    closeScreen();
    st.cart.clear();
    renderCart();
    loadCatalog();
  }
}

function paymentData({ pay, amount, pt, priced }) {
  const r = pay.res ?? {};
  return {
    cm_id: st.catalog.settings.MacAddr,
    pay_method: pay.method,
    pay_status: 'success',
    pay_card_dtl_res_code: r.RES ?? '0000',
    pay_card_dtl_res_msg: r.MSG ?? '정상완료',
    pay_card_dtl_price: pay.method === 'TEST' ? 0 : amount,
    pay_card_dtl_auth_data: r,
    pay_card_dtl_card_num: pay.cardNum ?? r.FILLER ?? '',
    pay_card_dtl_auth_num: r.APPROVALNO ?? '',
    pay_card_dtl_card_issuer: r.ISSUERCODE ?? '',
    pay_card_dtl_auth_date: r.TRADETIME ?? '',
    message1: r.MESSAGE1 ?? '',
    message2: r.MESSAGE2 ?? '',
    cust_tel: pt.tel,
    cust_point_pw: pt.pw,
    point_amount_use: pt.use,
    point_amount_accum: pt.accum,
    DataStatus: pt.status,
    pay_goods_detail: priced.map((l) => ({ gds_id: l.g.gds_id, gds_name: l.g.gds_name, pay_gds_stock: l.qty, pay_price: String(l.unit * l.qty) })),
  };
}

// ---------------------------------------------------------------------- points
async function pointsFlow(drinksTotal) {
  const { store, settings } = st.catalog;
  const rate = Number(store.st_dtl_point_rate) || 0;
  const choice = await ask('포인트', `음료 ${won(drinksTotal)} · 적립 예정 ${Math.floor((drinksTotal * rate) / 100).toLocaleString()}P`, [
    { label: '건너뛰기', value: 'skip' },
    { label: '사용하기', value: 'use' },
    { label: '적립하기', value: 'save', primary: true },
  ]);
  if (choice === 'skip') return { tel: '', pw: '', use: 0, accum: 0, status: 'skip' };
  const raw = await keypad({ title: '휴대폰 번호를 입력해 주세요', prefix: '010', maxLen: 11, format: telFormat, validate: (v) => v.length === 11 });
  if (!raw) return null;
  const tel = telFormat(raw);
  const cust = await call('api', 'GET', `mailbean/check_cust_tel/${settings.admin}/${tel}`);
  if (choice === 'save') {
    let pw = '';
    if (cust.st_customer !== 'Y') {
      pw = await keypad({ title: '포인트 비밀번호 4자리를 등록해 주세요', text: '포인트 사용 시 필요합니다', maxLen: 4, mask: true, validate: (v) => v.length === 4 });
      if (!pw) return null;
    }
    return { tel, pw, use: 0, accum: Math.floor((drinksTotal * rate) / 100), status: 'pay' };
  }
  if (cust.st_customer !== 'Y') {
    await notice('등록된 회원이 아닙니다', '적립하기로 먼저 회원 등록을 해 주세요.');
    return null;
  }
  for (;;) {
    const pw = await keypad({ title: '포인트 비밀번호 4자리', maxLen: 4, mask: true, validate: (v) => v.length === 4 });
    if (!pw) return null;
    const chk = await call('api', 'GET', `mailbean/check_cust_before_use_pt/${settings.admin}/${tel}/${pw}`);
    if (chk.message === 'invalid password') {
      await notice('비밀번호가 일치하지 않습니다');
      continue;
    }
    const max = Math.min(Number(chk.st_cust_pt) || 0, drinksTotal);
    const min = Number(store.st_dtl_point_min_price) || 0;
    const use = await keypad({
      title: `사용할 포인트 (보유 ${Number(chk.st_cust_pt).toLocaleString()}P)`,
      text: `최소 ${min.toLocaleString()}P · 최대 ${max.toLocaleString()}P`,
      maxLen: 7,
      format: (v) => `${Number(v || 0).toLocaleString()} P`,
      validate: (v) => Number(v) >= Math.min(min, max) && Number(v) <= max && Number(v) > 0,
    });
    if (use === null) return null;
    return { tel, pw, use: Number(use), accum: 0, status: 'use' };
  }
}

async function buyPointGoods(p) {
  const { settings } = st.catalog;
  const raw = await keypad({ title: `${p.pt_gds_name} (${p.pt_gds_price.toLocaleString()}P)`, text: '휴대폰 번호를 입력해 주세요', prefix: '010', maxLen: 11, format: telFormat, validate: (v) => v.length === 11 });
  if (!raw) return;
  const tel = telFormat(raw);
  const pw = await keypad({ title: '포인트 비밀번호 4자리', maxLen: 4, mask: true, validate: (v) => v.length === 4 });
  if (!pw) return;
  const chk = await call('api', 'GET', `mailbean/check_cust_before_use_pt/${settings.admin}/${tel}/${pw}`);
  if (chk.message === 'invalid password') return notice('비밀번호가 일치하지 않습니다');
  if (Number(chk.st_cust_pt) < p.pt_gds_price) return notice('포인트가 부족합니다', `보유 ${Number(chk.st_cust_pt).toLocaleString()}P`);
  await call('insertPayment', {
    cm_id: settings.MacAddr,
    pay_method: 'ETC',
    pay_status: 'success',
    pay_card_dtl_price: 0,
    cust_tel: tel,
    cust_point_pw: pw,
    point_amount_use: p.pt_gds_price,
    point_amount_accum: 0,
    DataStatus: 'point',
    pay_goods_detail: [{ gds_id: p.pt_gds_id, gds_name: p.pt_gds_name, pay_gds_stock: 1, pay_price: '0' }],
  });
  speak('포인트 상품 구매가 완료되었습니다');
  notice('포인트 상품 구매 완료', `${p.pt_gds_name}`);
}

// ---------------------------------------------------------------------- payment
function paymentFlow(amount) {
  const { settings } = st.catalog;
  const rfidOnly = settings.rfid === 'on';
  return new Promise((resolve) => {
    const el = screen(`<h2>결제 방법을 선택해 주세요</h2>
      <div class="pay-amount"><span>결제금액</span><b>${won(amount)}</b><button class="k-btn" id="payCancel">취소</button></div>
      <div class="pay-methods">${
        rfidOnly
          ? '<button class="card" data-m="rfid"><i>🪪</i>RFID 카드</button>'
          : '<button class="card" data-m="card"><i>💳</i>카드결제</button><button data-m="samsung"><i>📱</i>삼성페이</button><button class="kakao" data-m="kakao"><i>pay</i>카카오페이</button><button class="naver" data-m="naver"><i>N Pay</i>네이버페이</button>'
      }</div>`);
    el.querySelector('#payCancel').onclick = () => (closeScreen(), resolve(null));
    el.querySelectorAll('[data-m]').forEach(
      (b) =>
        (b.onclick = async () => {
          try {
            resolve(await payWith(b.dataset.m, amount));
          } catch (e) {
            speak('결제가 취소되었습니다');
            await notice('결제를 완료하지 못했습니다', esc(e.message));
            closeScreen();
            resolve(null);
          }
        }),
    );
  });
}

async function payWith(method, amount) {
  if (method === 'card' || method === 'samsung') {
    const card = method === 'card';
    speak(card ? '카드를 삽입해 주세요' : '휴대폰을 카드 단말기에 대 주세요');
    const el = screen(`<div class="pay-anim">${card ? '💳' : '📱'}</div><h2>${card ? '카드를 삽입해 주세요' : '휴대폰을 단말기에 대 주세요'}</h2>
      <p class="muted">${won(amount)} · 3D 화면의 카드 단말기(화면 아래 오른쪽)를 클릭하세요</p><button class="k-btn" id="pc">결제 취소</button>`);
    el.querySelector('#pc').onclick = () => call('cancelPayment');
    const res = await call('payCard', amount);
    if (card) {
      speak('카드를 빼 주세요');
      screen(`<div class="pay-anim">💳</div><h2>결제가 완료되었습니다</h2><p>승인번호 ${esc(res.APPROVALNO)} · 카드를 빼 주세요</p>`);
      await call('waitCardRemoved');
    }
    return { method: 'CD', res };
  }
  if (method === 'kakao' || method === 'naver') {
    const kakao = method === 'kakao';
    const len = kakao ? 24 : 160;
    speak('바코드를 스캐너에 보여 주세요');
    const code = await new Promise((resolve, reject) => {
      const el = screen(`<div class="pay-anim">${kakao ? '🟡' : '🟢'}</div><h2>${kakao ? '카카오페이' : '네이버페이'} 바코드를 스캐너에 보여 주세요</h2>
        <p class="muted">스캐너는 키보드처럼 ${len}자를 입력합니다 (가상 스캐너: 아래 버튼)</p>
        <div class="scan-box"><input id="scan" maxlength="${len}" placeholder="바코드 ${len}자"><button class="k-btn primary" id="vs">가상 스캔</button></div>
        <button class="k-btn" id="pc" style="margin-top:14px">결제 취소</button>`);
      const input = el.querySelector('#scan');
      input.focus();
      input.oninput = () => input.value.length >= len && resolve(input.value);
      el.querySelector('#vs').onclick = () => resolve(Array.from({ length: len }, (_, i) => (kakao ? Math.floor(Math.random() * 10) : 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 34)])).join(''));
      el.querySelector('#pc').onclick = () => reject(new Error('사용자 취소'));
    });
    speak('바코드를 확인했습니다');
    const res = await call('payBarcode', kakao ? 'PC' : 'MI', amount, code);
    return { method: 'CD', res };
  }
  if (method === 'rfid') {
    speak('카드를 리더기에 태그해 주세요');
    const uid = await new Promise((resolve, reject) => {
      const el = screen(`<div class="pay-anim">🪪</div><h2>RFID 카드를 태그해 주세요</h2><p class="muted">리더기는 10자리 숫자를 입력합니다</p>
        <div class="scan-box"><input id="rf" maxlength="10" placeholder="0000000000"><button class="k-btn primary" id="reg">등록된 카드 태그</button><button class="k-btn" id="unreg">미등록 카드</button></div>
        <button class="k-btn" id="pc" style="margin-top:14px">취소</button>`);
      const input = el.querySelector('#rf');
      input.focus();
      input.oninput = () => input.value.length >= 10 && resolve(input.value);
      el.querySelector('#reg').onclick = async () => {
        const s = await call('api', 'GET', 'cafesim-admin/state');
        resolve(String(parseInt(s.rfid[0] ?? '0', 16)).padStart(10, '0'));
      };
      el.querySelector('#unreg').onclick = () => resolve('0012345678');
      el.querySelector('#pc').onclick = () => reject(new Error('사용자 취소'));
    });
    const hex = Number(uid).toString(16).toUpperCase().padStart(10, '0');
    const r = await call('api', 'GET', `mailbean/check_rfid_card_uid/${st.catalog.settings.MacAddr}/${hex}/`);
    if (r.status !== 'RFID card exist') throw new Error(r.status === 'Invalid hexadecimal' ? '카드를 읽을 수 없습니다' : '등록되지 않은 카드입니다');
    return { method: 'RF', cardNum: hex, res: { RES: '0000', STATUS: 'O', MSG: 'RFID 승인', FILLER: hex } };
  }
  throw new Error(`unknown method ${method}`);
}

// ---------------------------------------------------------------------- production
async function produce(priced, personalCup, rec) {
  const drinks = priced.filter((l) => l.g.gds_type === 'goods-drink').flatMap((l) => Array.from({ length: l.qty }, () => l.g));
  const showReceipt = st.catalog.store.st_qr_recipt_status === 'Y' && rec?.receipt;
  if (!drinks.length) {
    speak('결제가 완료되었습니다');
    screen(`<div class="big">🛍️</div><h2>결제가 완료되었습니다</h2><p class="muted">기타 상품은 매장에서 받아 가세요</p>${receiptHtml(showReceipt && rec.receipt)}`);
    await sleep(5000);
    return;
  }
  st.progress = { drinks, index: 0, phase: 'cup', text: '음료를 준비합니다', guide: '' };
  drawProgress();
  await call('makeDrinks', drinks.map((g) => g.gds_id), { personalCup });
  const clean = st.catalog.store.st_dtl_auto_clean_status && st.catalog.store.st_dtl_auto_clean_status !== 'N';
  speak(clean ? '주문하신 음료가 완성되었습니다. 음료 픽업 후 고온 세척이 시작됩니다' : '주문하신 음료가 완성되었습니다. 맛있게 드세요');
  st.progress = null;
  screen(`<div class="big">😊</div><h2>주문하신 음료가 완성되었습니다</h2>${clean ? '<p class="muted">음료 픽업 후 고온 세척이 시작됩니다</p>' : ''}${receiptHtml(showReceipt && rec.receipt)}`);
  await sleep(5000);
}

function receiptHtml(url) {
  return url ? `<p><a class="k-btn" href="${esc(url)}" target="_blank">🧾 영수증 보기</a></p>` : '';
}

function drawProgress() {
  const p = st.progress;
  if (!p) return;
  const idx = STEP_ORDER.indexOf(p.phase);
  screen(`<h2>${esc(p.text)}</h2>
    <div class="prog-steps">${STEP_ORDER.map((s, i) => `<span class="${i < idx ? 'done' : i === idx ? 'now' : ''}">${STEP_LABEL[s]}</span>`).join('')}</div>
    <div class="prog-strip">${p.drinks
      .map((g, i) => `<div class="drink ${i === p.index ? 'now' : i < p.index ? 'done' : ''}"><img src="${esc(g.img_url)}" alt=""><b>${esc(g.gds_name)}</b><small>${g.gds_spout_num}번 추출구 · ${i < p.index ? '제조 완료' : i === p.index ? '제조중' : '제조 대기'}</small></div>`)
      .join('')}</div>
    <div class="guide-line">${p.guide ? `👉 ${esc(p.guide)}` : ''}</div>`);
}

const PHASE_VOICE = { cup: '컵을 꺼내 주세요', ice: '제빙기에서 얼음을 받아 주세요', place: '추출구로 컵을 옮겨 주세요', brew: '음료를 제조합니다', take: '음료를 가져가세요' };

S.on('progress', (e) => {
  if (e.phase === 'wash') {
    if (!st.progress) banner(`🧼 ${e.text}`);
    return;
  }
  if (e.phase === 'wash-done') return banner('');
  if (!st.progress) return;
  if (e.index !== undefined && e.index < st.progress.drinks.length) st.progress.index = e.index;
  if (e.phase && STEP_ORDER.includes(e.phase)) {
    st.progress.phase = e.phase;
    speak(PHASE_VOICE[e.phase]);
  }
  st.progress.text = e.text ?? st.progress.text;
  drawProgress();
});

S.on('guide', (prompts) => {
  if (!st.progress) return;
  const p = prompts.find((x) => x.action) ?? prompts[0];
  st.progress.guide = p?.text ?? '';
  drawProgress();
});

S.on('remote', (e) => {
  const names = { 'remote-wash': '원격 세척', 'remote-cup': '원격 컵 배출', 'remote-ice': '원격 출빙', 'remote-extraction': '원격 제조', 'remote-refund': '원격 환불', 'remote-refill': '재고 갱신', 'remote-restart': '원격 재시작', 'remote-loadLog': '로그 업로드' };
  if (e.status === 'start') banner(`📡 원격 조정 중입니다 · ${names[e.title] ?? e.title}`, e.by === 'server' ? 8000 : 0);
  else {
    banner(e.status === 'error' ? `⚠️ ${names[e.title] ?? e.title} 실패: ${e.error}` : '', e.status === 'error' ? 6000 : 0);
    if (e.title === 'remote-refill' || e.title === 'remote-refund') loadCatalog();
  }
});

S.on('data', () => !st.busy && loadCatalog());

// ====================================================================== admin mode
$('brand').onclick = () => {
  const now = Date.now();
  st.taps = [...st.taps.filter((t) => now - t < 3000), now];
  if (st.taps.length >= 6) {
    st.taps = [];
    adminLogin();
  }
};

async function adminLogin() {
  const pw = await keypad({ title: '관리자 비밀번호', maxLen: 4, mask: true, validate: (v) => v.length === 4 });
  if (pw === null) return;
  if (pw !== String(st.catalog.settings.login_password)) return notice('비밀번호가 일치하지 않습니다');
  openAdmin('stock');
}

const ADMIN_TABS = [
  ['stock', '재고량'],
  ['wash', '기기 세척'],
  ['test', '테스트 모드'],
  ['menu', '메뉴 관리'],
  ['machine', '기기 설정'],
  ['cup', '컵 리필'],
  ['ice', '제빙기 초기화'],
  ['power', '재시작'],
];

async function openAdmin(tab) {
  st.catalog = await call('catalog');
  let wrap = document.querySelector('.admin');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'admin';
    document.body.append(wrap);
  }
  wrap.innerHTML = `<aside class="admin-side">${ADMIN_TABS.map(([k, l]) => `<button data-t="${k}" class="${k === tab ? 'on' : ''}">${l}</button>`).join('')}<button class="close" data-close>닫기</button></aside><section class="admin-body" id="adminBody"></section>`;
  wrap.querySelectorAll('[data-t]').forEach((b) => (b.onclick = () => openAdmin(b.dataset.t)));
  wrap.querySelector('[data-close]').onclick = async () => {
    if (st.washing) return notice('세척 중에는 닫을 수 없습니다');
    wrap.remove();
    await loadCatalog();
  };
  const body = wrap.querySelector('#adminBody');
  await ADMIN[tab](body);
}

const ADMIN = {
  async stock(el) {
    const ing = st.catalog.ingredients;
    el.innerHTML = `<h3>재고량</h3><div class="stock-grid">${st.meta.ingredients
      .map((k) => {
        const now = Number(ing[`${k}_now`]);
        const max = Number(ing[`${k}_max`]) || 1;
        const per = Math.round((now / max) * 100);
        return `<div><b>${esc(st.meta.ingredientLabel[k])}</b><div class="bar"><i class="${per < Number(ing[`${k}_notification_per`]) ? 'low' : ''}" style="width:${per}%"></i></div>${Math.round(now)} / ${max} (${per}%) <button class="k-btn" data-fill="${k}" style="float:right;padding:4px 10px">채우기</button></div>`;
      })
      .join('')}</div>`;
    el.querySelectorAll('[data-fill]').forEach((b) => (b.onclick = async () => (await call('refill', b.dataset.fill), openAdmin('stock'))));
  },
  async wash(el) {
    el.innerHTML = `<h3>기기 세척</h3><p class="muted">세척 시간 ${st.catalog.settings.washTime}ms · 밸브 간격 ${st.catalog.settings.washAirTime}ms (관리 콘솔 → 장비 설정)</p>
      <div class="btn-grid">${st.meta.washParts.map((p) => `<button data-w="${p}">${esc(st.meta.washLabel[p])}</button>`).join('')}</div><p id="washState" class="muted"></p>`;
    el.querySelectorAll('[data-w]').forEach(
      (b) =>
        (b.onclick = async () => {
          if (st.washing) return;
          st.washing = b.dataset.w;
          el.querySelector('#washState').textContent = `${st.meta.washLabel[b.dataset.w]} 세척 중... (3D 화면에서 물이 나옵니다)`;
          speak('고온 세척을 시작합니다');
          try {
            await call('wash', b.dataset.w);
            el.querySelector('#washState').textContent = '세척 완료';
          } catch (e) {
            el.querySelector('#washState').textContent = `실패: ${e.message}`;
          } finally {
            st.washing = null;
          }
        }),
    );
  },
  async test(el) {
    el.innerHTML = `<h3>테스트 모드</h3><p>테스트 모드에서는 결제 없이 주문되고, 결제 수단은 TEST로 기록됩니다. 대기 시간이 지나면 자동으로 꺼집니다.</p>
      <div class="k-actions" style="max-width:420px"><button data-v="on" class="${st.testMode ? 'primary' : ''}">ON</button><button data-v="off" class="${!st.testMode ? 'primary' : ''}">OFF</button></div>`;
    el.querySelectorAll('[data-v]').forEach(
      (b) =>
        (b.onclick = () => {
          st.testMode = b.dataset.v === 'on';
          st.cart.clear();
          renderCart();
          renderFoot();
          ADMIN.test(el);
        }),
    );
  },
  async menu(el, selected) {
    const goods = st.catalog.goods.filter((g) => g.gds_type === 'goods-drink');
    const g = goods.find((x) => x.gds_id === selected) ?? goods[0];
    const r = g.gds_recipe;
    const codes = String(r.dataCodes).match(/S\d{3}/g) ?? [];
    const uses = [...new Set(codes.flatMap((c) => st.meta.dataCodes.find((d) => d.code === c)?.uses ?? []))];
    el.innerHTML = `<h3>메뉴 관리</h3>
      <div class="form2"><label>메뉴<select id="mg">${goods.map((x) => `<option value="${x.gds_id}" ${x.gds_id === g.gds_id ? 'selected' : ''}>${esc(x.gds_name)}</option>`).join('')}</select></label>
        <label>투출구<select id="ms">${['1', '2', '3'].map((v) => `<option ${String(g.gds_spout_num) === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label>가격<input id="mp" type="number" value="${g.gds_price}"></label></div>
      <p><b>제조 순서</b></p><div class="seq" id="seq">${codes.map((c, i) => `<span data-i="${i}">${c} ${esc(st.meta.dataCodes.find((d) => d.code === c)?.label ?? '')} ✕</span>`).join('')}</div>
      <div class="seq-src">${st.meta.dataCodes.map((d) => `<button data-c="${d.code}">${d.code} ${esc(d.label)}</button>`).join('')}</div>
      <p><b>레시피</b> <span class="muted">(제조 순서에 쓰이는 값)</span></p>
      <div class="form2">${uses.map((k) => `<label>${k}<input data-r="${k}" type="number" step="0.1" value="${esc(r[k])}"></label>`).join('') || '<span class="muted">-</span>'}</div>
      <div class="k-actions" style="max-width:420px"><button class="primary" id="msave">저장</button></div>
      <p class="muted">모든 항목(카테고리, 태그, 상태, 이미지 색상 …)은 시뮬레이터 상단의 '관리 콘솔'에서 편집할 수 있습니다.</p>`;
    el.querySelector('#mg').onchange = (e) => ADMIN.menu(el, e.target.value);
    const save = async (patchCodes) => {
      const next = structuredClone(g);
      next.gds_spout_num = el.querySelector('#ms').value;
      next.gds_recipe.gds_spout_num = next.gds_spout_num;
      next.gds_price = Number(el.querySelector('#mp').value) || 0;
      el.querySelectorAll('[data-r]').forEach((i) => (next.gds_recipe[i.dataset.r] = String(i.value || '0')));
      if (patchCodes !== undefined) next.gds_recipe.dataCodes = patchCodes;
      await call('saveGoods', next);
      st.catalog = await call('catalog');
      ADMIN.menu(el, g.gds_id);
    };
    el.querySelectorAll('#seq [data-i]').forEach((s) => (s.onclick = () => save(codes.filter((_, i) => i !== Number(s.dataset.i)).join(''))));
    el.querySelectorAll('[data-c]').forEach((b) => (b.onclick = () => save(codes.join('') + b.dataset.c)));
    el.querySelector('#msave').onclick = () => save();
  },
  async machine(el) {
    const t = st.catalog.settings.multiDevice?.mainDevice ?? st.catalog.settings;
    const keys = [
      ['coffeeReady', '커피 대기'],
      ['coffeeUse', '커피 사용'],
      ['coffeeExtraction', '커피 추출'],
      ['coffeeOffset', '커피 오프셋'],
      ['hotWaterReady', '온수 대기'],
      ['hotWaterUse', '온수 사용'],
      ['hotWaterExtraction', '온수 추출'],
      ['hotWaterOffset', '온수 오프셋'],
    ];
    el.innerHTML = `<h3>기기 설정</h3><div class="form2">${keys.map(([k, l]) => `<label>${l} (°C)<input data-k="${k}" type="number" value="${esc(t[k])}"></label>`).join('')}</div>
      <div class="k-actions" style="max-width:420px"><button class="primary" id="tsave">저장하고 장비에 적용</button></div><p id="tmsg" class="muted"></p>`;
    el.querySelector('#tsave').onclick = async () => {
      const body = Object.fromEntries([...el.querySelectorAll('[data-k]')].map((i) => [i.dataset.k, i.value]));
      await call('setTemperatures', body);
      el.querySelector('#tmsg').textContent = '저장했습니다 (update_temp_set + S001~S006 / S016~S017)';
    };
  },
  async cup(el) {
    const ing = st.catalog.ingredients;
    el.innerHTML = `<h3>컵 리필</h3><p>컵을 채운 뒤 확인을 누르면 컵 디스펜서를 리셋하고 재고를 최대로 맞춥니다.</p>
      <div class="btn-grid"><button data-c="hot">핫컵 확인<br><small>${ing.cup1_now}/${ing.cup1_max}</small></button><button data-c="ice">아이스컵 확인<br><small>${ing.cup2_now}/${ing.cup2_max}</small></button>
      <button data-o="hot">HOT 컵 1개 배출</button><button data-o="ice">ICE 컵 1개 배출</button></div>`;
    el.querySelectorAll('[data-c]').forEach((b) => (b.onclick = async () => (await call('resetCup', b.dataset.c), openAdmin('cup'))));
    el.querySelectorAll('[data-o]').forEach((b) => (b.onclick = async () => (await call('cupOut', b.dataset.o), openAdmin('cup'))));
  },
  async ice(el) {
    el.innerHTML = `<h3>제빙기 초기화</h3><p>제빙기를 재부팅(E0)하고 통신모드(A0)·타임아웃(D0)을 다시 설정합니다.</p><div class="k-actions" style="max-width:420px"><button class="primary" id="ir">초기화</button></div><p id="imsg" class="muted"></p>`;
    el.querySelector('#ir').onclick = async () => {
      el.querySelector('#imsg').textContent = '초기화 중...';
      await call('resetIce');
      el.querySelector('#imsg').textContent = '완료';
    };
  },
  async power(el) {
    el.innerHTML = `<h3>재시작</h3><p>키오스크 프로그램을 다시 시작합니다 (서버 설정 다시 읽기, 장치 리셋).</p><div class="k-actions" style="max-width:420px"><button class="primary" id="rs">재시작</button></div>`;
    el.querySelector('#rs').onclick = () => location.reload();
  },
};

// ====================================================================== idle / standby
let idleTimer = null;
function resetIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(goIdle, IDLE_MS);
}
function goIdle() {
  if (st.busy || document.querySelector('.admin')) return resetIdle();
  st.cart.clear();
  st.testMode = false;
  renderCart();
  renderFoot();
  closeModal();
  const s = st.catalog?.store;
  if (s?.st_standby_screen_status === 'Y' && s.st_standby_screen) {
    const url = s.st_standby_screen;
    $('standby').innerHTML = /\.(mp4|webm)$/i.test(url) ? `<video src="${esc(url)}" autoplay muted loop></video>` : '';
    $('standby').style.backgroundImage = /\.(mp4|webm)$/i.test(url) ? '' : `url("${url}")`;
    $('standby').hidden = false;
  }
}
$('standby').onclick = () => ($('standby').hidden = true);
for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, resetIdle, true);

// ====================================================================== boot
$('voiceBtn').onclick = () => {
  st.voice = !st.voice;
  $('voiceBtn').textContent = st.voice ? '🔊' : '🔇';
};
setInterval(() => {
  $('clock').textContent = new Date().toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}, 1000);
setInterval(async () => {
  if (st.busy || !st.catalog) return;
  try {
    const s = await call('getState');
    const main = Object.values(s?.devices ?? {}).find((d) => d.type === 'mailbean-mainboard');
    if (main) st.catalog.temps = main.temps;
    renderFoot();
  } catch {}
}, 3000);

async function boot() {
  if (!S?.available) {
    document.body.innerHTML = '<p style="padding:40px;font-size:20px">이 화면은 cafeSim 뷰어 안에서 실행됩니다.</p>';
    return;
  }
  st.meta = await call('meta');
  screen('<div class="big">☕</div><h2>시작하는 중...</h2><p class="muted">서버 설정을 받고 장치를 초기화합니다</p>');
  await loadCatalog();
  await call('init').catch(() => {});
  closeScreen();
  resetIdle();
}

boot().catch((e) => screen(`<h2>시작하지 못했습니다</h2><p>${esc(e.message)}</p>`));
