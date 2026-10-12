import * as THREE from 'three';
import URDFLoader from 'urdf-loader';
import { Emitter } from '@cafesim/core';
import { setData, JOINT_NAMES } from './studyur/model.js';
import { generate as generateUrdf } from './studyur/urdf.js';
import * as K from './studyur/kinematics.js';
import { planProgram } from './studyur/trajectory.js';
import * as SP from './studyur/spatial.js';
import { CollisionModel, CollisionDebug } from './collision.js';

/** cup geometry (same as the 3D cups): height and bottom/top radius */
const CUP = { hot: { h: 0.105, rb: 0.03, rt: 0.04 }, ice: { h: 0.13, rb: 0.034, rt: 0.047 } };
const GRASP_AT = 0.55; // grasp height as a fraction of the cup height
const STROKE = 0.07; // max half opening of the gripper (2F-140 class)
const HOME = [Math.PI, -1.75, 1.95, -1.77, -1.571, 0];
const TUCK = [Math.PI / 2, -2.2, 2.3, -1.67, -1.571, 0]; // compact transit pose (arm folded over the pedestal)

const f3 = (v) => v.map((x) => x.toFixed(4)).join(', ');
const poseStr = (Tm) => `p[${f3(SP.Tp(Tm))}, ${f3(SP.matToRotvec(SP.TR(Tm)))}]`;
const cupRadius = (type, frac) => CUP[type].rb + (CUP[type].rt - CUP[type].rb) * frac;

/**
 * A UR robot (studyUR kinematics + official ur_description meshes) that serves the M400 station.
 * It watches the customer guide of the simulation and performs the "move the cup" steps as
 * pick-and-place programs planned with studyUR's planProgram (MoveJ / MoveL):
 *   - the cup is gripped from the side (fingers close horizontally) at 55 % of its height and
 *     the gripper opening follows the cup diameter
 *   - every planned motion is checked against the cell (machines, counter, table, pedestal, wall)
 *     with capsules fitted to the UR link meshes; transfers use the straight corridor in front
 *     of the machines and fall back to direct / via-point / folded-pose candidates
 *
 * Events: 'status' { text, busy }, 'urscript' (lines[]), 'plan' { title, report, unresolved, avoided }
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
    this.lastPlan = null;
    this.cupSize = null;
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
    this.q = K.tryIkClosest(this.model, this.homeT(), HOME, this.tcp) ?? HOME.slice();
    this.setJoints(this.q);
    robot.updateMatrixWorld(true);

    const [bx, by, bz] = this.cfg.base;
    this.collision = new CollisionModel({
      robot,
      tool0: robot.links.tool0,
      tcpZ: this.tcp[2],
      obstacles: [...this.stage.obstacles, { name: '로봇 받침대', min: [bx - 0.12, -0.9, bz - 0.12], max: [bx + 0.12, by - 0.012, bz + 0.12] }],
    });
    this.collision.setGripper(this.grip);
    this.debug = new CollisionDebug(this.stage.scene, this.collision);

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

  /**
   * 2-finger parallel gripper on tool0: tool z = approach, fingers slide along tool x
   * (horizontal while grasping), tool y = up.
   */
  #gripper() {
    const g = new THREE.Group();
    const dark = new THREE.MeshStandardMaterial({ color: 0x2b2f35, metalness: 0.3, roughness: 0.5 });
    const alu = new THREE.MeshStandardMaterial({ color: 0xb8bec6, metalness: 0.8, roughness: 0.3 });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.042, 0.065, 28), dark);
    body.rotation.x = Math.PI / 2;
    body.position.z = 0.0325;
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.032, 0.022), dark);
    rail.position.z = 0.074;
    g.add(body, rail);
    // fingers reach from the rail (z 0.085) to just past the TCP: long fingers keep the wrist away from the machines
    const tipZ = this.tcp[2] + 0.004;
    const len = tipZ - 0.083;
    this.fingers = [-1, 1].map((s) => {
      const fg = new THREE.Group();
      const finger = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.03, len), alu);
      finger.position.set(s * 0.008, 0, 0.083 + len / 2);
      const pad = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.028, 0.045), new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.9 }));
      pad.position.set(s * 0.002, 0, this.tcp[2] - 0.012); // inner face of the pad sits at x = ±opening
      fg.add(finger, pad);
      fg.userData.side = s;
      g.add(fg);
      return fg;
    });
    this.cupAnchor = new THREE.Object3D();
    this.cupAnchor.position.z = this.tcp[2];
    g.add(this.cupAnchor);
    this.robot.links.tool0.add(g);
    this.grip = STROKE;
    this.gripTarget = STROKE;
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

  /** UR base frame -> world point */
  toWorld(p) {
    const v = this.base.localToWorld(new THREE.Vector3(...p));
    return [v.x, v.y, v.z];
  }

  /**
   * transit pose on the straight corridor in front of the machines: world x, fixed height and
   * depth, tool (and the held cup) facing the machines
   */
  lineT(x) {
    const { z = 0.3, height = 0.24 } = this.cfg.corridor ?? {};
    return this.graspT(this.toBase([x, height, z]), this.dirToBase([0, 0, -1]));
  }

  /** true when the tool of a base-frame pose points toward the machines (world -z) */
  #facesMachines(Tm) {
    const d = this.base.localToWorld(new THREE.Vector3(Tm[0][2], Tm[1][2], Tm[2][2])).sub(this.base.localToWorld(new THREE.Vector3()));
    return d.z < -0.5;
  }

  /** world direction -> UR base frame */
  dirToBase(d) {
    const p = new THREE.Vector3(...d).transformDirection(new THREE.Matrix4().copy(this.base.matrixWorld).invert());
    return [p.x, p.y, p.z];
  }

  /**
   * Grasp pose: tool z along the horizontal approach direction, fingers along the horizontal
   * normal and tool y up -> the cup is gripped from the side and stays upright.
   */
  graspT(p, dir) {
    const n = Math.hypot(dir[0], dir[1]) || 1;
    const dx = dir[0] / n;
    const dy = dir[1] / n;
    return [
      [-dy, 0, dx, p[0]],
      [dx, 0, dy, p[1]],
      [0, 1, 0, p[2]],
      [0, 0, 0, 1],
    ];
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
    if (!this.play && this.atHome === false) this.goHome();
  }

  async goHome() {
    if (this.busy) return;
    this.busy = true;
    this.atHome = true;
    try {
      await this.#execute([this.#transit(this.homeT(), { holding: false })], '대기 자세로 복귀');
    } finally {
      this.busy = false;
      this.#status('로봇 대기 중 · 주문을 기다립니다', false);
    }
  }

  /** home: on the transit corridor in front of the base, facing the machines */
  homeT() {
    return this.lineT(this.cfg.base[0]);
  }

  /** Approach direction (base frame) for a slot: into the machines, or away from the robot for the table. */
  #approachDir(slot) {
    if (slot === 'pickup') {
      const p = this.stage.slotPos.get('pickup');
      const [bx, , bz] = this.cfg.base;
      return this.dirToBase([p.x - bx, 0, p.z - bz]);
    }
    return this.dirToBase([0, 0, -1]);
  }

  /** Grip the cup on its slot and put it on `to`. */
  async pickPlace(cup, to, why = '') {
    this.busy = true;
    this.atHome = false;
    const label = { 'ice:tray': '제빙기', pickup: '픽업 테이블', 'cup:hot': 'HOT 컵 출구', 'cup:ice': 'ICE 컵 출구' }[to] ?? to.replace('main:spout', '') + '번 투출구';
    try {
      const from = this.stage.slotPos.get(cup.slot);
      const dest = this.stage.slotPos.get(to);
      if (!from || !dest) throw new Error(`위치를 알 수 없습니다: ${cup.slot} → ${to}`);
      const c = CUP[cup.type] ?? CUP.hot;
      const h = c.h * GRASP_AT;
      const r = cupRadius(cup.type, GRASP_AT);
      // opening = cup diameter at the grasp height + 9 mm per side, closing squeezes 1.5 mm
      this.cupSize = { open: Math.min(STROKE, r + 0.009), close: r - 0.0015, r, type: cup.type };
      const a = this.cfg.approach ?? 0.15;
      // lift the cup over the window sill / outlet tray, but slide it along the ice tray (nozzle above)
      const liftOf = (slot) => (slot.startsWith('ice:') ? 0.003 : this.cfg.lift ?? 0.03);
      const liftA = liftOf(cup.slot);
      const liftB = liftOf(to);
      const dA = this.#approachDir(cup.slot);
      const dB = this.#approachDir(to);
      const gA = this.toBase([from.x, from.y + h, from.z]);
      const gB = this.toBase([dest.x, dest.y + h + 0.004, dest.z]);
      // offset back toward the robot (along -dir) and up
      const off = (p, d, back, up) => {
        const n = Math.hypot(d[0], d[1]) || 1;
        return [p[0] - (d[0] / n) * back, p[1] - (d[1] / n) * back, p[2] + up];
      };
      const vL = this.cfg.speed?.linear ?? 0.25;
      const legs = [];
      let q = this.q;
      const push = (leg) => {
        legs.push(leg);
        q = leg.qEnd;
      };
      push(this.#leg([{ type: 'tool', on: false, width: this.cupSize.open }], q, { holding: false, title: '그리퍼 열기' }));
      push(this.#transit(this.graspT(off(gA, dA, a, liftA), dA), { holding: false, from: q }));
      push(
        this.#leg(
          [
            { type: 'movel', pose: this.graspT(off(gA, dA, 0.012, 0), dA), v: vL },
            { type: 'movel', pose: this.graspT(gA, dA), v: 0.08 },
            { type: 'tool', on: true, width: this.cupSize.close },
            { type: 'mark', label: `grip:${cup.id}` },
            { type: 'wait', t: 0.45 },
          ],
          q,
          { holding: false, title: '접근·파지' },
        ),
      );
      push(
        this.#leg(
          [
            { type: 'movel', pose: this.graspT(off(gA, dA, 0, liftA), dA), v: 0.1 },
            { type: 'movel', pose: this.graspT(off(gA, dA, a, liftA), dA), v: vL },
          ],
          q,
          { holding: true, title: '꺼내기', liftOff: true },
        ),
      );
      push(this.#transit(this.graspT(off(gB, dB, a, liftB), dB), { holding: true, from: q }));
      push(
        this.#leg(
          [
            { type: 'movel', pose: this.graspT(off(gB, dB, 0, liftB), dB), v: vL },
            { type: 'movel', pose: this.graspT(gB, dB), v: 0.08 },
            { type: 'tool', on: false, width: this.cupSize.open },
            { type: 'mark', label: `release:${cup.id}:${to}` },
            { type: 'wait', t: 0.45 },
          ],
          q,
          { holding: true, title: '내려놓기', liftOff: true },
        ),
      );
      push(this.#leg([{ type: 'movel', pose: this.graspT(off(gB, dB, a, 0.02), dB), v: vL }], q, { holding: false, title: '후퇴' }));

      this.#status(`🤖 ${cup.type === 'ice' ? 'ICE' : 'HOT'} 컵을 ${label}(으)로 옮기는 중${why ? ` · ${why}` : ''}`, true);
      await this.#execute(legs, `${cup.type.toUpperCase()} 컵 → ${label}`);
      this.#status(`🤖 ${label}에 컵을 놓았습니다`, false);
    } finally {
      this.busy = false;
    }
  }

  // ------------------------------------------------------------------ planning with collision checks
  /** Plan one leg (commands from q0) with studyUR and collision-check it. */
  #leg(cmds, q0, { holding, title = '', liftOff = false } = {}) {
    const motion = cmds.filter((c) => c.type === 'movej' || c.type === 'movel');
    const traj = motion.length ? planProgram(this.model, q0, motion, this.tcp) : null;
    const qEnd = traj ? traj.q[traj.q.length - 1].slice() : q0.slice();
    const hit = traj ? this.#checkTraj(traj, holding, liftOff) : null;
    return { cmds, q0, qEnd, hit, title };
  }

  /**
   * Free transfer to a pose (or joint target). Candidates are tried in order and the first
   * collision-free one is used:
   *   1. direct MoveJ
   *   2. retreat + raise from the current TCP, MoveJ to a raised pre-point, then down (2 sizes)
   *   3. via the folded transit pose
   */
  #transit(target, { holding, from = this.q, toQ = false }) {
    const vJ = this.cfg.speed?.joint ?? 1.2;
    const goal = toQ ? { type: 'movej', q: target, v: vJ } : { type: 'movej', pose: target, v: vJ };
    const cur = K.fk(this.model, from, this.tcp);
    const candidates = [];
    if (!toQ) {
      // straight corridor in front of the machines: out to the corridor, slide along it, go in.
      // poses facing the customer (pickup table) join the corridor in front of the base.
      const vL = this.cfg.speed?.linear ?? 0.25;
      const bx = this.cfg.base[0];
      const cx = this.#facesMachines(cur) ? this.toWorld(SP.Tp(cur))[0] : bx;
      const tIn = this.#facesMachines(target);
      const tx = tIn ? this.toWorld(SP.Tp(target))[0] : bx;
      const cmds = [];
      if (this.#facesMachines(cur)) cmds.push({ type: 'movel', pose: this.lineT(cx), v: vL });
      else cmds.push({ type: 'movej', pose: this.lineT(cx), v: vJ });
      if (Math.abs(tx - cx) > 1e-3) cmds.push({ type: 'movel', pose: this.lineT(tx), v: vL });
      cmds.push(tIn ? { type: 'movel', pose: target, v: vL } : { type: 'movej', pose: target, v: vJ });
      candidates.push({ name: '전면 통로', cmds });
    }
    candidates.push({ name: '직접 이동', cmds: [goal] });
    for (const [back, up] of [
      [0.12, 0.1],
      [0.22, 0.2],
    ]) {
      const viaA = this.#shiftT(cur, back, up);
      const viaB = toQ ? null : this.#shiftT(target, back * 0.6, up);
      candidates.push({ name: `경유점(후퇴 ${Math.round(back * 100)}cm·상승 ${Math.round(up * 100)}cm)`, cmds: [{ type: 'movej', pose: viaA, v: vJ }, ...(viaB ? [{ type: 'movej', pose: viaB, v: vJ }] : []), goal] });
    }
    candidates.push({ name: '접힌 자세 경유', cmds: [{ type: 'movej', pose: this.#shiftT(cur, 0.15, 0.12), v: vJ }, { type: 'movej', q: TUCK, v: vJ }, goal] });
    const attempts = [];
    let best = null;
    for (const cand of candidates) {
      let leg;
      try {
        leg = this.#leg(cand.cmds, from, { holding, title: cand.name });
      } catch {
        attempts.push({ name: cand.name, result: '도달 불가' });
        continue;
      }
      attempts.push({ name: cand.name, result: leg.hit ? `충돌(${leg.hit.capsule}↔${leg.hit.obstacle})` : '통과' });
      if (!leg.hit) {
        best = leg;
        break;
      }
      best ??= leg;
    }
    if (!best) throw new Error('이동 경로를 찾지 못했습니다');
    best.attempts = attempts;
    return best;
  }

  /** move a pose back along -tool z (horizontal component) and up (base z) */
  #shiftT(Tm, back, up) {
    const zx = Tm[0][2];
    const zy = Tm[1][2];
    const n = Math.hypot(zx, zy) || 1;
    const out = Tm.map((r) => r.slice());
    out[0][3] -= (zx / n) * back;
    out[1][3] -= (zy / n) * back;
    out[2][3] += up;
    return out;
  }

  /** Sample a trajectory against the collision model; restores the arm afterwards. */
  #checkTraj(traj, holding, liftOff) {
    if (!this.collision) return null;
    const saved = this.q.slice();
    const savedGrip = this.collision.gripper;
    const cs = this.cupSize;
    this.collision.setGripper(holding ? cs?.close ?? 0.04 : cs?.open ?? STROKE);
    // the held cup may touch the surface it is lifted from / set down on
    this.collision.setCup(holding && cs ? { tcp: this.tcp[2], r: CUP[cs.type].rt, below: CUP[cs.type].h * GRASP_AT - (liftOff ? 0.012 : 0), above: CUP[cs.type].h * (1 - GRASP_AT) } : null);
    let hit = null;
    for (let i = 0; i < traj.q.length && !hit; i += 4) {
      this.setJoints(traj.q[i]);
      this.robot.updateMatrixWorld(true);
      hit = this.collision.check();
      if (hit) hit.t = traj.t[i];
    }
    this.collision.gripper = savedGrip;
    this.collision.setCup(null);
    this.setJoints(saved);
    this.robot.updateMatrixWorld(true);
    return hit;
  }

  /** Concatenate the legs into one program, plan it with studyUR and play it back. */
  #execute(legs, title) {
    const cmds = legs.flatMap((l) => l.cmds);
    const traj = planProgram(
      this.model,
      this.q,
      cmds.map((c) => (c.type === 'tool' ? { type: 'tool', on: c.on } : c)),
      this.tcp,
    );
    const widths = cmds.filter((c) => c.type === 'tool').map((c) => c.width);
    const report = legs.filter((l) => l.attempts).map((l) => ({ chosen: l.title, attempts: l.attempts, hit: l.hit }));
    const avoided = report.filter((r) => r.attempts.length > 1 && !r.hit).length;
    const unresolved = legs.find((l) => l.hit)?.hit ?? null;
    this.lastPlan = { title, report, unresolved, avoided, checkedLegs: legs.length };
    this.emit('plan', this.lastPlan);
    this.#urscript(cmds, title, report, unresolved);
    return new Promise((resolve) => {
      this.play = { traj, t: 0, ev: 0, widths, wi: 0, resolve };
    });
  }

  #urscript(cmds, title, report, unresolved) {
    const lines = [`# ${title}`];
    for (const r of report) if (r.attempts.length > 1) lines.push(`# 충돌 회피: ${r.attempts.map((a) => `${a.name}=${a.result}`).join(' → ')}`);
    if (unresolved) lines.push(`# ⚠ 회피하지 못한 충돌: ${unresolved.capsule}↔${unresolved.obstacle}`);
    for (const c of cmds) {
      if (c.type === 'movej') lines.push(c.q ? `movej([${f3(c.q)}], a=1.4, v=${c.v ?? 1.05})` : `movej(get_inverse_kin(${poseStr(c.pose)}), a=1.4, v=${c.v ?? 1.05})`);
      else if (c.type === 'movel') lines.push(`movel(${poseStr(c.pose)}, a=1.2, v=${c.v ?? 0.25})`);
      else if (c.type === 'tool') lines.push(`rq_move_mm(${Math.round((c.width ?? STROKE) * 2000)})  # 그리퍼 ${c.on ? '닫기' : '열기'} ${Math.round((c.width ?? STROKE) * 2000)} mm`);
      else if (c.type === 'wait') lines.push(`sleep(${c.t})`);
    }
    this.script = lines;
    this.emit('urscript', lines);
  }

  /** Advances the gripper and the running program (30 ms timer). */
  tick(dt) {
    if (!this.robot) return;
    this.grip += (this.gripTarget - this.grip) * Math.min(1, dt * 10);
    for (const fg of this.fingers) fg.position.x = fg.userData.side * this.grip;
    const p = this.play;
    if (!p) return;
    const speed = Math.max(0.25, this.snap?.speed ?? 1);
    p.t += dt * speed;
    const q = p.traj.qAt(p.t);
    if (q) this.setJoints(q);
    const evs = p.traj.events;
    while (p.ev < evs.length && evs[p.ev][0] <= p.t) {
      const [, kind, value] = evs[p.ev++];
      if (kind === 'tool') this.gripTarget = p.widths[p.wi++] ?? (value ? 0.04 : STROKE);
      if (kind === 'mark' && typeof value === 'string') {
        const parts = value.split(':');
        const [what, cup] = parts;
        const to = parts.slice(2).join(':');
        if (what === 'grip') this.link.interact({ type: 'moveCup', cup, to: 'robot:gripper' });
        if (what === 'release') this.link.interact({ type: 'moveCup', cup, to });
      }
    }
    if (p.t >= p.traj.duration) {
      this.play = null;
      p.resolve();
    }
  }

  /** called by the stage every frame (debug drawing) */
  frame() {
    if (this.debug?.group.visible) {
      this.collision.setGripper(this.grip);
      this.debug.update(this.collision.check());
    }
  }

  setDebug(on) {
    if (this.debug) this.debug.group.visible = on;
  }

  /** World position where a carried cup's bottom should be. */
  carriedCupPosition(cupType) {
    const w = new THREE.Vector3();
    this.cupAnchor.getWorldPosition(w);
    w.y -= (CUP[cupType]?.h ?? 0.11) * GRASP_AT;
    return w;
  }

  dispose() {
    clearInterval(this.timer);
    this.unsub?.();
    clearTimeout(this.customerTimer);
  }
}
