/**
 * Port of the kiosk app's recipe engine (controller/serial/mainDevice/serialRequest_euro.js,
 * common/sequenceFunc.js, mainDevice/serialRequest_wash.js) on top of MainBoardClient.
 *
 * A menu item (goods) carries `gds_recipe.dataCodes`, e.g. "S162S150S156": every 4-character
 * code is executed in order. For each code the 60 byte parameter block (S080..S139) is written
 * with that code's fields, then the code's command sequence runs.
 */
import { sleep } from '../util/Emitter.js';

const num = (v) => Number(v ?? 0) || 0;

/** dataCodes renames done by euro() */
export const CODE_ALIASES = { S150: 'S184', S171: 'S185' };

export const splitCodes = (dataCodes) => (String(dataCodes ?? '').match(/S\d{3}/g) ?? []).map((c) => CODE_ALIASES[c] ?? c);

/** Parameter block for one code (same quirks as euro(): powder/ade water goes through the ade1 slot). */
export function paramsForCode(code, r, { feed = 0 } = {}) {
  const p = {};
  for (let n = 1; n <= 6; n++) p[`powderMixTime${n}`] = num(feed) / 10; // tagListV3 defaults the mix slots to global.feed (raw)
  const coffee = () => {
    p.coffeeAmount = num(r.coffee);
    p.hotWaterAmount = num(r.water);
    p.adeWaterAmount1 = num(r.water);
  };
  switch (code) {
    case 'S184':
    case 'S186':
      p.grinderTime1 = num(r.grinderTime1);
      coffee();
      break;
    case 'S185':
    case 'S187':
      p.grinderTime2 = num(r.grinderTime2);
      coffee();
      break;
    case 'S201':
    case 'S202':
      p.grinderTime1 = num(r.grinderTime1);
      p.grinderTime2 = num(r.grinderTime2);
      coffee();
      break;
    case 'S162':
      p.adeWaterAmount1 = num(r.adeWater1);
      p.adePumpTime1 = num(r.adePumpTime1);
      break;
    case 'S163':
      p.adeWaterAmount1 = num(r.adeWater2);
      p.adePumpTime2 = num(r.adePumpTime2);
      break;
    case 'S164':
      p.adeWaterAmount1 = num(r.adeWater3);
      p.adePumpTime3 = num(r.adePumpTime3);
      break;
    case 'S188':
      p.adeWaterAmount2 = num(r.teaBagHotWater);
      break;
    default: {
      const n = Number(code.slice(1)) - 155; // S156..S161 -> powder 1..6
      if (n >= 1 && n <= 6) {
        p[`powderAmount${n}`] = num(r[`powder${n}`]);
        p[`powderFeedTime${n}`] = num(r[`powderFeedTime${n}`]);
        p.adeWaterAmount1 = num(r[`powderHotWaterAmount${n}`]);
      }
    }
  }
  return p;
}

/** Spout specific brew sequences (S203..S206) */
const BREW = {
  hotWater1: ['brewUpper', 'preInfusion', 'coffee', 'hotWater', 'brewLower', 'brewMiddle'], // S203
  shot1: ['brewUpper', 'preInfusion', 'coffee', 'brewLower', 'brewMiddle'], // S204
  hotWater2: [{ select: true }, 'brewUpper', 'preInfusion', 'coffee', 'ade1', 'brewLower', 'brewMiddle', { select: false }], // S205
  shot2: [{ select: true }, 'brewUpper', 'preInfusion', 'coffee', 'brewLower', 'brewMiddle', { select: false }], // S206
};

/** Main board command steps for one code. */
export function stepsForCode(code, spout) {
  const brew = (withWater) => (spout == 1 ? BREW[withWater ? 'hotWater1' : 'shot1'] : spout == 2 ? BREW[withWater ? 'hotWater2' : 'shot2'] : []);
  switch (code) {
    case 'S184':
      return ['grinder1', ...brew(true)];
    case 'S185':
      return ['grinder2', ...brew(true)];
    case 'S186':
      return ['grinder1', ...brew(false)];
    case 'S187':
      return ['grinder2', ...brew(false)];
    case 'S201':
      return ['grinder1', 'grinder2', ...brew(true)];
    case 'S202':
      return ['grinder1', 'grinder2', ...brew(false)];
    case 'S162':
      return ['ade1'];
    case 'S163':
      return ['ade2', 'ade1'];
    case 'S164':
      return ['ade3', 'ade1'];
    case 'S188':
      return ['ade2'];
    default: {
      const n = Number(code.slice(1)) - 155;
      if (n >= 1 && n <= 6) return [`powder${n}`, 'ade1'];
      return null;
    }
  }
}

/** Ingredient consumed by a code: [item, recipe time field] (serialRequest_euro.js updateIngredients) */
export function ingredientsForCode(code) {
  switch (code) {
    case 'S184':
    case 'S186':
      return [['bean1', 'grinderTime1']];
    case 'S185':
    case 'S187':
      return [['bean2', 'grinderTime2']];
    case 'S201':
    case 'S202':
      return [
        ['bean1', 'grinderTime1'],
        ['bean2', 'grinderTime2'],
      ];
    case 'S162':
    case 'S163':
    case 'S164': {
      const n = Number(code.slice(1)) - 161;
      return [[`ade${n}`, `adePumpTime${n}`]];
    }
    default: {
      const n = Number(code.slice(1)) - 155;
      return n >= 1 && n <= 6 ? [[`powder${n}`, `powderFeedTime${n}`]] : [];
    }
  }
}

/** Which ingredient a code-substring refers to, for sold-out rendering (uiHandlerer.js). */
export const CODE_INGREDIENT = { S150: 'bean1', S171: 'bean2', S186: 'bean1', S187: 'bean2', S156: 'powder1', S157: 'powder2', S158: 'powder3', S159: 'powder4', S160: 'powder5', S161: 'powder6', S162: 'ade1', S163: 'ade2', S164: 'ade3' };

/** Auto-clean mapping (st_dtl_auto_clean_line): code -> [line, wash part] */
export const CLEAN_MAP = { S184: ['bean1', 'coffee1'], S185: ['bean2', 'coffee2'], S156: ['powder1', 'powder1'], S157: ['powder2', 'powder2'], S158: ['powder3', 'powder3'], S159: ['powder4', 'powder4'], S160: ['powder5', 'powder5'], S161: ['powder6', 'powder6'] };

/**
 * Execute all codes of one goods on the main board (cup already on the outlet).
 * onStep(code, label) is called before each code.
 */
export async function runCodes(main, goods, { feed = 0, onStep = () => {} } = {}) {
  const r = goods.gds_recipe ?? {};
  const spout = Number(goods.gds_spout_num ?? r.gds_spout_num ?? 1);
  for (const code of splitCodes(r.dataCodes)) {
    const steps = stepsForCode(code, spout);
    if (!steps) {
      onStep(code, `알 수 없는 코드 ${code} (건너뜀)`);
      continue;
    }
    onStep(code);
    await main.menuMode(false);
    await main.setRecipe(paramsForCode(code, r, { feed }));
    await main.menuMode(true);
    try {
      for (const s of steps) {
        if (typeof s === 'string') await main.command(s);
        else await main.selectOutlet2(s.select);
      }
    } finally {
      await main.clearCommands();
    }
  }
}

// ============================================================================ washing (serialRequest_wash.js)
export const WASH_PARTS = ['all', 'coffee1', 'coffee2', 'hotWater1', 'hotWater2', 'hotWater3', 'powder1', 'powder2', 'powder3', 'powder4', 'powder5', 'powder6'];
export const WASH_LABEL = { all: '전체(파우더1~6)', coffee1: '커피1', coffee2: '커피2', hotWater1: '온수1', hotWater2: '온수2', hotWater3: '온수3', powder1: '파우더1', powder2: '파우더2', powder3: '파우더3', powder4: '파우더4', powder5: '파우더5', powder6: '파우더6' };

/**
 * @param main MainBoardClient
 * @param part one of WASH_PARTS
 * @param washTime / washAirTime  milliseconds (settings.washTime / washAirTime)
 */
export async function wash(main, part, { washTime = 5000, washAirTime = 300 } = {}) {
  const t = Math.max(500, num(washTime));
  const air = Math.max(0, num(washAirTime));
  const brew = async (pos, s) => {
    await main.set(s, '1');
    await main.waitM({ upper: 58, middle: 59, lower: 60 }[pos], '1', { timeoutMs: 20000 });
    await main.set(s, '0');
  };
  const valves = async (list, extra = []) => {
    await main.manualMode(true);
    for (const v of [...list, ...extra]) await main.actuator(v, true);
    await main.actuator('mainPump', true);
    await sleep(t);
    await main.actuator('mainPump', false);
    for (const v of [...extra, ...list].reverse()) {
      await sleep(air);
      await main.actuator(v, false);
    }
    await sleep(air);
    await main.manualMode(false);
  };
  if (part === 'all') {
    for (let n = 1; n <= 6; n++) await wash(main, `powder${n}`, { washTime, washAirTime });
    return;
  }
  if (part === 'coffee1' || part === 'coffee2') {
    await main.menuMode(false);
    await main.manualMode(true);
    await brew('upper', 59);
    await main.manualMode(false);
    await main.selectOutlet2(part === 'coffee2');
    await main.manualMode(true);
    await main.actuator('solCoffee2', true);
    await main.actuator('solCoffee1', true);
    await main.actuator('mainPump', true);
    await sleep(t);
    await main.actuator('mainPump', false);
    await main.actuator('solCoffee1', false);
    await main.actuator('solCoffee2', false);
    await brew('lower', 61);
    await brew('middle', 60);
    await main.manualMode(false);
    if (part === 'coffee2') await main.selectOutlet2(false);
    return;
  }
  if (part.startsWith('hotWater')) {
    const n = Number(part.slice(-1));
    const extra = n === 1 ? ['solHotWater3'] : n === 2 ? ['solAde1'] : ['solAde2'];
    return valves(['solHotWater1', 'solHotWater2'], extra);
  }
  if (part.startsWith('powder')) {
    const n = Number(part.slice(-1));
    return valves(['solHotWater1', 'solHotWater2', `solPowder${n}`], [`mixer${n}`]);
  }
  throw new Error(`unknown wash part ${part}`);
}
