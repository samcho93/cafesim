/**
 * Drive the virtual M400 from your own Node program (same code works on the real machine).
 *
 *   terminal 1:  npm run sim -- --auto      (auto-assist moves cups for you)
 *   terminal 2:  npm run example:order
 */
import { connectMachine, loadPlatform } from '@cafesim/server';

const definition = await loadPlatform('m400');
const machine = await connectMachine({ definition });
// real hardware instead of the simulator:
// const machine = await connectMachine({ definition, serial: { main: 'COM1', ice: 'COM2', cup: 'COM3' }, kscat: { port: 27098 } });

machine.on('step', (s) => console.log(`[${s.id}] ${s.text}`));

await machine.init();
console.log('main board status:', (await machine.main.status()).temps);

const item = definition.menu.find((m) => m.id === 'americano');
await machine.pay(item.price);
await machine.order(item, { temp: 'ice' });

machine.close();
