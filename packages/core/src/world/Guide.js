/**
 * Derives "what should the customer do now" from the physical state only.
 * Because it does not depend on who drives the hardware, the same prompts appear
 * whether the machine is controlled by the bundled SDK, your own program, or the
 * original kiosk application connected through virtual serial ports.
 *
 * Each prompt: { id, text, target?: slot, cup?: id, action?: interaction to perform it }
 */
export function computeGuide(platform) {
  const { world } = platform;
  const prompts = [];
  const byType = (type) => Object.values(platform.devices).filter((d) => d.constructor.type === type);
  const mains = byType('mailbean-mainboard');
  const ices = byType('ice-maker');
  const pays = byType('kscat-terminal');
  const cupDevs = byType('cup-dispenser');

  for (const pay of pays) {
    if (pay.pending && pay.card !== 'inserted')
      prompts.push({ id: 'insert-card', text: `${pay.pending.amount.toLocaleString()}원 결제 - 카드를 단말기에 넣어 주세요`, target: `${pay.key}:slot`, action: { type: 'device', device: pay.key, action: { type: 'insertCard' } } });
    else if (!pay.pending && pay.card === 'inserted') prompts.push({ id: 'remove-card', text: '결제가 끝났습니다. 카드를 빼 주세요', target: `${pay.key}:slot`, action: { type: 'device', device: pay.key, action: { type: 'removeCard' } } });
  }

  const blinkingSpout = () => {
    for (const m of mains) {
      const i = m.lamps.findIndex((l) => l === 2);
      if (i >= 0 && !world.cupAt(`${m.key}:spout${i + 1}`)) return `${m.key}:spout${i + 1}`;
    }
    return null;
  };
  const freeIceTray = () => ices.map((d) => d.slot).find((s) => !world.cupAt(s));
  const move = (cup, to, text) => prompts.push({ id: `move-${cup.id}`, text, cup: cup.id, target: to, action: { type: 'moveCup', cup: cup.id, to } });
  const wait = (cup, text, target) => prompts.push({ id: `wait-${cup.id}`, text, cup: cup.id, target });
  const spoutNo = (slot) => slot.replace(/.*spout/, '');

  const cups = [...world.cups.values()].sort((a, b) => b.createdAt - a.createdAt);
  for (const cup of cups) {
    const slot = cup.slot ?? '';
    const [unit, place] = slot.split(':');
    const dev = platform.devices[unit];
    const kind = dev?.constructor.type;
    const label = cup.type === 'ice' ? 'ICE' : 'HOT';

    if (kind === 'cup-dispenser') {
      const spout = blinkingSpout();
      const tray = freeIceTray();
      if (cup.type === 'ice' && tray && cup.contents.ice === 0) move(cup, tray, `${label} 컵을 꺼내 제빙기에 대 주세요 (얼음 받는 곳)`);
      else if (spout) move(cup, spout, `${label} 컵을 꺼내 ${spoutNo(spout)}번 투출구에 놓아 주세요`);
      else wait(cup, `${label} 컵이 나왔습니다. 잠시 기다려 주세요`, slot);
    } else if (kind === 'ice-maker') {
      if (dev.dispensing) wait(cup, '얼음이 나오는 중입니다. 컵을 떼지 마세요', slot);
      else if (dev.armed) wait(cup, '출빙 준비 중...', slot);
      else {
        const spout = blinkingSpout();
        if (spout) move(cup, spout, `얼음을 받았습니다. ${spoutNo(spout)}번 투출구에 컵을 놓아 주세요`);
        else if (cup.contents.ice > 0) wait(cup, '얼음 완료 - 커피머신의 투출구 안내를 기다려 주세요', slot);
        else wait(cup, '출빙 명령을 기다리는 중...', slot);
      }
    } else if (kind === 'mailbean-mainboard') {
      const n = Number(place.replace('spout', ''));
      const lamp = dev.lamps[n - 1];
      const busy = dev.ops.size > 0;
      const poured = (cup.poured[slot] ?? 0) > 5;
      const released = lamp === 0 || (lamp === 2 && !dev.cupSensorUse);
      if (busy) wait(cup, `${n}번 투출구에서 음료를 추출하고 있습니다`, slot);
      else if (poured && released) move(cup, 'pickup', '음료가 완성되었습니다. 컵을 가져가세요');
      else wait(cup, '음료 추출을 준비하고 있습니다', slot);
    } else if (slot === 'pickup') {
      prompts.push({ id: `serve-${cup.id}`, text: '맛있게 드세요! (컵을 치우려면 클릭)', cup: cup.id, target: 'pickup', action: { type: 'serveCup', cup: cup.id } });
    }
  }

  if (!cups.length) {
    for (const ice of ices) if (ice.armed) prompts.push({ id: 'ice-no-cup', text: '제빙기가 출빙 대기 중입니다. 컵(또는 텀블러)을 대 주세요', target: ice.slot });
    const spout = blinkingSpout();
    if (spout) prompts.push({ id: 'spout-no-cup', text: `${spoutNo(spout)}번 투출구에 컵을 놓아 주세요`, target: spout });
    for (const c of cupDevs) if (c.ops.length) prompts.push({ id: 'cup-dropping', text: '컵이 나오고 있습니다...', target: `${c.key}:${c.ops[0].type}` });
  }
  return prompts;
}
