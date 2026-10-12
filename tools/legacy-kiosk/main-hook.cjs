/**
 * Loaded into the ORIGINAL kiosk app's Electron main process via NODE_OPTIONS=--require.
 * The application source stays untouched; this hook only swaps modules at require() time:
 *
 *   serialport           -> @cafesim/serialport-shim (COM1/2/3 -> simulator TCP 7001-7003)
 *   electron             -> BrowserWindow without fullscreen      (CAFESIM_WINDOWED=1)
 *   electron-updater     -> no-op auto updater                   (no GitHub update downloads)
 *   controller/public/taskbar*.js -> no-op                        (Windows taskbar is left alone)
 */
'use strict';
const Module = require('node:module');
const path = require('node:path');

require(path.join(__dirname, '../../packages/serialport-shim/register.cjs'));

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

Module._load = function (request, parent, isMain) {
  if (request === 'electron-updater') return noUpdater;
  if (/controller[\\/]public[\\/]taskbar(PS|Napi)?(\.js)?$/.test(request) || /^\.\/controller\/public\/taskbar/.test(request)) return noTaskbar;
  const real = load.apply(this, arguments);
  if (request === 'electron' && windowed && real && real.BrowserWindow) {
    if (!electronProxy) {
      class WindowedBrowserWindow extends real.BrowserWindow {
        constructor(opts = {}) {
          super({ ...opts, fullscreen: false, kiosk: false, width: opts.width ?? 1300, height: opts.height ?? 800 });
        }
        setFullScreen() {}
        setKiosk() {}
      }
      electronProxy = new Proxy(real, { get: (t, k) => (k === 'BrowserWindow' ? WindowedBrowserWindow : t[k]) });
    }
    return electronProxy;
  }
  return real;
};

console.log(`[cafesim] legacy kiosk hook: serial -> simulator, updater off, taskbar untouched${windowed ? ', windowed' : ''}`);
