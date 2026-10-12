/**
 * Script console examples. Scripts run as async functions with:
 *   machine  high-level SDK (Machine): init, pay, order, rinse, main/cup/ice clients
 *   sim      { interact(action), snapshot(), definition, on(event, fn) }
 *   sleep(ms), log(...values)
 * Everything goes through the real wire protocols - watch the 통신 tab while they run.
 */
export const EXAMPLES = [
  {
    name: '① 아이스 아메리카노 주문 (전체 과정)',
    code: `// 결제 → 컵 배출 → 제빙 → 투출구 → 추출 → 픽업
// 화면 상단 안내에 따라 컵을 직접 옮기거나, '자동 진행'을 켜 두세요.
machine.on('step', (s) => log('▶', s.text));
await machine.init();
await machine.pay(2000);
const item = sim.definition.menu.find((m) => m.id === 'americano');
await machine.order(item, { temp: 'ice' });
log('완료!');`,
  },
  {
    name: '② 나만의 레시피 (더블샷 라떼)',
    code: `// 메뉴에 없는 레시피도 바로 만들 수 있습니다.
const doubleShotLatte = {
  id: 'double-latte', name: '더블샷 라떼', temps: ['hot'], spout: 2,
  sequence: [{ select: true }, 'grinder1', 'brewUpper', 'preInfusion', 'coffee', 'brewLower', 'brewMiddle', { select: false }, 'powder1'],
  recipe: { grinderTime1: 4, coffeeAmount: 70, powderAmount1: 160, powderFeedTime1: 2.5 },
};
machine.on('step', (s) => log('▶', s.text));
await machine.init();
await machine.order(doubleShotLatte, { temp: 'hot' });`,
  },
  {
    name: '③ 메인보드 명령 하나씩 (저수준)',
    code: `// MainBoardClient: S 영역 쓰기 / M 영역 읽기
const m = machine.main;
await m.reset();
await m.setRecipe({ grinderTime1: 2.5, coffeeAmount: 30 });
await m.menuMode(true);
for (const cmd of ['grinder1', 'brewUpper', 'coffee', 'brewLower', 'brewMiddle']) {
  log('명령', cmd);
  await m.command(cmd);           // S15x = '1' 후 M1xx 가 '2' 될 때까지 폴링
}
await m.clearCommands();
await m.menuMode(false);
log(await m.status());
// 컵이 없으니 커피는 drip tray로 흘러갑니다 (상태 탭 spill)`,
  },
  {
    name: '④ 수동 모드: 펌프/밸브 직접 제어 (세척)',
    code: `const m = machine.main;
await m.manualMode(true);
await m.actuator('solHotWater1', true);
await m.actuator('solHotWater2', true);
await m.actuator('solHotWater3', true);
await m.actuator('mainPump', true);
log('온수 라인 세척 중 3초...');
await sleep(3000);
await m.actuator('mainPump', false);
for (const v of ['solHotWater1', 'solHotWater2', 'solHotWater3']) await m.actuator(v, false);
await m.manualMode(false);
log('세척 끝');`,
  },
  {
    name: '⑤ 제빙기 / 컵 디스펜서 직접 제어',
    code: `await machine.ice.init();                 // A0 통신모드 + D0 타임아웃
log('제빙기', await machine.ice.status());
await machine.cup.dispense('hot');         // S000=1, S002=1, M018 == '2' 대기
log('HOT 컵이 나왔습니다 - 컵을 클릭해서 제빙기 파란 원으로 옮겨 보세요');
const done = machine.ice.dispense(3, 0.5);  // B0: 얼음 3초, 물 0.5초 (레버 눌릴 때까지 대기)
log('출빙 대기...');
await done;
log('출빙 완료', await machine.ice.status());`,
  },
  {
    name: '⑥ 장애 주입 테스트 (물 부족)',
    code: `// 장치 장애를 주입하고 프로그램이 어떻게 반응하는지 확인
await sim.interact({ type: 'device', device: 'main', action: { type: 'fault', name: 'waterShortage', on: true } });
const m = machine.main;
await m.setRecipe({ hotWaterAmount: 100 });
try {
  await m.command('hotWater');
} catch (e) {
  log('예상된 오류:', e.message);
}
log('에러 목록', await m.errors());
await sim.interact({ type: 'device', device: 'main', action: { type: 'fault', name: 'waterShortage', on: false } });
await m.reset();
log('복구 완료');`,
  },
  {
    name: '⑦ 시뮬레이션 이벤트 구독',
    code: `// 물리 이벤트(컵 생성/이동/서빙)와 장치 로그를 구독
const off1 = sim.on('event', (e) => log('event', e.type, e.to ?? e.slot ?? ''));
const off2 = sim.on('log', (e) => log('log', e.device, e.message));
await machine.cup.dispense('ice');
await sleep(4000);
off1(); off2();`,
  },
];
