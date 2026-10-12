/**
 * UI pieces of the robot cafe demo:
 *   OrderKioskPopup - the customer's ordering monitor as a floating window (or a real pop-up window
 *                     for a second monitor). The kiosk talks to the simulator through the same
 *                     postMessage bridge as the screen on the coffee machine.
 *   RobotCard       - UR robot status, joint angles and the URScript of the current program.
 */
const KIOSK_W = 1024;
const KIOSK_H = 600;

export class OrderKioskPopup {
  constructor({ url, title }) {
    this.url = url;
    this.title = title;
    this.win = null;
    this.el = document.createElement('div');
    this.el.className = 'order-popup';
    this.el.hidden = true;
    this.el.innerHTML = `<div class="op-head"><b>🖥 ${title}</b><span class="op-btns"><button data-a="detach" title="새 창(별도 모니터)으로 분리">⧉ 새 창</button><button data-a="size" title="크기">⤢</button><button data-a="close" title="닫기">✕</button></span></div>
      <div class="op-body"><iframe title="주문 키오스크" allow="autoplay"></iframe></div>`;
    document.body.append(this.el);
    this.iframe = this.el.querySelector('iframe');
    this.scale = 0.62;
    this.#layout();
    this.el.querySelector('[data-a="close"]').onclick = () => this.close();
    this.el.querySelector('[data-a="size"]').onclick = () => {
      this.scale = this.scale > 0.7 ? 0.5 : this.scale > 0.55 ? 0.8 : 0.62;
      this.#layout();
    };
    this.el.querySelector('[data-a="detach"]').onclick = () => this.detach();
    this.#drag();
    window.addEventListener('resize', () => this.#layout());
  }

  #layout() {
    const max = Math.min((window.innerWidth - 24) / KIOSK_W, (window.innerHeight - 90) / KIOSK_H);
    const s = Math.min(this.scale, max);
    this.iframe.style.width = `${KIOSK_W}px`;
    this.iframe.style.height = `${KIOSK_H}px`;
    this.iframe.style.transform = `scale(${s})`;
    const body = this.el.querySelector('.op-body');
    body.style.width = `${KIOSK_W * s}px`;
    body.style.height = `${KIOSK_H * s}px`;
  }

  #drag() {
    const head = this.el.querySelector('.op-head');
    let start = null;
    head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const r = this.el.getBoundingClientRect();
      start = { x: e.clientX - r.left, y: e.clientY - r.top };
      head.setPointerCapture(e.pointerId);
    });
    head.addEventListener('pointermove', (e) => {
      if (!start) return;
      this.el.style.left = `${Math.max(0, Math.min(window.innerWidth - 120, e.clientX - start.x))}px`;
      this.el.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, e.clientY - start.y))}px`;
      this.el.style.right = 'auto';
      this.el.style.bottom = 'auto';
    });
    head.addEventListener('pointerup', () => (start = null));
  }

  open() {
    if (this.win && !this.win.closed) return this.win.focus();
    if (!this.iframe.src) this.iframe.src = this.url;
    this.el.hidden = false;
  }

  close() {
    this.el.hidden = true;
  }

  toggle() {
    if (this.win && !this.win.closed) return this.win.focus();
    if (this.el.hidden) this.open();
    else this.close();
  }

  /** Real pop-up window, e.g. dragged onto a second monitor. */
  detach() {
    this.win = window.open(this.url, 'cafesim-order-kiosk', `popup,width=${KIOSK_W},height=${KIOSK_H + 40}`);
    if (!this.win) return; // pop-up blocked: keep the in-page window
    this.close();
    this.iframe.removeAttribute('src');
  }
}

export class RobotCard {
  constructor(robot, model) {
    this.robot = robot;
    this.el = document.createElement('div');
    this.el.className = 'robot-card';
    this.el.innerHTML = `<div class="rc-head"><b>🤖 ${String(model).toUpperCase()}</b><span class="rc-src">studyUR 기구학 · ur_description 메시</span><button data-a="fold">URScript ▾</button></div>
      <div class="rc-status">로봇 모델을 불러오는 중...</div><div class="rc-joints"></div><pre class="rc-script" hidden></pre>`;
    document.getElementById('stage').append(this.el);
    this.statusEl = this.el.querySelector('.rc-status');
    this.jointsEl = this.el.querySelector('.rc-joints');
    this.scriptEl = this.el.querySelector('.rc-script');
    this.el.querySelector('[data-a="fold"]').onclick = (e) => {
      this.scriptEl.hidden = !this.scriptEl.hidden;
      e.target.textContent = this.scriptEl.hidden ? 'URScript ▾' : 'URScript ▴';
    };
    robot.on('status', (s) => {
      this.statusEl.textContent = s.text;
      this.el.classList.toggle('busy', !!s.busy);
    });
    robot.on('urscript', (lines) => (this.scriptEl.textContent = lines.join('\n')));
    setInterval(() => {
      if (!robot.q) return;
      this.jointsEl.innerHTML = ['Base', 'Shoulder', 'Elbow', 'Wrist1', 'Wrist2', 'Wrist3'].map((n, i) => `<span>${n}<b>${((robot.q[i] * 180) / Math.PI).toFixed(1)}°</b></span>`).join('');
    }, 150);
  }
}
