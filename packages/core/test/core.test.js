import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Platform, Machine, mailbean, iceProtocol, mainboardMap } from '../src/index.js';
import m400 from '../../../platforms/m400/platform.js';

const { encodeWrite, encodeRead, checksum, RequestParser, ResponseParser, encodeReadResponse } = mailbean;

test('mailbean frames match the legacy kiosk encoder', () => {
  // createPacket('01', 'BW', 'S000', '001', ['1']) from tagListV3.js
  const legacy = [0x05, ...Buffer.from('01BWS0000011'), 0x04];
  legacy.push(...checksum(legacy));
  assert.deepEqual(encodeWrite('01', 'S000', '1'), legacy);

  const frames = [];
  const p = new RequestParser((f) => frames.push(f));
  p.push(encodeRead('01', 'M000', 149));
  // legacy 3-char address used by setCupSensor(): '007'
  const odd = [0x05, ...Buffer.from('01BW0070011'), 0x04];
  p.push([...odd, ...checksum(odd)]);
  assert.equal(frames[0].cmd, 'BR');
  assert.equal(frames[0].length, 149);
  assert.equal(frames[1].addr, 'S007');
  assert.ok(frames[1].ok);

  const got = [];
  new ResponseParser((f) => got.push(f)).push(encodeReadResponse('01', 'M000', [0x30, 0x31, 0x02, 0x03]));
  assert.deepEqual(got[0].data, [0x30, 0x31, 0x02, 0x03]);
});

test('ice protocol + recipe codec round trip', () => {
  assert.equal(iceProtocol.secondsToIceByte(5.5), 0x55);
  assert.equal(iceProtocol.iceByteToSeconds(0x05), 0.5);
  assert.deepEqual(iceProtocol.encodeIce(0xcf, 0, 0), [0x02, 0x01, 0xcf, 0x00, 0x00, 0xce, 0x03]);
  const r = { grinderTime1: 2.5, coffeeAmount: 300, hotWaterAmount: 150, adePumpTime3: 1.2, grinderTime2: 0.5 };
  const bytes = mainboardMap.encodeRecipe(r);
  assert.equal(bytes.length, 60);
  const back = mainboardMap.decodeRecipe(bytes);
  for (const k of Object.keys(r)) assert.equal(back[k], r[k]);
});

test('full order: pay → cup → ice → extraction → pickup (auto assist)', async () => {
  const platform = new Platform(m400, { speed: 20, autoAssist: true, assistDelay: 0.2 }).start(10);
  const machine = Machine.local(platform);
  const steps = [];
  machine.on('step', (s) => steps.push(s.id));
  try {
    await machine.init();
    const res = await machine.pay(2000);
    assert.equal(res.RES, '0000');
    const item = m400.menu.find((m) => m.id === 'americano');
    const served = new Promise((resolve) => platform.on('event', (e) => e.type === 'cup-served' && resolve(e.record)));
    await machine.order(item, { temp: 'ice' });
    const cup = await served;
    assert.equal(cup.type, 'ice');
    assert.ok(cup.contents.ice > 10, 'has ice');
    assert.ok(cup.contents.coffee >= 39, `coffee ${cup.contents.coffee}`);
    assert.ok(cup.contents.water >= 100, `water ${cup.contents.water}`);
    assert.deepEqual(platform.world.spills, {});
    assert.deepEqual(steps, ['init', 'ready', 'pay', 'paid', 'cup', 'ice', 'place', 'brew', 'take', 'done']);
    assert.equal(platform.devices.main.brew.position, 'middle');
  } finally {
    machine.close();
    platform.stop();
  }
});

test('hot latte routes coffee and milk to outlet 2', async () => {
  const platform = new Platform(m400, { speed: 20, autoAssist: true, assistDelay: 0.2 }).start(10);
  const machine = Machine.local(platform);
  try {
    await machine.init();
    const served = new Promise((resolve) => platform.on('event', (e) => e.type === 'cup-served' && resolve(e.record)));
    await machine.order(m400.menu.find((m) => m.id === 'latte'), { temp: 'hot' });
    const cup = await served;
    assert.ok(cup.contents.coffee >= 39);
    assert.ok(cup.contents.powder[1] >= 140);
    assert.equal(cup.contents.ice, 0);
  } finally {
    machine.close();
    platform.stop();
  }
});
