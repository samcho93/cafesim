// Vendored from studyUR (a8adb01) assets/js/ur/trajectory.js by tools/sync-studyur.mjs - do not edit here.
// trajectory.js — UR-style motion planning. Mirror of python/urrobot/trajectory.py.
import * as S from './spatial.js';
import * as K from './kinematics.js';
import { getModel } from './model.js';

export const DT = 0.008;
const Z6 = () => [0, 0, 0, 0, 0, 0];
const r6 = (x) => Math.round(x * 1e6) / 1e6;

export class Trapezoid {
  constructor(D, v, a, T = null) {
    this.D = Math.abs(D);
    v = Math.abs(v); a = Math.abs(a);
    if (this.D < 1e-12) { this.T = 0; this.ta = 0; this.vp = 0; this.ap = 0; return; }
    if (T !== null && T !== undefined && T > 0) {
      const Tmin = new Trapezoid(D, v, a).T;
      T = Math.max(T, Tmin);
      let ta = Math.min(T / 2, a > 0 ? v / a : T / 2);
      ta = Math.min(ta, T / 2);
      const vp = this.D / (T - ta);
      this.T = T; this.ta = ta; this.vp = vp; this.ap = ta > 0 ? vp / ta : 0;
      return;
    }
    let ta = v / a;
    if (a * ta * ta >= this.D) {
      ta = Math.sqrt(this.D / a);
      this.vp = a * ta;
      this.T = 2 * ta;
    } else {
      this.vp = v;
      this.T = ta + this.D / v;
    }
    this.ta = ta; this.ap = a;
  }

  at(t) {
    if (this.T <= 0) return [this.D, 0, 0];
    t = Math.max(0, Math.min(this.T, t));
    const { ta, T, vp, ap } = this;
    if (t < ta) return [0.5 * ap * t * t, ap * t, ap];
    if (t <= T - ta) return [0.5 * ap * ta * ta + vp * (t - ta), vp, 0];
    const tr = T - t;
    return [this.D - 0.5 * ap * tr * tr, ap * tr, -ap];
  }
}

export class Quintic {
  constructor(D, T) { this.D = D; this.T = Math.max(T, 1e-9); }
  at(t) {
    const T = this.T, u = Math.max(0, Math.min(1, t / T));
    return [this.D * (10 * u ** 3 - 15 * u ** 4 + 6 * u ** 5),
            this.D * (30 * u ** 2 - 60 * u ** 3 + 30 * u ** 4) / T,
            this.D * (60 * u - 180 * u ** 2 + 120 * u ** 3) / (T * T)];
  }
}

export class MoveJ {
  constructor(q0, q1, v = 1.05, a = 1.4, t = null) {
    this.kind = 'movej';
    this.q0 = q0.slice(); this.q1 = q1.slice();
    this.dq = this.q1.map((b, i) => b - this.q0[i]);
    let lead = 0;
    for (let i = 1; i < 6; i++) if (Math.abs(this.dq[i]) > Math.abs(this.dq[lead])) lead = i;
    this.lead = lead;
    this.D = Math.abs(this.dq[lead]);
    this.prof = new Trapezoid(this.D, v, a, t);
    this.T = this.prof.T;
  }
  sample(t) {
    const [s, sd, sdd] = this.prof.at(t);
    if (this.D < 1e-12) return [this.q1.slice(), Z6(), Z6()];
    const k = s / this.D, kd = sd / this.D, kdd = sdd / this.D;
    return [this.q0.map((a, i) => a + k * this.dq[i]), this.dq.map((d) => kd * d), this.dq.map((d) => kdd * d)];
  }
}

class CartesianSegment {
  constructor(model, q0, tcp, v, a, t) {
    this.m = getModel(model);
    this.tcp = tcp;
    this.q0 = q0.slice();
    this.T0 = K.fk(this.m, q0, tcp);
    this.v = v; this.a = a; this._t = t;
  }
  _setup(L) { this.L = L; this.prof = new Trapezoid(L, this.v, this.a, this._t); this.T = this.prof.T; }
  sampleT(t) { return this.poseT(this.prof.at(t)[0]); }
}

const toT = (x) => (Array.isArray(x[0]) ? x : S.poseToT(x));

export class MoveL extends CartesianSegment {
  constructor(model, q0, target, v = 0.25, a = 1.2, tcp = null, t = null) {
    super(model, q0, tcp, v, a, t);
    this.kind = 'movel';
    this.T1 = toT(target);
    this.p0 = S.Tp(this.T0); this.p1 = S.Tp(this.T1);
    this.R0 = S.TR(this.T0); this.R1 = S.TR(this.T1);
    this.qa = S.matToQuat(this.R0); this.qb = S.matToQuat(this.R1);
    this.dp = S.norm(S.sub(this.p1, this.p0));
    this.ang = S.rotAngleBetween(this.R0, this.R1);
    this._setup(this.dp > 1e-6 ? this.dp : this.ang);
  }
  poseT(s) {
    const u = this.L < 1e-12 ? 0 : s / this.L;
    const p = this.p0.map((a, i) => a + u * (this.p1[i] - a));
    return S.makeT(S.quatToMat(S.quatSlerp(this.qa, this.qb, u)), p);
  }
}

export class MoveC extends CartesianSegment {
  constructor(model, q0, via, target, v = 0.25, a = 1.2, tcp = null, t = null) {
    super(model, q0, tcp, v, a, t);
    this.kind = 'movec';
    const Tv = toT(via);
    this.T1 = toT(target);
    const p0 = S.Tp(this.T0), p1 = S.Tp(Tv), p2 = S.Tp(this.T1);
    const a_ = S.sub(p1, p0), b_ = S.sub(p2, p0);
    const axb = S.cross(a_, b_);
    const n2 = S.dot(axb, axb);
    if (n2 < 1e-14) throw new Error('movec: points are collinear');
    const c = S.add(p0, S.scale(S.add(S.scale(S.cross(axb, a_), S.dot(b_, b_)), S.scale(S.cross(b_, axb), S.dot(a_, a_))), 0.5 / n2));
    this.c = c;
    this.n = S.normalize(axb);
    this.e1 = S.normalize(S.sub(p0, c));
    this.e2 = S.cross(this.n, this.e1);
    this.r = S.norm(S.sub(p0, c));
    const v2 = S.sub(p2, c);
    this.phi = Math.atan2(S.dot(v2, this.e2), S.dot(v2, this.e1));
    if (this.phi <= 0) this.phi += 2 * Math.PI;
    this.qa = S.matToQuat(S.TR(this.T0));
    this.qb = S.matToQuat(S.TR(this.T1));
    this._setup(this.r * this.phi);
  }
  poseT(s) {
    const u = this.L < 1e-12 ? 0 : s / this.L;
    const ang = u * this.phi;
    const p = S.add(this.c, S.add(S.scale(this.e1, this.r * Math.cos(ang)), S.scale(this.e2, this.r * Math.sin(ang))));
    return S.makeT(S.quatToMat(S.quatSlerp(this.qa, this.qb, u)), p);
  }
}

export class Wait {
  constructor(q, t) { this.kind = 'wait'; this.q = q.slice(); this.T = Math.max(0, t); }
  sample() { return [this.q.slice(), Z6(), Z6()]; }
}

export class Trajectory {
  constructor(dt) {
    this.dt = dt;
    this.t = []; this.q = []; this.qd = []; this.qdd = [];
    this.events = []; this.warnings = []; this.segments = [];
  }
  get duration() { return this.t.length ? this.t[this.t.length - 1] : 0; }
  toDict() {
    return { dt: this.dt, t: this.t, q: this.q, qd: this.qd, qdd: this.qdd, events: this.events, warnings: this.warnings, segments: this.segments };
  }
  /** Linear interpolation of q at time t (for playback). */
  qAt(t) {
    const ts = this.t;
    if (!ts.length) return null;
    if (t <= ts[0]) return this.q[0].slice();
    if (t >= ts[ts.length - 1]) return this.q[ts.length - 1].slice();
    let lo = 0, hi = ts.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (ts[mid] <= t) lo = mid; else hi = mid; }
    const u = (t - ts[lo]) / (ts[hi] - ts[lo]);
    return this.q[lo].map((x, i) => x + u * (this.q[hi][i] - x));
  }
}

function appendJointSegment(traj, seg, t0) {
  const n = Math.max(1, Math.ceil(seg.T / traj.dt - 1e-9));
  for (let k = 1; k <= n; k++) {
    const tt = Math.min(seg.T, k * traj.dt);
    const [q, qd, qdd] = seg.sample(tt);
    traj.t.push(t0 + tt); traj.q.push(q); traj.qd.push(qd); traj.qdd.push(qdd);
  }
  return t0 + seg.T;
}

function appendCartSegment(traj, m, seg, t0, qPrev, checkSpeed = true) {
  const n = Math.max(1, Math.ceil(seg.T / traj.dt - 1e-9));
  const qs = [qPrev.slice()], ts = [0];
  for (let k = 1; k <= n; k++) {
    const tt = Math.min(seg.T, k * traj.dt);
    let q;
    try {
      q = K.ikClosest(m, seg.sampleT(tt), qs[qs.length - 1], seg.tcp);
    } catch (e) {
      if (e instanceof K.Unreachable) traj.warnings.push([r6(t0 + tt), `${seg.kind}: 경로 중 도달 불가 (작업영역/관절 한계)`]);
      throw e;
    }
    qs.push(q); ts.push(tt);
  }
  const N = qs.length;
  const qd = qs.map(() => Z6());
  for (let k = 1; k < N - 1; k++) {
    const h = ts[k + 1] - ts[k - 1];
    qd[k] = qs[k].map((_, i) => (h > 0 ? (qs[k + 1][i] - qs[k - 1][i]) / h : 0));
  }
  const qdd = qs.map(() => Z6());
  for (let k = 1; k < N - 1; k++) {
    const h = ts[k + 1] - ts[k - 1];
    qdd[k] = qs[k].map((_, i) => (h > 0 ? (qd[k + 1][i] - qd[k - 1][i]) / h : 0));
  }
  let warned = false;
  for (let k = 1; k < N; k++) {
    if (checkSpeed && !warned) {
      for (let i = 0; i < 6; i++) {
        if (Math.abs(qd[k][i]) > m.vmax[i] * 1.0001) {
          traj.warnings.push([r6(t0 + ts[k]), `${seg.kind}: 관절 ${i + 1} 속도 한계 초과 (${Math.abs(qd[k][i]).toFixed(2)} rad/s) — 특이점 근처?`]);
          warned = true;
          break;
        }
      }
    }
    traj.t.push(t0 + ts[k]); traj.q.push(qs[k]); traj.qd.push(qd[k]); traj.qdd.push(qdd[k]);
  }
  return [t0 + seg.T, qs[N - 1]];
}

export function planProgram(model, q0, commands, tcp = null, dt = DT) {
  const m = getModel(model);
  const traj = new Trajectory(dt);
  let q = q0.slice();
  let t = 0;
  traj.t.push(0); traj.q.push(q.slice()); traj.qd.push(Z6()); traj.qdd.push(Z6());
  const opt = (c, k, d) => (c[k] === undefined || c[k] === null ? d : c[k]);
  for (const c of commands) {
    const kind = c.type;
    if (kind === 'movej') {
      let target = c.q;
      if (target === undefined || target === null) target = K.ikClosest(m, c.pose, q, tcp);
      if (!m.withinLimits(target)) throw new K.Unreachable('movej: joint target outside limits');
      const seg = new MoveJ(q, target, opt(c, 'v', 1.05), opt(c, 'a', 1.4), opt(c, 't', null));
      const t1 = appendJointSegment(traj, seg, t);
      traj.segments.push([r6(t), r6(t1), 'movej']);
      t = t1; q = target.slice();
    } else if (kind === 'movel' || kind === 'movec') {
      const seg = kind === 'movel'
        ? new MoveL(m, q, c.pose, opt(c, 'v', 0.25), opt(c, 'a', 1.2), tcp, opt(c, 't', null))
        : new MoveC(m, q, c.via, c.pose, opt(c, 'v', 0.25), opt(c, 'a', 1.2), tcp, opt(c, 't', null));
      const [t1, q1] = appendCartSegment(traj, m, seg, t, q);
      traj.segments.push([r6(t), r6(t1), kind]);
      t = t1; q = q1;
    } else if (kind === 'wait') {
      const seg = new Wait(q, opt(c, 't', 0.5));
      if (seg.T > 0) {
        const t1 = appendJointSegment(traj, seg, t);
        traj.segments.push([r6(t), r6(t1), 'wait']);
        t = t1;
      }
    } else if (kind === 'tcp') {
      tcp = c.pose.slice();
      traj.events.push([r6(t), 'tcp', tcp]);
    } else if (kind === 'tool') {
      traj.events.push([r6(t), 'tool', c.on === undefined ? true : !!c.on]);
    } else if (kind === 'payload') {
      traj.events.push([r6(t), 'payload', { mass: opt(c, 'mass', 0), cog: opt(c, 'cog', [0, 0, 0]) }]);
    } else if (kind === 'mark') {
      traj.events.push([r6(t), 'mark', opt(c, 'label', '')]);
    } else {
      throw new Error(`unknown command ${kind}`);
    }
  }
  return traj;
}
