import * as THREE from 'three';

/**
 * Collision model of the robot cell.
 *   robot   : capsules fitted to the visual meshes of every moving UR link (link-local, from the
 *             official ur_description meshes), the gripper body and fingers, and the carried cup
 *   world   : axis-aligned boxes (machines with their open bays, counter, pickup table, pedestal, wall)
 * A configuration collides when any capsule comes closer than `margin` to any box.
 */
const LINKS = ['upper_arm_link', 'forearm_link', 'wrist_1_link', 'wrist_2_link', 'wrist_3_link'];

export class CollisionModel {
  constructor({ robot, tool0, obstacles, tcpZ = 0.15, margin = 0.008 }) {
    this.robot = robot;
    this.tcpZ = tcpZ;
    this.tool0 = tool0;
    this.margin = margin;
    this.obstacles = obstacles.map((o) => ({ ...o, box: new THREE.Box3(new THREE.Vector3(...o.min), new THREE.Vector3(...o.max)) }));
    this.links = LINKS.map((name) => ({ name, link: robot.links[name], cap: fitCapsule(robot.links[name]) })).filter((l) => l.link && l.cap);
    this.gripper = null; // set by setGripper
    this.cup = null; // { r, below, above } while a cup is held
  }

  /** gripper capsules in tool0 frame for a given half opening (m) */
  setGripper(half) {
    this.gripper = [
      { name: 'gripper', a: new THREE.Vector3(0, 0, 0.0), b: new THREE.Vector3(0, 0, 0.075), r: 0.045 },
      ...[-1, 1].map((s) => ({ name: 'finger', a: new THREE.Vector3(s * (half + 0.008), 0, 0.085), b: new THREE.Vector3(s * (half + 0.008), 0, this.tcpZ + 0.002), r: 0.011 })),
    ];
  }

  /** cup held at the TCP (tool y = up): bottom/top distances from the TCP and radius */
  setCup(cup) {
    this.cup = cup;
  }

  /** world-space capsules of the current robot pose */
  capsules() {
    const out = [];
    for (const l of this.links) {
      const m = l.link.matrixWorld;
      out.push({ name: l.name, a: l.cap.a.clone().applyMatrix4(m), b: l.cap.b.clone().applyMatrix4(m), r: l.cap.r });
    }
    const t = this.tool0.matrixWorld;
    for (const g of this.gripper ?? []) out.push({ name: g.name, a: g.a.clone().applyMatrix4(t), b: g.b.clone().applyMatrix4(t), r: g.r });
    if (this.cup) {
      const tcp = new THREE.Vector3(0, 0, this.cup.tcp).applyMatrix4(t);
      out.push({ name: 'cup', a: tcp.clone().add(new THREE.Vector3(0, -this.cup.below + this.cup.r, 0)), b: tcp.clone().add(new THREE.Vector3(0, this.cup.above - this.cup.r, 0)), r: this.cup.r });
    }
    return out;
  }

  /** First collision of the current pose: { capsule, obstacle } | null */
  check(ignore = () => false) {
    const sphere = new THREE.Sphere();
    for (const c of this.capsules()) {
      const len = c.a.distanceTo(c.b);
      const n = Math.max(1, Math.ceil(len / (c.r * 0.9)));
      for (const o of this.obstacles) {
        if (ignore(c, o)) continue;
        for (let i = 0; i <= n; i++) {
          sphere.center.lerpVectors(c.a, c.b, i / n);
          sphere.radius = c.r + this.margin;
          if (o.box.intersectsSphere(sphere)) return { capsule: c.name, obstacle: o.name, at: sphere.center.clone() };
        }
      }
    }
    return null;
  }
}

/** Capsule (link-local) around the visual meshes that belong to `link` (not to its child links). */
function fitCapsule(link) {
  if (!link) return null;
  link.updateMatrixWorld(true);
  const inv = link.matrixWorld.clone().invert();
  const box = new THREE.Box3();
  const tmp = new THREE.Box3();
  link.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    let p = o;
    while (p && !p.isURDFLink && !p.isURDFCollider) p = p.parent;
    if (p !== link) return; // child link or collider
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    tmp.copy(o.geometry.boundingBox).applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld));
    box.union(tmp);
  });
  if (box.isEmpty()) return null;
  const size = box.getSize(new THREE.Vector3());
  const c = box.getCenter(new THREE.Vector3());
  const axis = size.x >= size.y && size.x >= size.z ? 'x' : size.y >= size.z ? 'y' : 'z';
  const others = ['x', 'y', 'z'].filter((k) => k !== axis);
  const r = Math.max(size[others[0]], size[others[1]]) / 2;
  const half = Math.max(0, size[axis] / 2 - r);
  const a = c.clone();
  const b = c.clone();
  a[axis] -= half;
  b[axis] += half;
  return { a, b, r };
}

/** Debug drawing of obstacles and robot capsules. */
export class CollisionDebug {
  constructor(scene, model) {
    this.model = model;
    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);
    for (const o of model.obstacles) {
      const h = new THREE.Box3Helper(o.box, 0xe5484d);
      h.material.transparent = true;
      h.material.opacity = 0.55;
      this.group.add(h);
    }
    this.caps = new THREE.Group();
    this.group.add(this.caps);
    this.mat = new THREE.MeshBasicMaterial({ color: 0x2fbf71, wireframe: true, transparent: true, opacity: 0.45 });
    this.hitMat = new THREE.MeshBasicMaterial({ color: 0xff2d2d, wireframe: true });
  }

  update(hit) {
    if (!this.group.visible) return;
    for (const m of this.caps.children) m.geometry.dispose();
    this.caps.clear();
    for (const c of this.model.capsules()) {
      const len = c.a.distanceTo(c.b);
      const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(c.r, Math.max(1e-4, len), 4, 10), hit?.capsule === c.name ? this.hitMat : this.mat);
      mesh.position.lerpVectors(c.a, c.b, 0.5);
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), c.b.clone().sub(c.a).normalize().lengthSq() ? c.b.clone().sub(c.a).normalize() : new THREE.Vector3(0, 1, 0));
      this.caps.add(mesh);
    }
  }
}
