import { MainBoard } from '../devices/MainBoard.js';
import { CupDispenser } from '../devices/CupDispenser.js';
import { IceMaker } from '../devices/IceMaker.js';
import { PaymentTerminal } from '../devices/PaymentTerminal.js';

/**
 * Device type registry. New platforms can add their own device classes:
 *
 *   import { Device, registerDeviceType } from '@cafesim/core';
 *   class SyrupPump extends Device { static type = 'syrup-pump'; ... }
 *   registerDeviceType(SyrupPump);
 */
const deviceTypes = new Map();

export function registerDeviceType(cls) {
  if (!cls.type) throw new Error('Device class needs a static "type"');
  deviceTypes.set(cls.type, cls);
}

export function getDeviceType(type) {
  const cls = deviceTypes.get(type);
  if (!cls) throw new Error(`Unknown device type "${type}". Registered: ${[...deviceTypes.keys()].join(', ')}`);
  return cls;
}

export const listDeviceTypes = () => [...deviceTypes.values()].map((c) => ({ type: c.type, label: c.label }));

[MainBoard, CupDispenser, IceMaker, PaymentTerminal].forEach(registerDeviceType);

/** Platform definitions (see /platforms/<name>/platform.js) */
const platforms = new Map();

export function definePlatform(def) {
  if (!def?.id) throw new Error('Platform definition needs an id');
  for (const d of def.devices ?? []) if (d.class) registerDeviceType(d.class);
  platforms.set(def.id, def);
  return def;
}

export const getPlatformDefinition = (id) => platforms.get(id);
export const listPlatforms = () => [...platforms.values()].map((p) => ({ id: p.id, name: p.name, description: p.description }));
