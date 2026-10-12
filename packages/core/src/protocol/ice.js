/**
 * Ice maker binary protocol (7 bytes, fixed length):
 *   STX(02) STATUS(01) CMD D1 D2 CHECK(STATUS^CMD^D1^D2) ETX(03)
 *
 * Commands used by the kiosk app:
 *   B0 d1 d2  dispense ice d1 / water d2 seconds, BCD-like (0x55 = 5.5 s)
 *   CF 00 00  status query. reply D1 = flags, D2 = flags | error code (low nibble)
 *   A0 01 01  communication mode on + ignore cup-leave
 *   D0 mm ss  dispense wait timeout (minutes, seconds)
 *   E0 00 00  reboot
 */
import { toBytes } from '../util/Emitter.js';

export const ICE = {
  DISPENSE: 0xb0,
  STATUS: 0xcf,
  MODE: 0xa0,
  TIMEOUT: 0xd0,
  REBOOT: 0xe0,
};

/** DATA1 bit masks (MSB first, as documented in the original source) */
export const D1 = {
  FULL: 0x80, // 만빙
  COMM_MODE: 0x40, // 통신모드
  CUP_LEVER: 0x20, // 컵레버 감지
  DISPENSE_SOL: 0x10, // 출빙 SOL 감지
  GEAR_MOTOR: 0x08, // 기어모터 동작 중
  COMPRESSOR: 0x04, // 콤프 동작 중
  ICE_DETECTED: 0x02, // 직전 출빙 얼음 감지
  ICE_MISSING: 0x01, // 직전 출빙 얼음 미감지
};

/** DATA2 bit masks */
export const D2 = {
  WAITING: 0x10, // 1 = 출빙명령 대기, 0 = 출빙완료 or 타임아웃
  ERROR_MASK: 0x0f,
};

export const ICE_ERRORS = ['E0 정상', 'E1 급수부적합', 'E2 배수부적합', 'E3 분위기온도 저온', 'E4 분위기온도 고온', 'E5 Condensor 고온', 'E6 Evaporator 저온', 'E7 G/M 부적합', 'E8 제빙기능 부적합', 'E9 점검주기', 'Ec I2C 통신 에러', 'EF FAN MT 부적합'];

export function encodeIce(cmd, d1 = 0, d2 = 0, status = 0x01) {
  return [0x02, status, cmd, d1, d2, status ^ cmd ^ d1 ^ d2, 0x03];
}

/** 5.5 -> 0x55, 5 -> 0x50, 0.5 -> 0x05 (each decimal digit in a nibble) */
export function secondsToIceByte(sec) {
  const n = Math.max(0, Math.min(99, Math.round(Number(sec) * 10)));
  return parseInt(String(n).padStart(2, '0'), 16);
}

export function iceByteToSeconds(b) {
  return Number(b.toString(16).padStart(2, '0')) / 10;
}

export class IceParser {
  buf = [];

  constructor(onFrame) {
    this.onFrame = onFrame;
  }

  push(chunk) {
    for (const b of toBytes(chunk)) this.buf.push(b);
    for (;;) {
      const s = this.buf.indexOf(0x02);
      if (s < 0) {
        this.buf = [];
        return;
      }
      if (s > 0) this.buf.splice(0, s);
      if (this.buf.length < 7) return;
      const raw = this.buf.slice(0, 7);
      if (raw[6] !== 0x03) {
        this.buf.shift();
        continue;
      }
      this.buf.splice(0, 7);
      const [, status, cmd, d1, d2, check] = raw;
      this.onFrame({ status, cmd, d1, d2, raw, ok: (status ^ cmd ^ d1 ^ d2) === check });
    }
  }
}

export function describeIce(raw) {
  const b = toBytes(raw);
  const name = { 0xb0: 'DISPENSE', 0xcf: 'STATUS', 0xa0: 'MODE', 0xd0: 'TIMEOUT', 0xe0: 'REBOOT' }[b[2]] ?? 'CMD';
  return `${name} ${b.map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join(' ')}`;
}
