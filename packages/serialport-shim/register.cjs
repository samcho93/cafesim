/**
 * Make require('serialport') return the cafeSim shim without touching the application code.
 *
 *   set NODE_OPTIONS=--require D:\path\to\cafesim\packages\serialport-shim\register.cjs
 *   npm start            (Electron main process and plain Node both honour NODE_OPTIONS --require)
 */
'use strict';
const Module = require('node:module');
const path = require('node:path');

const shim = path.join(__dirname, 'index.cjs');
const original = Module._resolveFilename;
Module.__cafesimOriginalResolve = (request, parent) => original.call(Module, request, parent, false);
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === 'serialport' && !(parent && parent.filename === shim)) return shim;
  return original.call(this, request, parent, ...rest);
};
if (!process.env.CAFESIM_QUIET) console.log(`[cafesim] serialport -> TCP (${process.env.CAFESIM_PORTS || 'COM1=7001,COM2=7002,COM3=7003'})`);
