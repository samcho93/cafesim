import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { textTexture, grateTexture, iceInstructionTexture, cupFrontTexture } from './textures.js';

/**
 * Procedural models of the units in the photo. Each builder returns
 *   { group, slots: { name: Vector3 (local) }, pickables: [{ object, id }], shells: Mesh[], update(dev, t), anchors }
 * Units are built facing +Z with the counter top at y = 0 and the unit centred on x = 0.
 */

const M = {
  white: new THREE.MeshStandardMaterial({ color: 0xf4f4f1, roughness: 0.45, metalness: 0.02 }),
  whiteSoft: new THREE.MeshStandardMaterial({ color: 0xe9e9e5, roughness: 0.6 }),
  steel: new THREE.MeshStandardMaterial({ color: 0xc9ced3, roughness: 0.28, metalness: 0.85 }),
  steelDark: new THREE.MeshStandardMaterial({ color: 0x8e959b, roughness: 0.35, metalness: 0.8 }),
  black: new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.4, metalness: 0.1 }),
  glassDark: new THREE.MeshStandardMaterial({ color: 0x1b2128, roughness: 0.08, metalness: 0.3, transparent: true, opacity: 0.82 }),
  grey: new THREE.MeshStandardMaterial({ color: 0x6f757b, roughness: 0.5, metalness: 0.4 }),
  rubber: new THREE.MeshStandardMaterial({ color: 0x2a2c2f, roughness: 0.9 }),
};

const box = (w, h, d, mat, r = 0) => new THREE.Mesh(r ? new RoundedBoxGeometry(w, h, d, 3, r) : new THREE.BoxGeometry(w, h, d), mat);
const cyl = (rt, rb, h, mat, seg = 32) => new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat);
const at = (mesh, x, y, z) => (mesh.position.set(x, y, z), mesh);
const plane = (w, h, map, opts = {}) => new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map, roughness: 0.5, transparent: !!opts.transparent, ...opts }));

function shellMaterial(mat) {
  // every unit gets its own copy so the x-ray toggle can fade it
  const m = mat.clone();
  m.userData.baseOpacity = m.opacity;
  return m;
}

function emissive(color, intensity = 0) {
  return new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: intensity, roughness: 0.4 });
}

// ============================================================================ coffee machine (M400)
export function buildMainMachine({ spouts = 3 } = {}) {
  const g = new THREE.Group();
  const W = 0.64;
  const D = 0.54;
  const front = D / 2;
  const shellW = shellMaterial(M.white);
  const shells = [];
  const add = (m, shell = false) => (g.add(m), shell && shells.push(m), m);

  // feet + base
  for (const [x, z] of [[-0.27, 0.2], [0.27, 0.2], [-0.27, -0.2], [0.27, -0.2]]) add(at(cyl(0.018, 0.022, 0.018, M.grey), x, 0.009, z));
  add(at(box(W, 0.07, D, shellW, 0.012), 0, 0.053, 0), true);
  // drip tray + grate
  const tray = add(at(box(W - 0.06, 0.022, 0.2, M.whiteSoft, 0.006), 0, 0.098, front - 0.1));
  const grate = add(at(plane(W - 0.08, 0.18, grateTexture()), 0, 0.11, front - 0.1));
  grate.rotation.x = -Math.PI / 2;
  // lower bay: side walls, stainless back
  add(at(box(0.04, 0.27, D, shellW, 0.008), -W / 2 + 0.02, 0.225, 0), true);
  add(at(box(0.04, 0.27, D, shellW, 0.008), W / 2 - 0.02, 0.225, 0), true);
  add(at(box(W - 0.08, 0.27, 0.02, M.steel), 0, 0.225, front - 0.24));
  // head
  add(at(box(W, 0.37, D, shellW, 0.02), 0, 0.545, 0), true);
  add(at(box(W - 0.02, 0.012, D - 0.04, M.whiteSoft), 0, 0.356, 0.005));

  // touch screen bezel (the kiosk iframe is placed on `anchors.screen` by the stage)
  add(at(box(0.52, 0.31, 0.012, M.black, 0.01), 0, 0.555, front + 0.004));
  const screenSize = { w: 0.475, h: 0.278 };
  const anchors = { screen: new THREE.Vector3(0, 0.555, front + 0.0105), screenSize };

  // card reader under the screen (right)
  const reader = add(at(box(0.11, 0.035, 0.03, M.whiteSoft, 0.006), 0.17, 0.378, front + 0.01));
  const readerSlot = add(at(box(0.08, 0.004, 0.005, M.black), 0.17, 0.385, front + 0.026));
  const readerLed = add(at(box(0.07, 0.006, 0.004, emissive(0x2f80ff, 0.2)), 0.17, 0.372, front + 0.026));
  const card = add(at(box(0.054, 0.002, 0.085, new THREE.MeshStandardMaterial({ color: 0x2a4f9e, metalness: 0.3, roughness: 0.3 })), 0.17, 0.386, front + 0.06));
  card.visible = false;
  readerSlot.userData.id = reader.userData.id = 'card';

  // outlets
  const spoutX = [-0.18, 0, 0.18].slice(0, spouts);
  const lamps = [];
  const slots = {};
  const spoutTops = [];
  spoutX.forEach((x, i) => {
    add(at(cyl(0.036, 0.03, 0.05, M.steel), x, 0.33, front - 0.1));
    add(at(cyl(0.012, 0.012, 0.012, M.black, 16), x, 0.302, front - 0.1));
    const lamp = add(at(new THREE.Mesh(new THREE.TorusGeometry(0.034, 0.004, 8, 32), emissive(0xffffff, 0)), x, 0.306, front - 0.1));
    lamp.rotation.x = Math.PI / 2;
    lamps.push(lamp);
    const label = add(at(plane(0.04, 0.03, textTexture(64, 48, [{ text: String(i + 1), size: 34, color: '#7a8086', y: 24 }]), { transparent: true }), x, 0.335, front + 0.0015));
    label.material.depthWrite = false;
    slots[`spout${i + 1}`] = new THREE.Vector3(x, 0.109, front - 0.1);
    spoutTops.push(new THREE.Vector3(x, 0.298, front - 0.1));
  });

  // bean hoppers on top
  const hoppers = [-0.2, -0.04].map((x) => {
    const h = add(at(box(0.15, 0.09, 0.17, M.black, 0.01), x, 0.775, -0.1));
    add(at(box(0.152, 0.012, 0.172, M.glassDark), x, 0.825, -0.1));
    return h;
  });

  // ------------------------------------------------ internals (visible in x-ray mode)
  const internals = new THREE.Group();
  g.add(internals);
  const grinders = [-0.2, -0.04].map((x) => at(cyl(0.035, 0.035, 0.07, M.steelDark), x, 0.68, -0.1));
  grinders.forEach((m) => internals.add(m));
  const brewBody = at(cyl(0.045, 0.045, 0.16, new THREE.MeshStandardMaterial({ color: 0x7c6a58, roughness: 0.6, transparent: true, opacity: 0.8 })), -0.1, 0.5, 0.0);
  const piston = at(cyl(0.04, 0.04, 0.03, M.steel), -0.1, 0.45, 0.0);
  const grounds = at(cyl(0.038, 0.038, 0.02, new THREE.MeshStandardMaterial({ color: 0x3a2516 })), -0.1, 0.44, 0.0);
  internals.add(brewBody, piston, grounds);
  const boilerCoffee = at(cyl(0.05, 0.05, 0.14, emissive(0xb33a1e, 0)), 0.12, 0.47, -0.08);
  const boilerWater = at(cyl(0.05, 0.05, 0.15, emissive(0xb33a1e, 0)), 0.235, 0.47, -0.08);
  internals.add(boilerCoffee, boilerWater);
  const pump = at(box(0.08, 0.06, 0.06, emissive(0x3c7bd9, 0)), 0.05, 0.41, -0.18);
  internals.add(pump);
  const canColors = [0xefe6d6, 0x5a3522, 0x7d9b4f, 0xd98b4a, 0xbfa48a, 0xe2d6c1];
  const canisters = canColors.map((c, i) => {
    const m = at(box(0.07, 0.11, 0.09, new THREE.MeshStandardMaterial({ color: c, transparent: true, opacity: 0.9 })), -0.24 + i * 0.075, 0.6, 0.15);
    internals.add(m);
    return m;
  });
  const mixers = canisters.map((cMesh, i) => {
    const m = at(cyl(0.022, 0.016, 0.035, M.steelDark, 16), cMesh.position.x, 0.52, 0.18);
    internals.add(m);
    return m;
  });
  internals.visible = false;

  const brewY = { upper: 0.52, middle: 0.47, lower: 0.43 };

  // collision boxes (local, [min, max]); the outlet bay between the side walls stays free
  const obstacles = [
    ['본체 하부', [-W / 2, 0, -D / 2], [W / 2, 0.088, D / 2]],
    ['드립 트레이', [-W / 2 + 0.03, 0.088, front - 0.2], [W / 2 - 0.03, 0.109, front]],
    ['좌측 벽', [-W / 2, 0.088, -D / 2], [-W / 2 + 0.04, 0.36, D / 2]],
    ['우측 벽', [W / 2 - 0.04, 0.088, -D / 2], [W / 2, 0.36, D / 2]],
    ['투출부 뒷판', [-W / 2, 0.088, -D / 2], [W / 2, 0.36, front - 0.235]],
    ['헤드', [-W / 2, 0.356, -D / 2], [W / 2, 0.73, front + 0.015]],
    ['원두통', [-0.28, 0.73, -0.19], [0.04, 0.83, -0.01]],
    ['카드 단말기', [0.11, 0.36, front], [0.23, 0.4, front + 0.03]],
    ...spoutX.map((x, i) => [`투출구${i + 1}`, [x - 0.037, 0.297, front - 0.137], [x + 0.037, 0.36, front - 0.063]]),
  ].map(([name, min, max]) => ({ name: `커피머신 ${name}`, min, max }));

  return {
    group: g,
    slots,
    shells,
    obstacles,
    anchors: { ...anchors, spoutTops, card: new THREE.Vector3(0.17, 0.386, front + 0.03) },
    pickables: [
      { object: reader, id: 'card' },
      { object: readerSlot, id: 'card' },
      { object: card, id: 'card' },
    ],
    xray(on) {
      internals.visible = on;
    },
    update(dev, pay, t) {
      if (!dev) return;
      dev.lamps.forEach((v, i) => {
        const m = lamps[i]?.material;
        if (!m) return;
        const on = v === 1 || (v === 2 && Math.sin(t * 9) > 0);
        m.emissiveIntensity = on ? 2.4 : 0;
        m.color.set(on ? 0x9fe7ff : 0x55595e);
        m.emissive.set(v === 2 ? 0x55ccff : 0xffffff);
      });
      grinders.forEach((m, i) => {
        const on = dev.actuators.includes(`grinder${i + 1}`);
        m.rotation.y += on ? 0.6 : 0;
        hoppers[i].position.x = (i ? -0.04 : -0.2) + (on ? Math.sin(t * 80) * 0.0015 : 0);
      });
      piston.position.y = THREE.MathUtils.lerp(piston.position.y, brewY[dev.brew.position] ?? 0.47, 0.15);
      grounds.position.y = piston.position.y - 0.025;
      grounds.visible = dev.brew.grounds > 0.5;
      const heat = (name, mesh) => (mesh.material.emissiveIntensity = dev.actuators.includes(name) ? 0.8 + Math.sin(t * 6) * 0.3 : 0.05);
      heat('coffeeHeater', boilerCoffee);
      heat('hotWaterHeater', boilerWater);
      pump.material.emissiveIntensity = dev.actuators.includes('mainPump') ? 1.2 : 0;
      mixers.forEach((m, i) => (m.rotation.y += dev.actuators.includes(`mixer${i + 1}`) ? 0.8 : 0));
      canisters.forEach((m, i) => (m.scale.y = Math.max(0.05, (dev.stock.powder[i] ?? 0) / 800)));
      if (pay) {
        const waiting = !!pay.pending && pay.card !== 'inserted';
        readerLed.material.emissiveIntensity = waiting ? (Math.sin(t * 10) > 0 ? 3 : 0.2) : 0.3;
        card.visible = pay.card === 'inserted';
      }
    },
  };
}

// ============================================================================ ice dispenser
export function buildIceDispenser() {
  const g = new THREE.Group();
  const W = 0.3;
  const D = 0.46;
  const front = D / 2;
  const shell = shellMaterial(M.white);
  const shells = [];
  const add = (m, s = false) => (g.add(m), s && shells.push(m), m);

  for (const [x, z] of [[-0.12, 0.18], [0.12, 0.18], [-0.12, -0.18], [0.12, -0.18]]) add(at(cyl(0.015, 0.018, 0.02, M.grey), x, 0.01, z));
  add(at(box(W, 0.05, D, shell, 0.008), 0, 0.045, 0), true);
  add(at(box(W - 0.04, 0.018, 0.16, M.steel, 0.004), 0, 0.078, front - 0.09));
  const grate = add(at(plane(W - 0.06, 0.14, grateTexture()), 0, 0.088, front - 0.09));
  grate.rotation.x = -Math.PI / 2;
  add(at(box(0.025, 0.24, D, shell, 0.006), -W / 2 + 0.0125, 0.19, 0), true);
  add(at(box(0.025, 0.24, D, shell, 0.006), W / 2 - 0.0125, 0.19, 0), true);
  add(at(box(W - 0.05, 0.24, 0.015, M.steel), 0, 0.19, front - 0.2));
  add(at(box(W, 0.44, D, shell, 0.012), 0, 0.53, 0), true);
  const panel = add(at(plane(W - 0.03, 0.4, iceInstructionTexture()), 0, 0.53, front + 0.001));
  panel.material.roughness = 0.6;
  // nozzle + lever
  add(at(box(0.1, 0.05, 0.08, M.steel, 0.008), 0, 0.29, front - 0.09));
  add(at(cyl(0.02, 0.016, 0.03, M.steelDark), 0, 0.255, front - 0.09));
  const lever = new THREE.Group();
  lever.position.set(0, 0.27, front - 0.13);
  const paddle = at(box(0.014, 0.12, 0.008, M.steelDark, 0.003), 0, -0.06, 0);
  paddle.add(at(box(0.04, 0.02, 0.01, M.steelDark, 0.004), 0, -0.055, 0.004));
  lever.add(paddle);
  g.add(lever);
  const push = add(at(plane(0.12, 0.05, textTexture(240, 100, [{ text: 'PUSH', size: 30, color: '#fff', y: 34 }, { text: '컵을 눌러주세요', size: 22, color: '#ddd', y: 72, weight: 500 }], { bg: '#2b2f33' })), 0, 0.2, front - 0.2 + 0.009));
  push.material.roughness = 0.4;
  const led = add(at(box(0.03, 0.006, 0.004, emissive(0x39d353, 1)), W / 2 - 0.04, 0.73, front + 0.002));

  const obstacles = [
    ['하부', [-W / 2, 0, -D / 2], [W / 2, 0.069, D / 2]],
    ['트레이', [-W / 2 + 0.02, 0.069, front - 0.17], [W / 2 - 0.02, 0.087, front - 0.01]],
    ['좌측 벽', [-W / 2, 0.07, -D / 2], [-W / 2 + 0.025, 0.31, D / 2]],
    ['우측 벽', [W / 2 - 0.025, 0.07, -D / 2], [W / 2, 0.31, D / 2]],
    ['뒷판', [-W / 2, 0.07, -D / 2], [W / 2, 0.31, front - 0.195]],
    ['상부', [-W / 2, 0.31, -D / 2], [W / 2, 0.75, D / 2]],
    ['노즐', [-0.05, 0.24, front - 0.13], [0.05, 0.315, front - 0.05]],
  ].map(([name, min, max]) => ({ name: `제빙기 ${name}`, min, max }));

  return {
    group: g,
    shells,
    obstacles,
    slots: { tray: new THREE.Vector3(0, 0.088, front - 0.09) },
    anchors: { nozzle: new THREE.Vector3(0, 0.24, front - 0.09) },
    pickables: [{ object: paddle, id: 'lever' }],
    xray() {},
    update(dev, _p, t) {
      if (!dev) return;
      lever.rotation.x = THREE.MathUtils.lerp(lever.rotation.x, dev.lever ? -0.32 : 0, 0.2);
      led.material.emissive.set(dev.error ? 0xff3b30 : dev.armed ? 0xffc400 : 0x39d353);
      led.material.emissiveIntensity = dev.armed ? (Math.sin(t * 8) > 0 ? 2 : 0.3) : 1.2;
    },
  };
}

// ============================================================================ cup dispenser
export function buildCupDispenser() {
  const g = new THREE.Group();
  const W = 0.4;
  const D = 0.46;
  const H = 0.82;
  const front = D / 2;
  const shell = shellMaterial(M.white);
  const shells = [];
  const add = (m, s = false) => (g.add(m), s && shells.push(m), m);

  add(at(box(W, H, D, shell, 0.012), 0, H / 2, 0), true);
  const face = add(at(plane(W - 0.02, H - 0.24, cupFrontTexture()), 0, H / 2 + 0.11, front + 0.001));
  face.material.roughness = 0.55;
  add(at(plane(0.12, 0.022, textTexture(256, 48, [{ text: '컵 디스펜서', size: 26, color: '#fff', y: 24 }], { bg: '#111' })), 0.02, H - 0.08, front + 0.002));
  add(at(box(0.028, 0.08, 0.02, M.grey, 0.008), -W / 2 + 0.06, 0.5, front + 0.01));
  add(at(cyl(0.008, 0.008, 0.012, M.steel), -W / 2 + 0.06, 0.52, front + 0.022)).rotation.x = Math.PI / 2;

  // output windows (HOT left, ICE right)
  const slots = {};
  const flaps = {};
  const stacks = {};
  for (const [type, x] of [['hot', -0.095], ['ice', 0.095]]) {
    add(at(box(0.16, 0.19, 0.16, M.black), x, 0.115, front - 0.075));
    add(at(box(0.17, 0.006, 0.17, M.steelDark), x, 0.02, front - 0.075));
    const flap = new THREE.Group();
    flap.position.set(x, 0.205, front + 0.003);
    flap.add(at(box(0.155, 0.18, 0.006, M.glassDark, 0.003), 0, -0.09, 0));
    g.add(flap);
    flaps[type] = flap;
    slots[type] = new THREE.Vector3(x, 0.024, front - 0.06);
    // internal cup stacks (x-ray)
    const stack = new THREE.Group();
    for (let i = 0; i < 18; i++) {
      const c = at(cyl(type === 'ice' ? 0.046 : 0.04, type === 'ice' ? 0.034 : 0.03, 0.06, new THREE.MeshStandardMaterial({ color: type === 'ice' ? 0xdfeaf3 : 0xf3efe8, transparent: true, opacity: 0.8 })), 0, 0.25 + i * 0.022, 0);
      stack.add(c);
    }
    stack.position.set(x, 0, -0.04);
    stack.visible = false;
    g.add(stack);
    stacks[type] = stack;
  }

  // the two output windows (x ±0.015..±0.175, y 0.02..0.205, 0.155 deep) stay free
  const obstacles = [
    ['상부', [-W / 2, 0.205, -D / 2], [W / 2, H, front + 0.005]],
    ['하부', [-W / 2, 0, -D / 2], [W / 2, 0.02, D / 2]],
    ['가운데 칸막이', [-0.015, 0.02, -D / 2], [0.015, 0.205, front + 0.005]],
    ['좌측 벽', [-W / 2, 0.02, -D / 2], [-0.175, 0.205, front + 0.005]],
    ['우측 벽', [0.175, 0.02, -D / 2], [W / 2, 0.205, front + 0.005]],
    ['출구 안쪽', [-W / 2, 0.02, -D / 2], [W / 2, 0.205, front - 0.155]],
  ].map(([name, min, max]) => ({ name: `컵 디스펜서 ${name}`, min, max }));

  return {
    group: g,
    shells,
    slots,
    obstacles,
    anchors: {},
    pickables: [],
    xray(on) {
      stacks.hot.visible = stacks.ice.visible = on;
    },
    update(dev, _p, t, world, key) {
      if (!dev) return;
      for (const type of ['hot', 'ice']) {
        const occupied = world?.slots?.[`${key}:${type}`];
        const dropping = dev.dropping.some((d) => d.type === type);
        flaps[type].rotation.x = THREE.MathUtils.lerp(flaps[type].rotation.x, occupied || dropping ? -1.2 : 0, 0.15);
        const n = Math.ceil((dev.stock[type] / 50) * 18);
        stacks[type].children.forEach((c, i) => (c.visible = i < n));
      }
    },
  };
}

export const MODEL_BUILDERS = {
  'm400-main': buildMainMachine,
  'ice-dispenser': buildIceDispenser,
  'cup-dispenser': buildCupDispenser,
};

/** Register a model for a new platform: registerModel('my-unit', (opts) => ({ group, slots, ... })) */
export function registerModel(name, builder) {
  MODEL_BUILDERS[name] = builder;
}
