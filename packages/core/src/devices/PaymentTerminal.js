import { Device } from './Device.js';

const FS = '\x1c';

/**
 * Virtual KSCAT card terminal.
 * The kiosk app talks to the KSCAT agent over HTTP (http://127.0.0.1:27098, JSONP, field REQ).
 * The server package exposes that endpoint; in the browser `request()` is called directly.
 *
 * Approval waits until a card is inserted (viewer: click the card slot) and leaves the
 * card in the slot, so the "카드를 빼주세요" (S4 retrieve) polling also works.
 */
export class PaymentTerminal extends Device {
  static type = 'kscat-terminal';
  static label = '카드 단말기 (KSCAT)';
  static slots = () => ['slot'];

  constructor(args) {
    super(args);
    this.options = { http: 27098, tid: 'DPT0TEST03', autoApprove: false, timeoutSec: 60, ...this.options };
    this.card = 'none'; // 'none' | 'inserted'
    this.pending = null; // { kind, amount, resolve, waited }
    this.history = [];
    this.seq = 0;
  }

  connect() {
    throw new Error('KSCAT terminal is reached through request(), not a serial connection');
  }

  /** Parse a KSCAT "AP..." telegram. */
  static parse(req) {
    const text = String(req ?? '');
    if (/^AP\x02\d{4}S4/.test(text)) return { kind: 'retrieve' };
    const stx = text.indexOf('\x02');
    const body = text.slice(stx + 1);
    const trade = body.slice(0, 2); // IC (card) / PC (kakao) / MI (naver)
    const telegram = body.slice(4, 8); // 0200 approve / 0420 cancel
    const fs = body.indexOf(FS);
    const amount = fs >= 0 ? Number(body.slice(fs + 3, fs + 15)) : 0;
    const tid = body.slice(9, 19).trim();
    return { kind: telegram === '0420' ? 'cancel' : 'approve', trade, telegram, amount, tid };
  }

  /** Handle one request; resolves with the KSCAT JSON response. */
  request(req) {
    const p = typeof req === 'string' ? PaymentTerminal.parse(req) : req;
    if (p.kind === 'retrieve') return Promise.resolve({ RES: '0000', STATUS: this.card === 'inserted' ? 'INS' : 'DEL' });
    if (p.kind === 'cancel' || p.trade === 'PC' || p.trade === 'MI') {
      // cancels and barcode payments do not need a card
      return Promise.resolve(this.#response(p, true));
    }
    if (this.pending) this.pending.resolve(this.#response(this.pending, false, '이전 거래 취소'));
    this.log('info', `결제 요청 ${p.amount.toLocaleString()}원 - 카드를 넣어 주세요`);
    return new Promise((resolve) => {
      this.pending = { ...p, resolve, waited: 0 };
      if (this.options.autoApprove || this.card === 'inserted') this.#complete(true);
    });
  }

  #response(p, ok, message) {
    const now = new Date();
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    const stamp = `${String(now.getFullYear()).slice(2)}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const res = ok
      ? {
          RES: '0000',
          RESPCODE: '0000',
          STATUS: 'O',
          TRADEFLAG: p.trade ?? 'IC',
          TELEGRAMFLAG: p.telegram ?? '0210',
          TERMID: p.tid || this.options.tid,
          APPROVALNO: String(10000000 + ++this.seq * 7919).slice(-8),
          TRADETIME: stamp,
          CARDNAME: 'SIM CARD',
          ISSUERCODE: '99',
          AMOUNT: String(p.amount ?? 0),
          MESSAGE1: '정상승인',
          MESSAGE2: '가상 결제 (cafeSim)',
          MSG: '정상승인',
        }
      : { RES: '1000', RESPCODE: '8000', STATUS: 'X', MESSAGE1: message ?? '거래 취소', MESSAGE2: '', MSG: message ?? '거래 취소' };
    this.history.unshift({ at: now.toISOString(), kind: p.kind, amount: p.amount, ok, approval: res.APPROVALNO });
    this.history.length = Math.min(this.history.length, 10);
    return res;
  }

  #complete(ok, message) {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    this.log(ok ? 'info' : 'warn', ok ? `승인 완료 ${p.amount.toLocaleString()}원` : `결제 실패: ${message}`);
    p.resolve(this.#response(p, ok, message));
  }

  update(dt) {
    if (!this.pending) return;
    this.pending.waited += dt;
    if (this.pending.waited > this.options.timeoutSec) this.#complete(false, '입력 시간 초과');
  }

  interact(action) {
    switch (action.type) {
      case 'insertCard':
        this.card = 'inserted';
        if (this.pending) this.#complete(!this.faults.decline, '승인 거절 (한도초과)');
        return true;
      case 'removeCard':
        this.card = 'none';
        return true;
      case 'cancel':
        this.#complete(false, '사용자 취소');
        return true;
      case 'fault':
        this.setFault(action.name, action.on);
        return true;
      case 'autoApprove':
        this.options.autoApprove = !!action.on;
        return true;
      default:
        return false;
    }
  }

  snapshot() {
    return {
      type: PaymentTerminal.type,
      card: this.card,
      pending: this.pending ? { amount: this.pending.amount, trade: this.pending.trade, waited: Math.round(this.pending.waited) } : null,
      history: this.history.slice(0, 5),
      autoApprove: this.options.autoApprove,
      faults: Object.keys(this.faults),
    };
  }
}
