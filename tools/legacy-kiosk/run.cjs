#!/usr/bin/env node
/**
 * Run the ORIGINAL kiosk application (Electron) against the cafeSim virtual hardware.
 *
 *   npm run kiosk:legacy                                   virtual hardware + virtual Mailbean server (no account needed)
 *   npm run kiosk:legacy -- --cloud https://cafesim.<you>.workers.dev/?room=main
 *   npm run kiosk:legacy -- --real --mac <장비 ID> [--web stg]   real Mailbean server (menus/sales on mailbean.kr)
 *   options: --source ../source  --fullscreen  --debug-port 9222
 *
 * - starts the local simulator server if it is not running (viewer: http://localhost:8700),
 *   or with --cloud a relay to a Cloudflare room (viewer: that URL)
 * - writes ~/settings/settings.json { MacAddr, webMode } (an existing file is backed up once)
 * - launches <source>/node_modules/electron with tools/legacy-kiosk/main-hook.cjs preloaded
 * The application source is not modified.
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const source = path.resolve(opt('source', path.join(root, 'source')));
const webMode = opt('web', process.argv.includes('--real') ? 'stg' : 'was');
const fullscreen = !!opt('fullscreen', false);
const cloud = opt('cloud', null);
const settingsDir = path.join(os.homedir(), 'settings');
const settingsFile = path.join(settingsDir, 'settings.json');

function readExistingMac() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile, 'utf8')).MacAddr;
  } catch {
    return undefined;
  }
}
const real = !!opt('real', false);
const mac = real ? opt('mac', process.env.CAFESIM_MAC ?? readExistingMac()) : opt('mac', 'SIM-M400-0001');

function fail(msg) {
  console.error(`\n[cafesim] ${msg}\n`);
  process.exit(1);
}

if (!mac || mac === true) fail('실제 서버 모드에는 장비 ID가 필요합니다:  npm run kiosk:legacy -- --real --mac <MacAddr> [--web stg]');
if (!['stg', 'was', 'web'].includes(webMode)) fail(`--web 은 stg | was | web 중 하나여야 합니다 (입력: ${webMode})`);
const electronExe = path.join(source, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
if (!fs.existsSync(path.join(source, 'main.js'))) fail(`원본 앱 폴더를 찾을 수 없습니다: ${source}  (--source 로 지정)`);
if (!fs.existsSync(electronExe)) fail(`Electron 이 설치되어 있지 않습니다. 원본 폴더에서 실행하세요:\n  cd "${source}"\n  npm ci --ignore-scripts\n  node node_modules/electron/install.js`);

// ---------------------------------------------------------------- settings.json
fs.mkdirSync(settingsDir, { recursive: true });
if (fs.existsSync(settingsFile) && !fs.existsSync(`${settingsFile}.cafesim-backup`)) fs.copyFileSync(settingsFile, `${settingsFile}.cafesim-backup`);
fs.writeFileSync(settingsFile, JSON.stringify({ MacAddr: mac, webMode }, null, 2));
console.log(`[cafesim] ${settingsFile} -> MacAddr=${mac}, webMode=${webMode} ${real ? `(실제 서버 ${webMode}.mailbean.kr)` : '(가상 Mailbean 서버)'}`);

// ---------------------------------------------------------------- simulator server
const ping = () =>
  new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:8700/api/info', (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(800, () => (req.destroy(), resolve(false)));
  });

(async () => {
  let server = null;
  const portOpen = (port) =>
    new Promise((resolve) => {
      const s = require('node:net').connect(port, '127.0.0.1');
      s.once('connect', () => (s.destroy(), resolve(true)));
      s.once('error', () => resolve(false));
    });
  if (cloud) {
    console.log(`[cafesim] 클라우드 룸에 릴레이 연결: ${cloud}`);
    server = spawn(process.execPath, [path.join(root, 'packages/server/bin/cafesim.js'), 'relay', cloud], { stdio: 'inherit' });
    for (let i = 0; i < 60 && !(await portOpen(7001)); i++) await new Promise((r) => setTimeout(r, 250));
    if (!(await portOpen(7001))) fail('릴레이를 시작하지 못했습니다 (URL, 또는 포트 7001-7003/27098 사용 여부 확인)');
  } else if (await ping()) console.log('[cafesim] 시뮬레이터 서버 사용 중: http://localhost:8700');
  else {
    console.log('[cafesim] 시뮬레이터 서버 시작: http://localhost:8700');
    server = spawn(process.execPath, [path.join(root, 'packages/server/bin/cafesim.js'), 'start'], { stdio: 'inherit' });
    for (let i = 0; i < 40 && !(await ping()); i++) await new Promise((r) => setTimeout(r, 250));
    if (!(await ping())) fail('시뮬레이터 서버를 시작하지 못했습니다 (포트 8700/7001-7003/27098 사용 중인지 확인)');
  }

  // the original app executes remote commands itself -> stop the simulator's own executor
  if (!real) {
    const base = cloud ? new URL(cloud).origin : 'http://127.0.0.1:8700';
    const room = cloud ? `?room=${encodeURIComponent(new URL(cloud).searchParams.get('room') ?? 'main')}` : '';
    try {
      await fetch(`${base}/cafesim-admin/settings${room}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sim_remote_executor: 'off' }) });
      console.log('[cafesim] 원격 명령은 원본 앱이 실행합니다 (시뮬레이터 실행기 off)');
    } catch {}
  }

  // ---------------------------------------------------------------- original app
  const hook = path.join(__dirname, 'main-hook.cjs').split(path.sep).join('/'); // NODE_OPTIONS treats backslashes as escapes
  const env = {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require "${hook}"`.trim(),
    CAFESIM_PORTS: process.env.CAFESIM_PORTS ?? 'COM1=7001,COM2=7002,COM3=7003',
    CAFESIM_WINDOWED: fullscreen ? '0' : '1',
    CAFESIM_BACKEND: real ? '' : cloud ? new URL(cloud).origin : 'http://127.0.0.1:8700',
    CAFESIM_ROOM: real || !cloud ? '' : new URL(cloud).searchParams.get('room') ?? 'main',
    NODE_ENV: 'development',
  };
  console.log(`[cafesim] 원본 키오스크 실행: ${source}`);
  const debugPort = opt('debug-port', null); // e.g. 9222 -> inspect / screenshot the kiosk via Chrome DevTools Protocol
  const app = spawn(electronExe, ['.', ...(debugPort ? [`--remote-debugging-port=${debugPort}`] : [])], { cwd: source, env, stdio: 'inherit' });
  const stop = () => {
    app.kill();
    server?.kill();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  app.on('exit', (code) => {
    console.log(`[cafesim] 원본 키오스크 종료 (code ${code})`);
    server?.kill();
    process.exit(code ?? 0);
  });
})();
