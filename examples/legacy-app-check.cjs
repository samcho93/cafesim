/**
 * Compatibility check: drives the simulator with the ORIGINAL kiosk serial code
 * (source/controller/serial/**), unmodified, through the serialport shim.
 *
 *   1) npm run sim -- --auto        (auto-assist performs the customer actions)
 *   2) node --require ./packages/serialport-shim/register.cjs examples/legacy-app-check.cjs [path/to/source]
 *
 * The original source is not part of this repository; pass its folder (default ../source).
 */
'use strict';
const path = require('node:path');
const Module = require('node:module');

const SRC = path.resolve(process.argv[2] || path.join(__dirname, '..', 'source'));
const req = (p) => require(path.join(SRC, p));

// --- stand-ins for the Electron main process ---------------------------------------
const logs = [];
global.mainWindow = { webContents: { send: (ch, ...a) => logs.push([ch, ...a]) }, isDestroyed: () => false };
global.settingsLog = 'off';
global.settingsReset = 'on';
global.settingsErrorShow = 'off';
global.comMailBean = 'COM1';
global.comIceDispenser = 'COM2';
global.comCupDispenser = 'COM3';
global.feed = 0;
global.nnStateIce = global.nnStateHot = 'N';
global.mainWindow.webContents.send.bind(null);
globalThis.mainWindow = global.mainWindow;
globalThis.settingsLog = 'off';
globalThis.comIceDispenser = 'COM2';

// the cup manager pulls in HTTP helpers (node-fetch) that are irrelevant here
const resolve = Module._resolveFilename;
const stub = path.join(__dirname, 'stub-module.cjs');
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === 'node-fetch' || /apiCupState(.js)?$/.test(request)) return stub;
  return resolve.call(this, request, parent, ...rest);
};

const step = (msg) => console.log(`\n=== ${msg}`);

(async () => {
  const SerialManager = req('controller/serial/mainDevice/serialManager.js');
  const SerialRequestReset = req('controller/serial/mainDevice/serialRequest_reset.js');
  const SerialManagerIce = req('controller/serial/ice/serialManagerIce.js');
  const SerialRequestIce = req('controller/serial/ice/serialRequest_ice.js');
  const SerialRequestResetIce = req('controller/serial/ice/serialRequest_reset_ice.js');
  const SerialManagerCup = req('controller/serial/cup/serialManagerCup.js');
  const SerialRequestCup = req('controller/serial/cup/serialRequest_cup.js');
  const SerialRequestResetCup = req('controller/serial/cup/serialRequest_reset_cup.js');
  const seq = req('controller/serial/common/sequenceFunc.js');
  const tagList = req('controller/serial/common/tagListV3.js');

  const main = new SerialManager('COM1', 38400);
  const ice = new SerialManagerIce('COM2', 9600);
  const cup = new SerialManagerCup('COM3', 9600);
  await new Promise((r) => setTimeout(r, 500));
  const prefix = '[메일빈][Req]';

  step('메인보드 리셋 (serialRequest_reset.js) - 온도설정, 브로멕 상/하/중');
  await new SerialRequestReset(main).reset({ coffeeReady: 92, hotWaterReady: 85, coffeeUse: 90, hotWaterUse: 85, coffeeExtraction: 93, hotWaterExtraction: 88, coffeeOffset: 0, hotWaterOffset: 0 });
  console.log('ok');

  step('제빙기 초기화 + 컵디스펜서 리셋');
  await new SerialRequestResetIce(ice).resetIce();
  await new SerialRequestResetCup(cup).resetCup();
  console.log('ok');

  step('ICE 컵 배출 (serialRequest_cup.js)');
  await new SerialRequestCup(cup).cupDispenser('ice');
  console.log('ok');

  step('제빙기 출빙 5s (serialRequest_ice.js) - 시뮬레이터 auto-assist 가 컵을 제빙기로 옮깁니다');
  await new SerialRequestIce(ice).iceDispenser('ice', 5, 0);
  console.log('ok');

  step('메인보드: 메뉴모드, 1번 램프/컵센서, 레시피, S203(커피+온수)');
  await seq.S000(main, prefix, ['1']);
  await seq.S165(main, prefix, ['2']);
  await seq.S007(main, prefix, ['1'], 1);
  await seq.S165(main, prefix, ['1']);
  await seq.S000(main, prefix, ['0']);
  const cc = tagList.splitToHexBytesCC;
  const coffee = cc(40);
  const water = cc(120);
  await main.sendRequestWithChecksum(
    tagList.Cvt_Scode2hex4DirectHexTemp60({ grinderTime1: tagList.ginderToBytesSec(2.5), coffeeAmountHigh: coffee.highByte, coffeeAmountLow: coffee.lowByte, hotWaterAmountHigh: water.highByte, hotWaterAmountLow: water.lowByte }),
    prefix,
  );
  await seq.S000(main, prefix, ['1']);
  await seq.S150(main, prefix);
  await seq.S203(main, prefix);
  await main.sendRequestWithChecksum(tagList.createPacketClear15(), prefix);
  await main.sendRequestWithChecksum(tagList.createPacketClear05(), prefix);
  console.log('ok');

  step('컵 이탈 대기 (S165=2, S007=0)');
  await seq.S165(main, prefix, ['2']);
  await seq.S007(main, prefix, ['0'], 1);
  await seq.S165(main, prefix, ['0']);
  await seq.S000(main, prefix, ['0']);
  console.log('ok');

  await new Promise((r) => setTimeout(r, 2500));
  const res = await fetch('http://127.0.0.1:8700/api/state').then((r) => r.json());
  const done = res.world.served[0] ?? res.world.cups.find((c) => c.slot === 'pickup');
  console.log('\n=== 결과: 완성된 컵', done ? JSON.stringify({ type: done.type, contents: done.contents }) : '(없음 - 서버를 --auto 로 실행했는지 확인)');
  const errors = logs.filter(([ch]) => /error/.test(ch));
  console.log(errors.length ? errors : 'no device errors reported to the UI');
  process.exit(0);
})().catch((e) => {
  console.error('FAILED', e);
  process.exit(1);
});
