/**
 * Register map of the Mailbean main board, reconstructed from the kiosk source
 * (sequenceFunc.js, tagListV3.js, codeMtag.js).
 *
 * S area = commands/parameters written by the host (BW)
 * M area = status read by the host (BR M000, length 140/149)
 */

// ----------------------------------------------------------------- S area
export const S = {
  MENU_MODE: 0,
  // boiler temperatures (raw bytes, °C)
  COFFEE_READY: 1,
  HOTWATER_READY: 2,
  COFFEE_USE: 3,
  HOTWATER_USE: 4,
  COFFEE_EXTRACT: 5,
  HOTWATER_EXTRACT: 6,
  CUP_SENSOR_USE: 7,
  COFFEE_OFFSET: 16,
  HOTWATER_OFFSET: 17,
  MANUAL_MODE: 20,
  RESET: 70,
  CLEAR_ERROR: 71,
  EMERGENCY_STOP: 72,
  RECIPE: 80, // 60 bytes S080..S139
  SELECT_OUTLET: 155,
};

/** Manual actuators: S address -> { key, label, m: status index } */
export const ACTUATORS = {
  21: { key: 'solCoffee2', label: '커피 2차 솔레노이드', m: 17 },
  22: { key: 'solHotWater3', label: '온수 3차 솔레노이드', m: 18 },
  23: { key: 'solHotWater1', label: '온수 1차 솔레노이드', m: 26 },
  24: { key: 'solPowder1', label: '파우더1 솔레노이드', m: 20 },
  25: { key: 'solPowder2', label: '파우더2 솔레노이드', m: 21 },
  26: { key: 'solPowder3', label: '파우더3 솔레노이드', m: 22 },
  27: { key: 'solPowder4', label: '파우더4 솔레노이드', m: 23 },
  28: { key: 'solPowder5', label: '파우더5 솔레노이드', m: 24 },
  29: { key: 'solPowder6', label: '파우더6 솔레노이드', m: 25 },
  30: { key: 'solCoffee1', label: '커피 1차 솔레노이드', m: 19 },
  31: { key: 'solAde1', label: '에이드1 솔레노이드', m: 27 },
  32: { key: 'solAde2', label: '에이드2 솔레노이드', m: 28 },
  33: { key: 'solAde3', label: '에이드3 솔레노이드', m: 29 },
  34: { key: 'solAdeHotWater', label: '에이드 온수 솔레노이드', m: 30 },
  35: { key: 'solHotWater2', label: '온수 2차 솔레노이드', m: 31 },
  36: { key: 'solSupply', label: '급수 솔레노이드', m: 32 },
  37: { key: 'solSpare1', label: '예비1 솔레노이드', m: 33 },
  38: { key: 'solSpare2', label: '예비2 솔레노이드', m: 34 },
  40: { key: 'adePump1', label: '에이드 펌프1', m: 37 },
  41: { key: 'adePump2', label: '에이드 펌프2', m: 38 },
  42: { key: 'adePump3', label: '에이드 펌프3', m: 39 },
  43: { key: 'feeder1', label: '파우더1 피더', m: 3 },
  44: { key: 'feeder2', label: '파우더2 피더', m: 4 },
  45: { key: 'feeder3', label: '파우더3 피더', m: 5 },
  46: { key: 'feeder4', label: '파우더4 피더', m: 6 },
  47: { key: 'feeder5', label: '파우더5 피더', m: 7 },
  48: { key: 'feeder6', label: '파우더6 피더', m: 8 },
  49: { key: 'mixer1', label: '파우더1 믹서', m: 10 },
  50: { key: 'mixer2', label: '파우더2 믹서', m: 11 },
  51: { key: 'mixer3', label: '파우더3 믹서', m: 12 },
  52: { key: 'mixer4', label: '파우더4 믹서', m: 13 },
  53: { key: 'mixer5', label: '파우더5 믹서', m: 14 },
  54: { key: 'mixer6', label: '파우더6 믹서', m: 15 },
  55: { key: 'fan1', label: '배기팬1(전면)', m: 41 },
  56: { key: 'fan2', label: '배기팬2(전면)', m: 42 },
  57: { key: 'fan3', label: '배기팬3(후면)', m: 43 },
  58: { key: 'fan4', label: '배기팬4(후면)', m: 44 },
  62: { key: 'mainPump', label: '메인 펌프', m: 50 },
  63: { key: 'sparePump', label: '예비 펌프', m: null },
  64: { key: 'grinder1', label: '그라인더1', m: 45 },
  65: { key: 'hotWaterHeater', label: '온수보일러 히터', m: 49 },
  66: { key: 'coffeeHeater', label: '커피보일러 히터', m: 48 },
  67: { key: 'grinder2', label: '그라인더2', m: 46 },
  68: { key: 'selectOutlet', label: '커피 투출구 선택 솔레노이드', m: null },
  73: { key: 'lamp1', label: '투출구1 램프', m: 135 },
  74: { key: 'lamp2', label: '투출구2 램프', m: 136 },
  75: { key: 'lamp3', label: '투출구3 램프', m: 137 },
};

/** Manual brew-mechanism ("브로멕") positions */
export const BREW_MANUAL = { 59: 'upper', 60: 'middle', 61: 'lower' };

/**
 * Menu commands: S address -> { key, m: progress index, label }
 * Host writes '1' then polls M[m] until '2' (done). Writing '0' resets M[m] to '0'.
 */
export const COMMANDS = {
  150: { key: 'grinder1', m: 108, label: '그라인더1 분쇄' },
  151: { key: 'brewUpper', m: 109, label: '브로멕 압축(상단)' },
  152: { key: 'brewLower', m: 110, label: '브로멕 해제(하단)' },
  153: { key: 'coffee', m: 111, label: '커피 추출' },
  154: { key: 'hotWater', m: 112, label: '온수 추출' },
  156: { key: 'powder1', m: 114, label: '파우더1 추출' },
  157: { key: 'powder2', m: 115, label: '파우더2 추출' },
  158: { key: 'powder3', m: 116, label: '파우더3 추출' },
  159: { key: 'powder4', m: 117, label: '파우더4 추출' },
  160: { key: 'powder5', m: 118, label: '파우더5 추출' },
  161: { key: 'powder6', m: 119, label: '파우더6 추출' },
  162: { key: 'ade1', m: 120, label: '에이드1 추출' },
  163: { key: 'ade2', m: 121, label: '에이드2 추출' },
  164: { key: 'ade3', m: 122, label: '에이드3 추출' },
  168: { key: 'preInfusion', m: 126, label: '불림(프리인퓨전)' },
  169: { key: 'steam', m: 127, label: '스팀' },
  170: { key: 'cake', m: 128, label: '케이크 배출' },
  171: { key: 'grinder2', m: 129, label: '그라인더2 분쇄' },
  172: { key: 'brewMiddle', m: 130, label: '브로멕 중단 이동' },
};

export const COMMAND_BY_KEY = Object.fromEntries(Object.entries(COMMANDS).map(([s, c]) => [c.key, { ...c, s: Number(s) }]));

/** Outlet lamps: S165..S167 value '0' off, '1' on, '2' blink (guide the customer) */
export const LAMPS = { 165: 1, 166: 2, 167: 3 };

/** Recipe block layout written as 60 raw bytes from S080 (Cvt_Scode2hex4DirectHexTemp60) */
export const RECIPE_FIELDS = [
  ['grinderTime1', 1],
  ['coffeeAmount', 2],
  ['hotWaterAmount', 2],
  ['powderAmount1', 2],
  ['powderAmount2', 2],
  ['powderAmount3', 2],
  ['powderAmount4', 2],
  ['powderAmount5', 2],
  ['powderAmount6', 2],
  ['adeWaterAmount1', 2],
  ['adeWaterAmount2', 2],
  ['adeWaterAmount3', 2],
  ['adeIceWaterAmount1', 2],
  ['adeIceWaterAmount2', 2],
  ['adeIceWaterAmount3', 2],
  ['powderFeedTime1', 2],
  ['powderFeedTime2', 2],
  ['powderFeedTime3', 2],
  ['powderFeedTime4', 2],
  ['powderFeedTime5', 2],
  ['powderFeedTime6', 2],
  ['powderMixTime1', 2],
  ['powderMixTime2', 2],
  ['powderMixTime3', 2],
  ['powderMixTime4', 2],
  ['powderMixTime5', 2],
  ['powderMixTime6', 2],
  ['adePumpTime1', 2],
  ['adePumpTime2', 2],
  ['adePumpTime3', 2],
  ['grinderTime2', 1],
];

/** Unit conversions: cc fields are raw cc, time fields are 0.1 s units */
export const RECIPE_UNITS = (name) => (/Time/.test(name) ? 'sec' : 'cc');

export function decodeRecipe(bytes) {
  const out = {};
  let p = 0;
  for (const [name, size] of RECIPE_FIELDS) {
    const raw = size === 1 ? bytes[p] ?? 0 : ((bytes[p] ?? 0) << 8) | (bytes[p + 1] ?? 0);
    out[name] = RECIPE_UNITS(name) === 'sec' ? raw / 10 : raw;
    p += size;
  }
  return out;
}

export function encodeRecipe(recipe = {}) {
  const bytes = [];
  for (const [name, size] of RECIPE_FIELDS) {
    const v = Number(recipe[name] ?? 0);
    const raw = Math.max(0, Math.round(RECIPE_UNITS(name) === 'sec' ? v * 10 : v));
    if (size === 1) bytes.push(Math.min(255, raw));
    else bytes.push((raw >> 8) & 0xff, raw & 0xff);
  }
  return bytes;
}

// ----------------------------------------------------------------- M area (status)
export const M = {
  CUP_SENSOR_USE: 53,
  CUP_SENSOR: [54, 55, 56],
  BOILER_USE: 57,
  BREW_UPPER: 58,
  BREW_MIDDLE: 59,
  BREW_LOWER: 60,
  CANISTER: [61, 62, 63, 64, 65, 66],
  DOOR: 67,
  BEAN: [69, 70],
  WATER_LEVEL: 71,
  BREW_MOUNTED: 72,
  COFFEE_TEMP: 73,
  HOTWATER_TEMP: 74,
  FIRMWARE: 80,
  ERROR_ANY: 83,
  MANUAL_MODE: 134,
  LAMP: [135, 136, 137],
  FLOW: 141, // 4 ascii digits
  PRESSURE: 145, // 4 ascii digits (110..920 -> 0..25 bar)
};

/** Error flags M084..M103 */
export const ERRORS = {
  84: '그라인더1 동작에러',
  85: '그라인더2 동작에러',
  86: '브로멕 동작에러',
  87: '커피보일러 에러',
  88: '온수보일러 에러',
  89: '물부족 에러',
  90: '메뉴 추출시간 에러',
  91: '커피보일러 대기온도 미달',
  92: '온수보일러 대기온도 미달',
  93: '커피추출 동작에러',
  94: '온수추출 동작에러',
  95: '파우더1 추출동작에러',
  96: '파우더2 추출동작에러',
  97: '파우더3 추출동작에러',
  98: '파우더4 추출동작에러',
  99: '파우더5 추출동작에러',
  100: '파우더6 추출동작에러',
  101: '에이드1 동작에러',
  102: '에이드2 동작에러',
  103: '에이드3 동작에러',
};

export const pressureCountToBar = (count) => (count <= 110 ? 0 : count >= 920 ? 25 : ((count - 110) / 810) * 25);
export const barToPressureCount = (bar) => Math.round(110 + (Math.max(0, Math.min(25, bar)) / 25) * 810);
