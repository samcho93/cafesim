import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS3DRenderer, CSS3DObject } from 'three/examples/jsm/renderers/CSS3DRenderer.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { MODEL_BUILDERS } from './models.js';
import { CupLayer, KIND_COLOR } from './cups.js';
import { woodTexture, textTexture } from './textures.js';

const SCREEN_PX = { w: 1024, h: 600 };

/**
 * The 3D stage: room, counter, units from `definition.layout`, cups, liquid streams,
 * guide markers, click interaction and the kiosk iframe on the machine's screen.
 */
export class Stage {
  constructor(container, { definition, link, kioskUrl, onAction, onToast }) {
    this.container = container;
    this.definition = definition;
    this.link = link;
    this.onAction = onAction;
    this.onToast = onToast ?? (() => {});
    this.units = [];
    this.slotPos = new Map();
    this.obstacles = []; // world AABBs for robot collision checking
    this.selected = null;
    this.snapshot = null;
    this.clock = new THREE.Clock();
    this.time = 0;

    // ---------------------------------------------------------------- renderers
    const w = container.clientWidth;
    const h = container.clientHeight;
    this.css = new CSS3DRenderer();
    this.css.setSize(w, h);
    this.css.domElement.className = 'stage-css';
    container.appendChild(this.css.domElement);

    this.gl = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.gl.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.gl.setSize(w, h);
    this.gl.shadowMap.enabled = true;
    this.gl.shadowMap.type = THREE.PCFSoftShadowMap;
    this.gl.toneMapping = THREE.ACESFilmicToneMapping;
    this.gl.toneMappingExposure = 1.05;
    this.gl.domElement.className = 'stage-gl';
    container.appendChild(this.gl.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xd9d3c9);
    const pmrem = new THREE.PMREMGenerator(this.gl);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    this.cssScene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, w / h, 0.01, 30);
    this.controls = new OrbitControls(this.camera, this.css.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.62;
    this.controls.minDistance = 0.25;
    this.controls.maxDistance = 4.5;

    this.#buildRoom();
    this.#buildUnits();
    this.#buildKiosk(kioskUrl);
    this.cups = new CupLayer(this.scene, (slot) => this.slotPos.get(slot) ?? null);
    this.#buildEffects();
    this.#buildMarkers();
    this.#bindPointer();
    this.view('overview', true);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.gl.setAnimationLoop(() => this.#frame());
  }

  // ==================================================================== construction
  #buildRoom() {
    const s = this.scene;
    s.add(new THREE.HemisphereLight(0xfff8ee, 0x8a7d6c, 0.7));
    const sun = new THREE.DirectionalLight(0xffffff, 1.3);
    sun.position.set(0.8, 2.4, 1.6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -1.6, right: 1.6, top: 1.6, bottom: -1, near: 0.5, far: 6 });
    sun.shadow.bias = -0.0004;
    s.add(sun);
    const fill = new THREE.PointLight(0xfff2e0, 0.6, 4);
    fill.position.set(-1.2, 1.2, 1.2);
    s.add(fill);

    const { width = 2.6, depth = 0.72 } = this.definition.layout?.counter ?? {};
    const top = new THREE.Mesh(new RoundedBoxGeometry(width, 0.04, depth, 2, 0.008), new THREE.MeshStandardMaterial({ color: 0xece7df, roughness: 0.55 }));
    top.position.set(0, -0.02, 0.06);
    top.receiveShadow = true;
    s.add(top);
    const wood = woodTexture();
    wood.repeat.set(width / 1.2, 1);
    const cab = new THREE.Mesh(new THREE.BoxGeometry(width - 0.04, 0.84, depth - 0.06), new THREE.MeshStandardMaterial({ map: wood, roughness: 0.7 }));
    cab.position.set(0, -0.46, 0.04);
    s.add(cab);
    for (let x = -width / 2 + width / 4; x < width / 2; x += width / 4) {
      const seam = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.84, 0.002), new THREE.MeshStandardMaterial({ color: 0x5a3b22 }));
      seam.position.set(x, -0.46, 0.04 + (depth - 0.06) / 2 + 0.001);
      s.add(seam);
    }
    const kick = new THREE.Mesh(new THREE.BoxGeometry(width - 0.04, 0.05, 0.01), new THREE.MeshStandardMaterial({ color: 0x3a3029 }));
    kick.position.set(0, -0.86, 0.36);
    s.add(kick);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(8, 6), new THREE.MeshStandardMaterial({ color: 0xbab3a8, roughness: 0.85 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.89;
    floor.receiveShadow = true;
    s.add(floor);
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(8, 4), new THREE.MeshStandardMaterial({ color: 0xd8d0c4, roughness: 0.95 }));
    wall.position.set(0, 1, -0.33);
    wall.receiveShadow = true;
    s.add(wall);

    // pickup area on the counter
    const p = this.definition.layout?.pickup ?? [-1.08, 0, 0.16];
    const pad = new THREE.Mesh(new THREE.CircleGeometry(0.075, 32), new THREE.MeshStandardMaterial({ color: 0xd8d1c6, roughness: 0.8 }));
    pad.rotation.x = -Math.PI / 2;
    pad.position.set(p[0], 0.001, p[2]);
    s.add(pad);
    const label = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.04), new THREE.MeshBasicMaterial({ map: textTexture(256, 64, [{ text: '픽업대', size: 30, color: '#6b6258', y: 32 }]), transparent: true }));
    label.rotation.x = -Math.PI / 2;
    label.position.set(p[0], 0.002, p[2] + 0.11);
    s.add(label);
    this.slotPos.set('pickup', new THREE.Vector3(p[0], 0.001, p[2]));
    this.obstacles.push({ name: '카운터', min: [-width / 2, -0.9, 0.06 - depth / 2], max: [width / 2, 0, 0.06 + depth / 2] }, { name: '벽', min: [-4, -1, -0.6], max: [4, 3, -0.33] });
    const table = this.definition.layout?.pickupTable;
    if (table) {
      // pickup table in front of the robot (robot cafe): the customer takes the drink here
      const [tw, td] = table.size ?? [0.6, 0.36];
      const wood = new THREE.MeshStandardMaterial({ color: 0xece7df, roughness: 0.5 });
      const topMesh = new THREE.Mesh(new RoundedBoxGeometry(tw, 0.035, td, 2, 0.008), wood);
      topMesh.position.set(p[0], -0.0175, p[2]);
      topMesh.castShadow = topMesh.receiveShadow = true;
      s.add(topMesh);
      const legMat = new THREE.MeshStandardMaterial({ color: 0x5b5148, metalness: 0.3, roughness: 0.5 });
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.85, 0.035), legMat);
        leg.position.set(p[0] + sx * (tw / 2 - 0.04), -0.46, p[2] + sz * (td / 2 - 0.04));
        leg.castShadow = true;
        s.add(leg);
      }
      this.obstacles.push({ name: '픽업 테이블', min: [p[0] - tw / 2, -0.9, p[2] - td / 2], max: [p[0] + tw / 2, 0, p[2] + td / 2] });
    }
    if (this.definition.layout?.pickupStand) {
      // free-standing pickup stand in front of the counter (robot cafe)
      const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.05, 0.89, 24), new THREE.MeshStandardMaterial({ color: 0x8a7a68, metalness: 0.2, roughness: 0.6 }));
      stand.position.set(p[0], -0.445, p[2]);
      const top = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.03, 40), new THREE.MeshStandardMaterial({ color: 0xece7df, roughness: 0.5 }));
      top.position.set(p[0], -0.015, p[2]);
      stand.castShadow = top.castShadow = top.receiveShadow = true;
      s.add(stand, top);
    }
  }

  #buildUnits() {
    for (const u of this.definition.layout?.units ?? []) {
      const devDef = this.definition.devices.find((d) => d.key === u.device);
      const builder = MODEL_BUILDERS[u.model] ?? genericModel(u, devDef);
      const model = builder(devDef?.options ?? {});
      model.group.position.set(...u.position);
      if (u.rotation) model.group.rotation.y = u.rotation;
      model.group.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });
      this.scene.add(model.group);
      model.group.updateMatrixWorld(true);
      for (const [name, v] of Object.entries(model.slots ?? {})) this.slotPos.set(`${u.device}:${name}`, model.group.localToWorld(v.clone()));
      if (u.payment && model.anchors?.card) this.slotPos.set(`${u.payment}:slot`, model.group.localToWorld(model.anchors.card.clone()));
      for (const p of model.pickables ?? []) p.object.userData.pick = { ...p, unit: u };
      for (const o of model.obstacles ?? []) {
        const at = (v) => v.map((x, i) => x + u.position[i]);
        this.obstacles.push({ name: o.name, min: at(o.min), max: at(o.max) });
      }
      this.units.push({ ...u, model });
    }
  }

  #buildKiosk(url) {
    const unit = this.units.find((u) => u.model.anchors?.screen);
    if (!unit || !url) return;
    const { screen, screenSize } = unit.model.anchors;
    const pos = unit.model.group.localToWorld(screen.clone());
    // transparent "hole" in the WebGL layer so the DOM iframe behind it shows through
    const hole = new THREE.Mesh(new THREE.PlaneGeometry(screenSize.w, screenSize.h), new THREE.MeshBasicMaterial({ color: 0x000000, opacity: 0, blending: THREE.NoBlending, side: THREE.DoubleSide }));
    hole.position.copy(pos);
    hole.rotation.y = unit.model.group.rotation.y;
    this.scene.add(hole);

    const iframe = document.createElement('iframe');
    iframe.src = url;
    iframe.className = 'kiosk-frame';
    iframe.style.width = `${SCREEN_PX.w}px`;
    iframe.style.height = `${SCREEN_PX.h}px`;
    iframe.setAttribute('allow', 'autoplay');
    this.kioskFrame = iframe;
    const obj = new CSS3DObject(iframe);
    obj.position.copy(pos);
    obj.rotation.y = unit.model.group.rotation.y;
    obj.scale.setScalar(screenSize.w / SCREEN_PX.w);
    this.cssScene.add(obj);
    this.screenUnit = unit;
  }

  #buildEffects() {
    this.streams = Array.from({ length: 6 }, () => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.006, 1, 10, 1, true), new THREE.MeshStandardMaterial({ color: 0x3b2416, transparent: true, opacity: 0.85, roughness: 0.1 }));
      m.visible = false;
      this.scene.add(m);
      return m;
    });
    this.iceBits = new THREE.InstancedMesh(new THREE.BoxGeometry(0.014, 0.014, 0.014), new THREE.MeshStandardMaterial({ color: 0xeef8ff, transparent: true, opacity: 0.8 }), 24);
    this.iceBits.count = 0;
    this.scene.add(this.iceBits);
    this.spills = new Map();
  }

  #buildMarkers() {
    const ringGeo = new THREE.RingGeometry(0.055, 0.07, 40);
    this.guideRing = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xff7a1a, transparent: true, side: THREE.DoubleSide, depthTest: false }));
    this.guideRing.rotation.x = -Math.PI / 2;
    this.guideRing.renderOrder = 10;
    this.guideRing.visible = false;
    this.guideArrow = new THREE.Mesh(new THREE.ConeGeometry(0.022, 0.05, 16), new THREE.MeshStandardMaterial({ color: 0xff7a1a, emissive: 0xff7a1a, emissiveIntensity: 0.6 }));
    this.guideArrow.rotation.x = Math.PI;
    this.guideArrow.visible = false;
    this.scene.add(this.guideRing, this.guideArrow);
    this.guideRing.userData.pick = { id: 'guide' };
    this.guideArrow.userData.pick = { id: 'guide' };

    // move targets shown while a cup is selected
    this.targetRings = new Map();
    for (const [slot, pos] of this.slotPos) {
      if (slot.endsWith(':slot')) continue;
      const r = new THREE.Mesh(new THREE.CircleGeometry(0.06, 32), new THREE.MeshBasicMaterial({ color: 0x2f9bff, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthTest: false }));
      r.rotation.x = -Math.PI / 2;
      r.position.copy(pos).add(new THREE.Vector3(0, 0.003, 0));
      r.renderOrder = 9;
      r.visible = false;
      r.userData.pick = { id: 'slot', slot };
      this.scene.add(r);
      this.targetRings.set(slot, r);
    }
  }

  // ==================================================================== interaction
  #bindPointer() {
    const el = this.css.domElement;
    let down = null;
    el.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
    el.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) return;
      this.#click(e);
    });
    el.addEventListener('pointermove', (e) => {
      const hit = this.#raycast(e);
      el.style.cursor = hit ? 'pointer' : 'grab';
    });
  }

  #raycast(e) {
    const r = this.css.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const targets = [...this.cups.objects(), this.guideRing, this.guideArrow, ...[...this.targetRings.values()].filter((m) => m.visible)];
    for (const u of this.units) for (const p of u.model.pickables ?? []) targets.push(p.object);
    const hits = ray.intersectObjects(targets.filter((t) => t.visible !== false), true);
    for (const h of hits) {
      let o = h.object;
      while (o && !o.userData.cupId && !o.userData.pick) o = o.parent;
      if (o) return o.userData.cupId ? { cup: o.userData.cupId } : o.userData.pick;
    }
    return null;
  }

  #click(e) {
    const hit = this.#raycast(e);
    const snap = this.snapshot;
    if (!hit) return this.#select(null);
    if (hit.cup) {
      const cup = snap?.world.cups.find((c) => c.id === hit.cup);
      if (cup?.slot === 'pickup') return this.onAction({ type: 'serveCup', cup: cup.id });
      return this.#select(this.selected === hit.cup ? null : hit.cup);
    }
    if (hit.id === 'slot' && this.selected) {
      this.onAction({ type: 'moveCup', cup: this.selected, to: hit.slot });
      return this.#select(null);
    }
    if (hit.id === 'guide') {
      const p = snap?.guide?.find((g) => g.action);
      if (p) this.onAction(p.action);
      return;
    }
    if (hit.id === 'card') {
      const payKey = hit.unit.payment;
      const pay = snap?.devices[payKey];
      if (!pay) return;
      if (pay.card === 'inserted') this.onAction({ type: 'device', device: payKey, action: { type: 'removeCard' } });
      else this.onAction({ type: 'device', device: payKey, action: { type: 'insertCard' } });
      return;
    }
    if (hit.id === 'lever') this.onToast('컵을 제빙기 레버에 대야 얼음이 나옵니다. 컵을 클릭한 뒤 파란 원을 클릭하세요.');
  }

  #select(id) {
    this.selected = id;
    this.cups.select(id);
    const occupied = new Set(Object.entries(this.snapshot?.world.slots ?? {}).filter(([, c]) => c).map(([s]) => s));
    for (const [slot, ring] of this.targetRings) ring.visible = !!id && !occupied.has(slot);
  }

  // ==================================================================== camera
  get views() {
    const units = this.units;
    const find = (model) => units.find((u) => u.model === model || u.model?.group?.userData?.model === model);
    const pos = (u) => u?.model.group.position ?? new THREE.Vector3();
    const main = units.find((u) => u.model.anchors?.screen);
    const ice = units.find((u) => u.model.slots?.tray);
    const cup = units.find((u) => u.model.slots?.hot);
    const m = pos(main);
    return {
      overview: { pos: [m.x + 0.45, 0.62, 2.05], target: [m.x + 0.45, 0.32, 0] },
      screen: { pos: [m.x, 0.56, 0.86], target: [m.x, 0.55, 0.2] },
      outlets: { pos: [m.x + 0.05, 0.3, 0.82], target: [m.x, 0.17, 0.12] },
      ice: { pos: [pos(ice).x, 0.34, 0.92], target: [pos(ice).x, 0.25, 0.1] },
      cups: { pos: [pos(cup).x, 0.3, 0.98], target: [pos(cup).x, 0.25, 0.1] },
      top: { pos: [m.x + 0.3, 1.9, 0.9], target: [m.x + 0.3, 0.2, 0.05] },
      robot: { pos: [m.x + 1.9, 1.05, 2.25], target: [m.x + 0.45, 0.1, 0.45] },
      find,
    };
  }

  view(name, instant = false) {
    const v = this.views[name];
    if (!v) return;
    this.currentView = name;
    const target = new THREE.Vector3(...v.target);
    const pos = new THREE.Vector3(...v.pos);
    // keep the whole subject in frame on narrow / portrait viewports
    const fit = Math.max(1, 1.75 / this.camera.aspect);
    pos.sub(target).multiplyScalar(name === 'screen' ? Math.max(1, 1.2 / this.camera.aspect) : fit).add(target);
    this.camTween = { fromPos: this.camera.position.clone(), fromTarget: this.controls.target.clone(), toPos: pos, toTarget: target, t: instant ? 1 : 0 };
    if (instant) {
      this.camera.position.copy(this.camTween.toPos);
      this.controls.target.copy(this.camTween.toTarget);
    }
  }

  setXray(on) {
    for (const u of this.units) {
      u.model.xray?.(on);
      for (const s of u.model.shells ?? []) {
        s.material.transparent = on;
        s.material.opacity = on ? 0.22 : 1;
        s.material.depthWrite = !on;
        s.material.needsUpdate = true;
        s.castShadow = !on;
      }
    }
  }

  resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.gl.setSize(w, h);
    this.css.setSize(w, h);
    if (this.currentView && (!this.camTween || this.camTween.t >= 1)) this.view(this.currentView, true);
  }

  // ==================================================================== per frame
  update(snapshot) {
    this.snapshot = snapshot;
    this.cups.sync(snapshot.world);
    if (this.selected && !snapshot.world.cups.some((c) => c.id === this.selected)) this.#select(null);
  }

  #frame() {
    const dt = Math.min(0.05, this.clock.getDelta());
    this.time += dt;
    const t = this.time;
    const snap = this.snapshot;

    if (this.camTween && this.camTween.t < 1) {
      const c = this.camTween;
      c.t = Math.min(1, c.t + dt / 0.8);
      const e = 1 - Math.pow(1 - c.t, 3);
      this.camera.position.lerpVectors(c.fromPos, c.toPos, e);
      this.controls.target.lerpVectors(c.fromTarget, c.toTarget, e);
    }
    this.controls.update();
    this.cups.tick(dt);
    if (this.robot) {
      this.robot.frame?.();
      for (const v of this.cups.views.values()) if (v.slot === 'robot:gripper') v.group.position.copy(this.robot.carriedCupPosition(v.type));
    }

    if (snap) {
      for (const u of this.units) u.model.update?.(snap.devices[u.device], u.payment ? snap.devices[u.payment] : null, t, snap.world, u.device);
      this.#updateStreams(snap, t);
      this.#updateGuide(snap, t);
    }
    this.gl.render(this.scene, this.camera);
    this.css.render(this.cssScene, this.camera);
  }

  #updateStreams(snap, t) {
    let i = 0;
    const show = (top, bottomY, color, width = 1) => {
      const m = this.streams[i++];
      if (!m) return;
      const len = Math.max(0.01, top.y - bottomY);
      m.visible = true;
      m.scale.set(width * (1 + Math.sin(t * 40 + i) * 0.15), len, width);
      m.position.set(top.x, bottomY + len / 2, top.z);
      m.material.color.copy(color);
    };
    for (const u of this.units) {
      const dev = snap.devices[u.device];
      if (dev?.streams && u.model.anchors?.spoutTops) {
        const seen = new Set();
        for (const s of dev.streams) {
          const key = `${s.spout}-${s.kind}-${s.sub}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const top = u.model.group.localToWorld(u.model.anchors.spoutTops[s.spout - 1].clone());
          const slot = `${u.device}:spout${s.spout}`;
          const bottom = this.cups.topOf(slot) ?? this.slotPos.get(slot)?.y ?? 0.1;
          show(top, Math.min(bottom - 0.03, top.y - 0.02), KIND_COLOR(s.kind, s.sub), s.kind === 'coffee' ? 0.8 : 1.1);
        }
      }
      if (dev?.dispensing && u.model.anchors?.nozzle) {
        const top = u.model.group.localToWorld(u.model.anchors.nozzle.clone());
        const slot = `${u.device}:tray`;
        const bottom = this.cups.topOf(slot) ?? 0.09;
        if (dev.dispensing.phase === 'water') show(top, bottom - 0.03, KIND_COLOR('water'), 1.2);
        else {
          const m = new THREE.Matrix4();
          this.iceBits.count = 10;
          for (let k = 0; k < 10; k++) {
            const f = (t * 2.2 + k / 10) % 1;
            m.makeRotationFromEuler(new THREE.Euler(k + t * 3, k * 2, 0));
            m.setPosition(top.x + Math.sin(k * 7.1) * 0.012, top.y - f * (top.y - bottom + 0.02), top.z + Math.cos(k * 3.3) * 0.012);
            this.iceBits.setMatrixAt(k, m);
          }
          this.iceBits.instanceMatrix.needsUpdate = true;
        }
      }
      if (!snap.devices[u.device]?.dispensing && u.model.anchors?.nozzle) this.iceBits.count = 0;
    }
    for (; i < this.streams.length; i++) this.streams[i].visible = false;
  }

  #updateGuide(snap, t) {
    const p = snap.guide?.[0];
    const target = p?.target && this.slotPos.get(p.target);
    const actionable = snap.guide?.find((g) => g.action);
    this.guideRing.visible = this.guideArrow.visible = !!target;
    if (!target) return;
    const cupTop = this.cups.topOf(p.target);
    this.guideRing.position.copy(target).add(new THREE.Vector3(0, 0.004, 0));
    const s = 1 + Math.sin(t * 5) * 0.12;
    this.guideRing.scale.set(s, s, s);
    this.guideRing.material.color.set(actionable ? 0xff7a1a : 0x2fbf71);
    this.guideArrow.material.color.set(actionable ? 0xff7a1a : 0x2fbf71);
    this.guideArrow.material.emissive.set(actionable ? 0xff7a1a : 0x2fbf71);
    if (p.target.endsWith(':slot')) {
      // card reader: point at it from the side so the arrow does not cover the screen
      this.guideArrow.rotation.set(0, 0, Math.PI / 2);
      this.guideArrow.position.copy(target).add(new THREE.Vector3(0.1 + Math.sin(t * 4) * 0.012, 0, 0.02));
      this.guideRing.rotation.set(0, 0, 0);
      return;
    }
    this.guideArrow.rotation.set(Math.PI, 0, 0);
    this.guideRing.rotation.set(-Math.PI / 2, 0, 0);
    this.guideArrow.position.copy(target).add(new THREE.Vector3(0, (cupTop ? cupTop - target.y : 0.05) + 0.07 + Math.sin(t * 4) * 0.015, 0));
  }
}

/** Fallback box for device types that have no dedicated 3D model yet. */
function genericModel(u, devDef) {
  return () => {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new RoundedBoxGeometry(0.3, 0.5, 0.35, 2, 0.01), new THREE.MeshStandardMaterial({ color: 0xe8e8e8 }));
    body.position.y = 0.25;
    g.add(body);
    const label = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.06), new THREE.MeshBasicMaterial({ map: textTexture(512, 120, [{ text: devDef?.type ?? u.device, size: 40, color: '#333', y: 60 }]), transparent: true }));
    label.position.set(0, 0.38, 0.176);
    g.add(label);
    return { group: g, slots: { nozzle: new THREE.Vector3(0, 0.0, 0.25) }, shells: [body], pickables: [], update() {} };
  };
}
