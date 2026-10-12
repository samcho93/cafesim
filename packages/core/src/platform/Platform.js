import { Emitter } from '../util/Emitter.js';
import { World } from '../world/World.js';
import { computeGuide } from '../world/Guide.js';
import { getDeviceType } from './registry.js';

/**
 * A running virtual machine: devices + physical world + simulation clock.
 *
 *   const platform = new Platform(m400);   // definition from /platforms/m400
 *   platform.start();
 *   const port = platform.connect('main'); // raw byte endpoint, like a serial port
 *
 * Events:
 *   'tick'      (snapshot-less, every step)
 *   'traffic'   { device, dir, bytes, text }
 *   'log'       { device, level, message }
 *   'event'     world events (cup created / moved / served ...)
 *   'guide'     prompts[] when they change
 */
export class Platform extends Emitter {
  constructor(definition, overrides = {}) {
    super();
    this.definition = definition;
    this.world = new World();
    this.devices = {};
    this.time = 0;
    this.speed = overrides.speed ?? 1;
    this.autoAssist = overrides.autoAssist ?? false;
    this.assistDelay = overrides.assistDelay ?? 1.2; // real seconds
    this.paused = false;
    this.guide = [];
    this.#timer = null;
    this.#assistWait = 0;

    for (const slot of definition.slots ?? []) this.world.defineSlot(slot.name ?? slot, slot);
    this.world.defineSlot('pickup', { label: '픽업대' });
    for (const d of definition.devices) {
      const Cls = getDeviceType(d.type);
      this.devices[d.key] = new Cls({ key: d.key, platform: this, options: { ...(d.options ?? {}), ...(overrides.devices?.[d.key] ?? {}) } });
      for (const s of Cls.slots?.(d) ?? []) this.world.defineSlot(`${d.key}:${s}`);
    }
    this.world.on('event', (e) => this.emit('event', e));
  }

  #timer;
  #assistWait;
  #last = 0;

  device(key) {
    const d = this.devices[key];
    if (!d) throw new Error(`No device "${key}" on platform ${this.definition.id}`);
    return d;
  }

  /** Host-side byte endpoint for a device (what a serial cable would give you). */
  connect(key, name) {
    return this.device(key).connect(name);
  }

  start(intervalMs = 50) {
    if (this.#timer) return this;
    this.#last = Date.now();
    this.#timer = setInterval(() => {
      const now = Date.now();
      const real = Math.min(0.25, (now - this.#last) / 1000);
      this.#last = now;
      if (!this.paused) this.step(real * this.speed);
    }, intervalMs);
    return this;
  }

  stop() {
    clearInterval(this.#timer);
    this.#timer = null;
  }

  step(dt) {
    let left = dt;
    while (left > 1e-6) {
      const h = Math.min(0.1, left);
      for (const d of Object.values(this.devices)) d.update(h);
      this.time += h;
      left -= h;
    }
    this.#updateGuide(dt / this.speed);
    this.emit('tick', this.time);
  }

  #updateGuide(dt) {
    const prompts = computeGuide(this);
    const sig = prompts.map((p) => p.id + p.text).join('|');
    if (sig !== this.guide.map((p) => p.id + p.text).join('|')) {
      this.guide = prompts;
      this.#assistWait = 0;
      this.emit('guide', prompts);
    }
    if (this.autoAssist) {
      const next = this.guide.find((p) => p.action);
      if (next) {
        this.#assistWait += dt;
        if (this.#assistWait >= this.assistDelay) {
          this.#assistWait = 0;
          this.interact(next.action);
        }
      }
    }
  }

  /**
   * Physical / operator actions:
   *   { type: 'moveCup', cup, to }          { type: 'serveCup', cup }
   *   { type: 'device', device, action }    { type: 'speed', value }
   *   { type: 'autoAssist', on }            { type: 'pause', on }
   *   { type: 'clearSpills' }               { type: 'refillAll' }
   */
  interact(action) {
    switch (action?.type) {
      case 'moveCup':
        return this.world.moveCup(action.cup, action.to);
      case 'serveCup':
        return !!this.world.serveCup(action.cup);
      case 'device':
        return this.device(action.device).interact(action.action);
      case 'speed':
        this.speed = Math.max(0.1, Math.min(20, Number(action.value) || 1));
        return true;
      case 'autoAssist':
        this.autoAssist = !!action.on;
        return true;
      case 'pause':
        this.paused = !!action.on;
        return true;
      case 'clearSpills':
        this.world.clearSpills();
        return true;
      case 'refillAll':
        for (const d of Object.values(this.devices)) d.interact({ type: 'refill' });
        return true;
      case 'step':
        this.step(Number(action.dt) || 0.1);
        return true;
      default:
        throw new Error(`Unknown interaction ${JSON.stringify(action)}`);
    }
  }

  snapshot() {
    return {
      platform: this.definition.id,
      time: +this.time.toFixed(2),
      speed: this.speed,
      paused: this.paused,
      autoAssist: this.autoAssist,
      devices: Object.fromEntries(Object.entries(this.devices).map(([k, d]) => [k, d.snapshot()])),
      world: this.world.snapshot(),
      guide: this.guide,
    };
  }
}
