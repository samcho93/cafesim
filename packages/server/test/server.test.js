import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, connectMachine } from '../src/index.js';

test('external program drives the virtual hardware over TCP + KSCAT HTTP', async () => {
  const srv = await startServer({ platform: 'm400', port: 8890, tcpOffset: 300, kscat: 27398, speed: 20, autoAssist: true, log: () => {} });
  srv.platform.assistDelay = 0.2;
  const machine = await connectMachine({ tcp: { main: 7301, ice: 7302, cup: 7303 }, kscat: { port: 27398 }, definition: srv.platform.definition });
  try {
    await machine.init();
    const paid = await machine.pay(3200);
    assert.equal(paid.STATUS, 'O');
    const served = new Promise((resolve) => srv.platform.on('event', (e) => e.type === 'cup-served' && resolve(e.record)));
    await machine.order(srv.platform.definition.menu.find((m) => m.id === 'lemon'), { temp: 'ice' });
    const cup = await served;
    assert.ok(cup.contents.ade[2] > 20, 'lemon syrup');
    assert.ok(cup.contents.ice > 0, 'ice');

    const state = await fetch('http://127.0.0.1:8890/api/state').then((r) => r.json());
    assert.equal(state.platform, 'm400');
    const r = await fetch('http://127.0.0.1:8890/api/interact', { method: 'POST', body: JSON.stringify({ type: 'device', device: 'cup', action: { type: 'refill' } }) }).then((x) => x.json());
    assert.equal(r.ok, true);
  } finally {
    machine.close();
    await srv.close();
  }
});

test('two clients sharing one machine are serialised by the room lock', async () => {
  const srv = await startServer({ platform: 'm400', port: 8891, tcp: false, kscat: false, speed: 20, autoAssist: true, log: () => {} });
  srv.platform.assistDelay = 0.2;
  const url = 'ws://127.0.0.1:8891/ws';
  const def = srv.platform.definition;
  const a = await connectMachine({ url, definition: def });
  const b = await connectMachine({ url, definition: def });
  const served = [];
  srv.platform.on('event', (e) => e.type === 'cup-served' && served.push(e.record));
  try {
    const item = def.menu.find((m) => m.id === 'americano');
    const run = async (m, temp) => {
      await m.init();
      await m.order(item, { temp });
    };
    await Promise.all([run(a, 'ice'), run(b, 'hot')]);
    for (let i = 0; i < 40 && served.length < 2; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(served.length, 2);
    for (const cup of served) assert.ok(cup.contents.coffee >= 39, `coffee in ${cup.type} cup`);
  } finally {
    a.close();
    b.close();
    await srv.close();
  }
});

test('an init issued during an order on the same client waits for the order', async () => {
  const srv = await startServer({ platform: 'm400', port: 8892, tcp: false, kscat: false, speed: 20, autoAssist: true, log: () => {} });
  srv.platform.assistDelay = 0.2;
  const def = srv.platform.definition;
  const m = await connectMachine({ url: 'ws://127.0.0.1:8892/ws', definition: def });
  const served = [];
  srv.platform.on('event', (e) => e.type === 'cup-served' && served.push(e.record));
  try {
    await m.init();
    const order = m.order(def.menu.find((x) => x.id === 'americano'), { temp: 'hot' });
    await new Promise((r) => setTimeout(r, 300));
    await Promise.all([order, m.init()]); // like the kiosk page booting mid-order
    for (let i = 0; i < 40 && !served.length; i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(served[0]?.contents.coffee >= 39, 'order finished with coffee');
  } finally {
    m.close();
    await srv.close();
  }
});

test('virtual Mailbean server: REST shapes, payments and SSE remote commands', async () => {
  const srv = await startServer({ platform: 'm400', port: 8893, tcp: false, kscat: false, data: false, log: () => {} });
  try {
    const base = 'http://127.0.0.1:8893';
    const settings = await fetch(`${base}/mailbean/get_settings/SIM-M400-0001`).then((r) => r.json());
    assert.equal(settings.MacAddr, 'SIM-M400-0001');
    const goods = await fetch(`${base}/mailbean/goods_list/${settings.admin}`).then((r) => r.json());
    assert.ok(goods.length > 5 && goods[0].gds_recipe.dataCodes);
    const svg = await fetch(`${base}${goods[0].gds_img}`);
    assert.match(svg.headers.get('content-type'), /svg/);

    // SSE: the kiosk app's EventSource format  data: {"data":"<json>"}
    const http = await import('node:http');
    const frame = new Promise((resolve) => {
      http.get(`${base}/notifications/SIM-M400-0001/`, (res) => {
        let buf = '';
        res.on('data', (c) => {
          buf += c;
          const m = /data: (\{"data".*\})\n\n/.exec(buf);
          if (m) {
            res.destroy();
            resolve(JSON.parse(JSON.parse(m[1]).data));
          }
        });
      });
    });
    await new Promise((r) => setTimeout(r, 200));
    srv.backend.state.settings.sim_remote_executor = 'off';
    await fetch(`${base}/cafesim-admin/remote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'remote-refill', data: {} }) });
    const cmd = await frame;
    assert.equal(cmd.title, 'remote-refill');

    const rec = await fetch(`${base}/mailbean/payment_data_insert/`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pay_method: 'CD', pay_card_dtl_price: 2000, pay_goods_detail: [{ gds_name: '아메리카노', pay_gds_stock: 1, pay_price: '2000' }] }) }).then((r) => r.json());
    const receipt = await fetch(`${base}${rec.recipt_url}`).then((r) => r.text());
    assert.match(receipt, /아메리카노/);
  } finally {
    await srv.close();
  }
});
