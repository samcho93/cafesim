// Stand-in for modules that need the kiosk's cloud backend (node-fetch, apiCupState).
const noop = async () => ({ ok: true, json: async () => ({}), text: async () => '' });
module.exports = new Proxy(noop, { get: (t, k) => (k in t ? t[k] : noop) });
