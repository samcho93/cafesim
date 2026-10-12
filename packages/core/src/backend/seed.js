/**
 * Seed data for the virtual Mailbean cloud, in exactly the shapes the kiosk app reads
 * (get_settings, goods_list, goods_category_list, pt_goods_list, store_detail_list, ingredient_list ...).
 */

const RECIPE_KEYS = [
  'coffee', 'grinderTime1', 'grinderTime2', 'water', 'soak', 'soakWater', 'dumping', 'teaBagHotWater', 'iceGenIce', 'iceGenWater',
  ...[1, 2, 3, 4, 5, 6].flatMap((n) => [`powder${n}`, `powderFeedTime${n}`, `powderMixTime${n}`, `powderHotWaterAmount${n}`]),
  ...[1, 2, 3].flatMap((n) => [`adeWater${n}`, `adePumpTime${n}`]),
];

export const RECIPE_FIELDS = RECIPE_KEYS;

/** Data codes the kiosk app understands (serialRequest_euro.js / makeDrinks) */
export const DATA_CODES = [
  { code: 'S150', label: '커피 (그라인더1)', uses: ['grinderTime1', 'coffee', 'water'] },
  { code: 'S171', label: '커피 (그라인더2)', uses: ['grinderTime2', 'coffee', 'water'] },
  { code: 'S186', label: '샷 (그라인더1)', uses: ['grinderTime1', 'coffee'] },
  { code: 'S187', label: '샷 (그라인더2)', uses: ['grinderTime2', 'coffee'] },
  { code: 'S201', label: '하모니 블렌드 (그라인더1+2)', uses: ['grinderTime1', 'grinderTime2', 'coffee', 'water'] },
  { code: 'S202', label: '하모니 블렌드 샷', uses: ['grinderTime1', 'grinderTime2', 'coffee'] },
  ...[1, 2, 3, 4, 5, 6].map((n) => ({ code: `S${155 + n}`, label: `파우더${n}`, uses: [`powder${n}`, `powderFeedTime${n}`, `powderHotWaterAmount${n}`] })),
  ...[1, 2, 3].map((n) => ({ code: `S${161 + n}`, label: `에이드${n}`, uses: [`adeWater${n}`, `adePumpTime${n}`] })),
  { code: 'S188', label: '티백 온수', uses: ['teaBagHotWater'] },
  { code: 'S200', label: '얼음물 (제빙기만)', uses: ['iceGenIce', 'iceGenWater'] },
];

export function emptyRecipe(extra = {}) {
  const r = Object.fromEntries(RECIPE_KEYS.map((k) => [k, '0']));
  return { mainboardId: 'SIMULATOR', categoryList: '', gdsList: '', ice_YN: 'N', dataCodes: '', gds_spout_num: '1', gds_status_show: true, gds_status_soldout: false, new_gds: false, best_gds: false, ...r, ...extra };
}

let seq = 0;
function goods({ name, price, cat, codes, spout = '1', color = '#6b4226', ice = null, type = 'goods-drink', best = 'N', isNew = 'N', status = 'displayed', point = 10, ...recipe }) {
  seq += 1;
  const id = `GdsSIM${String(seq).padStart(3, '0')}`;
  const r = emptyRecipe({ categoryList: cat, gdsList: name, dataCodes: codes, gds_spout_num: spout, ice_YN: ice ? 'Y' : 'N', best_gds: best === 'Y', new_gds: isNew === 'Y' });
  for (const [k, v] of Object.entries(recipe)) r[k] = String(v);
  if (ice) {
    r.iceGenIce = String(ice.ice);
    r.iceGenWater = String(ice.water ?? 0);
  }
  return {
    gds_id: id,
    gds_name: name,
    gds_seq: seq,
    gds_price: price,
    gds_recipe: r,
    gds_option: {},
    gds_status: status,
    gds_spout_num: spout,
    gds_point_status: 'None',
    gds_point_rate: point,
    gds_timestamp: '2026-10-01T09:00:00',
    gds_img: `/media/sim/${id}.svg`,
    gds_type: type,
    owner_name: 'simadmin',
    gds_best_tag_status: best,
    gds_new_tag_status: isNew,
    sim_color: color,
  };
}

export function seedGoods() {
  seq = 0;
  return [
    goods({ name: '아메리카노', price: 2000, cat: '커피_전체메뉴', codes: 'S150', spout: '1', color: '#3b2416', grinderTime1: 2.5, coffee: 40, water: 150, best: 'Y' }),
    goods({ name: '아이스 아메리카노', price: 2000, cat: '커피_전체메뉴', codes: 'S150', spout: '1', color: '#3b2416', grinderTime1: 2.5, coffee: 40, water: 110, ice: { ice: 5, water: 0 }, best: 'Y' }),
    goods({ name: '디카페인 아메리카노', price: 2500, cat: '커피_전체메뉴', codes: 'S171', spout: '1', color: '#4a2f1e', grinderTime2: 2.5, coffee: 40, water: 150 }),
    goods({ name: '하모니 블렌드', price: 2800, cat: '커피_전체메뉴', codes: 'S201', spout: '1', color: '#3a2618', grinderTime1: 1.5, grinderTime2: 1.5, coffee: 45, water: 140, isNew: 'Y' }),
    goods({ name: '에스프레소', price: 1800, cat: '커피_전체메뉴', codes: 'S186', spout: '1', color: '#2a170d', grinderTime1: 2.5, coffee: 40 }),
    goods({ name: '카페라떼', price: 2800, cat: '커피_라떼_전체메뉴', codes: 'S150S156', spout: '2', color: '#b98a5e', grinderTime1: 2.5, coffee: 40, powder1: 30, powderFeedTime1: 2, powderHotWaterAmount1: 120 }),
    goods({ name: '아이스 카페라떼', price: 2800, cat: '커피_라떼_전체메뉴', codes: 'S150S156', spout: '2', color: '#b98a5e', grinderTime1: 2.5, coffee: 40, powder1: 30, powderFeedTime1: 2, powderHotWaterAmount1: 90, ice: { ice: 4.5 } }),
    goods({ name: '바닐라라떼', price: 3200, cat: '커피_라떼_전체메뉴', codes: 'S162S150S156', spout: '2', color: '#c9a173', adePumpTime1: 2, grinderTime1: 2.5, coffee: 40, powder1: 30, powderFeedTime1: 2, powderHotWaterAmount1: 110 }),
    goods({ name: '초코라떼', price: 3000, cat: '라떼_전체메뉴', codes: 'S157', spout: '2', color: '#5a3522', powder2: 40, powderFeedTime2: 3, powderHotWaterAmount2: 150 }),
    goods({ name: '녹차라떼', price: 3000, cat: '라떼_전체메뉴', codes: 'S158', spout: '2', color: '#7d9b4f', powder3: 40, powderFeedTime3: 3, powderHotWaterAmount3: 150 }),
    goods({ name: '복숭아 아이스티', price: 2500, cat: '티·에이드_전체메뉴', codes: 'S159', spout: '2', color: '#d98b4a', powder4: 40, powderFeedTime4: 2.5, powderHotWaterAmount4: 160, ice: { ice: 6 } }),
    goods({ name: '레몬에이드', price: 3200, cat: '티·에이드_전체메뉴', codes: 'S163', spout: '2', color: '#e8d34f', adeWater2: 180, adePumpTime2: 4, ice: { ice: 6 } }),
    goods({ name: '자몽에이드', price: 3200, cat: '티·에이드_전체메뉴', codes: 'S164', spout: '2', color: '#e5645a', adeWater3: 180, adePumpTime3: 4, ice: { ice: 6 } }),
    goods({ name: '얼그레이 티', price: 2000, cat: '티·에이드_전체메뉴', codes: 'S188', spout: '2', color: '#9a5b2e', teaBagHotWater: 220 }),
    goods({ name: '얼음물', price: 500, cat: '티·에이드_전체메뉴', codes: 'S200', spout: '2', color: '#cfe6f2', ice: { ice: 6, water: 2 } }),
    goods({ name: '수제 쿠키', price: 1500, cat: '디저트_전체메뉴', codes: '', type: 'goods-etc', color: '#c58b4b' }),
  ];
}

export function seedCategories() {
  return ['전체메뉴', '커피', '라떼', '티·에이드', '디저트'].map((name, i) => ({ gds_cat_name: name, gds_cat_seq: i + 1, gds_cat_status: 'displayed' }));
}

export function seedPointGoods() {
  return [
    { pt_gds_id: 'PtSIM001', pt_gds_name: '아메리카노 쿠폰', pt_gds_seq: 1, pt_gds_price: 2000, pt_gds_point_rate: 0, pt_gds_status: 'displayed', pt_gds_img: '/media/sim/coupon.svg' },
    { pt_gds_id: 'PtSIM002', pt_gds_name: '라떼 쿠폰', pt_gds_seq: 2, pt_gds_price: 2800, pt_gds_point_rate: 0, pt_gds_status: 'displayed', pt_gds_img: '/media/sim/coupon.svg' },
  ];
}

export function seedSettings(mac = 'SIM-M400-0001') {
  const temps = { coffeeReady: '92', hotWaterReady: '85', coffeeUse: '90', hotWaterUse: '85', coffeeExtraction: '93', hotWaterExtraction: '88', coffeeOffset: '0', hotWaterOffset: '0' };
  return {
    MacAddr: mac,
    admin: 'simadmin',
    webMode: 'was',
    serialNumber: 'SIM-M400-0001',
    tid: 'DPT0TEST03',
    login_password: '1234',
    payMode: 'on',
    reset: 'on',
    cupInverse: 'off',
    errorShow: 'off',
    logShow: 'off',
    washTime: 5000,
    washAirTime: 300,
    autoUpdate: 'off',
    developeMode: 'off',
    feed: 0,
    rfid: 'off',
    idleWaitTime: 10,
    ...temps,
    multiDevice: {
      mainDevice: { useState: 'Y', comPort: 'COM1', ...temps },
      cardReader: { useState: 'Y', comPort: 'COM6', TID: 'DPT0TEST03', modelName: 'SIM-KSCAT' },
      iceDispenser: { useState: 'Y', comPort: 'COM2' },
      cupDispenser: { useState: 'Y', comPort: 'COM3' },
    },
  };
}

export function seedStore() {
  return {
    st_id: 'SIM-STORE',
    st_name: 'cafeSim 시뮬레이터 매장',
    st_icon: '',
    st_logo: 'sim/logo.svg', // the kiosk prefixes /media/
    st_theme: 'light',
    st_qr_recipt_status: 'Y',
    st_dtl_pcup_discount_status: 'Y',
    st_dtl_pcup_discount: 500,
    st_dtl_auto_clean_status: 'N',
    st_dtl_auto_clean_type: 'N',
    st_dtl_auto_clean_line: { bean1: 'Y', bean2: 'Y', powder1: 'Y', powder2: 'Y', powder3: 'Y', powder4: 'Y', powder5: 'Y', powder6: 'Y', ade1: 'N', ade2: 'N', ade3: 'N' },
    st_dtl_auto_soldout_status: 'both',
    st_dtl_auto_refill_status: 'cup',
    st_dtl_point_status: 'Y',
    st_dtl_point_type: 'rate',
    st_dtl_point_rate: 5,
    st_dtl_point_min_price: 1000,
    st_dtl_stamp_status: 'N',
    st_dtl_stamp_free_drink_count: 10,
    st_dtl_display_goods_tag: { new: 'true', best: 'true', hotice: 'true' },
    st_dtl_max_cart_quantity: 10,
    st_standby_screen_status: 'N',
    st_standby_screen: '',
    st_standby_screen_time: 0,
  };
}

export const INGREDIENTS = ['bean1', 'bean2', 'powder1', 'powder2', 'powder3', 'powder4', 'powder5', 'powder6', 'ade1', 'ade2', 'ade3', 'cup1', 'cup2'];

export const INGREDIENT_LABEL = { bean1: '원두1', bean2: '원두2', powder1: '파우더1 (우유)', powder2: '파우더2 (초코)', powder3: '파우더3 (녹차)', powder4: '파우더4 (아이스티)', powder5: '파우더5', powder6: '파우더6', ade1: '에이드1 (바닐라)', ade2: '에이드2 (레몬)', ade3: '에이드3 (자몽)', cup1: 'HOT 컵', cup2: 'ICE 컵' };

export function seedIngredients() {
  const max = { bean1: 1000, bean2: 1000, powder1: 800, powder2: 800, powder3: 800, powder4: 800, powder5: 800, powder6: 800, ade1: 2000, ade2: 2000, ade3: 2000, cup1: 50, cup2: 50 };
  const out = {};
  for (const k of INGREDIENTS) {
    out[`${k}_max`] = max[k];
    out[`${k}_now`] = max[k];
    out[`${k}_notification_per`] = 30;
    out[`${k}_notification_status`] = 'N';
  }
  out.cup1_backline_exist_status = 'Y';
  out.cup2_backline_exist_status = 'Y';
  return out;
}

export function seedPerSec() {
  return { bean1: 4, bean2: 4, powder1: 6, powder2: 6, powder3: 6, powder4: 6, powder5: 6, powder6: 6, ade1: 6, ade2: 6, ade3: 6, cup1: 1, cup2: 1 };
}

export function seedState(mac) {
  return {
    version: 1,
    settings: seedSettings(mac),
    goods: seedGoods(),
    categories: seedCategories(),
    ptGoods: seedPointGoods(),
    store: seedStore(),
    ingredients: seedIngredients(),
    perSec: seedPerSec(),
    customers: { '010-1234-5678': { point: 3000, pw: '1234' } },
    rfid: ['00A1B2C3D4'],
    payments: [],
    refunds: [],
    alimtalk: [],
    templates: { CM_INGR_REMAINING_NOTIFICATION: '[#{매장명}] #{물품명}(#{물품위치}) 재고가 #{알림기준}% 이하입니다.' },
    machine: { sw: '', fw: '', temps: null, errors: null, lastSeen: null },
    uploads: [],
    remote: [],
  };
}
