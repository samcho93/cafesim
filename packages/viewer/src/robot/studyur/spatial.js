// Vendored from studyUR (a8adb01) assets/js/ur/spatial.js by tools/sync-studyur.mjs - do not edit here.
// spatial.js — small spatial-math toolbox. Mirror of python/urrobot/spatial.py.
// Vectors: [x,y,z]; rotation: 3x3 row-major nested arrays; transforms: 4x4.
// RPY = URDF convention R = Rz(yaw) Ry(pitch) Rx(roll). Rotation vector = axis*angle (UR rx,ry,rz).

export const PI = Math.PI;

// ------------------------------------------------------------------ vectors
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a) => Math.sqrt(dot(a, a));
export function normalize(a) {
  const n = norm(a);
  return n > 1e-15 ? [a[0] / n, a[1] / n, a[2] / n] : [0, 0, 0];
}

// ------------------------------------------------------------------ 3x3
export const eye3 = () => [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
export function mat3Mul(a, b) {
  const r = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
  return r;
}
export const mat3Vec = (a, v) => [
  a[0][0] * v[0] + a[0][1] * v[1] + a[0][2] * v[2],
  a[1][0] * v[0] + a[1][1] * v[1] + a[1][2] * v[2],
  a[2][0] * v[0] + a[2][1] * v[1] + a[2][2] * v[2]];
export const transpose3 = (a) => [[a[0][0], a[1][0], a[2][0]], [a[0][1], a[1][1], a[2][1]], [a[0][2], a[1][2], a[2][2]]];

export function rotX(t) { const c = Math.cos(t), s = Math.sin(t); return [[1, 0, 0], [0, c, -s], [0, s, c]]; }
export function rotY(t) { const c = Math.cos(t), s = Math.sin(t); return [[c, 0, s], [0, 1, 0], [-s, 0, c]]; }
export function rotZ(t) { const c = Math.cos(t), s = Math.sin(t); return [[c, -s, 0], [s, c, 0], [0, 0, 1]]; }
export const rpyToMat = (rpy) => mat3Mul(rotZ(rpy[2]), mat3Mul(rotY(rpy[1]), rotX(rpy[0])));

export function matToRpy(R) {
  const sp = Math.max(-1, Math.min(1, -R[2][0]));
  const pitch = Math.asin(sp);
  let roll, yaw;
  if (Math.abs(sp) > 1 - 1e-12) {
    roll = 0;
    yaw = Math.atan2(-R[0][1], R[1][1]);
  } else {
    roll = Math.atan2(R[2][1], R[2][2]);
    yaw = Math.atan2(R[1][0], R[0][0]);
  }
  return [roll, pitch, yaw];
}

export function rotvecToMat(v) {
  const th = norm(v);
  if (th < 1e-12) return eye3();
  const x = v[0] / th, y = v[1] / th, z = v[2] / th;
  const c = Math.cos(th), s = Math.sin(th), C = 1 - c;
  return [[c + x * x * C, x * y * C - z * s, x * z * C + y * s],
          [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
          [z * x * C - y * s, z * y * C + x * s, c + z * z * C]];
}

export function matToRotvec(R) {
  const tr = R[0][0] + R[1][1] + R[2][2];
  const c = Math.max(-1, Math.min(1, (tr - 1) / 2));
  const th = Math.acos(c);
  if (th < 1e-9) return [0, 0, 0];
  if (th > PI - 1e-6) {
    const xx = (R[0][0] + 1) / 2, yy = (R[1][1] + 1) / 2, zz = (R[2][2] + 1) / 2;
    let x, y, z;
    if (xx >= yy && xx >= zz) {
      x = Math.sqrt(Math.max(xx, 0)); y = (R[0][1] + R[1][0]) / (4 * x); z = (R[0][2] + R[2][0]) / (4 * x);
    } else if (yy >= zz) {
      y = Math.sqrt(Math.max(yy, 0)); x = (R[0][1] + R[1][0]) / (4 * y); z = (R[1][2] + R[2][1]) / (4 * y);
    } else {
      z = Math.sqrt(Math.max(zz, 0)); x = (R[0][2] + R[2][0]) / (4 * z); y = (R[1][2] + R[2][1]) / (4 * z);
    }
    return scale(normalize([x, y, z]), th);
  }
  const s = 2 * Math.sin(th);
  return scale([(R[2][1] - R[1][2]) / s, (R[0][2] - R[2][0]) / s, (R[1][0] - R[0][1]) / s], th);
}

export function matToQuat(R) {
  const tr = R[0][0] + R[1][1] + R[2][2];
  let q, s;
  if (tr > 0) {
    s = Math.sqrt(tr + 1) * 2;
    q = [0.25 * s, (R[2][1] - R[1][2]) / s, (R[0][2] - R[2][0]) / s, (R[1][0] - R[0][1]) / s];
  } else if (R[0][0] > R[1][1] && R[0][0] > R[2][2]) {
    s = Math.sqrt(1 + R[0][0] - R[1][1] - R[2][2]) * 2;
    q = [(R[2][1] - R[1][2]) / s, 0.25 * s, (R[0][1] + R[1][0]) / s, (R[0][2] + R[2][0]) / s];
  } else if (R[1][1] > R[2][2]) {
    s = Math.sqrt(1 + R[1][1] - R[0][0] - R[2][2]) * 2;
    q = [(R[0][2] - R[2][0]) / s, (R[0][1] + R[1][0]) / s, 0.25 * s, (R[1][2] + R[2][1]) / s];
  } else {
    s = Math.sqrt(1 + R[2][2] - R[0][0] - R[1][1]) * 2;
    q = [(R[1][0] - R[0][1]) / s, (R[0][2] + R[2][0]) / s, (R[1][2] + R[2][1]) / s, 0.25 * s];
  }
  if (q[0] < 0) q = q.map((x) => -x);
  const n = Math.sqrt(q.reduce((a, x) => a + x * x, 0));
  return q.map((x) => x / n);
}

export function quatToMat(q) {
  const [w, x, y, z] = q;
  return [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
          [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
          [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]];
}

export function quatSlerp(q0, q1, t) {
  let d = q0[0] * q1[0] + q0[1] * q1[1] + q0[2] * q1[2] + q0[3] * q1[3];
  if (d < 0) { q1 = q1.map((x) => -x); d = -d; }
  let q;
  if (d > 0.9995) {
    q = q0.map((a, i) => a + t * (q1[i] - a));
  } else {
    const th = Math.acos(Math.min(1, d));
    const s0 = Math.sin((1 - t) * th) / Math.sin(th);
    const s1 = Math.sin(t * th) / Math.sin(th);
    q = q0.map((a, i) => s0 * a + s1 * q1[i]);
  }
  const n = Math.sqrt(q.reduce((a, x) => a + x * x, 0));
  return q.map((x) => x / n);
}

export function rotAngleBetween(Ra, Rb) {
  const Rr = mat3Mul(transpose3(Ra), Rb);
  const c = Math.max(-1, Math.min(1, (Rr[0][0] + Rr[1][1] + Rr[2][2] - 1) / 2));
  return Math.acos(c);
}

// ------------------------------------------------------------------ 4x4
export const eye4 = () => [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
export const makeT = (R, p) => [[R[0][0], R[0][1], R[0][2], p[0]], [R[1][0], R[1][1], R[1][2], p[1]],
                                [R[2][0], R[2][1], R[2][2], p[2]], [0, 0, 0, 1]];
export const TR = (T) => [[T[0][0], T[0][1], T[0][2]], [T[1][0], T[1][1], T[1][2]], [T[2][0], T[2][1], T[2][2]]];
export const Tp = (T) => [T[0][3], T[1][3], T[2][3]];
export function mat4Mul(a, b) {
  const r = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    r[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j] + a[i][3] * b[3][j];
  }
  return r;
}
export function invT(T) {
  const Rt = transpose3(TR(T));
  const p = mat3Vec(Rt, Tp(T));
  return makeT(Rt, [-p[0], -p[1], -p[2]]);
}
export const Tpoint = (T, v) => [
  T[0][0] * v[0] + T[0][1] * v[1] + T[0][2] * v[2] + T[0][3],
  T[1][0] * v[0] + T[1][1] * v[1] + T[1][2] * v[2] + T[1][3],
  T[2][0] * v[0] + T[2][1] * v[1] + T[2][2] * v[2] + T[2][3]];
export const xyzRpyT = (xyz, rpy) => makeT(rpyToMat(rpy), xyz);

export function dhT(theta, d, a, alpha) {
  const ct = Math.cos(theta), st = Math.sin(theta), ca = Math.cos(alpha), sa = Math.sin(alpha);
  return [[ct, -st * ca, st * sa, a * ct], [st, ct * ca, -ct * sa, a * st], [0, sa, ca, d], [0, 0, 0, 1]];
}

// ------------------------------------------------------------------ poses (UR p[...])
export const poseToT = (p) => makeT(rotvecToMat(p.slice(3, 6)), p.slice(0, 3));
export const TtoPose = (T) => Tp(T).concat(matToRotvec(TR(T)));
export const poseTrans = (a, b) => TtoPose(mat4Mul(poseToT(a), poseToT(b)));
export const poseInv = (p) => TtoPose(invT(poseToT(p)));
export const poseDist = (a, b) => norm(sub(a.slice(0, 3), b.slice(0, 3)));

// ------------------------------------------------------------------ linear algebra
export function solve(A, b) {
  const n = A.length;
  const M = A.map((row, i) => row.map(Number).concat([Number(b[i])]));
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-14) throw new Error('singular matrix');
    if (p !== c) { const t = M[c]; M[c] = M[p]; M[p] = t; }
    const piv = M[c][c];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / piv;
      if (f !== 0) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

export function matmul(A, B) {
  const n = A.length, m = B.length, p = B[0].length;
  const R = [];
  for (let i = 0; i < n; i++) {
    const row = [];
    for (let j = 0; j < p; j++) { let s = 0; for (let k = 0; k < m; k++) s += A[i][k] * B[k][j]; row.push(s); }
    R.push(row);
  }
  return R;
}
export const transpose = (A) => A[0].map((_, j) => A.map((r) => r[j]));

export function det(A) {
  const n = A.length;
  const M = A.map((r) => r.map(Number));
  let d = 1;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-300) return 0;
    if (p !== c) { const t = M[c]; M[c] = M[p]; M[p] = t; d = -d; }
    d *= M[c][c];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k < n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return d;
}

export function symEig(A, iters = 100) {
  const n = A.length;
  const M = A.map((r) => r.map(Number));
  for (let it = 0; it < iters; it++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j) off += M[i][j] ** 2;
    if (off < 1e-22) break;
    for (let p = 0; p < n - 1; p++) for (let q = p + 1; q < n; q++) {
      if (Math.abs(M[p][q]) < 1e-300) continue;
      const th = 0.5 * Math.atan2(2 * M[p][q], M[q][q] - M[p][p]);
      const c = Math.cos(th), s = Math.sin(th);
      for (let k = 0; k < n; k++) { const a = M[k][p], b = M[k][q]; M[k][p] = c * a - s * b; M[k][q] = s * a + c * b; }
      for (let k = 0; k < n; k++) { const a = M[p][k], b = M[q][k]; M[p][k] = c * a - s * b; M[q][k] = s * a + c * b; }
    }
  }
  return M.map((r, i) => r[i]).sort((a, b) => b - a);
}

// Python math.fmod semantics (sign of dividend) — same as JS %.
export function wrapPi(a) {
  a = (a + PI) % (2 * PI);
  if (a <= 0) a += 2 * PI;
  return a - PI;
}
