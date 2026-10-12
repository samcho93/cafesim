/**
 * Extra preload for the kiosk renderer (nodeIntegration, no context isolation): the renderer's
 * own require('node-fetch') calls (model/api/apiTest.js) go to the virtual Mailbean server too.
 */
'use strict';
const Module = require('node:module');
const { installNodeFetchHook, BACKEND } = require('./redirect.cjs');

if (BACKEND) installNodeFetchHook(Module);
