import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from './server.js';

const CUSTOM_DEVICE = `/**
 * Example of a new device type for this platform.
 * Register it in platform.js:
 *
 *   import { SyrupStation } from './devices/SyrupStation.js';
 *   devices: [ ..., { key: 'syrup', type: 'syrup-station', class: SyrupStation, port: { tcp: 7010 } } ]
 *
 * The protocol here is a tiny line based text protocol: "PUMP <n> <seconds>\\n" -> "OK\\n".
 */
import { Device } from '@cafesim/core';

class LineParser {
  buf = '';
  constructor(onFrame) {
    this.onFrame = onFrame;
  }
  push(bytes) {
    this.buf += String.fromCharCode(...bytes);
    let i;
    while ((i = this.buf.indexOf('\\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (line) this.onFrame({ line, raw: [...line].map((c) => c.charCodeAt(0)) });
    }
  }
}

export class SyrupStation extends Device {
  static type = 'syrup-station';
  static label = '시럽 스테이션';
  static slots = () => ['nozzle'];

  constructor(args) {
    super(args);
    this.pumping = null; // { n, remaining }
  }

  createParser(onFrame) {
    return new LineParser(onFrame);
  }

  describe(raw) {
    return String.fromCharCode(...raw).trim();
  }

  handleFrame({ line }, reply) {
    const [cmd, n, sec] = line.split(/\\s+/);
    if (cmd === 'PUMP') {
      this.pumping = { n: Number(n), remaining: Number(sec) };
      this.log('info', \`시럽\${n} \${sec}s\`);
    }
    reply([...'OK\\n'].map((c) => c.charCodeAt(0)));
  }

  update(dt) {
    if (!this.pumping) return;
    const step = Math.min(dt, this.pumping.remaining);
    this.world.pour(\`\${this.key}:nozzle\`, 'ade', step * 5, this.pumping.n);
    this.pumping.remaining -= step;
    if (this.pumping.remaining <= 0) this.pumping = null;
  }

  snapshot() {
    return { type: SyrupStation.type, pumping: this.pumping };
  }
}
`;

/** Copy an existing platform as the starting point of a new one. */
export function createPlatform(name, { from = 'm400', title } = {}) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error('Platform name: lower-case letters, digits and "-" only');
  const src = path.join(repoRoot, 'platforms', from);
  const dst = path.join(repoRoot, 'platforms', name);
  if (!fs.existsSync(src)) throw new Error(`Source platform not found: ${from}`);
  if (fs.existsSync(dst)) throw new Error(`Already exists: ${dst}`);
  fs.cpSync(src, dst, { recursive: true });
  const file = path.join(dst, 'platform.js');
  let text = fs.readFileSync(file, 'utf8');
  text = text.replace(/id: '[^']+'/, `id: '${name}'`).replace(/name: '[^']+',\n  description/, `name: '${title ?? name}',\n  description`);
  fs.writeFileSync(file, text);
  fs.mkdirSync(path.join(dst, 'devices'), { recursive: true });
  fs.writeFileSync(path.join(dst, 'devices', 'SyrupStation.example.js'), CUSTOM_DEVICE);
  fs.writeFileSync(
    path.join(dst, 'README.md'),
    `# ${title ?? name}\n\nCreated from \`${from}\`.\n\n- Edit \`platform.js\`: devices, routing, sequences, menu and 3D layout.\n- Add device types in \`devices/\` (see \`SyrupStation.example.js\`).\n- Run the 3D viewer: \`npm run dev\` then open \`/?platform=${name}\`\n- Run as virtual hardware: \`npx cafesim start --platform ${name}\`\n`,
  );
  return dst;
}
