import { mainboardMap, sleep } from '@cafesim/core';
import { EXAMPLES } from './examples.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const pct = (v, max) => Math.max(0, Math.min(100, (v / max) * 100));

const M_NAMES = {};
for (let i = 0; i < 150; i++) M_NAMES[i] = `M${String(i).padStart(3, '0')}`;
Object.entries(mainboardMap.ERRORS).forEach(([i, l]) => (M_NAMES[i] += ` ${l}`));
Object.values(mainboardMap.COMMANDS).forEach((c) => (M_NAMES[c.m] += ` ${c.label} 상태`));
const S_NAMES = {};
Object.entries(mainboardMap.ACTUATORS).forEach(([s, a]) => (S_NAMES[s] = a.label));
Object.entries(mainboardMap.COMMANDS).forEach(([s, c]) => (S_NAMES[s] = c.label));
Object.assign(S_NAMES, { 0: '메뉴모드', 1: '커피 대기온도', 2: '온수 대기온도', 3: '커피 사용온도', 4: '온수 사용온도', 5: '커피 추출온도', 6: '온수 추출온도', 7: '컵센서 사용', 16: '커피 오프셋', 17: '온수 오프셋', 20: '수동모드', 59: '브로멕 상(수동)', 60: '브로멕 중(수동)', 61: '브로멕 하(수동)', 70: '리셋', 71: '에러해제', 72: '비상정지', 155: '커피 투출구 선택', 165: '투출구1 램프', 166: '투출구2 램프', 167: '투출구3 램프' });
for (let i = 80; i < 140; i++) S_NAMES[i] ??= '레시피 레지스터';

export class Panels {
  tab = 'status';
  traffic = [];
  trafficFilter = 'all';
  trafficPaused = false;
  regDevice = null;
  prevRegs = {};

  constructor(el, { definition, link, machine, act, toast, stage }) {
    Object.assign(this, { el, definition, link, machine, act, toast, stage });
    this.regDevice = definition.devices.find((d) => d.type === 'mailbean-mainboard')?.key;
    link.on('traffic', (e) => {
      if (this.trafficPaused) return;
      this.traffic.push({ ...e, at: new Date() });
      if (this.traffic.length > 400) this.traffic.splice(0, this.traffic.length - 400);
      this.trafficDirty = true;
    });
    this.scriptLog = [];
    this.show('status');
  }

  show(tab) {
    this.tab = tab;
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    this.el.innerHTML = '';
    this.el.scrollTop = 0;
    const build = { status: () => this.#statusShell(), control: () => this.#control(), registers: () => this.#registersShell(), traffic: () => this.#trafficShell(), script: () => this.#script(), dev: () => this.#dev() }[tab];
    build?.();
    if (this.link.snapshot) this.update(this.link.snapshot);
  }

  update(snap) {
    this.snap = snap;
    if (this.tab === 'status') this.#status(snap);
    else if (this.tab === 'registers') this.#registers(snap);
    else if (this.tab === 'traffic' && this.trafficDirty) this.#renderTraffic();
    else if (this.tab === 'control') this.#controlState(snap);
  }

  // ================================================================== 상태
  #statusShell() {
    this.el.innerHTML = '<div id="statusCards"></div>';
  }

  #status(snap) {
    const host = this.el.querySelector('#statusCards');
    if (!host) return;
    const parts = [];
    for (const d of this.definition.devices) {
      const s = snap.devices[d.key];
      if (!s) continue;
      const port = d.port?.path ? `${d.port.path} · ${d.port.baudRate}` : d.port?.http ? `HTTP :${d.port.http}` : '';
      parts.push(`<div class="card-dev"><h3>${esc(deviceTitle(s.type, d.key))}<small>${esc(port)}</small></h3>${renderDevice(s, d)}</div>`);
    }
    const w = snap.world;
    const spills = Object.entries(w.spills);
    parts.push(`<div class="card-dev"><h3>월드 <small>t=${snap.time.toFixed(1)}s ×${snap.speed}</small></h3>
      <dl class="kv"><dt>컵</dt><dd>${w.cups.map((c) => `${c.type.toUpperCase()}@${c.slot ?? '-'} (${Math.round(c.volume)}cc)`).join('<br>') || '-'}</dd>
      ${snap.lock ? `<dt>공유 장비</dt><dd>${snap.lock.busy ? `사용 중: ${esc(snap.lock.label)}${snap.lock.waiting ? ` · 대기 ${snap.lock.waiting}건` : ''}` : '대기'}</dd>` : ''}
      <dt>흘린 양</dt><dd>${spills.length ? spills.map(([s, v]) => `${s}: ${Math.round(v)}`).join(', ') + ' <button data-a="clearSpills">닦기</button>' : '없음'}</dd></dl></div>`);
    host.innerHTML = parts.join('');
    host.querySelector('[data-a="clearSpills"]')?.addEventListener('click', () => this.act({ type: 'clearSpills' }));
  }

  // ================================================================== 제어
  #control() {
    const d = this.definition.devices;
    const main = d.find((x) => x.type === 'mailbean-mainboard')?.key;
    const cup = d.find((x) => x.type === 'cup-dispenser')?.key;
    const ice = d.find((x) => x.type === 'ice-maker')?.key;
    const pay = d.find((x) => x.type === 'kscat-terminal')?.key;
    const menu = this.definition.menu ?? [];
    this.el.innerHTML = `
      <div class="section-title">빠른 주문 (SDK · 실제 프로토콜 사용)</div>
      <div class="btn-row">${menu.map((m) => m.temps.map((t) => `<button data-order="${m.id}" data-temp="${t}">${t === 'ice' ? '🧊' : '☕'} ${esc(m.name)}</button>`).join('')).join('')}</div>
      <p class="muted">주문은 키오스크 화면에서도 할 수 있습니다. 결제가 필요하면 카드 단말기를 클릭하세요.</p>

      <div class="section-title">장치 직접 조작 (물리 동작)</div>
      <div class="btn-row">
        ${cup ? `<button data-dev="${cup}" data-act='{"type":"dispense","cup":"hot"}'>HOT 컵 배출</button><button data-dev="${cup}" data-act='{"type":"dispense","cup":"ice"}'>ICE 컵 배출</button>` : ''}
        ${ice ? `<button data-dev="${ice}" data-act='{"type":"manualDispense","ice":3,"water":0}'>제빙기 PUSH (일반모드)</button>` : ''}
        ${pay ? `<button data-dev="${pay}" data-act='{"type":"insertCard"}'>카드 넣기</button><button data-dev="${pay}" data-act='{"type":"removeCard"}'>카드 빼기</button><button data-dev="${pay}" data-act='{"type":"cancel"}'>결제 취소</button>` : ''}
      </div>

      <div class="section-title">메인보드 수동 액추에이터 (S020 수동모드 → S021~S068)</div>
      <div class="btn-row" id="actuators">${Object.values(mainboardMap.ACTUATORS)
        .filter((a) => !a.key.startsWith('lamp') && !a.key.startsWith('fan'))
        .map((a) => `<button data-actuator="${a.key}" title="${esc(a.label)}">${esc(a.label.replace(' 솔레노이드', ' SOL'))}</button>`)
        .join('')}</div>
      <div class="btn-row" style="margin-top:6px">
        <button data-cmd="reset">리셋+에러해제</button><button data-cmd="estop">비상정지</button>
        <button data-cmd="brewUpper">브로멕 상</button><button data-cmd="brewMiddle">브로멕 중</button><button data-cmd="brewLower">브로멕 하</button>
        <button data-cmd="rinse">온수 라인 세척</button>
      </div>

      <div class="section-title">재고 / 장애 주입</div>
      <div class="btn-row">
        <button data-world='{"type":"refillAll"}'>전체 재고 채우기</button>
        ${main ? `<button data-dev="${main}" data-act='{"type":"coldStart"}'>보일러 냉각(콜드 스타트)</button>` : ''}
      </div>
      <div class="btn-row" style="margin-top:6px" id="faults">
        ${main ? `<button data-fault="${main}:waterShortage">물 부족</button><button data-fault="${main}:doorOpen">도어 열림</button><button data-fault="${main}:brewRemoved">브로멕 탈거</button>` : ''}
        ${cup ? `<button data-fault="${cup}:jam">컵 걸림</button>` : ''}
        ${ice ? `<button data-fault="${ice}:error">제빙기 E1</button>` : ''}
        ${pay ? `<button data-fault="${pay}:decline">카드 승인 거절</button><button data-autoapprove="${pay}">카드 자동 승인</button>` : ''}
      </div>
      <p class="muted">장애 버튼은 토글입니다. 켠 상태로 주문/스크립트를 실행해 예외 처리를 테스트하세요.</p>`;

    const run = async (label, fn) => {
      try {
        await fn();
      } catch (e) {
        this.toast(`${label}: ${e.message}`, 'error');
      }
    };
    this.el.querySelectorAll('[data-order]').forEach(
      (b) =>
        (b.onclick = () =>
          run('주문', async () => {
            const item = menu.find((m) => m.id === b.dataset.order);
            this.toast(`${item.name} 주문 시작`);
            await this.machine.init();
            await this.machine.order(item, { temp: b.dataset.temp });
          })),
    );
    this.el.querySelectorAll('[data-dev]').forEach((b) => (b.onclick = () => this.act({ type: 'device', device: b.dataset.dev, action: JSON.parse(b.dataset.act) })));
    this.el.querySelectorAll('[data-world]').forEach((b) => (b.onclick = () => this.act(JSON.parse(b.dataset.world))));
    this.el.querySelectorAll('[data-fault]').forEach(
      (b) =>
        (b.onclick = () => {
          const [device, name] = b.dataset.fault.split(':');
          const on = !b.classList.contains('on');
          this.act({ type: 'device', device, action: { type: 'fault', name, on } });
        }),
    );
    this.el.querySelectorAll('[data-autoapprove]').forEach((b) => (b.onclick = () => this.act({ type: 'device', device: b.dataset.autoapprove, action: { type: 'autoApprove', on: !b.classList.contains('on') } })));
    const m = this.machine.main;
    this.el.querySelectorAll('[data-actuator]').forEach(
      (b) =>
        (b.onclick = () =>
          run('액추에이터', async () => {
            const on = !b.classList.contains('on');
            await m.manualMode(true);
            await m.actuator(b.dataset.actuator, on);
          })),
    );
    const cmds = {
      reset: () => m.reset(),
      estop: () => m.emergencyStop(),
      brewUpper: () => m.manualMode(true).then(() => m.set(59, '1')),
      brewMiddle: () => m.manualMode(true).then(() => m.set(60, '1')),
      brewLower: () => m.manualMode(true).then(() => m.set(61, '1')),
      rinse: () => this.machine.rinse({ seconds: 3 }),
    };
    this.el.querySelectorAll('[data-cmd]').forEach((b) => (b.onclick = () => run(b.textContent, cmds[b.dataset.cmd])));
  }

  #controlState(snap) {
    const main = this.definition.devices.find((x) => x.type === 'mailbean-mainboard')?.key;
    const act = new Set(snap.devices[main]?.actuators ?? []);
    this.el.querySelectorAll('[data-actuator]').forEach((b) => b.classList.toggle('on', act.has(b.dataset.actuator)));
    this.el.querySelectorAll('[data-fault]').forEach((b) => {
      const [device, name] = b.dataset.fault.split(':');
      b.classList.toggle('on', snap.devices[device]?.faults?.includes(name));
    });
    this.el.querySelectorAll('[data-autoapprove]').forEach((b) => b.classList.toggle('on', !!snap.devices[b.dataset.autoapprove]?.autoApprove));
  }

  // ================================================================== 레지스터
  #registersShell() {
    const opts = this.definition.devices.filter((d) => ['mailbean-mainboard', 'cup-dispenser'].includes(d.type));
    this.el.innerHTML = `<div class="btn-row"><select id="regDev">${opts.map((d) => `<option value="${d.key}" ${d.key === this.regDevice ? 'selected' : ''}>${esc(deviceTitle(d.type, d.key))}</option>`).join('')}</select>
      <span class="muted">'1' 녹색 · '2' 파랑 · 값 변경 시 주황 테두리 · 마우스를 올리면 이름</span></div>
      <div class="section-title">S 영역 (호스트 → 장치 명령/설정)</div><div class="grid-reg" id="regS"></div>
      <div class="section-title">M 영역 (장치 → 호스트 상태)</div><div class="grid-reg" id="regM"></div>`;
    this.el.querySelector('#regDev').onchange = (e) => {
      this.regDevice = e.target.value;
      this.prevRegs = {};
    };
  }

  #registers(snap) {
    const s = snap.devices[this.regDevice];
    if (!s?.S) return;
    const isMain = s.type === 'mailbean-mainboard';
    const draw = (id, arr, names, count) => {
      const host = this.el.querySelector(id);
      if (!host) return;
      const prev = this.prevRegs[id] ?? [];
      const cells = [];
      for (let row = 0; row < count; row += 10) {
        cells.push(`<span class="h">${String(row).padStart(3, '0')}</span>`);
        for (let i = row; i < row + 10; i++) {
          const v = arr[i] ?? 0;
          const ch = v >= 0x20 && v < 0x7f ? String.fromCharCode(v) : `x${v.toString(16)}`;
          const cls = [v === 0x31 ? 'one' : v === 0x32 ? 'two' : v !== 0x30 && v !== 0 ? 'nz' : '', prev[i] !== undefined && prev[i] !== v ? 'flash' : ''].join(' ');
          const name = isMain ? names[i] ?? '' : '';
          cells.push(`<span class="${cls}" title="${id === '#regS' ? 'S' : 'M'}${String(i).padStart(3, '0')} = ${v} ${esc(name)}">${esc(ch)}</span>`);
        }
      }
      host.innerHTML = cells.join('');
      this.prevRegs[id] = [...arr];
    };
    draw('#regS', s.S, S_NAMES, isMain ? 180 : 20);
    draw('#regM', s.M, M_NAMES, isMain ? 150 : 30);
  }

  // ================================================================== 통신
  #trafficShell() {
    const devs = this.definition.devices.filter((d) => d.port?.path);
    this.el.innerHTML = `<div class="btn-row"><select id="tf"><option value="all">전체 장치</option>${devs.map((d) => `<option value="${d.key}">${esc(deviceTitle(d.type, d.key))}</option>`).join('')}</select>
      <label class="toggle"><input type="checkbox" id="tfPoll"> 상태 폴링(BR/CF) 숨기기</label>
      <button id="tfPause">${this.trafficPaused ? '재개' : '일시정지'}</button><button id="tfClear">지우기</button></div>
      <p class="muted">호스트(SDK·키오스크·외부 프로그램) ⇄ 가상 장치 사이의 실제 바이트 프레임입니다.</p>
      <div class="traffic" id="traffic"></div>`;
    const tf = this.el.querySelector('#tf');
    tf.value = this.trafficFilter;
    tf.onchange = () => ((this.trafficFilter = tf.value), this.#renderTraffic());
    const poll = this.el.querySelector('#tfPoll');
    poll.checked = this.hidePoll ?? true;
    poll.onchange = () => ((this.hidePoll = poll.checked), this.#renderTraffic());
    this.hidePoll = poll.checked;
    this.el.querySelector('#tfPause').onclick = (e) => {
      this.trafficPaused = !this.trafficPaused;
      e.target.textContent = this.trafficPaused ? '재개' : '일시정지';
    };
    this.el.querySelector('#tfClear').onclick = () => ((this.traffic = []), this.#renderTraffic());
    this.#renderTraffic();
  }

  #renderTraffic() {
    this.trafficDirty = false;
    const host = this.el.querySelector('#traffic');
    if (!host) return;
    const isPoll = (e) => /BRM0|STATUS|^STX/.test(e.text) || (e.dir === 'dev→host' && /^(STX|STATUS)/.test(e.text));
    const rows = this.traffic.filter((e) => (this.trafficFilter === 'all' || e.device === this.trafficFilter) && !(this.hidePoll && isPoll(e))).slice(-200);
    host.innerHTML = rows
      .reverse()
      .map((e) => `<div class="${e.dir === 'host→dev' ? 'tx' : 'rx'}"><span class="t">${e.at.toLocaleTimeString()} ${esc(e.device)} ${e.dir === 'host→dev' ? '→' : '←'}</span>${esc(e.text)}</div>`)
      .join('');
  }

  // ================================================================== 스크립트
  #script() {
    this.el.innerHTML = `
      <div class="btn-row"><select id="ex">${EXAMPLES.map((e, i) => `<option value="${i}">${esc(e.name)}</option>`).join('')}</select>
      <button id="run" class="primary">▶ 실행</button><button id="stop">중지</button></div>
      <p class="muted">변수: <code>machine</code> (SDK), <code>sim</code> (interact/snapshot/on/definition), <code>sleep</code>, <code>log</code>. 코드는 브라우저에 저장됩니다.</p>
      <textarea class="code" id="code" spellcheck="false"></textarea>
      <div class="console" id="out"></div>`;
    const ex = this.el.querySelector('#ex');
    const code = this.el.querySelector('#code');
    const out = this.el.querySelector('#out');
    let saved = null;
    try {
      saved = localStorage.getItem('cafesim.script');
    } catch {}
    code.value = saved ?? EXAMPLES[0].code;
    ex.onchange = () => (code.value = EXAMPLES[ex.value].code);
    code.oninput = () => {
      try {
        localStorage.setItem('cafesim.script', code.value);
      } catch {}
    };
    code.onkeydown = (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        code.setRangeText('  ', code.selectionStart, code.selectionEnd, 'end');
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') this.el.querySelector('#run').click();
    };
    const print = (cls, ...a) => {
      const line = document.createElement('div');
      line.className = cls;
      line.textContent = a.map((x) => (typeof x === 'object' ? JSON.stringify(x, (k, v) => (k === 'raw' ? undefined : v)) : String(x))).join(' ');
      out.append(line);
      out.scrollTop = out.scrollHeight;
    };
    for (const [cls, a] of this.scriptLog) print(cls, ...a);
    const log = (...a) => (this.scriptLog.push(['', a]), print('', ...a));
    this.el.querySelector('#stop').onclick = () => {
      this.cancelScript?.();
      print('err', '중지 요청됨 (진행 중인 장치 동작은 끝날 때까지 계속됩니다)');
    };
    this.el.querySelector('#run').onclick = async () => {
      out.innerHTML = '';
      this.scriptLog = [];
      let cancelled = false;
      this.cancelScript = () => (cancelled = true);
      const listeners = [];
      const sim = {
        definition: this.definition,
        interact: (a) => this.link.interact(a),
        snapshot: () => this.link.snapshot,
        on: (t, fn) => {
          const off = this.link.on(t, fn);
          listeners.push(off);
          return off;
        },
      };
      const machine = new Proxy(this.machine, {
        get: (t, k) => {
          if (cancelled) throw new Error('스크립트 중지됨');
          if (k === 'on') return (type, fn) => listeners.push(t.on(type, fn));
          const v = t[k];
          return typeof v === 'function' ? v.bind(t) : v;
        },
      });
      const sleepC = async (ms) => {
        await sleep(ms);
        if (cancelled) throw new Error('스크립트 중지됨');
      };
      try {
        const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
        await new AsyncFunction('machine', 'sim', 'sleep', 'log', code.value)(machine, sim, sleepC, log);
        print('step', '✔ 스크립트 종료');
      } catch (e) {
        print('err', `✖ ${e.message}`);
      } finally {
        listeners.forEach((off) => off());
      }
    };
  }

  // ================================================================== 연동 (환경 구축 튜토리얼)
  #dev() {
    const d = this.definition;
    const remote = this.link.mode === 'remote';
    const cloud = !!this.link.info?.cloud;
    const room = this.link.info?.room || 'main';
    const here = location.origin + location.pathname.replace(/index\.html$/, '');
    const cloudBase = cloud ? location.origin : 'https://cafesim.samdori93.workers.dev';
    const rows = d.devices
      .map((x) => `<tr><td>${esc(deviceTitle(x.type, x.key))}</td><td>${x.port?.path ? `${x.port.path} @ ${x.port.baudRate}` : '-'}</td><td>${x.port?.tcp ? `127.0.0.1:${x.port.tcp}` : x.port?.http ? `http://127.0.0.1:${x.port.http}` : '-'}</td></tr>`)
      .join('');
    const code = (s) => `<div class="snip"><pre class="snippet">${s}</pre><button type="button" class="copy" title="복사">복사</button></div>`;
    const os = (cmd, ps) => `<div class="os"><span class="os-tag">cmd</span>${code(cmd)}<span class="os-tag">PowerShell</span>${code(ps)}</div>`;
    const ok = (t) => `<p class="tut-ok">✔ 확인: ${t}</p>`;
    const sec = (id, title, sub, body) => `<details class="tut" data-tut="${id}"><summary><b>${title}</b><span class="muted">${sub}</span></summary><div class="tut-body">${body}</div></details>`;

    this.el.innerHTML = `
      <div class="section-title">현재 모드: ${cloud ? `Cloudflare 클라우드 장비 (룸: ${esc(room)})` : remote ? '서버 연결 (가상 하드웨어 서비스)' : '브라우저 내장 시뮬레이터'}</div>
      <p class="muted">${cloud ? '여러 사람이 같은 장비를 공유합니다. 외부 프로그램은 WebSocket · REST · 릴레이로 연결합니다 (6번).' : remote ? '이 뷰어는 서버의 상태를 미러링합니다. 외부 프로그램이 TCP/COM 포트로 장치를 구동하면 여기에 그대로 표시됩니다.' : '지금은 브라우저 안에서만 동작합니다. 외부 프로그램(원본 키오스크 앱, 내 프로그램, 다른 언어)과 연결하려면 아래 순서대로 내 PC에 환경을 만드세요.'}</p>
      <div class="tut-guide">
        <b>무엇을 하고 싶나요?</b>
        <div class="tut-pick">
          <button type="button" data-go="t1">가상 장비를 PC에서 실행</button>
          <button type="button" data-go="t2">원본 키오스크 앱 연결</button>
          <button type="button" data-go="t3">Node 로 장비 제어</button>
          <button type="button" data-go="t4">Python · 다른 언어</button>
          <button type="button" data-go="t5">나만의 키오스크 화면</button>
          <button type="button" data-go="t6">클라우드 장비 연결</button>
        </div>
        <p class="muted">1~5번은 <b>0. 준비</b>를 먼저 한 번 해 두어야 합니다. 6번(클라우드)은 Node 만 있으면 됩니다.</p>
      </div>

      ${sec('t0', '0. 준비 — 한 번만', 'Node.js · Git 설치, 저장소 받기', `
        <ol>
          <li><b>Node.js 18 이상</b> 설치: <a href="https://nodejs.org/" target="_blank" rel="noopener">nodejs.org</a> 에서 LTS 를 받아 설치합니다 (설치 후 터미널을 새로 엽니다).</li>
          <li><b>Git</b> 설치: <a href="https://git-scm.com/" target="_blank" rel="noopener">git-scm.com</a> (Windows 는 기본 옵션 그대로).</li>
          <li>설치 확인 — 버전이 나오면 됩니다.${code('node -v\nnpm -v\ngit --version')}</li>
          <li>작업할 폴더에서 저장소를 받고 필요한 패키지를 설치합니다 (1~2분).${code('git clone https://github.com/samcho93/cafesim.git\ncd cafesim\nnpm install')}</li>
          <li>3D 뷰어를 빌드합니다 (서버가 이 화면을 함께 제공).${code('npm run build')}</li>
        </ol>
        ${ok('<code>packages/viewer/dist</code> 폴더가 생기고 오류 없이 끝남')}
        <p class="muted">이후 명령은 모두 <code>cafesim</code> 폴더 안에서 실행합니다.</p>`)}

      ${sec('t1', '1. 가상 하드웨어 서버 실행', '실기와 같은 포트를 내 PC에 엽니다', `
        <ol>
          <li>서버를 실행합니다. 이 터미널은 계속 열어 둡니다.${code('npm run sim')}
            <span class="muted">고객 동작(컵 옮기기)을 자동으로: <code>npm run sim -- --auto</code> · 빠르게: <code>-- --speed 4</code> · 다른 포트: <code>-- --port 8800</code></span></li>
          <li>터미널에 아래와 같은 줄이 나오면 준비 완료입니다.${code('[cafesim] viewer / REST / WebSocket : http://localhost:8700\n[cafesim] device main  TCP 127.0.0.1:7001\n[cafesim] device ice   TCP 127.0.0.1:7002\n[cafesim] device cup   TCP 127.0.0.1:7003\n[cafesim] KSCAT emulator http://127.0.0.1:27098')}</li>
          <li>브라우저에서 <a href="http://localhost:8700" target="_blank" rel="noopener">http://localhost:8700</a> 을 엽니다. Windows 방화벽 창이 뜨면 <b>개인 네트워크 허용</b>.</li>
        </ol>
        <table class="kv tut-table"><tr class="muted"><td>장치</td><td>실기 포트</td><td>시뮬레이터</td></tr>${rows}</table>
        ${ok('뷰어 상단 배지가 <b>SERVER</b> 이고, 이 연동 탭의 현재 모드가 "서버 연결"로 나옴')}`)}

      ${sec('t2', '2. 원본 키오스크 앱 연결', '앱 코드는 고치지 않습니다 — 세 가지 방법', `
        <p><b>방법 A. 실행 래퍼 (가장 간단, 권장)</b> — 시리얼 포트는 가상 하드웨어로, 메일빈 서버 호출은 가상 메일빈 서버로 돌립니다.</p>
        <ol>
          <li>원본 앱 소스를 <code>cafesim/source</code> 폴더에 둡니다 (저장소에는 포함되지 않음).</li>
          <li>최초 1회 의존성 설치:${code('cd source\nnpm ci --ignore-scripts\nnode node_modules/electron/install.js\ncd ..')}</li>
          <li>실행 (가상 하드웨어 + 가상 메일빈 서버가 함께 뜸):${code('npm run kiosk:legacy')}
            <span class="muted">클라우드 룸에 붙이기: <code>npm run kiosk:legacy -- --cloud ${esc(cloudBase)}/?room=${esc(room)}</code> · DevTools: <code>-- --debug-port 9222</code></span></li>
        </ol>
        <p><b>방법 B. serialport 가로채기</b> — 이미 앱을 <code>npm start</code> 로 실행하는 경우. 1번 서버를 먼저 띄운 뒤, <b>같은 터미널</b>에서 (경로는 내 cafesim 폴더로):</p>
        ${os('set NODE_OPTIONS=--require D:\\path\\to\\cafesim\\packages\\serialport-shim\\register.cjs\nset CAFESIM_PORTS=COM1=7001,COM2=7002,COM3=7003\nnpm start',
          '$env:NODE_OPTIONS="--require D:\\path\\to\\cafesim\\packages\\serialport-shim\\register.cjs"\n$env:CAFESIM_PORTS="COM1=7001,COM2=7002,COM3=7003"\nnpm start')}
        <p><b>방법 C. 가상 COM 포트 (com0com)</b> — 앱을 아예 건드릴 수 없을 때.</p>
        <ol>
          <li><a href="https://sourceforge.net/projects/com0com/" target="_blank" rel="noopener">com0com</a> 설치 후, <b>관리자 권한</b> 명령 프롬프트에서 com0com 설치 폴더로 이동해 포트 쌍 3개를 만듭니다.${code('setupc install PortName=COM1 PortName=COM11\nsetupc install PortName=COM2 PortName=COM12\nsetupc install PortName=COM3 PortName=COM13')}</li>
          <li>시뮬레이터를 반대쪽 포트에 붙여 실행합니다 — 앱은 평소처럼 COM1/2/3 을 엽니다.${code('npm run sim -- --serial main=COM11,ice=COM12,cup=COM13')}</li>
        </ol>
        <p class="muted">카드 결제는 어느 방법이든 서버의 KSCAT 에뮬레이터(<code>127.0.0.1:27098</code>)가 받습니다 — 결제 요청이 오면 뷰어의 카드 단말기를 클릭.</p>
        ${ok('앱에서 주문하면 <b>통신</b> 탭에 호스트 ⇄ 장치 프레임이 흐르고, 3D 화면의 장비가 움직임')}`)}

      ${sec('t3', '3. 내 Node 프로그램으로 장비 제어', '같은 코드가 실제 M400 에서도 동작', `
        <ol>
          <li>터미널 1에서 서버 실행 (자동 진행 켜기):${code('npm run sim -- --auto')}</li>
          <li><code>cafesim</code> 폴더 안에 <code>my/order.js</code> 파일을 만들고 붙여 넣습니다 (저장소 안이어야 <code>@cafesim/server</code> 를 찾습니다).${code(`import { connectMachine, loadPlatform } from '@cafesim/server';

const definition = await loadPlatform('m400');
const machine = await connectMachine({ definition });     // 시뮬레이터 (localhost)
machine.on('step', (s) => console.log(s.text));

await machine.init();
const item = definition.menu.find((m) => m.id === 'americano');
await machine.pay(item.price);                            // 카드 결제
await machine.order(item, { temp: 'ice' });               // 컵 → 얼음 → 투출구 → 추출 → 픽업
console.log('완료');
process.exit(0);`)}</li>
          <li>터미널 2에서 실행:${code('node my/order.js')}</li>
        </ol>
        <p class="muted">실제 장비: <code>connectMachine({ definition, serial: { main: 'COM1', ice: 'COM2', cup: 'COM3' } })</code> · 저수준 제어: <code>machine.main.command('coffee')</code>, <code>machine.main.actuator('mainPump', true)</code>, <code>machine.ice.dispense(5, 0.5)</code>, <code>machine.cup.dispense('hot')</code> · 완성 예제: <code>npm run example:order</code></p>
        ${ok('터미널에 제조 단계가 차례로 찍히고, 뷰어에서 컵이 움직이며 음료가 완성됨')}`)}

      ${sec('t4', '4. Python · 다른 언어', 'REST 로 간단히, 또는 TCP 바이트 프로토콜', `
        <p><b>REST</b> — 1번 서버를 띄운 뒤 어떤 언어든 HTTP 로 상태를 읽고 조작합니다.</p>
        ${os('curl http://localhost:8700/api/state\ncurl -X POST http://localhost:8700/api/interact -H "Content-Type: application/json" -d "{\\"type\\":\\"autoAssist\\",\\"on\\":true}"',
          'Invoke-RestMethod http://localhost:8700/api/state\nInvoke-RestMethod -Method Post http://localhost:8700/api/interact -ContentType "application/json" -Body \'{"type":"autoAssist","on":true}\'')}
        ${code(`# Python (pip install requests)
import requests
state = requests.get("http://localhost:8700/api/state").json()
requests.post("http://localhost:8700/api/interact", json={"type": "moveCup", "cup": "cup1", "to": "ice:tray"})
requests.post("http://localhost:8700/api/interact", json={"type": "device", "device": "pay", "action": {"type": "insertCard"}})`)}
        <p><b>TCP (실기와 같은 바이트)</b> — 메인보드 <code>127.0.0.1:7001</code>, 제빙기 7002, 컵 7003. Python 3.10 이상에서 예제를 그대로 실행해 보세요.${code('python examples/python_client.py')}
          프레임 형식은 <code>docs/PROTOCOL.md</code> 에 있습니다.</p>
        ${ok('<code>/api/state</code> 가 JSON 을 돌려주고, interact 요청 후 뷰어 화면이 바뀜')}`)}

      ${sec('t5', '5. 나만의 키오스크 화면', '어떤 웹 페이지든 터치스크린에 띄우기', `
        <ol>
          <li>1번 서버를 실행합니다.</li>
          <li>예제를 복사해 내 화면을 만듭니다: <code>examples/custom-kiosk/index.html</code>. SDK 주소를 서버 주소로 바꿉니다.${code('&lt;script src="http://localhost:8700/cafesim-kiosk-sdk.js"&gt;&lt;/script&gt;\n&lt;script&gt;\n  CafeSim.on(\'guide\', (g) =&gt; g[0] &amp;&amp; console.log(g[0].text));\n  await CafeSim.pay(2000);\n  await CafeSim.order(\'americano\', \'ice\');\n&lt;/script&gt;')}
            <span class="muted">개발 모드(<code>npm run dev</code>)로 볼 때는 <code>http://localhost:5173/cafesim-kiosk-sdk.js</code></span></li>
          <li>내 화면을 3000 번 포트로 띄웁니다 (둘 중 하나).${code('npx serve examples/custom-kiosk -l 3000\npython -m http.server 3000 -d examples/custom-kiosk')}</li>
          <li>뷰어를 <code>?kiosk=</code> 주소로 엽니다: <a href="http://localhost:8700/?kiosk=http://localhost:3000" target="_blank" rel="noopener">http://localhost:8700/?kiosk=http://localhost:3000</a></li>
        </ol>
        ${ok('3D 장비의 터치스크린에 내 페이지가 보이고, 버튼으로 결제 · 주문이 진행됨')}`)}

      ${sec('t6', '6. 클라우드 장비 연결 (Cloudflare)', '설치 없이 여러 명이 같은 장비 공유', `
        <ol>
          <li>브라우저: <a href="${esc(cloudBase)}/?room=${esc(room)}" target="_blank" rel="noopener">${esc(cloudBase)}/?room=${esc(room)}</a> — <code>room</code> 이름이 같으면 같은 장비입니다 (내 장비는 다른 이름으로).</li>
          <li>Node SDK (0. 준비 후):${code(`const machine = await connectMachine({ url: '${esc(cloudBase.replace(/^http/, 'ws'))}/ws?room=${esc(room)}', definition });`)}</li>
          <li>REST:${code(`curl "${esc(cloudBase)}/api/state?room=${esc(room)}"`)}</li>
          <li>TCP/COM 을 쓰는 프로그램(원본 키오스크 앱 등)은 <b>릴레이</b>로 — 내 PC에 7001-7003, 27098 이 열립니다.${code(`npm run relay -- ${esc(cloudBase)}/?room=${esc(room)}`)}</li>
        </ol>
        ${ok('두 브라우저에서 같은 room 을 열면 한쪽 조작이 다른 쪽에도 보임')}`)}

      ${sec('t7', '7. 새 매장 구성(플랫폼) 만들기', '장치 · 메뉴 · 배관 · 3D 배치를 바꿔 새 장비로', `
        ${code('npm run create-platform my-cafe -- --title "우리 매장"\nnpm run dev')}
        <p>브라우저에서 <code>http://localhost:5173/?platform=my-cafe</code>. <code>platforms/my-cafe/platform.js</code> 를 고치면 바로 다시 로드됩니다. 자세한 방법: <code>docs/PLATFORM.md</code></p>`)}

      ${sec('t8', '문제 해결', '자주 막히는 곳', `
        <dl class="kv tut-faq">
          <dt>'npm' 은(는) 내부 또는 외부 명령… 이 아닙니다</dt><dd>Node.js 설치 후 터미널을 새로 여세요. 그래도 안 되면 Node.js 를 다시 설치합니다.</dd>
          <dt>PowerShell 에서 npm 실행이 막힘 (스크립트 실행 정책)</dt><dd>명령 프롬프트(cmd)에서 실행하면 됩니다.</dd>
          <dt>EADDRINUSE (포트 사용 중)</dt><dd>이미 서버가 떠 있거나 다른 프로그램이 포트를 쓰고 있습니다. 기존 터미널을 닫거나 <code>npm run sim -- --port 8800 --tcp-offset 100</code> (TCP 7101-7103).</dd>
          <dt>방법 B 로 연결했는데 장비가 반응하지 않음</dt><dd><code>NODE_OPTIONS</code> 의 경로가 실제 <code>register.cjs</code> 위치인지, <code>set</code> 과 <code>npm start</code> 를 <b>같은 터미널</b>에서 실행했는지 확인하세요.</dd>
          <dt>컵이 움직이지 않고 제조가 멈춤</dt><dd>고객 동작(컵 옮기기)을 기다리는 중입니다. 뷰어에서 직접 옮기거나 <code>--auto</code> 로 실행하세요.</dd>
          <dt>브라우저에서 localhost:8700 이 안 열림</dt><dd>서버 터미널이 열려 있는지, 방화벽에서 허용했는지 확인하세요.</dd>
        </dl>
        <p class="muted">더 자세한 내용: <code>README.md</code>, <code>docs/</code> (프로토콜 · 플랫폼 · 하드웨어 · 원본 기능 대응표)</p>`)}`;

    // 바로가기 · 복사 · 펼친 항목 기억
    const KEY = 'cafesim.devTut';
    let open = [];
    try { open = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { /* 저장 불가 */ }
    if (!open.length) open = [remote || cloud ? (cloud ? 't6' : 't2') : 't0'];
    this.el.querySelectorAll('details.tut').forEach((x) => {
      x.open = open.includes(x.dataset.tut);
      x.addEventListener('toggle', () => {
        const now = [...this.el.querySelectorAll('details.tut[open]')].map((y) => y.dataset.tut);
        try { localStorage.setItem(KEY, JSON.stringify(now)); } catch { /* 저장 불가 */ }
      });
    });
    this.el.onclick = async (e) => {
      const go = e.target.closest('[data-go]');
      if (go) {
        const t = this.el.querySelector(`details[data-tut="${go.dataset.go}"]`);
        t.open = true;
        t.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      const btn = e.target.closest('.copy');
      if (!btn) return;
      const text = btn.previousElementSibling.textContent;
      try { await navigator.clipboard.writeText(text); btn.textContent = '복사됨'; }
      catch { const r = document.createRange(); r.selectNodeContents(btn.previousElementSibling); getSelection().removeAllRanges(); getSelection().addRange(r); btn.textContent = '선택됨'; }
      setTimeout(() => (btn.textContent = '복사'), 1500);
    };
  }
}

function deviceTitle(type, key) {
  return { 'mailbean-mainboard': '커피머신 메인보드', 'cup-dispenser': '컵 디스펜서', 'ice-maker': '제빙기', 'kscat-terminal': '카드 단말기' }[type] ?? `${type} (${key})`;
}

function renderDevice(s, def) {
  switch (s.type) {
    case 'mailbean-mainboard': {
      const lamp = (v) => `<span class="dot ${v === 1 ? 'on' : v === 2 ? 'blink' : ''}"></span>`;
      return `<dl class="kv">
        <dt>모드</dt><dd>${s.emergency ? '<span class="chip err">비상정지</span> ' : ''}${s.menuMode ? '<span class="chip on">메뉴모드</span> ' : ''}${s.manualMode ? '<span class="chip on">수동모드</span>' : ''}${!s.menuMode && !s.manualMode && !s.emergency ? '대기' : ''}</dd>
        <dt>커피 보일러</dt><dd>${s.temps.coffee}°C / ${s.temps.coffeeTarget}°C<div class="bar"><i style="width:${pct(s.temps.coffee, 100)}%;background:#d0582b"></i></div></dd>
        <dt>온수 보일러</dt><dd>${s.temps.hotWater}°C / ${s.temps.hotWaterTarget}°C<div class="bar"><i style="width:${pct(s.temps.hotWater, 100)}%;background:#d0582b"></i></div></dd>
        <dt>브로멕</dt><dd>${{ upper: '상단(압축)', middle: '중단', lower: '하단(해제)' }[s.brew.position]}${s.brew.moving ? ' · 이동 중' : ''} · 원두 ${s.brew.grounds}g · 찌꺼기통 ${s.brew.cakeBin}</dd>
        <dt>추출 압력</dt><dd>${s.pressure} bar</dd>
        <dt>투출구 램프</dt><dd>${s.lamps.map((v, i) => `${i + 1}${lamp(v)}`).join(' &nbsp; ')} &nbsp; 컵센서 ${s.cupSensorUse ? 'ON' : 'OFF'}: ${s.cupSensors.map((c) => (c ? '●' : '○')).join('')}</dd>
        <dt>동작 중</dt><dd class="ops">${s.ops.map((o) => `<div class="op">${esc(o.label)}<div class="bar"><i style="width:${o.progress * 100}%"></i></div></div>`).join('') || '-'}</dd>
        <dt>구동부</dt><dd class="chips">${s.actuators.map((a) => `<span class="chip on">${esc(a)}</span>`).join('') || '-'}</dd>
        <dt>에러</dt><dd class="chips">${s.errors.map((e) => `<span class="chip err">M${e.index} ${esc(e.label)}</span>`).join('') || '없음'}</dd>
        <dt>재고</dt><dd><div class="stock">${s.stock.bean.map((g, i) => `<div>원두${i + 1} ${g}g<div class="bar"><i style="width:${pct(g, 1000)}%;background:#6b4226"></i></div></div>`).join('')}${s.stock.powder.map((g, i) => `<div>파우더${i + 1} ${g}g<div class="bar"><i style="width:${pct(g, 800)}%;background:#b38b5d"></i></div></div>`).join('')}${s.stock.ade.map((g, i) => `<div>시럽${i + 1} ${g}cc<div class="bar"><i style="width:${pct(g, 2000)}%;background:#e1b92f"></i></div></div>`).join('')}<div>물 ${(s.stock.water / 1000).toFixed(1)}L<div class="bar"><i style="width:${pct(s.stock.water, 20000)}%"></i></div></div></div></dd>
      </dl>`;
    }
    case 'cup-dispenser':
      return `<dl class="kv"><dt>재고</dt><dd>HOT ${s.stock.hot}개 · ICE ${s.stock.ice}개</dd>
        <dt>배출 상태</dt><dd>ICE M017='${s.state.ice}' · HOT M018='${s.state.hot}'</dd>
        <dt>동작</dt><dd>${s.dropping.map((d) => `${d.type.toUpperCase()} 컵 배출 중 <div class="bar"><i style="width:${d.progress * 100}%"></i></div>`).join('') || '-'}</dd>
        ${s.faults.length ? `<dt>장애</dt><dd class="chips">${s.faults.map((f) => `<span class="chip err">${esc(f)}</span>`).join('')}</dd>` : ''}</dl>`;
    case 'ice-maker':
      return `<dl class="kv"><dt>모드</dt><dd>${s.commMode ? '통신모드' : '일반모드'}</dd>
        <dt>출빙</dt><dd>${s.dispensing ? `${s.dispensing.phase === 'ice' ? '얼음' : '물'} 나오는 중<div class="bar"><i style="width:${s.dispensing.progress * 100}%"></i></div>` : s.armed ? `<span class="chip on">명령 대기</span> 얼음 ${s.armed.ice}s / 물 ${s.armed.water}s` : '-'}</dd>
        <dt>컵 레버</dt><dd>${s.lever ? '눌림' : '-'}</dd>
        <dt>저빙량</dt><dd>${s.bin}%<div class="bar"><i style="width:${s.bin}%;background:#7cc4ef"></i></div></dd>
        <dt>상태 바이트</dt><dd style="font-family:var(--mono)">D1=${s.status.d1.toString(2).padStart(8, '0')} D2=${s.status.d2.toString(2).padStart(8, '0')}</dd>
        <dt>에러</dt><dd>${s.error ? `<span class="chip err">${esc(s.error)}</span>` : '없음'}</dd></dl>`;
    case 'kscat-terminal':
      return `<dl class="kv"><dt>카드</dt><dd>${s.card === 'inserted' ? '<span class="chip on">삽입됨</span>' : '없음'}</dd>
        <dt>대기 거래</dt><dd>${s.pending ? `${s.pending.amount.toLocaleString()}원 (${s.pending.waited}s) - <b>카드 단말기를 클릭</b>` : '-'}</dd>
        <dt>최근 거래</dt><dd>${s.history.map((h) => `${h.ok ? '✔' : '✖'} ${h.kind} ${h.amount?.toLocaleString() ?? ''}원 ${h.approval ?? ''}`).join('<br>') || '-'}</dd></dl>`;
    default:
      return `<pre class="snippet">${esc(JSON.stringify(s, null, 1).slice(0, 600))}</pre>`;
  }
}
