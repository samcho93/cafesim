/**
 * Loaded into the ORIGINAL kiosk app's Electron main process via NODE_OPTIONS=--require.
 * The application source stays untouched; this hook only swaps behaviour at runtime:
 *
 *   serialport           -> @cafesim/serialport-shim (COM1/2/3 -> simulator TCP 7001-7003)
 *   *.mailbean.kr        -> virtual Mailbean server (CAFESIM_BACKEND): node-fetch in main + renderer,
 *                           EventSource / images / fetch through session.webRequest
 *   alimtalk API         -> virtual server log (no real KakaoTalk messages)
 *   electron             -> BrowserWindow without fullscreen      (CAFESIM_WINDOWED=1)
 *   electron-updater     -> no-op auto updater
 *   taskbar hide/show    -> no-op
 *   child_process        -> "shutdown" (remote-reboot) is blocked, "tasklist" reports the KSCAT agent
 */
'use strict';
const Module = require('node:module');
const path = require('node:path');
const childProcess = require('node:child_process');
const { BACKEND, rewrite, installNodeFetchHook } = require('./redirect.cjs');

require(path.join(__dirname, '../../packages/serialport-shim/register.cjs'));
if (BACKEND) installNodeFetchHook(Module);

const windowed = process.env.CAFESIM_WINDOWED === '1';
const load = Module._load;
let electronProxy = null;

const noUpdater = (() => {
  const { EventEmitter } = require('node:events');
  const autoUpdater = new EventEmitter();
  Object.assign(autoUpdater, {
    checkForUpdates: async () => null,
    checkForUpdatesAndNotify: async () => null,
    downloadUpdate: async () => [],
    quitAndInstall: () => {},
    setFeedURL: () => {},
    logger: null,
    autoDownload: false,
  });
  return { autoUpdater };
})();

const noTaskbar = { hideTaskbar: async () => '', showTaskbar: async () => '' };

// ---------------------------------------------------------------- child_process guard
const exec = childProcess.exec;
childProcess.exec = function (command, ...rest) {
  const cb = rest.find((a) => typeof a === 'function');
  if (/\bshutdown\b/i.test(String(command))) {
    console.log(`[cafesim] blocked: ${command}`);
    cb && process.nextTick(cb, null, '', '');
    return { on() {}, kill() {} };
  }
  if (/^\s*tasklist/i.test(String(command)) && BACKEND) {
    // the KSCAT agent is emulated by the simulator (http://127.0.0.1:27098)
    cb && process.nextTick(cb, null, 'KSCAT.exe                 9999 Console    1     10,000 K\r\n', '');
    return { on() {}, kill() {} };
  }
  return exec.call(this, command, ...rest);
};

// ---------------------------------------------------------------- electron session redirect
function setupSession(electron) {
  if (!BACKEND) return;
  electron.app.whenReady().then(() => {
    const { session } = electron;
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['*://*.mailbean.kr/*', '*://alimtalk-api.sweettracker.net/*'] }, (details, callback) => {
      const to = rewrite(details.url);
      callback(to !== details.url ? { redirectURL: to } : {});
    });
    const preload = path.join(__dirname, 'renderer-preload.cjs');
    const current = session.defaultSession.getPreloads?.() ?? [];
    if (!current.includes(preload)) session.defaultSession.setPreloads([...current, preload]);
    console.log(`[cafesim] mailbean.kr -> ${BACKEND}`);
  });
}

Module._load = function (request, parent, isMain) {
  if (request === 'electron-updater') return noUpdater;
  if (/controller[\\/]public[\\/]taskbar(PS|Napi)?(\.js)?$/.test(request)) return noTaskbar;
  const real = load.apply(this, arguments);
  if (request === 'electron' && real && real.BrowserWindow) {
    if (!electronProxy) {
      setupSession(real);
      class WindowedBrowserWindow extends real.BrowserWindow {
        constructor(opts = {}) {
          super(windowed ? { ...opts, fullscreen: false, kiosk: false, width: opts.width ?? 1300, height: opts.height ?? 800 } : opts);
        }
        setFullScreen(v) {
          if (!windowed) super.setFullScreen(v);
        }
        setKiosk(v) {
          if (!windowed) super.setKiosk(v);
        }
      }
      electronProxy = new Proxy(real, { get: (t, k) => (k === 'BrowserWindow' ? WindowedBrowserWindow : t[k]) });
    }
    return electronProxy;
  }
  return real;
};

console.log(`[cafesim] legacy kiosk hook: serial -> simulator${BACKEND ? `, mailbean -> ${BACKEND}` : ', mailbean -> real server'}, updater off, taskbar untouched${windowed ? ', windowed' : ''}`);
