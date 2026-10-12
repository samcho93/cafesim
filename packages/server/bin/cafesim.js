#!/usr/bin/env node
import { startServer, createPlatform, startRelay } from '../src/index.js';

const [, , command = 'help', ...rest] = process.argv;

function parseArgs(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const [k, v] = a.slice(2).split('=');
    const next = v ?? (args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true);
    out[k] = next;
  }
  return out;
}

const HELP = `cafesim - M400 virtual hardware

Usage
  cafesim start [options]               run the simulator service
  cafesim create-platform <name>        copy a platform as a starting point (--from m400 --title "이름")
  cafesim relay <wss://.../ws?room=x>   expose a cloud (Cloudflare) room locally on TCP 7001-7003 + KSCAT 27098

start options
  --platform <id|file>    platform id in /platforms or a platform.js path   (default m400)
  --port <n>              viewer + REST + WebSocket port                    (default 8700)
  --serial main=COM11,ice=COM12,cup=COM13
                          attach devices to COM ports (com0com pairs) so an unmodified
                          kiosk app can open the other side (COM1/COM2/COM3 ...)
  --no-tcp                do not open the per-device TCP ports (7001/7002/7003)
  --tcp-offset <n>        add n to every TCP port
  --kscat <port|false>    KSCAT agent emulator port                         (default 27098)
  --speed <x>             simulation speed                                  (default 1)
  --auto                  auto-assist: perform the customer actions automatically
  --data <file|false>     virtual Mailbean server data (menus, settings, payments)
                          default .cafesim-data/backend-<platform>.json
`;

if (command === 'start') {
  const a = parseArgs(rest);
  const serial = a.serial ? Object.fromEntries(String(a.serial).split(',').map((p) => p.split('='))) : undefined;
  const srv = await startServer({
    platform: a.platform ?? 'm400',
    port: a.port ? Number(a.port) : 8700,
    tcp: a['no-tcp'] ? false : true,
    tcpOffset: a['tcp-offset'] ? Number(a['tcp-offset']) : 0,
    serial,
    kscat: a.kscat === 'false' ? false : a.kscat ? Number(a.kscat) : undefined,
    speed: a.speed ? Number(a.speed) : 1,
    autoAssist: !!a.auto,
    data: a.data === 'false' ? false : a.data,
  });
  const stop = async () => {
    await srv.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} else if (command === 'relay') {
  const a = parseArgs(rest);
  let url = a._[0];
  if (!url) {
    console.error('Usage: cafesim relay <wss://cafesim.<you>.workers.dev/ws?room=main> [--tcp-offset n] [--kscat port]');
    process.exit(1);
  }
  if (/^https?:/.test(url)) url = url.replace(/^http/, 'ws');
  if (!/\/ws(\?|$)/.test(url)) {
    const u = new URL(url);
    url = `${u.protocol}//${u.host}/ws?room=${u.searchParams.get('room') ?? 'main'}`;
  }
  const relay = await startRelay(url, { tcpOffset: a['tcp-offset'] ? Number(a['tcp-offset']) : 0, kscat: a.kscat === 'false' ? 0 : a.kscat ? Number(a.kscat) : 27098 });
  process.on('SIGINT', () => (relay.close(), process.exit(0)));
  relay.link.on('close', () => process.exit(2));
} else if (command === 'create-platform') {
  const a = parseArgs(rest);
  const name = a._[0];
  if (!name) {
    console.error('Usage: cafesim create-platform <name> [--from m400] [--title "My machine"]');
    process.exit(1);
  }
  const dir = createPlatform(name, { from: a.from ?? 'm400', title: a.title });
  console.log(`Created ${dir}\n  viewer: npm run dev  ->  /?platform=${name}\n  server: npx cafesim start --platform ${name}`);
} else {
  console.log(HELP);
}
