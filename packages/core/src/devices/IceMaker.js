import { Device } from './Device.js';
import { IceParser, encodeIce, describeIce, ICE, D1, D2, iceByteToSeconds, ICE_ERRORS } from '../protocol/ice.js';

/**
 * Virtual ice dispenser.
 * In communication mode a DISPENSE (B0) command arms the machine ("출빙명령 대기");
 * ice and water only come out when a cup pushes the lever on the tray slot.
 */
export class IceMaker extends Device {
  static type = 'ice-maker';
  static label = '제빙기';
  static slots = () => ['tray'];

  constructor(args) {
    super(args);
    this.options = { iceRate: 4, binCapacity: 3000, ...this.options }; // cubes / s
    this.commMode = false;
    this.ignoreCupLeave = false;
    this.timeoutSec = 10 * 60;
    this.armed = null; // { ice, water, waited }
    this.dispensing = null; // { ice, water, elapsed }
    this.bin = this.options.binCapacity;
    this.lastDetected = true;
    this.errorCode = 0;
    this.compressor = false;
    this.rebooting = 0;
  }

  createParser(onFrame) {
    return new IceParser(onFrame);
  }

  describe(raw) {
    return describeIce(raw);
  }

  get slot() {
    return `${this.key}:tray`;
  }

  get leverPressed() {
    return !!this.world.cupAt(this.slot);
  }

  statusBytes() {
    let d1 = 0;
    if (this.bin >= this.options.binCapacity * 0.95) d1 |= D1.FULL;
    if (this.commMode) d1 |= D1.COMM_MODE;
    if (this.leverPressed) d1 |= D1.CUP_LEVER;
    if (this.dispensing) d1 |= D1.DISPENSE_SOL | D1.GEAR_MOTOR;
    if (this.compressor) d1 |= D1.COMPRESSOR;
    d1 |= this.lastDetected ? D1.ICE_DETECTED : D1.ICE_MISSING;
    let d2 = this.errorCode & D2.ERROR_MASK;
    if (this.armed || this.dispensing) d2 |= D2.WAITING;
    return [d1, d2];
  }

  handleFrame(f, reply) {
    if (!f.ok || this.rebooting > 0) return; // real unit stays silent
    switch (f.cmd) {
      case ICE.DISPENSE: {
        const ice = iceByteToSeconds(f.d1);
        const water = iceByteToSeconds(f.d2);
        if (this.errorCode) this.log('error', `출빙 요청 거부: ${ICE_ERRORS[this.errorCode]}`);
        else {
          this.armed = { ice, water, waited: 0 };
          this.log('info', `출빙 대기: 얼음 ${ice}s / 물 ${water}s - 컵을 레버에 대 주세요`);
        }
        break;
      }
      case ICE.MODE:
        this.commMode = f.d1 === 1;
        this.ignoreCupLeave = f.d2 === 1;
        this.log('info', `통신모드 ${this.commMode ? 'ON' : 'OFF'}, 컵이탈무시 ${this.ignoreCupLeave ? 'ON' : 'OFF'}`);
        break;
      case ICE.TIMEOUT:
        this.timeoutSec = f.d1 * 60 + f.d2;
        this.log('info', `출빙 타임아웃 ${f.d1}분 ${f.d2}초`);
        break;
      case ICE.REBOOT:
        this.armed = this.dispensing = null;
        this.rebooting = 2;
        this.log('info', '재부팅');
        break;
      default:
        break;
    }
    const [d1, d2] = this.statusBytes();
    reply(encodeIce(f.cmd, d1, d2));
  }

  update(dt) {
    if (this.rebooting > 0) this.rebooting -= dt;
    this.errorCode = this.faults.error ? Number(this.faults.error) || 1 : 0;

    // ice production
    this.compressor = this.bin < this.options.binCapacity;
    if (this.compressor) this.bin = Math.min(this.options.binCapacity, this.bin + dt * 2);

    if (this.armed && !this.dispensing) {
      this.armed.waited += dt;
      if (this.leverPressed) {
        this.dispensing = { ice: this.armed.ice, water: this.armed.water, elapsed: 0 };
        this.armed = null;
        this.log('info', '출빙 시작');
      } else if (this.armed.waited > this.timeoutSec) {
        this.armed = null;
        this.log('warn', '출빙 타임아웃 - 명령 취소');
      }
    }

    if (this.dispensing) {
      const d = this.dispensing;
      if (!this.leverPressed && !this.ignoreCupLeave) {
        this.log('warn', '컵 이탈 - 출빙 중단');
        this.dispensing = null;
        return;
      }
      const t0 = d.elapsed;
      d.elapsed += dt;
      const iceDt = Math.max(0, Math.min(d.elapsed, d.ice) - Math.min(t0, d.ice));
      if (iceDt > 0) {
        const cubes = Math.min(this.bin, iceDt * this.options.iceRate);
        this.bin -= cubes;
        this.lastDetected = cubes > 0;
        this.world.pour(this.slot, 'ice', cubes);
      }
      const wDt = Math.max(0, Math.min(d.elapsed, d.ice + d.water) - Math.max(t0, d.ice));
      if (wDt > 0) this.world.pour(this.slot, 'water', wDt * 20);
      if (d.elapsed >= d.ice + d.water) {
        this.dispensing = null;
        this.log('info', '출빙 완료');
      }
    }
  }

  interact(action) {
    if (action.type === 'fault') {
      this.setFault(action.name, action.on);
      return true;
    }
    if (action.type === 'manualDispense') {
      // front PUSH button in normal (non-communication) mode
      this.dispensing = { ice: action.ice ?? 3, water: action.water ?? 0, elapsed: 0 };
      return true;
    }
    if (action.type === 'refill') {
      this.bin = this.options.binCapacity;
      return true;
    }
    return false;
  }

  snapshot() {
    const [d1, d2] = this.statusBytes();
    const d = this.dispensing;
    return {
      type: IceMaker.type,
      commMode: this.commMode,
      armed: this.armed ? { ice: this.armed.ice, water: this.armed.water } : null,
      dispensing: d ? { phase: d.elapsed < d.ice ? 'ice' : 'water', progress: d.elapsed / (d.ice + d.water || 1) } : null,
      lever: this.leverPressed,
      bin: Math.round((this.bin / this.options.binCapacity) * 100),
      error: this.errorCode ? ICE_ERRORS[this.errorCode] : null,
      status: { d1, d2 },
      faults: Object.keys(this.faults),
    };
  }
}
