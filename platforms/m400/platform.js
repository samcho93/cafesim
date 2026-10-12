/**
 * M400 unmanned cafe station
 *   - coffee machine (main board, 3 outlets, touch screen, card reader)
 *   - ice dispenser
 *   - cup dispenser (HOT / ICE)
 *
 * Everything here is data: change a recipe, routing or layout value and the
 * simulator (and its 3D view) follows. Copy this folder to start a new platform:
 *   npx cafesim create-platform my-machine
 */
import { definePlatform } from '@cafesim/core';

export default definePlatform({
  id: 'm400',
  name: 'M400 무인카페 스테이션',
  description: '커피머신(3 투출구) + 제빙기 + 컵 디스펜서 + 카드 단말기',

  // ------------------------------------------------------------------ hardware
  devices: [
    {
      key: 'main',
      type: 'mailbean-mainboard',
      port: { path: 'COM1', baudRate: 38400, tcp: 7001 },
      options: {
        id: '01',
        spouts: 3,
        // which outlet each liquid path ends at. coffee: [default, with S155 select solenoid]
        routing: { coffee: [1, 2], hotWater: 1, ade: [2, 3, 3], powder: [2, 2, 2, 3, 3, 3] },
      },
    },
    { key: 'ice', type: 'ice-maker', port: { path: 'COM2', baudRate: 9600, tcp: 7002 } },
    { key: 'cup', type: 'cup-dispenser', port: { path: 'COM3', baudRate: 9600, tcp: 7003 }, options: { id: '02', stock: { hot: 50, ice: 50 } } },
    { key: 'pay', type: 'kscat-terminal', port: { http: 27098 }, options: { tid: 'DPT0TEST03' } },
  ],

  temperatures: { coffeeReady: 92, hotWaterReady: 85, coffeeUse: 90, hotWaterUse: 85, coffeeExtract: 93, hotWaterExtract: 88 },

  // ------------------------------------------------------------------ production programs
  // A step is a main-board command key, { select: true|false } (coffee outlet 2), { wait: ms } or { actuator, on }
  sequences: {
    americano: ['grinder1', 'brewUpper', 'preInfusion', 'coffee', 'hotWater', 'brewLower', 'brewMiddle'],
    espresso: ['grinder1', 'brewUpper', 'preInfusion', 'coffee', 'brewLower', 'brewMiddle'],
    latte: [{ select: true }, 'grinder1', 'brewUpper', 'preInfusion', 'coffee', 'brewLower', 'brewMiddle', { select: false }, 'powder1'],
    vanillaLatte: [{ select: true }, 'grinder1', 'brewUpper', 'preInfusion', 'coffee', 'brewLower', 'brewMiddle', { select: false }, 'ade1', 'powder1'],
    choco: ['powder2'],
    greenTea: ['powder3'],
    icedTea: ['powder4'],
    lemonAde: ['ade2'],
    grapefruitAde: ['ade3'],
  },

  // ------------------------------------------------------------------ menu (used by the bundled kiosk UI)
  menu: [
    {
      id: 'americano',
      name: '아메리카노',
      price: 2000,
      category: '커피',
      color: '#3b2416',
      temps: ['ice', 'hot'],
      spout: 1,
      sequence: 'americano',
      recipe: { grinderTime1: 2.5, coffeeAmount: 40, hotWaterAmount: 150 },
      variants: { ice: { recipe: { hotWaterAmount: 110 }, ice: { ice: 5, water: 0 } } },
    },
    { id: 'espresso', name: '에스프레소', price: 1800, category: '커피', color: '#2a170d', temps: ['hot'], spout: 1, sequence: 'espresso', recipe: { grinderTime1: 2.5, coffeeAmount: 40 } },
    {
      id: 'latte',
      name: '카페라떼',
      price: 2800,
      category: '커피',
      color: '#b98a5e',
      temps: ['ice', 'hot'],
      spout: 2,
      sequence: 'latte',
      recipe: { grinderTime1: 2.5, coffeeAmount: 40, powderAmount1: 150, powderFeedTime1: 2, powderMixTime1: 3 },
      variants: { ice: { recipe: { powderAmount1: 110 }, ice: { ice: 4.5, water: 0 } } },
    },
    {
      id: 'vanilla',
      name: '바닐라라떼',
      price: 3200,
      category: '커피',
      color: '#c9a173',
      temps: ['ice', 'hot'],
      spout: 2,
      sequence: 'vanillaLatte',
      recipe: { grinderTime1: 2.5, coffeeAmount: 40, adePumpTime1: 2, powderAmount1: 130, powderFeedTime1: 2, powderMixTime1: 3 },
      variants: { ice: { ice: { ice: 4.5, water: 0 } } },
    },
    { id: 'choco', name: '초코라떼', price: 3000, category: '라떼', color: '#5a3522', temps: ['ice', 'hot'], spout: 2, sequence: 'choco', recipe: { powderAmount2: 180, powderFeedTime2: 3, powderMixTime2: 3 }, variants: { ice: { recipe: { powderAmount2: 140 } } } },
    { id: 'greentea', name: '녹차라떼', price: 3000, category: '라떼', color: '#7d9b4f', temps: ['ice', 'hot'], spout: 2, sequence: 'greenTea', recipe: { powderAmount3: 180, powderFeedTime3: 3, powderMixTime3: 3 }, variants: { ice: { recipe: { powderAmount3: 140 } } } },
    { id: 'icedtea', name: '복숭아 아이스티', price: 2500, category: '티/에이드', color: '#d98b4a', temps: ['ice'], spout: 3, sequence: 'icedTea', recipe: { powderAmount4: 200, powderFeedTime4: 2.5, powderMixTime4: 2 }, ice: { ice: 6, water: 0 } },
    { id: 'lemon', name: '레몬에이드', price: 3200, category: '티/에이드', color: '#e8d34f', temps: ['ice'], spout: 3, sequence: 'lemonAde', recipe: { adeIceWaterAmount2: 180, adePumpTime2: 4 }, ice: { ice: 6, water: 0 } },
    { id: 'grapefruit', name: '자몽에이드', price: 3200, category: '티/에이드', color: '#e5645a', temps: ['ice'], spout: 3, sequence: 'grapefruitAde', recipe: { adeIceWaterAmount3: 180, adePumpTime3: 4 }, ice: { ice: 6, water: 0 } },
  ],

  // ------------------------------------------------------------------ 3D layout (metres, counter top = y 0)
  layout: {
    counter: { width: 2.6, depth: 0.72 },
    pickup: [-1.08, 0, 0.16],
    units: [
      { model: 'm400-main', device: 'main', payment: 'pay', position: [-0.6, 0, -0.04] },
      { model: 'ice-dispenser', device: 'ice', position: [0.0, 0, -0.06] },
      { model: 'cup-dispenser', device: 'cup', position: [0.43, 0, -0.06] },
    ],
  },
});
