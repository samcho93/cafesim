import * as THREE from 'three';

const FONT = '"Pretendard", "Noto Sans KR", "Malgun Gothic", system-ui, sans-serif';

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')];
}

function finish(c) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Text lines on a (transparent by default) canvas: [{ text, size, weight, color, y }] */
export function textTexture(w, h, lines, { bg = null, align = 'center' } = {}) {
  const [c, g] = canvas(w, h);
  if (bg) {
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
  }
  for (const l of lines) {
    g.font = `${l.weight ?? 700} ${l.size}px ${FONT}`;
    g.fillStyle = l.color ?? '#222';
    g.textAlign = l.align ?? align;
    g.textBaseline = 'middle';
    g.fillText(l.text, l.x ?? (align === 'center' ? w / 2 : 20), l.y);
  }
  return finish(c);
}

/** Vertical wooden slats of the counter cabinets. */
export function woodTexture() {
  const [c, g] = canvas(1024, 512);
  const grad = g.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0, '#c4936a');
  grad.addColorStop(1, '#b07f57');
  g.fillStyle = grad;
  g.fillRect(0, 0, 1024, 512);
  for (let x = 0; x < 1024; x += 16) {
    g.fillStyle = 'rgba(70,40,20,0.35)';
    g.fillRect(x, 0, 3, 512);
    g.fillStyle = 'rgba(255,230,200,0.12)';
    g.fillRect(x + 4, 0, 5, 512);
  }
  for (let i = 0; i < 400; i++) {
    g.fillStyle = `rgba(90,55,30,${Math.random() * 0.08})`;
    g.fillRect(Math.random() * 1024, Math.random() * 512, 1, 20 + Math.random() * 60);
  }
  const t = finish(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** Drip tray grate. */
export function grateTexture() {
  const [c, g] = canvas(256, 64);
  g.fillStyle = '#d9dcdf';
  g.fillRect(0, 0, 256, 64);
  g.fillStyle = '#7d8388';
  for (let x = 6; x < 256; x += 12) g.fillRect(x, 8, 5, 48);
  return finish(c);
}

/** Ice dispenser instruction panel (usage steps + "얼음 받는 곳"). */
export function iceInstructionTexture() {
  const [c, g] = canvas(512, 760);
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 512, 760);
  g.fillStyle = '#d6332b';
  g.font = `900 40px ${FONT}`;
  g.textAlign = 'center';
  g.fillText('SELF CAFE', 256, 70);
  g.fillStyle = '#333';
  g.font = `700 24px ${FONT}`;
  g.fillText('무인카페 이용방법', 256, 110);
  const steps = ['메뉴 선택', '결제', '컵 받기', '얼음 받기', '음료 받기', '완성'];
  steps.forEach((s, i) => {
    const x = 100 + (i % 3) * 156;
    const y = 180 + Math.floor(i / 3) * 140;
    g.strokeStyle = '#d6332b';
    g.lineWidth = 3;
    g.beginPath();
    g.arc(x, y, 34, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = '#d6332b';
    g.font = `800 26px ${FONT}`;
    g.fillText(String(i + 1), x, y + 9);
    g.fillStyle = '#444';
    g.font = `600 20px ${FONT}`;
    g.fillText(s, x, y + 64);
  });
  g.fillStyle = '#111';
  g.font = `900 64px ${FONT}`;
  g.fillText('얼음 받는 곳', 256, 560);
  g.fillStyle = '#555';
  g.font = `600 20px ${FONT}`;
  g.fillText('얼음이 다 나올 때까지 컵을 떼지 말아 주세요.', 256, 720);
  return finish(c);
}

/** Cup dispenser front ("컵 나오는 곳", HOT/ICE markers). */
export function cupFrontTexture() {
  const [c, g] = canvas(600, 1100);
  g.fillStyle = '#f7f7f5';
  g.fillRect(0, 0, 600, 1100);
  g.textAlign = 'center';
  g.fillStyle = '#111';
  g.font = `900 72px ${FONT}`;
  g.fillText('컵 나오는 곳', 300, 330);
  g.fillStyle = '#555';
  g.font = `600 24px ${FONT}`;
  g.fillText('결제 후 컵이 자동으로 나옵니다.', 300, 640);
  const pin = (x, color, label) => {
    g.fillStyle = '#222';
    g.font = `800 34px ${FONT}`;
    g.fillText(`${label} 컵`, x, 720);
    g.fillStyle = color;
    g.beginPath();
    g.arc(x, 775, 26, Math.PI, 0);
    g.lineTo(x, 830);
    g.closePath();
    g.fill();
    g.fillStyle = '#fff';
    g.font = `800 13px ${FONT}`;
    g.fillText(label, x, 778);
  };
  pin(165, '#d23a2c', 'HOT');
  pin(435, '#1f2b55', 'ICE');
  return finish(c);
}

export function screenPlaceholderTexture(text = '키오스크 로딩 중...') {
  return textTexture(1024, 600, [{ text, size: 44, color: '#9aa3ad', y: 300 }], { bg: '#0d1117' });
}
