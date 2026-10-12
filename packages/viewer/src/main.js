import { LocalLink, RemoteLink, createMachine } from './link.js';
import { Stage } from './scene/Stage.js';
import { Panels } from './ui/panels.js';
import { KioskBridge } from './kiosk/bridge.js';
import { createBackendClient } from './backendClient.js';
import { AdminConsole } from './ui/console.js';
import { OrderKioskPopup, RobotCard } from './ui/robotUi.js';

// Every platform folder in /platforms is bundled; add one with `npm run create-platform <name>`
const platformModules = import.meta.glob('@platforms/*/platform.js', { eager: true });
const platforms = Object.fromEntries(Object.values(platformModules).map((m) => [m.default.id, m.default]));

const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);

/** When the page itself is served by `cafesim start`, mirror that server automatically. */
async function detectServer() {
  if (params.has('server')) return params.get('server');
  if (params.has('local')) return null;
  // the robot cafe is a self-contained demo that runs in this browser
  if (platforms[params.get('platform')]?.layout?.robot) return null;
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 800);
    const room = encodeURIComponent(params.get('room') ?? 'main');
    const res = await fetch(`./api/info?room=${room}`, { signal: ctrl.signal });
    if (res.ok && res.headers.get('content-type')?.includes('json')) return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?room=${room}`;
  } catch {}
  return null;
}

async function boot() {
  const serverUrl = await detectServer();
  let link;
  let definition;
  if (serverUrl) {
    link = await new RemoteLink(serverUrl).connect();
    definition = platforms[link.platformId];
    if (!definition) throw new Error(`서버 플랫폼 "${link.platformId}" 정의를 이 뷰어에서 찾을 수 없습니다 (/platforms)`);
    $('modeBadge').textContent = link.info?.cloud ? `CLOUD · ${link.info.room}` : 'SERVER';
    $('modeBadge').classList.add('remote');
    $('modeBadge').title = serverUrl;
    link.on('disconnected', () => toast('시뮬레이터 서버 연결이 끊어졌습니다', 'error'));
  } else {
    definition = platforms[params.get('platform') ?? 'm400'] ?? platforms.m400;
    link = new LocalLink(definition, { autoAssist: params.has('auto') });
  }
  document.title = `cafeSim · ${definition.name}`;
  $('platformName').textContent = definition.name;

  const sel = $('platformSelect');
  for (const p of Object.values(platforms)) sel.add(new Option(p.name, p.id, false, p.id === definition.id));
  const go = (id) => {
    // the server's own platform is mirrored, every other platform (e.g. the robot cafe demo) runs in this browser
    if (serverUrl && id === link.platformId) params.delete('platform');
    else params.set('platform', id);
    params.delete('server');
    location.search = params.toString();
  };
  sel.onchange = () => go(sel.value);
  const robotDemo = Object.values(platforms).find((p) => p.layout?.robot);
  if (robotDemo && !definition.layout?.robot) {
    $('robotDemoBtn').hidden = false;
    $('robotDemoBtn').onclick = () => go(robotDemo.id);
  }

  const machine = createMachine(link, definition);
  const kioskUrl = params.get('kiosk') ?? definition.kiosk ?? `./kiosk.html?platform=${definition.id}`;

  const act = (action) => link.interact(action).catch((e) => toast(e.message, 'error'));
  const stage = new Stage($('stage'), { definition, link, kioskUrl, onAction: act, onToast: (m) => toast(m) });
  const panels = new Panels($('tabBody'), { definition, link, machine, act, toast, stage });
  const backend = createBackendClient(link, definition);
  const bridge = new KioskBridge({ machine, definition, link, backend, toast });
  const adminConsole = new AdminConsole({ backend, bridge, definition, toast });
  $('consoleBtn').onclick = () => adminConsole.open();

  // ------------------------------------------------------------------ order kiosk pop-up (separate monitor) + robot cell
  const orderUrl = `./kiosk.html?platform=${definition.id}`;
  const orderPopup = new OrderKioskPopup({ url: orderUrl, title: `${definition.name} · 주문 키오스크` });
  $('orderBtn').onclick = () => orderPopup.toggle();
  let robot = null;
  if (definition.layout?.robot) {
    const { RobotCell } = await import('./robot/RobotCell.js');
    robot = new RobotCell({ stage, link, definition });
    stage.robot = robot;
    const card = new RobotCard(robot, definition.layout.robot.model);
    toast('UR5e 로봇 모델을 불러오는 중... (studyUR)');
    robot
      .load()
      .then(() => toast('로봇 준비 완료 - 주문 키오스크에서 메뉴를 주문하세요'))
      .catch((e) => toast(`로봇 로딩 실패: ${e.message}`, 'error'));
    void card;
    orderPopup.open();
  }
  window.cafesim = { link, machine, definition, stage, bridge, backend, adminConsole, platforms }; // handy in DevTools

  // ------------------------------------------------------------------ top bar
  document.querySelectorAll('[data-view]').forEach((b) => (b.onclick = () => stage.view(b.dataset.view)));
  $('xray').onchange = (e) => stage.setXray(e.target.checked);
  $('autoAssist').onchange = (e) => act({ type: 'autoAssist', on: e.target.checked });
  $('speed').oninput = (e) => {
    $('speedOut').textContent = `${e.target.value}×`;
    act({ type: 'speed', value: Number(e.target.value) });
  };
  let paused = false;
  $('pauseBtn').onclick = () => {
    paused = !paused;
    $('pauseBtn').textContent = paused ? '▶' : '❚❚';
    act({ type: 'pause', on: paused });
  };
  $('panelBtn').onclick = () => {
    $('panel').classList.toggle('hidden');
    stage.resize();
  };
  document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => panels.show(b.dataset.tab)));

  // ------------------------------------------------------------------ guide banner
  let currentAction = null;
  const renderGuide = (snap) => {
    const prompts = snap.guide ?? [];
    const g = $('guide');
    g.hidden = !prompts.length;
    if (!prompts.length) return;
    const actionable = prompts.find((p) => p.action);
    const main = actionable ?? prompts[0];
    $('guideText').textContent = robot ? `${robot.busy ? robot.status : main.text}` : main.text;
    g.classList.toggle('waiting', !actionable || !!robot);
    $('guideDo').hidden = !actionable || !!robot;
    currentAction = actionable?.action ?? null;
  };
  $('guideDo').onclick = () => currentAction && act(currentAction);

  // ------------------------------------------------------------------ state stream
  let last = 0;
  const onSnap = (snap) => {
    stage.update(snap);
    renderGuide(snap);
    const now = performance.now();
    if (now - last > 150) {
      last = now;
      panels.update(snap);
      $('autoAssist').checked = snap.autoAssist;
    }
  };
  link.on('snap', onSnap);
  if (link.snapshot) onSnap(link.snapshot);

  link.on('log', (e) => {
    if (e.level === 'error') toast(`[${e.device}] ${e.message}`, 'error');
    else if (e.level === 'warn') toast(`[${e.device}] ${e.message}`, 'warn');
  });
  link.on('event', (e) => {
    if (e.type === 'cup-served') servedCard(e.record);
    if (e.type === 'cup-overflow') toast('컵이 넘쳤습니다!', 'warn');
  });

  if (params.has('view')) stage.view(params.get('view'));
  else if (robot) stage.view('robot', true);
}

function toast(message, level = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${level}`;
  el.textContent = message;
  $('toasts').prepend(el);
  setTimeout(() => el.remove(), level === 'error' ? 7000 : 4000);
  while ($('toasts').children.length > 5) $('toasts').lastChild.remove();
}

function servedCard(r) {
  const c = r.contents;
  const fmt = (n) => Math.round(n);
  const parts = [];
  if (c.coffee) parts.push(`커피 ${fmt(c.coffee)}cc`);
  if (c.water) parts.push(`물 ${fmt(c.water)}cc`);
  for (const [k, v] of Object.entries(c.powder)) parts.push(`파우더${k} ${fmt(v)}cc`);
  for (const [k, v] of Object.entries(c.ade)) parts.push(`시럽${k} ${fmt(v)}cc`);
  if (c.ice) parts.push(`얼음 ${fmt(c.ice)}개`);
  const el = document.createElement('div');
  el.className = 'card';
  el.innerHTML = `<b>☕ ${r.type === 'ice' ? 'ICE' : 'HOT'} 음료 서빙 완료</b><div class="muted">${parts.join(' · ') || '빈 컵'}</div>`;
  $('served').prepend(el);
  setTimeout(() => el.remove(), 9000);
}

boot().catch((e) => {
  console.error(e);
  document.body.innerHTML = `<div style="padding:40px;font:15px system-ui"><h2>cafeSim 시작 실패</h2><p>${e.message}</p><p>서버 모드라면 <code>npm run sim</code> 이 실행 중인지 확인하세요.</p></div>`;
});
