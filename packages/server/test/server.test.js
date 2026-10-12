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
