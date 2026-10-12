import * as THREE from 'three';
import URDFLoader from 'urdf-loader';
import { Emitter } from '@cafesim/core';
import { setData, JOINT_NAMES } from './studyur/model.js';
import { generate as generateUrdf } from './studyur/urdf.js';
import { planProgram } from './studyur/trajectory.js';
import * as SP from './studyur/spatial.js';

const CUP_H = { hot: 0.105, ice: 0.13 };
// tool orientation in the UR base frame: tool z -> base +X (toward the machines), tool x -> down
const R_GRASP = [
  [0, 0, 1],
  [0, 1, 0],
  [-1, 0, 0],
];
const HOME = [Math.PI, -1.75, 1.95, -1.77, -1.571, 0];

const T = (p) => [
  [R_GRASP[0][0], R_GRASP[0][1], R_GRASP[0][2], p[0]],
  [R_GRASP[1][0], R_GRASP[1][1], R_GRASP[1][2], p[1]],
  [R_GRASP[2][0], R_GRASP[2][1], R_GRASP[2][2], p[2]],
  [0, 0, 0, 1],
];
const f3 = (v) => v.map((x) => x.toFixed(4)).join(', ');
const poseStr = (Tm) => {
  const rv = SP.matToRotvec(SP.TR(Tm));
  return `p[${f3(SP.Tp(Tm))}, ${f3(rv)}]`;
};

/**
 * A UR robot (studyUR kinematics + official ur_description meshes) that serves the M400 station:
 * it watches the customer guide of the simulation and performs the "move the cup" steps as
 * pick-and-place programs (MoveJ / MoveL planned by studyUR's planProgram), plus the remaining
 * customer actions (card, pickup) after a short delay.
 *
 * Events: 'status' { text, busy }, 'urscript' (lines[])
 */
export class RobotCell extends Emitter {
  constructor({ stage, link, definition }) {
    super();
    this.stage = stage;
    this.link = link;
    this.cfg = definition.layout.robot;
    this.model = this.cfg.model ?? 'ur5e';
    this.tcp = this.cfg.tcp ?? [0, 0, 0.15, 0, 0, 0];
    this.q = HOME.slice();
    this.busy = false;
    this.play = null;
    this.handled = new Set();
    this.customerTimer = null;
    this.enabled = true;
    this.status = '로봇 준비 중...';
    this.script = [];
  }

  async load() {
    const [models, tools] = await Promise.all([fetch('./ur/models.json').then((r) => r.json()), fetch('./ur/tools.json').then((r) => r.json())]);
    setData(models, tools);

    // container = UR base frame (z up, x toward the machines) placed in the y-up world
    const base = new THREE.Group();
    base.matrixAutoUpdate = false;
    const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, -1), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 1, 0));
    m.setPosition(...this.cfg.base);
    base.matrix.copy(m);
    base.updateMatrixWorld(true);
    this.base = base;
    this.stage.scene.add(base);
    this.#pedestal();

    const urdf = generateUrdf(this.model, './ur/models', null);
    const loader = new URDFLoader();
    const manager = new THREE.LoadingManager();
    loader.manager = manager;
    const done = new Promise((resolve) => (manager.onLoad = resolve));
    const robot = loader.parse(urdf);
    robot.rotation.z = Math.PI; // URDF base_link = Rz(pi) * base (studyUR convention)
    base.add(robot);
    this.robot = robot;
    await Promise.race([done, new Promise((r) => setTimeout(r, 20000))]);
    robot.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    this.#gripper();
    this.setJoints(this.q);
    this.#status('로봇 대기 중 · 주문을 기다립니다');
    this.unsub = this.link.on('snap', (s) => this.#onSnap(s));
    // robot motion runs on its own clock (keeps going when the tab is not rendering)
    let last = performance.now();
    this.timer = setInterval(() => {
      const now = performance.now();
      this.tick(Math.min(0.1, (now - last) / 1000));
      last = now;
    }, 30);
    this.link.interact({ type: 'autoAssist', on: false });
  }

  #pedestal() {
    const [x, y, z] = this.cfg.base;
    const h = y + 0.89;
    const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.12, h, 32), new THREE.MeshStandardMaterial({ color: 0x3a3f46, metalness: 0.5, roughness: 0.4 }));
    ped.position.set(x, y - h / 2, z);
    ped.castShadow = ped.receiveShadow = true;
    const plate = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.02, 32), new THREE.MeshStandardMaterial({ color: 0x2a2e33, metalness: 0.4, roughness: 0.5 }));
    plate.position.set(x, -0.88, z);
    this.stage.scene.add(ped, plate);
  }

  /** Simple 2-finger gripper on tool0 (tool z = approach). */
  #gripper() {
    const g = new THREE.Group();
    const dark = new THREE.MeshStandardMaterial({ color: 0x2b2f35, metalness: 0.3, roughness: 0.5 });
    const alu = new THREE.MeshStandardMaterial({ color: 0xb8bec6, metalness: 0.8, roughness: 0.3 });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.04, 0.06, 24), dark);
    body.rotation.x = Math.PI / 2;
    body.position.z = 0.03;
    const palm = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.03, 0.02), dark);
    palm.position.z = 0.07;
    g.add(body, palm);
    this.fingers = [-1, 1].map((s) => {
      const fg = new THREE.Group();
      const finger = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.026, 0.085), alu);
      finger.position.z = 0.115;
      const pad = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.024, 0.04), new THREE.MeshStandardMaterial({ color: 0x111111 }));
      pad.position.set(-s * 0.007, 0, 0.135);
      fg.add(finger, pad);
      fg.userData.side = s;
      g.add(fg);
      return fg;
    });
    this.cupAnchor = new THREE.Object3D();
    this.cupAnchor.position.z = this.tcp[2];
    g.add(this.cupAnchor);
    this.robot.links.tool0.add(g);
    this.grip = 0.06; // half opening (m)
    this.gripTarget = 0.06;
  }

  setJoints(q) {
    this.q = q.slice();
    JOINT_NAMES.forEach((n, i) => this.robot?.joints[n]?.setJointValue(q[i]));
  }

  /** world point (x, y, z) -> UR base frame */
  toBase(v) {
    const p = this.base.worldToLocal(new THREE.Vector3(...v));
    return [p.x, p.y, p.z];
  }

  // ------------------------------------------------------------------ brain
  #status(text, busy = this.busy) {
    this.status = text;
    this.emit('status', { text, busy });
  }

  #onSnap(s) {
    this.snap = s;
    if (!this.enabled || this.busy) return;
    const prompts = s.guide ?? [];
    const move = prompts.find((p) => p.action?.type === 'moveCup');
    if (move) {
      const key = `${move.action.cup}->${move.action.to}`;
      if (this.handled.has(key)) return;
      this.handled.add(key);
      const cup = s.world.cups.find((c) => c.id === move.action.cup);
      if (cup) this.pickPlace(cup, move.action.to, move.text).catch((e) => this.#status(`⚠ ${e.message}`, false));
      return;
    }
    // the customer's own actions (card, taking the drink) happen after a moment
    const other = prompts.find((p) => p.action && p.action.type !== 'moveCup');
    if (other && !this.customerTimer) {
      this.customerTimer = setTimeout(() => {
        this.customerTimer = null;
        const still = (this.snap?.guide ?? []).find((p) => p.id === other.id);
        if (still?.action) this.link.interact(still.action);
      }, 1800);
    }
    if (!move && !this.play && this.atHome === false) this.goHome();
  }

  async goHome() {
    if (this.busy) return;
    this.busy = true;
    this.atHome = true;
    try {
      await this.run([{ type: 'movej', q: HOME, v: this.cfg.speed?.joint ?? 1.2 }], '대기 자세로 복귀');
    } finally {
      this.busy = false;
      this.#status('로봇 대기 중 · 주문을 기다립니다', false);
    }
  }

  /** Grasp the cup on its slot and put it on `to`. */
  async pickPlace(cup, to, why = '') {
    this.busy = true;
    this.atHome = false;
    const label = { 'ice:tray': '제빙기', pickup: '픽업대', 'cup:hot': 'HOT 컵 출구', 'cup:ice': 'ICE 컵 출구' }[to] ?? to.replace('main:spout', '') + '번 투출구';
    try {
      const from = this.stage.slotPos.get(cup.slot);
      const dest = this.stage.slotPos.get(to);
      if (!from || !dest) throw new Error(`위치를 알 수 없습니다: ${cup.slot} → ${to}`);
      const h = (CUP_H[cup.type] ?? 0.11) * 0.55;
      const a = this.cfg.approach ?? 0.15;
      const lift = this.cfg.lift ?? 0.03;
      const grasp = this.toBase([from.x, from.y + h, from.z]);
      const place = this.toBase([dest.x, dest.y + h + 0.004, dest.z]);
      const off = (p, dx, dz) => [p[0] + dx, p[1], p[2] + dz]; // base: -x = toward customer, +z = up
      const vL = this.cfg.speed?.linear ?? 0.25;
      const vJ = this.cfg.speed?.joint ?? 1.2;
      const cmds = [
        { type: 'tool', on: false },
        { type: 'movej', pose: T(off(grasp, -a, lift)), v: vJ },
        { type: 'movel', pose: T(off(grasp, -0.01, 0)), v: vL },
        { type: 'movel', pose: T(grasp), v: 0.08 },
        { type: 'tool', on: true },
        { type: 'mark', label: `grip:${cup.id}` },
        { type: 'wait', t: 0.4 },
        { type: 'movel', pose: T(off(grasp, 0, lift)), v: 0.1 },
        { type: 'movel', pose: T(off(grasp, -a, lift)), v: vL },
        { type: 'movej', pose: T(off(place, -a, lift)), v: vJ },
        { type: 'movel', pose: T(off(place, 0, lift)), v: vL },
        { type: 'movel', pose: T(place), v: 0.08 },
        { type: 'tool', on: false },
        { type: 'mark', label: `release:${cup.id}:${to}` },
        { type: 'wait', t: 0.4 },
        { type: 'movel', pose: T(off(place, -a, 0.02)), v: vL },
      ];
      this.#status(`🤖 ${cup.type === 'ice' ? 'ICE' : 'HOT'} 컵을 ${label}(으)로 옮기는 중${why ? ` · ${why}` : ''}`, true);
      await this.run(cmds, `${cup.type.toUpperCase()} 컵 → ${label}`);
      this.#status(`🤖 ${label}에 컵을 놓았습니다`, false);
    } finally {
      this.busy = false;
    }
  }

  /** Plan with studyUR and play the trajectory back on the 3D arm. */
  run(cmds, title) {
    const traj = planProgram(this.model, this.q, cmds, this.tcp);
    this.#urscript(cmds, title);
    return new Promise((resolve) => {
      this.play = { traj, t: 0, ev: 0, resolve };
    });
  }

  #urscript(cmds, title) {
    const lines = [`# ${title}`];
    for (const c of cmds) {
      if (c.type === 'movej') lines.push(c.q ? `movej([${f3(c.q)}], a=1.4, v=${c.v ?? 1.05})` : `movej(get_inverse_kin(${poseStr(c.pose)}), a=1.4, v=${c.v ?? 1.05})`);
      else if (c.type === 'movel') lines.push(`movel(${poseStr(c.pose)}, a=1.2, v=${c.v ?? 0.25})`);
      else if (c.type === 'tool') lines.push(`set_tool_digital_out(0, ${c.on ? 'True' : 'False'})  # gripper ${c.on ? 'close' : 'open'}`);
      else if (c.type === 'wait') lines.push(`sleep(${c.t})`);
    }
    this.script = lines;
    this.emit('urscript', lines);
  }

  /** Advances the gripper and the running program (30 ms timer). */
  tick(dt) {
    if (!this.robot) return;
    this.grip += (this.gripTarget - this.grip) * Math.min(1, dt * 10);
    for (const fg of this.fingers) fg.position.x = fg.userData.side * this.grip * 0.62;
    const p = this.play;
    if (!p) return;
    const speed = Math.max(0.25, this.snap?.speed ?? 1);
    p.t += dt * speed;
    const q = p.traj.qAt(p.t);
    if (q) this.setJoints(q);
    const evs = p.traj.events;
    while (p.ev < evs.length && evs[p.ev][0] <= p.t) {
      const [, kind, value] = evs[p.ev++];
      if (kind === 'tool') this.gripTarget = value ? 0.043 : 0.06;
      if (kind === 'mark' && typeof value === 'string') {
        const [what, cup, to] = value.split(':').length > 3 ? [value.split(':')[0], value.split(':')[1], value.split(':').slice(2).join(':')] : value.split(':');
        if (what === 'grip') this.link.interact({ type: 'moveCup', cup, to: 'robot:gripper' });
        if (what === 'release') this.link.interact({ type: 'moveCup', cup, to });
      }
    }
    if (p.t >= p.traj.duration) {
      this.play = null;
      p.resolve();
    }
  }

  /** World position where a carried cup's bottom should be. */
  carriedCupPosition(cupType) {
    const w = new THREE.Vector3();
    this.cupAnchor.getWorldPosition(w);
    w.y -= (CUP_H[cupType] ?? 0.11) * 0.55;
    return w;
  }

  dispose() {
    clearInterval(this.timer);
    this.unsub?.();
    clearTimeout(this.customerTimer);
  }
}
