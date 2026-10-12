import * as THREE from 'three';

const COLORS = {
  coffee: new THREE.Color('#3b2416'),
  water: new THREE.Color('#cfe6f2'),
  milk: new THREE.Color('#f1ebe0'),
  powder: { 1: new THREE.Color('#efe6d6'), 2: new THREE.Color('#5a3522'), 3: new THREE.Color('#7d9b4f'), 4: new THREE.Color('#d98b4a'), 5: new THREE.Color('#bfa48a'), 6: new THREE.Color('#e2d6c1') },
  ade: { 1: new THREE.Color('#f1e2b8'), 2: new THREE.Color('#ead54a'), 3: new THREE.Color('#e5645a') },
};
export const KIND_COLOR = (kind, sub) => (sub != null ? COLORS[kind]?.[sub] : COLORS[kind]) ?? COLORS.water;

const DIM = {
  hot: { h: 0.105, rt: 0.04, rb: 0.03 },
  ice: { h: 0.13, rt: 0.047, rb: 0.034 },
};

/** Liquid colour + fill level from the cup contents. */
function mix(contents) {
  const parts = [['coffee', null, contents.coffee], ['water', null, contents.water], ['milk', null, contents.milk]];
  for (const [k, v] of Object.entries(contents.powder ?? {})) parts.push(['powder', k, v]);
  for (const [k, v] of Object.entries(contents.ade ?? {})) parts.push(['ade', k, v * 3]); // syrups are strong
  const total = parts.reduce((a, p) => a + p[2], 0);
  const color = new THREE.Color(0, 0, 0);
  if (!total) return { color: COLORS.water, opacity: 0, volume: 0 };
  let tint = 0;
  for (const [k, s, v] of parts) {
    color.add(KIND_COLOR(k, s).clone().multiplyScalar(v / total));
    if (k !== 'water') tint += v / total;
  }
  const volume = contents.coffee + contents.water + contents.milk + Object.values(contents.powder ?? {}).reduce((a, b) => a + b, 0) + Object.values(contents.ade ?? {}).reduce((a, b) => a + b, 0);
  return { color, opacity: 0.35 + Math.min(0.6, tint * 1.6), volume };
}

class CupView {
  constructor(cup, scene) {
    const d = DIM[cup.type] ?? DIM.hot;
    this.dim = d;
    this.group = new THREE.Group();
    this.group.userData.cupId = cup.id;
    const wallMat =
      cup.type === 'ice'
        ? new THREE.MeshStandardMaterial({ color: 0xeaf4fb, transparent: true, opacity: 0.28, roughness: 0.05, metalness: 0.1, side: THREE.DoubleSide, depthWrite: false })
        : new THREE.MeshStandardMaterial({ color: 0xfaf8f4, roughness: 0.7, side: THREE.DoubleSide });
    const wall = new THREE.Mesh(new THREE.CylinderGeometry(d.rt, d.rb, d.h, 32, 1, true), wallMat);
    wall.position.y = d.h / 2;
    const bottom = new THREE.Mesh(new THREE.CircleGeometry(d.rb, 24), wallMat);
    bottom.rotation.x = -Math.PI / 2;
    bottom.position.y = 0.001;
    const rim = new THREE.Mesh(new THREE.TorusGeometry(d.rt, 0.0025, 6, 32), new THREE.MeshStandardMaterial({ color: cup.type === 'ice' ? 0xdfe9f0 : 0xffffff }));
    rim.rotation.x = Math.PI / 2;
    rim.position.y = d.h;
    this.group.add(wall, bottom, rim);
    if (cup.type === 'hot') {
      const band = new THREE.Mesh(new THREE.CylinderGeometry(d.rt * 0.93, d.rb * 1.12, d.h * 0.36, 32, 1, true), new THREE.MeshStandardMaterial({ color: 0xc8372b, roughness: 0.6, side: THREE.DoubleSide }));
      band.position.y = d.h * 0.48;
      band.scale.setScalar(1.012);
      this.group.add(band);
    }
    this.liquid = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 28), new THREE.MeshStandardMaterial({ color: 0x3b2416, transparent: true, opacity: 0.9, roughness: 0.15 }));
    this.liquid.visible = false;
    this.group.add(this.liquid);
    this.ice = new THREE.InstancedMesh(new THREE.BoxGeometry(0.018, 0.018, 0.018), new THREE.MeshStandardMaterial({ color: 0xeef8ff, transparent: true, opacity: 0.75, roughness: 0.05 }), 30);
    this.ice.count = 0;
    this.iceSeed = Array.from({ length: 30 }, () => [Math.random(), Math.random(), Math.random() * Math.PI]);
    this.group.add(this.ice);
    // selection glow
    this.halo = new THREE.Mesh(new THREE.RingGeometry(d.rt * 1.15, d.rt * 1.45, 32), new THREE.MeshBasicMaterial({ color: 0x2f9bff, transparent: true, opacity: 0.85, side: THREE.DoubleSide }));
    this.halo.rotation.x = -Math.PI / 2;
    this.halo.position.y = 0.002;
    this.halo.visible = false;
    this.group.add(this.halo);
    this.group.traverse((o) => (o.userData.cupId = cup.id));
    scene.add(this.group);
    this.anim = null;
  }

  setContents(cup) {
    const d = this.dim;
    const capacity = cup.capacity ?? 400;
    const { color, opacity, volume } = mix(cup.contents);
    const iceCount = Math.min(30, Math.round(cup.contents.ice ?? 0));
    const fill = Math.min(0.96, (volume + iceCount * 6) / capacity);
    const h = Math.max(0.001, fill * d.h);
    this.liquid.visible = volume > 1;
    const r = d.rb + (d.rt - d.rb) * (fill * 0.9);
    this.liquid.scale.set(r * 0.96, h, r * 0.96);
    this.liquid.position.y = h / 2 + 0.002;
    this.liquid.material.color.copy(color);
    this.liquid.material.opacity = opacity;
    // ice cubes stacked from the bottom
    this.ice.count = iceCount;
    const m = new THREE.Matrix4();
    for (let i = 0; i < iceCount; i++) {
      const [a, b, rot] = this.iceSeed[i];
      const layer = Math.floor(i / 5);
      const y = 0.012 + layer * 0.017;
      const rr = d.rb * 0.55 * Math.sqrt(a);
      m.makeRotationY(rot);
      m.setPosition(Math.cos(b * Math.PI * 2) * rr, Math.min(y, d.h - 0.01), Math.sin(b * Math.PI * 2) * rr);
      this.ice.setMatrixAt(i, m);
    }
    this.ice.instanceMatrix.needsUpdate = true;
  }

  moveTo(target, { drop = false, duration = 0.65 } = {}) {
    const from = this.group.position.clone();
    if (drop) from.copy(target).add(new THREE.Vector3(0, 0.16, -0.02));
    this.anim = { from, to: target.clone(), t: 0, duration, arc: drop ? 0 : 0.16 };
    if (drop) this.group.position.copy(from);
  }

  tick(dt) {
    if (!this.anim) return;
    const a = this.anim;
    a.t = Math.min(1, a.t + dt / a.duration);
    const e = a.t < 0.5 ? 2 * a.t * a.t : 1 - Math.pow(-2 * a.t + 2, 2) / 2;
    this.group.position.lerpVectors(a.from, a.to, e);
    this.group.position.y += Math.sin(Math.PI * a.t) * a.arc;
    if (a.t >= 1) this.anim = null;
  }

  dispose(scene) {
    scene.remove(this.group);
  }
}

export class CupLayer {
  views = new Map();

  constructor(scene, slotPosition) {
    this.scene = scene;
    this.slotPosition = slotPosition; // (slotName) => Vector3 | null
  }

  sync(world) {
    const seen = new Set();
    for (const cup of world.cups) {
      seen.add(cup.id);
      let v = this.views.get(cup.id);
      const target = this.slotPosition(cup.slot);
      if (!v) {
        v = new CupView(cup, this.scene);
        this.views.set(cup.id, v);
        if (target) v.moveTo(target, { drop: cup.slot?.startsWith('cup') || true, duration: 0.5 });
        v.slot = cup.slot;
      } else if (cup.slot !== v.slot && target) {
        v.moveTo(target);
        v.slot = cup.slot;
      }
      v.setContents(cup);
    }
    for (const [id, v] of this.views) {
      if (!seen.has(id)) {
        v.dispose(this.scene);
        this.views.delete(id);
      }
    }
  }

  select(id) {
    for (const [cid, v] of this.views) v.halo.visible = cid === id;
  }

  tick(dt) {
    for (const v of this.views.values()) v.tick(dt);
  }

  topOf(slot) {
    for (const v of this.views.values()) if (v.slot === slot) return v.group.position.y + v.dim.h;
    return null;
  }

  objects() {
    return [...this.views.values()].map((v) => v.group);
  }
}
