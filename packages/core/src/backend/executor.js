import { KioskEngine } from '../host/KioskEngine.js';
import { Machine } from '../host/Machine.js';

/**
 * Server-side kiosk for remote commands (remote-wash / cup / ice / extraction / refund ...).
 * The Node server and the Cloudflare room run one, so commands from the admin console work
 * without any kiosk window open. When the original kiosk app is connected it executes the
 * commands itself; set settings.sim_remote_executor = 'off' (the legacy launcher does) to avoid
 * running them twice.
 */
export function attachRemoteExecutor(platform, backend) {
  const machine = Machine.local(platform);
  const api = async (method, path, body) => {
    const r = await backend.handle(method, path, { body });
    if (r.status >= 400) throw new Error(typeof r.body === 'object' ? r.body.error : String(r.body));
    return r.body;
  };
  const engine = new KioskEngine({ machine, api });
  const log = (entry, patch) => {
    Object.assign(entry, patch);
    backend.changed('remote');
  };
  engine.on('notice', (n) => platform.emit('log', { device: 'kiosk', level: n.level, message: n.text }));
  const off = backend.on('notify', async (cmd) => {
    if ((backend.state.settings.sim_remote_executor ?? 'server') === 'off') return;
    const entry = backend.state.remote.find((r) => r.title === cmd.title && r.data === cmd.data) ?? {};
    log(entry, { status: 'running', by: 'server' });
    const done = engine.on('remote', (e) => {
      if (e.title !== cmd.title || e.status === 'start') return;
      done();
      log(entry, { status: e.status, error: e.error ?? null });
    });
    await engine.load().catch(() => {});
    await engine.handleRemote(cmd);
  });
  return {
    engine,
    close() {
      off();
      machine.close();
    },
  };
}
