import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Platform, Machine, KioskEngine, MailbeanBackend, euro } from '../src/index.js';
import m400 from '../../../platforms/m400/platform.js';

function setup() {
  const platform = new Platform(m400, { speed: 25, autoAssist: true, assistDelay: 0.15 }).start(10);
  const machine = Machine.local(platform);
  const backend = new MailbeanBackend();
  const api = async (method, path, body) => {
    const r = await backend.handle(method, path, { body });
    if (r.status >= 400) throw new Error(JSON.stringify(r.body));
    return r.body;
  };
  const engine = new KioskEngine({ machine, api });
  const served = [];
  platform.on('event', (e) => e.type === 'cup-served' && served.push(e.record));
  const close = () => (machine.close(), platform.stop());
  return { platform, machine, backend, engine, served, close };
}

const waitFor = async (fn, ms = 4000) => {
  for (let t = 0; t < ms && !fn(); t += 50) await new Promise((r) => setTimeout(r, 50));
};

test('dataCodes parameter mapping follows euro()', () => {
  const r = { coffee: '40', water: '150', grinderTime1: '2.5', powder3: '30', powderFeedTime3: '2', powderHotWaterAmount3: '120', adeWater2: '180', adePumpTime2: '4' };
  assert.deepEqual(euro.splitCodes('S150S158S163'), ['S184', 'S158', 'S163']);
  assert.equal(euro.paramsForCode('S184', r).adeWaterAmount1, 150);
  assert.equal(euro.paramsForCode('S158', r).adeWaterAmount1, 120);
  assert.equal(euro.paramsForCode('S163', r).adeWaterAmount1, 180);
  assert.deepEqual(euro.stepsForCode('S184', 2), ['grinder1', { select: true }, 'brewUpper', 'preInfusion', 'coffee', 'ade1', 'brewLower', 'brewMiddle', { select: false }]);
  assert.deepEqual(euro.stepsForCode('S163', 2), ['ade2', 'ade1']);
});

test('backend serves the kiosk API shapes and records payments with points', async () => {
  const b = new MailbeanBackend();
  const s = (await b.handle('GET', '/mailbean/get_settings/SIM-M400-0001')).body;
  assert.equal(s.multiDevice.cupDispenser.comPort, 'COM3');
  const goods = (await b.handle('GET', `/mailbean/goods_list/${s.admin}`)).body;
  assert.ok(goods.every((g) => g.gds_recipe && 'dataCodes' in g.gds_recipe));
  assert.equal((await b.handle('GET', '/mailbean/check_cust_tel/simadmin/010-1234-5678')).body.st_customer, 'Y');
  const pay = (await b.handle('POST', '/mailbean/payment_data_insert/', { body: { pay_method: 'CD', cust_tel: '010-1234-5678', point_amount_use: 1000, point_amount_accum: 0, pay_card_dtl_price: 1000 } })).body;
  assert.match(pay.recipt_url, /^\/receipt\//);
  assert.equal(b.state.customers['010-1234-5678'].point, 2000);
  let got = null;
  b.on('notify', (m) => (got = m));
  await b.handle('POST', '/cafesim-admin/remote', { body: { title: 'remote-wash', data: { wash_part: 'powder1' } } });
  assert.equal(got.title, 'remote-wash');
  assert.match(MailbeanBackend.sseFrame(got), /^data: \{"data":"\{\\"title\\":\\"remote-wash/);
});

test('cart of iced latte + lemonade runs through euro() and consumes stock', async () => {
  const { backend, engine, served, close } = setup();
  try {
    await engine.machine.init();
    const data = await engine.load();
    const latte = data.goods.find((g) => g.gds_name === '아이스 카페라떼');
    const lemon = data.goods.find((g) => g.gds_name === '레몬에이드');
    await engine.makeDrinks([latte, lemon]);
    await waitFor(() => served.length >= 2);
    assert.equal(served.length, 2);
    const l = served.find((c) => c.contents.coffee > 0);
    const a = served.find((c) => c !== l);
    assert.ok(l.contents.coffee >= 39 && l.contents.powder[1] >= 29 && l.contents.ice > 0, JSON.stringify(l.contents));
    assert.ok(a.contents.ade[2] > 20 && a.contents.water >= 179, JSON.stringify(a.contents));
    const ing = backend.state.ingredients;
    assert.equal(ing.cup2_now, 48);
    assert.ok(ing.bean1_now < 1000 && ing.powder1_now < 800 && ing.ade2_now < 2000);
  } finally {
    close();
  }
});

test('remote wash and remote extraction commands', async () => {
  const { engine, served, close } = setup();
  try {
    engine.data = null;
    await engine.load();
    engine.data.settings.washTime = 600;
    engine.data.settings.washAirTime = 0;
    const events = [];
    engine.on('remote', (e) => events.push(e.status));
    await engine.handleRemote({ title: 'remote-wash', data: { wash_part: 'hotWater1' } });
    await engine.handleRemote({ title: 'remote-extraction', data: { made_gds_name: '에스프레소', made_method_ids: 'cup-extract,drink-extract' } });
    await waitFor(() => served.length >= 1);
    assert.deepEqual(events, ['start', 'done', 'start', 'done']);
    assert.ok(served[0].contents.coffee >= 39);
  } finally {
    close();
  }
});
