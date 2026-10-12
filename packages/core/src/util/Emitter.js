/** Minimal event emitter that works in both Node and the browser. */
export class Emitter {
  #handlers = new Map();

  on(type, fn) {
    if (!this.#handlers.has(type)) this.#handlers.set(type, new Set());
    this.#handlers.get(type).add(fn);
    return () => this.off(type, fn);
  }

  once(type, fn) {
    const off = this.on(type, (...args) => {
      off();
      fn(...args);
    });
    return off;
  }

  off(type, fn) {
    this.#handlers.get(type)?.delete(fn);
  }

  emit(type, ...args) {
    for (const fn of [...(this.#handlers.get(type) ?? [])]) {
      try {
        fn(...args);
      } catch (err) {
        console.error(`[cafesim] listener for "${type}" failed`, err);
      }
    }
    if (type !== '*') {
      for (const fn of [...(this.#handlers.get('*') ?? [])]) fn(type, ...args);
    }
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const toBytes = (data) => {
  if (data == null) return [];
  if (typeof data === 'string') return [...data].map((c) => c.charCodeAt(0) & 0xff);
  return Array.from(data);
};

export const ascii = (bytes) => bytes.map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : `{${b.toString(16).padStart(2, '0')}}`)).join('');

export const hex = (bytes) => bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
