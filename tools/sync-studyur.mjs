#!/usr/bin/env node
/**
 * Vendor the UR robot pieces of studyUR (https://github.com/samcho93/studyUR) into cafeSim:
 *   - kinematics / URDF generator modules  -> packages/viewer/src/robot/studyur/
 *   - UR model + tool data (models.json, tools.json) -> packages/viewer/public/ur/
 *   - official UR meshes (BSD-3-Clause)    -> packages/viewer/public/ur/models/<model>/
 *
 *   node tools/sync-studyur.mjs [--from ../strudyUR] [--models ur5e,ur3e]
 * Without --from (and no local checkout) the files are downloaded from GitHub (main branch).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d);
const localCandidates = [opt('from', null), path.join(root, '..', 'studyUR'), path.join(root, '..', 'strudyUR')].filter(Boolean);
const src = localCandidates.find((p) => fs.existsSync(path.join(p, 'assets/js/ur/kinematics.js')));
const RAW = 'https://raw.githubusercontent.com/samcho93/studyUR/main/';
const models = opt('models', 'ur5e').split(',');

const MODULES = ['spatial.js', 'model.js', 'kinematics.js', 'urdf.js', 'trajectory.js'];
const PARTS = ['base', 'shoulder', 'upperarm', 'forearm', 'wrist1', 'wrist2', 'wrist3'];

async function read(rel) {
  if (src) return fs.readFileSync(path.join(src, rel));
  const res = await fetch(RAW + rel);
  if (!res.ok) throw new Error(`${res.status} ${RAW + rel}`);
  return Buffer.from(await res.arrayBuffer());
}

function write(rel, data) {
  const out = path.join(root, rel);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, data);
  return out;
}

const outJs = 'packages/viewer/src/robot/studyur';
const outPub = 'packages/viewer/public/ur';
let commit = 'main';
if (src) {
  try {
    const head = fs.readFileSync(path.join(src, '.git/HEAD'), 'utf8').trim();
    commit = head.startsWith('ref:') ? fs.readFileSync(path.join(src, '.git', head.slice(5)), 'utf8').trim().slice(0, 7) : head.slice(0, 7);
  } catch {}
}
console.log(`studyUR source: ${src ?? RAW} (${commit})`);

for (const m of MODULES) {
  const text = (await read(`assets/js/ur/${m}`)).toString('utf8');
  write(`${outJs}/${m}`, `// Vendored from studyUR (${commit}) assets/js/ur/${m} by tools/sync-studyur.mjs - do not edit here.\n${text}`);
}
for (const j of ['models.json', 'tools.json']) write(`${outPub}/${j}`, await read(`python/urrobot/data/${j}`));
write(`${outPub}/models/LICENSE-ur_description.txt`, await read('assets/models/LICENSE-ur_description.txt'));
for (const m of models) {
  for (const p of PARTS) {
    for (const [kind, ext] of [['visual', 'dae'], ['collision', 'stl']]) {
      try {
        write(`${outPub}/models/${m}/${kind}/${p}.${ext}`, await read(`assets/models/${m}/${kind}/${p}.${ext}`));
      } catch (e) {
        if (kind === 'visual') throw e;
      }
    }
  }
}
write(`${outJs}/VERSION`, `studyUR ${commit}\nmodels: ${models.join(', ')}\n`);
console.log(`vendored ${MODULES.length} modules, data and meshes (${models.join(', ')})`);
