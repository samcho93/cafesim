// Vendored from studyUR (a8adb01) assets/js/ur/kinematics.js by tools/sync-studyur.mjs - do not edit here.
// kinematics.js — UR kinematics. Mirror of python/urrobot/kinematics.py (same formulas, same solution order).
// base = DH frame 0 (UR Base), tool0 = DH frame 6, TCP = tool0 ⊕ tcp.
import * as S from './spatial.js';
import { getModel } from './model.js';

export class Unreachable extends Error {}

// ------------------------------------------------------------------ forward
export function dhFrames(model, q) {
  const m = getModel(model);
  let T = S.eye4();
  const out = [T];
  for (let i = 0; i < 6; i++) {
    T = S.mat4Mul(T, S.dhT(q[i], m.d[i], m.a[i], m.alpha[i]));
    out.push(T);
  }
  return out;
}

export const tcpT = (tcp) => (tcp ? S.poseToT(tcp) : S.eye4());
const hasTcp = (tcp) => !!tcp && tcp.length > 0;

export function fk(model, q, tcp = null) {
  const T = dhFrames(model, q)[6];
  return hasTcp(tcp) ? S.mat4Mul(T, tcpT(tcp)) : T;
}

export const fkPose = (model, q, tcp = null) => S.TtoPose(fk(model, q, tcp));

/** URDF joint frames in base (= base_link_inertia) and tool0. */
export function urdfFrames(model, q) {
  const m = getModel(model);
  let T = S.eye4();
  const frames = [];
  m.joints.forEach((j, i) => {
    T = S.mat4Mul(T, S.xyzRpyT(j.origin.xyz, j.origin.rpy));
    T = S.mat4Mul(T, S.makeT(S.rotZ(q[i]), [0, 0, 0]));
    frames.push(T);
  });
  const flange = S.mat4Mul(frames[5], S.xyzRpyT([0, 0, 0], [0, -S.PI / 2, -S.PI / 2]));
  const tool0 = S.mat4Mul(flange, S.xyzRpyT([0, 0, 0], [S.PI / 2, 0, S.PI / 2]));
  return { frames, tool0 };
}

// ------------------------------------------------------------------ inverse (analytic, Hawkins 2013)
const clamp1 = (x) => Math.max(-1, Math.min(1, x));

/** 8 entries (null when that branch has no real solution). target: 4x4 or pose p[...]. */
export function ikAll(model, target, tcp = null) {
  const m = getModel(model);
  let T = Array.isArray(target[0]) ? target : S.poseToT(target);
  if (hasTcp(tcp)) T = S.mat4Mul(T, S.invT(tcpT(tcp)));
  const d1 = m.d[0], d4 = m.d[3], d5 = m.d[4], d6 = m.d[5];
  const a2 = m.a[1], a3 = m.a[2];
  const R = S.TR(T);
  const p06 = S.Tp(T);
  const p05 = S.Tpoint(T, [0, 0, -d6]);
  const out = [];
  const r = Math.hypot(p05[0], p05[1]);
  for (const s1 of [1, -1]) {
    if (r < Math.abs(d4) - 1e-12) { out.push(null, null, null, null); continue; }
    const c = clamp1(d4 / r);
    const th1 = Math.atan2(p05[1], p05[0]) + s1 * Math.acos(c) + S.PI / 2;
    const c1 = Math.cos(th1), sn1 = Math.sin(th1);
    for (const s5 of [1, -1]) {
      const v = (p06[0] * sn1 - p06[1] * c1 - d4) / d6;
      if (Math.abs(v) > 1 + 1e-9) { out.push(null, null); continue; }
      const th5 = s5 * Math.acos(clamp1(v));
      const sn5 = Math.sin(th5);
      let th6;
      if (Math.abs(sn5) < 1e-10) th6 = 0;
      else th6 = Math.atan2((-R[0][1] * sn1 + R[1][1] * c1) / sn5, (R[0][0] * sn1 - R[1][0] * c1) / sn5);
      const T01 = S.dhT(th1, d1, 0, m.alpha[0]);
      const T45 = S.dhT(th5, d5, 0, m.alpha[4]);
      const T56 = S.dhT(th6, d6, 0, m.alpha[5]);
      const T14 = S.mat4Mul(S.mat4Mul(S.invT(T01), T), S.invT(S.mat4Mul(T45, T56)));
      const P13 = S.Tpoint(T14, [0, -d4, 0]);
      const L = Math.hypot(P13[0], P13[1]);
      const c3 = (P13[0] ** 2 + P13[1] ** 2 - a2 * a2 - a3 * a3) / (2 * a2 * a3);
      for (const s3 of [1, -1]) {
        if (Math.abs(c3) > 1 + 1e-9) { out.push(null); continue; }
        const th3 = s3 * Math.acos(clamp1(c3));
        const th2 = -Math.atan2(P13[1], -P13[0]) + Math.asin(clamp1(a3 * Math.sin(th3) / L));
        const T12 = S.dhT(th2, 0, a2, 0);
        const T23 = S.dhT(th3, 0, a3, 0);
        const T34 = S.mat4Mul(S.invT(S.mat4Mul(T12, T23)), T14);
        const th4 = Math.atan2(T34[1][0], T34[0][0]);
        out.push([th1, th2, th3, th4, th5, th6].map(S.wrapPi));
      }
    }
  }
  return out;
}

export function ik(model, target, tcp = null, checkLimits = true) {
  const m = getModel(model);
  let sols = ikAll(m, target, tcp).filter((s) => s !== null);
  if (checkLimits) sols = sols.filter((s) => m.withinLimits(s));
  return sols;
}

export function nearestEquivalent(model, q, qRef) {
  const m = getModel(model);
  const out = [];
  for (let i = 0; i < 6; i++) {
    let best = null;
    for (const k of [-2, -1, 0, 1, 2]) {
      const v = q[i] + k * 2 * S.PI;
      if (m.lower[i] - 1e-9 <= v && v <= m.upper[i] + 1e-9) {
        if (best === null || Math.abs(v - qRef[i]) < Math.abs(best - qRef[i])) best = v;
      }
    }
    if (best === null) return null;
    out.push(best);
  }
  return out;
}

export function ikClosest(model, target, qRef, tcp = null) {
  const m = getModel(model);
  let best = null, bd = Infinity;
  for (const s of ikAll(m, target, tcp)) {
    if (s === null) continue;
    const s2 = nearestEquivalent(m, s, qRef);
    if (s2 === null) continue;
    let dd = 0;
    for (let i = 0; i < 6; i++) dd += (s2[i] - qRef[i]) ** 2;
    if (dd < bd - 1e-12) { best = s2; bd = dd; }
  }
  if (best === null) throw new Unreachable('no IK solution');
  return best;
}

export function tryIkClosest(model, target, qRef, tcp = null) {
  try { return ikClosest(model, target, qRef, tcp); } catch (e) { if (e instanceof Unreachable) return null; throw e; }
}

export function configFlags(model, q) {
  const m = getModel(model);
  const T = dhFrames(m, q);
  const p05 = S.Tpoint(T[6], [0, 0, -m.d[5]]);
  const phi = Math.atan2(p05[1], p05[0]) + S.PI / 2;
  const shoulder = S.wrapPi(q[0] - phi) >= 0 ? 1 : -1;
  const wrist = S.wrapPi(q[4]) >= 0 ? 1 : -1;
  const elbow = S.wrapPi(q[2]) >= 0 ? 1 : -1;
  return { shoulder, wrist, elbow, index: (shoulder > 0 ? 0 : 4) + (wrist > 0 ? 0 : 2) + (elbow > 0 ? 0 : 1) };
}

// ------------------------------------------------------------------ jacobian & singularities
export function jacobian(model, q, tcp = null) {
  const T = dhFrames(model, q);
  const pe = S.Tp(hasTcp(tcp) ? S.mat4Mul(T[6], tcpT(tcp)) : T[6]);
  const J = [0, 1, 2, 3, 4, 5].map(() => [0, 0, 0, 0, 0, 0]);
  for (let i = 0; i < 6; i++) {
    const z = [T[i][0][2], T[i][1][2], T[i][2][2]];
    const v = S.cross(z, S.sub(pe, S.Tp(T[i])));
    for (let k = 0; k < 3; k++) { J[k][i] = v[k]; J[k + 3][i] = z[k]; }
  }
  return J;
}

export const manipulability = (J) => Math.sqrt(Math.max(0, S.det(S.matmul(J, S.transpose(J)))));
export const singularValues = (J) => S.symEig(S.matmul(J, S.transpose(J))).map((e) => Math.sqrt(Math.max(0, e)));
export function conditionNumber(J) {
  const sv = singularValues(J);
  return sv[sv.length - 1] < 1e-12 ? Infinity : sv[0] / sv[sv.length - 1];
}

export function singularity(model, q) {
  const m = getModel(model);
  const shoulder = m.a[1] * Math.cos(q[1]) + m.a[2] * Math.cos(q[1] + q[2]) + m.d[4] * Math.sin(q[1] + q[2] + q[3]);
  return { wrist: Math.sin(q[4]), elbow: Math.sin(q[2]), shoulder };
}

export function singularityReport(model, q, tol = null) {
  tol = tol || { wrist: 0.05, elbow: 0.05, shoulder: 0.02 };
  const s = singularity(model, q);
  return { wrist: Math.abs(s.wrist) < tol.wrist, elbow: Math.abs(s.elbow) < tol.elbow, shoulder: Math.abs(s.shoulder) < tol.shoulder };
}

// ------------------------------------------------------------------ numeric IK (DLS)
export function poseError(Tc, Tt) {
  const dp = S.sub(S.Tp(Tt), S.Tp(Tc));
  const Rerr = S.mat3Mul(S.TR(Tt), S.transpose3(S.TR(Tc)));
  return dp.concat(S.matToRotvec(Rerr));
}

export function ikDls(model, target, q0, tcp = null, { damping = 0.05, iters = 200, tol = 1e-9, step = 1.0 } = {}) {
  const m = getModel(model);
  const Tt = Array.isArray(target[0]) ? target : S.poseToT(target);
  let q = q0.slice();
  const lam2 = damping * damping;
  let err = Infinity;
  for (let it = 1; it <= iters; it++) {
    const e = poseError(fk(m, q, tcp), Tt);
    err = S.norm(e.slice(0, 3)) + S.norm(e.slice(3, 6));
    if (err < tol) return { q, iterations: it - 1, error: err, converged: true };
    const J = jacobian(m, q, tcp);
    const JJt = S.matmul(J, S.transpose(J));
    for (let k = 0; k < 6; k++) JJt[k][k] += lam2;
    const y = S.solve(JJt, e);
    const dq = [0, 1, 2, 3, 4, 5].map((c) => { let s = 0; for (let r = 0; r < 6; r++) s += J[r][c] * y[r]; return s; });
    q = q.map((x, i) => x + step * dq[i]);
  }
  return { q, iterations: iters, error: err, converged: err < tol };
}

export function wristCenter(model, q) {
  const m = getModel(model);
  return S.Tpoint(dhFrames(m, q)[6], [0, 0, -m.d[5]]);
}
