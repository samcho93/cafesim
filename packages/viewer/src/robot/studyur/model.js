// Vendored from studyUR (a8adb01) assets/js/ur/model.js by tools/sync-studyur.mjs - do not edit here.
// model.js — UR model data + tool catalog. Mirror of python/urrobot/model.py.
// Data comes from python/urrobot/data/{models,tools}.json — call setData() (browser: loadData()).

export const JOINT_NAMES = ['shoulder_pan_joint', 'shoulder_lift_joint', 'elbow_joint',
  'wrist_1_joint', 'wrist_2_joint', 'wrist_3_joint'];
export const JOINT_LABELS = ['Base', 'Shoulder', 'Elbow', 'Wrist 1', 'Wrist 2', 'Wrist 3'];
export const HOME = [0, -Math.PI / 2, 0, -Math.PI / 2, 0, 0];
export const READY = [0, -1.9, 1.9, -1.571, -1.571, 0];
export const GRAVITY = 9.80665;

let MODELS = null;
let TOOLS = null;

export function setData(models, tools) {
  MODELS = models.models || models;
  if (tools) TOOLS = tools.tools || tools;
}

/** Fetch models.json + tools.json relative to the site root (base = '../' from sim/ or tools/). */
export async function loadData(base = '../') {
  const [m, t] = await Promise.all([
    fetch(base + 'python/urrobot/data/models.json').then((r) => r.json()),
    fetch(base + 'python/urrobot/data/tools.json').then((r) => r.json()),
  ]);
  setData(m, t);
  return { models: MODELS, tools: TOOLS };
}

export const models = () => MODELS;
export const tools = () => TOOLS;

export class URModel {
  constructor(name = 'ur5e') {
    if (!MODELS) throw new Error('model data not loaded (call loadData/setData)');
    const data = MODELS[name];
    if (!data) throw new Error(`unknown model ${name}`);
    this.id = name;
    this.data = data;
    this.title = data.title;
    this.d = data.dh.d.slice();
    this.a = data.dh.a.slice();
    this.alpha = data.dh.alpha.slice();
    this.joints = data.joints;
    this.links = data.links;
    this.lower = this.joints.map((j) => j.lower);
    this.upper = this.joints.map((j) => j.upper);
    this.vmax = this.joints.map((j) => j.velocity);
    this.effort = this.joints.map((j) => j.effort);
    this.payload = data.payload;
    this.reach = data.reach;
  }

  withinLimits(q, tol = 1e-9) {
    return q.every((x, i) => this.lower[i] - tol <= x && x <= this.upper[i] + tol);
  }
}

const cache = new Map();
export function getModel(m = 'ur5e') {
  if (m instanceof URModel) return m;
  if (!cache.has(m) || cache.get(m).data !== MODELS[m]) cache.set(m, new URModel(m));
  return cache.get(m);
}

export class Tool {
  constructor(name = 'none', { mass = 0, cog = [0, 0, 0], tcp = [0, 0, 0, 0, 0, 0], title = null, kind = 'none', ...extra } = {}) {
    this.id = name;
    this.title = title || name;
    this.kind = kind;
    this.mass = Number(mass);
    this.cog = cog.map(Number);
    this.tcp = tcp.map(Number);
    this.extra = extra;
  }

  static fromCatalog(name) {
    const t = TOOLS && TOOLS[name];
    if (!t) throw new Error(`unknown tool ${name}`);
    return new Tool(name, t);
  }

  static of(t) {
    if (t == null) return new Tool();
    if (t instanceof Tool) return t;
    if (typeof t === 'string') return Tool.fromCatalog(t);
    const { id, name, ...rest } = t;
    return new Tool(id || name || 'custom', rest);
  }

  toDict() {
    return { id: this.id, title: this.title, kind: this.kind, mass: this.mass, cog: this.cog, tcp: this.tcp };
  }
}
