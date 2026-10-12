/**
 * Default kiosk UI for the M400 touch screen. It only uses the public kiosk SDK
 * (window.CafeSim from /cafesim-kiosk-sdk.js), so it doubles as an example for
 * building your own UI.
 */
const S = window.CafeSim;
const $ = (id) => document.getElementById(id);
const won = (n) => `${n.toLocaleString()}원`;

const state = { menu: [], cat: null, cart: [], option: null, busy: false };
const STEP_ORDER = ['cup', 'ice', 'place', 'brew', 'take'];
const STEP_LABEL = { cup: '컵', ice: '얼음', place: '투출구', brew: '제조', take: '픽업' };

function cupArt(item, temp) {
  return `<div class="cupart ${temp}" style="--c:${item.color ?? '#6b4226'}"><div class="body"></div><div class="lid"></div></div>`;
}

async function boot() {
  if (!S?.available) {
    document.body.innerHTML = '<p style="padding:40px;font-size:20px">이 화면은 cafeSim 뷰어 안에서 실행됩니다.</p>';
    return;
  }
  state.menu = await S.getMenu();
  const cats = [...new Set(state.menu.map((m) => m.category ?? '메뉴'))];
  state.cat = cats[0];
  $('cats').innerHTML = cats.map((c) => `<button data-cat="${c}">${c}</button>`).join('');
  $('cats').onclick = (e) => {
    if (e.target.dataset.cat) {
      state.cat = e.target.dataset.cat;
      renderGrid();
    }
  };
  renderGrid();
  renderCart();
  setInterval(() => ($('clock').textContent = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })), 1000);

  S.on('guide', (prompts) => {
    const p = prompts.find((x) => x.action) ?? prompts[0];
    $('ovGuide').textContent = state.busy && p ? `👉 ${p.text}` : '';
  });
  S.on('step', onStep);
  S.init().catch(() => {});
}

function renderGrid() {
  document.querySelectorAll('#cats button').forEach((b) => b.classList.toggle('on', b.dataset.cat === state.cat));
  $('grid').innerHTML = state.menu
    .filter((m) => (m.category ?? '메뉴') === state.cat)
    .map(
      (m) => `<button class="k-item" data-id="${m.id}">
        ${cupArt(m, m.temps[0])}
        <h4>${m.name}</h4><div class="price">${won(m.price)}</div>
        <div class="temps">${m.temps.map((t) => `<span class="tag ${t}">${t.toUpperCase()}</span>`).join('')}</div>
      </button>`,
    )
    .join('');
  $('grid').onclick = (e) => {
    const b = e.target.closest('[data-id]');
    if (b) openOption(state.menu.find((m) => m.id === b.dataset.id));
  };
}

function openOption(item) {
  state.option = { item, temp: item.temps[0] };
  $('optName').textContent = item.name;
  $('optPrice').textContent = won(item.price);
  const draw = () => {
    $('optCup').innerHTML = cupArt(item, state.option.temp);
    $('optTemps').innerHTML = item.temps.map((t) => `<button class="${t} ${t === state.option.temp ? 'on' : ''}" data-t="${t}">${t === 'ice' ? 'ICE 🧊' : 'HOT ☕'}</button>`).join('');
  };
  $('optTemps').onclick = (e) => {
    if (e.target.dataset.t) {
      state.option.temp = e.target.dataset.t;
      draw();
    }
  };
  draw();
  $('optModal').hidden = false;
}

$('optCancel').onclick = () => ($('optModal').hidden = true);
$('optAdd').onclick = () => {
  const { item, temp } = state.option;
  const line = state.cart.find((l) => l.item.id === item.id && l.temp === temp);
  if (line) line.qty++;
  else state.cart.push({ item, temp, qty: 1 });
  $('optModal').hidden = true;
  renderCart();
};
$('clearBtn').onclick = () => {
  state.cart = [];
  renderCart();
};

function total() {
  return state.cart.reduce((a, l) => a + l.item.price * l.qty, 0);
}

function renderCart() {
  $('cartList').innerHTML = state.cart
    .map((l, i) => `<li><span>${l.temp === 'ice' ? 'ICE' : 'HOT'} ${l.item.name}</span><button data-i="${i}" data-d="-1">−</button><b>${l.qty}</b><button data-i="${i}" data-d="1">+</button></li>`)
    .join('');
  $('cartList').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const l = state.cart[b.dataset.i];
    l.qty += Number(b.dataset.d);
    if (l.qty <= 0) state.cart.splice(b.dataset.i, 1);
    renderCart();
  };
  $('total').textContent = won(total());
  $('payBtn').disabled = !state.cart.length;
}

function overlay({ icon, title, text = '', steps = null, cancel = false }) {
  $('overlay').hidden = false;
  $('ovIcon').innerHTML = icon;
  $('ovTitle').textContent = title;
  $('ovText').textContent = text;
  $('ovCancel').hidden = !cancel;
  $('ovSteps').innerHTML = steps ?? '';
}

let currentStep = null;
function onStep(s) {
  if (!state.busy || !STEP_ORDER.includes(s.id)) return;
  currentStep = s.id;
  const idx = STEP_ORDER.indexOf(s.id);
  $('ovSteps').innerHTML = STEP_ORDER.map((id, i) => `<li class="${i < idx ? 'done' : i === idx ? 'now' : ''}">${STEP_LABEL[id]}</li>`).join('');
  $('ovText').textContent = s.text;
}

$('ovCancel').onclick = () => S.cancelPayment();

$('payBtn').onclick = async () => {
  if (state.busy) return;
  state.busy = true;
  const amount = total();
  try {
    overlay({ icon: '<span class="card-anim">💳</span>', title: '카드를 단말기에 넣어 주세요', text: `결제 금액 ${won(amount)} · 화면 아래 카드 단말기를 클릭하세요`, cancel: true });
    const res = await S.pay(amount);
    overlay({ icon: '✅', title: '결제가 완료되었습니다', text: `승인번호 ${res.APPROVALNO ?? '-'} · 카드를 빼 주세요` });
    await new Promise((r) => setTimeout(r, 1200));
    const lines = state.cart.flatMap((l) => Array.from({ length: l.qty }, () => l));
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      overlay({ icon: l.temp === 'ice' ? '🧊' : '☕', title: `${l.temp === 'ice' ? 'ICE' : 'HOT'} ${l.item.name} (${i + 1}/${lines.length})`, text: '음료를 준비하고 있습니다', steps: '' });
      await S.order(l.item.id, l.temp);
    }
    overlay({ icon: '😊', title: '맛있게 드세요!', text: '이용해 주셔서 감사합니다' });
    state.cart = [];
    renderCart();
    await new Promise((r) => setTimeout(r, 2500));
  } catch (e) {
    overlay({ icon: '⚠️', title: '처리하지 못했습니다', text: e.message });
    await new Promise((r) => setTimeout(r, 3000));
  } finally {
    state.busy = false;
    currentStep = null;
    $('overlay').hidden = true;
    $('ovGuide').textContent = '';
  }
};

boot();
