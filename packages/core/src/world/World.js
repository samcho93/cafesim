import { Emitter } from '../util/Emitter.js';

/**
 * The physical world around the devices: cups and the places a cup can be.
 *
 * Slots are named "<unit>:<place>", e.g.
 *   cup:hot, cup:ice      cup dispenser output windows
 *   ice:tray             under the ice nozzle (pushes the cup lever)
 *   main:spout1..3       main machine outlets (cup sensors)
 *   pickup               the counter in front of the customer
 *
 * Devices pour into whatever cup sits on their slot. If no cup is there the
 * liquid is counted as spilled so mistakes are visible in the simulation.
 */
export class World extends Emitter {
  cups = new Map();
  slots = new Map();
  spills = {};
  served = [];
  #seq = 0;

  defineSlot(name, meta = {}) {
    this.slots.set(name, { name, cup: null, ...meta });
  }

  cupAt(slot) {
    const id = this.slots.get(slot)?.cup;
    return id ? this.cups.get(id) : null;
  }

  createCup(type, slot) {
    if (this.cupAt(slot)) {
      // a cup is already in the window: the new one is jammed/stacked, keep the old one
      this.emit('event', { type: 'cup-blocked', slot });
    }
    const id = `cup${++this.#seq}`;
    const cup = { id, type, slot: null, capacity: type === 'ice' ? 470 : 360, contents: { ice: 0, coffee: 0, water: 0, milk: 0, powder: {}, ade: {} }, poured: {}, createdAt: Date.now() };
    this.cups.set(id, cup);
    this.#place(cup, slot);
    this.emit('event', { type: 'cup-created', cup: id, cupType: type, slot });
    return cup;
  }

  #place(cup, slot) {
    if (cup.slot && this.slots.get(cup.slot)?.cup === cup.id) this.slots.get(cup.slot).cup = null;
    cup.slot = slot;
    if (slot && this.slots.has(slot)) this.slots.get(slot).cup = cup.id;
  }

  /** Move a cup to another slot. Returns false if the target is occupied. */
  moveCup(id, slot) {
    const cup = this.cups.get(id);
    if (!cup) throw new Error(`Unknown cup ${id}`);
    if (!this.slots.has(slot)) throw new Error(`Unknown slot ${slot}`);
    const other = this.cupAt(slot);
    if (other && other.id !== id) return false;
    const from = cup.slot;
    this.#place(cup, slot);
    this.emit('event', { type: 'cup-moved', cup: id, from, to: slot });
    return true;
  }

  /** Customer takes the cup away (from pickup or any slot). */
  serveCup(id) {
    const cup = this.cups.get(id);
    if (!cup) return null;
    this.#place(cup, null);
    this.cups.delete(id);
    const record = { ...cup, servedAt: Date.now(), volume: this.volume(cup) };
    this.served.unshift(record);
    this.served.length = Math.min(this.served.length, 20);
    this.emit('event', { type: 'cup-served', cup: id, record });
    return record;
  }

  /** Pour liquid (cc) or ice (cubes) into the cup on a slot. */
  pour(slot, kind, amount, sub) {
    const cup = this.cupAt(slot);
    if (!cup) {
      this.spills[slot] = (this.spills[slot] ?? 0) + amount;
      return null;
    }
    const c = cup.contents;
    if (kind !== 'ice') cup.poured[slot] = (cup.poured[slot] ?? 0) + amount;
    if (sub != null) c[kind][sub] = (c[kind][sub] ?? 0) + amount;
    else c[kind] += amount;
    const overflow = this.volume(cup) - cup.capacity;
    if (overflow > 0 && !cup.overflowed) {
      cup.overflowed = true;
      this.emit('event', { type: 'cup-overflow', cup: cup.id, slot });
    }
    return cup;
  }

  volume(cup) {
    const c = cup.contents;
    const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
    return c.coffee + c.water + c.milk + sum(c.powder) + sum(c.ade) + c.ice * 8;
  }

  clearSpills() {
    this.spills = {};
  }

  snapshot() {
    return {
      cups: [...this.cups.values()].map((c) => ({ ...c, contents: structuredClone(c.contents), volume: this.volume(c) })),
      slots: Object.fromEntries([...this.slots.values()].map((s) => [s.name, s.cup])),
      spills: { ...this.spills },
      served: this.served.slice(0, 5),
    };
  }
}
