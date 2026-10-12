/**
 * Robot cafe demo: the M400 station served by a UR5e collaborative robot (studyUR).
 *
 * The customer orders on a separate kiosk monitor (pop-up). The robot does what the customer
 * would do in the unmanned cafe: takes the cup out of the cup dispenser, holds it under the ice
 * maker, puts it on the coffee machine outlet and hands the finished drink over at the pickup stand.
 * The machines, their protocols and the menu are exactly those of the m400 platform.
 */
import { definePlatform } from '@cafesim/core';
import m400 from '../m400/platform.js';

export default definePlatform({
  ...m400,
  id: 'm400-robot',
  name: 'M400 로봇 카페 (UR5e)',
  description: '커피머신·제빙기·컵 디스펜서 + UR5e 협동로봇 (studyUR 기구학)',
  // the cup is "in the gripper" while the robot carries it
  slots: [{ name: 'robot:gripper', label: '로봇 그리퍼' }],
  // the coffee machine screen shows the production status; orders come from the kiosk pop-up
  kiosk: './kiosk.html?platform=m400-robot&mode=status',
  layout: {
    ...m400.layout,
    pickup: [-0.5, 0, 0.72],
    pickupStand: true,
    robot: {
      model: 'ur5e',
      base: [-0.1, 0, 0.7], // world position of the UR base frame (on a pedestal in front of the counter)
      tcp: [0, 0, 0.15, 0, 0, 0], // gripper TCP (UR pose, base of tool0)
      approach: 0.15, // m, pre-grasp distance toward the customer
      lift: 0.03, // m, lift before carrying
      speed: { joint: 1.2, linear: 0.25 },
    },
  },
});
