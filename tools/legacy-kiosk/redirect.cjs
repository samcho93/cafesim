/**
 * URL rewriting shared by the main-process hook and the renderer preload:
 * the kiosk's cloud (http://{was|stg|web}.mailbean.kr/...) and the Kakao alimtalk API are sent to
 * the cafeSim virtual Mailbean server instead (CAFESIM_BACKEND, optional CAFESIM_ROOM).
 */
'use strict';

const BACKEND = (process.env.CAFESIM_BACKEND || '').replace(/\/+$/, '');
const ROOM = process.env.CAFESIM_ROOM || '';

const MAILBEAN = /^https?:\/\/[a-z0-9-]+\.mailbean\.kr(\/[^?#]*)?(\?[^#]*)?/i;
const ALIMTALK = /^https?:\/\/alimtalk-api\.sweettracker\.net\/.*/i;

function withRoom(url) {
  if (!ROOM) return url;
  return url + (url.includes('?') ? '&' : '?') + 'room=' + encodeURIComponent(ROOM);
}

function rewrite(url) {
  if (!BACKEND || typeof url !== 'string') return url;
  const m = MAILBEAN.exec(url);
  if (m) return withRoom(BACKEND + (m[1] || '/') + (m[2] || ''));
  if (ALIMTALK.test(url)) return withRoom(BACKEND + '/alimtalk');
  return url;
}

/** Wrap a node-fetch module so every call goes through rewrite(). */
function wrapNodeFetch(real) {
  if (!real || real.__cafesim) return real;
  const fn = typeof real === 'function' ? real : real.default;
  const wrapped = function (input, init) {
    if (typeof input === 'string') return fn(rewrite(input), init);
    if (input && typeof input.url === 'string' && rewrite(input.url) !== input.url) return fn(rewrite(input.url), init ?? input);
    return fn(input, init);
  };
  Object.assign(wrapped, real);
  wrapped.default = wrapped;
  wrapped.__cafesim = true;
  return wrapped;
}

function installNodeFetchHook(Module) {
  const load = Module._load;
  let cache = null;
  Module._load = function (request, parent, isMain) {
    const real = load.apply(this, arguments);
    if (request === 'node-fetch') return (cache ??= wrapNodeFetch(real));
    return real;
  };
}

module.exports = { BACKEND, ROOM, rewrite, wrapNodeFetch, installNodeFetchHook };
