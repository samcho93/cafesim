import { MailbeanBackend, Emitter } from '@cafesim/core';

const STORE_KEY = (platform) => `cafesim.backend.${platform}`;

/**
 * Access to the virtual Mailbean cloud from the viewer.
 *   local  : the backend runs in this tab and is saved in localStorage (GitHub Pages / npm run dev)
 *   remote : the server / Cloudflare room serves it at /mailbean/* (+ SSE /notifications/)
 *
 * api(method, path, body)  path like 'mailbean/goods_list/simadmin' or 'cafesim-admin/state'
 * mediaUrlAsync(path)      absolute URL / data URL for '/media/sim/<id>.svg'
 * onNotify(fn)             remote commands { title, data }
 */
export function createBackendClient(link, definition) {
  const events = new Emitter();
  if (link.mode === 'local') {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(STORE_KEY(definition.id)) ?? 'null');
    } catch {}
    const backend = new MailbeanBackend({
      state: saved?.version ? saved : undefined,
      save: (state) => {
        try {
          localStorage.setItem(STORE_KEY(definition.id), JSON.stringify(state));
        } catch {}
      },
    });
    backend.on('notify', (c) => events.emit('notify', c));
    backend.on('change', (w) => events.emit('change', w));
    return {
      mode: 'local',
      backend,
      async api(method, path, body) {
        const r = await backend.handle(method, path, { body });
        if (r.status >= 400) throw new Error(typeof r.body === 'object' ? r.body.error : String(r.body));
        return r.body;
      },
      async mediaUrlAsync(path) {
        const res = await backend.handle('GET', path);
        return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(res.body)}`;
      },
      async receiptUrl(url) {
        const res = await backend.handle('GET', url);
        return URL.createObjectURL(new Blob([res.body], { type: 'text/html' }));
      },
      onNotify: (fn) => events.on('notify', fn),
      onChange: (fn) => events.on('change', fn),
      executesRemote: true,
    };
  }

  // ------------------------------------------------------------------ remote (server / cloud room)
  const wsUrl = new URL(link.url);
  const base = `${wsUrl.protocol === 'wss:' ? 'https:' : 'http:'}//${wsUrl.host}`;
  const room = wsUrl.searchParams.get('room') ?? link.info?.room ?? '';
  const q = (path) => `${base}/${path.replace(/^\/+/, '')}${room ? `${path.includes('?') ? '&' : '?'}room=${encodeURIComponent(room)}` : ''}`;
  let es = null;
  const client = {
    mode: 'remote',
    base,
    room,
    async api(method, path, body) {
      const res = await fetch(q(path), { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
      const text = await res.text();
      let data = text;
      try {
        data = JSON.parse(text);
      } catch {}
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      return data;
    },
    mediaUrlAsync: async (path) => q(path),
    receiptUrl: async (url) => q(url),
    onNotify(fn) {
      if (!es) {
        client.api('GET', 'mailbean/get_settings/x').then((s) => {
          es = new EventSource(q(`notifications/${s.MacAddr}/`));
          es.onmessage = (ev) => {
            try {
              const outer = JSON.parse(ev.data);
              if (outer.data) events.emit('notify', JSON.parse(outer.data));
            } catch {}
          };
        });
      }
      return events.on('notify', fn);
    },
    onChange: (fn) => events.on('change', fn),
    // the server / Durable Object runs its own remote executor
    executesRemote: false,
  };
  return client;
}
