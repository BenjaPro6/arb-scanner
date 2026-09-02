import * as THREE from 'three';
import { CFG } from '../core/config.js';
import { buildHuman, animateHuman } from './human.js';
import { clamp, angDelta, TAU } from '../core/utils.js';

const OFFSET = 1.4;   // cuánto camina el peatón adentro de la vereda

// Los peatones caminan el perímetro de su manzana. Es barato, se ve natural
// y les da el patrón correcto: doblan en las esquinas y cruzan en la senda.
export class Peds {
  constructor(scene, city, rng) {
    this.city = city; this.rng = rng;
    this.list = [];
    this.group = new THREE.Group();
    scene.add(this.group);
    for (let i = 0; i < CFG.PED_COUNT; i++) {
      const mesh = buildHuman(rng);
      mesh.visible = false;
      this.group.add(mesh);
      this.list.push({
        mesh, active: false, state: 'walk', x: 0, z: 0, yaw: 0,
        block: null, side: 0, t: 0, dir: 1, speed: 1.25, timer: 0,
        fear: 0, downTime: 0,
      });
    }
  }

  // Punto del perímetro de la manzana: side 0=norte 1=este 2=sur 3=oeste.
  perimeter(b, side, t, out = {}) {
    const o = OFFSET;
    if (side === 0) { out.x = b.x0 - o + (b.w + o * 2) * t; out.z = b.z0 - o; out.yaw = Math.PI / 2; }
    else if (side === 1) { out.x = b.x1 + o; out.z = b.z0 - o + (b.d + o * 2) * t; out.yaw = 0; }
    else if (side === 2) { out.x = b.x1 + o - (b.w + o * 2) * t; out.z = b.z1 + o; out.yaw = -Math.PI / 2; }
    else { out.x = b.x0 - o; out.z = b.z1 + o - (b.d + o * 2) * t; out.yaw = Math.PI; }
    return out;
  }

  spawnNear(p, px, pz) {
    const rng = this.rng;
    for (let tries = 0; tries < 12; tries++) {
      const ang = rng() * TAU, r = rng.range(70, CFG.SIM_RADIUS * 0.9);
      const b = this.city.blockAt(px + Math.cos(ang) * r, pz + Math.sin(ang) * r);
      if (!b) continue;
      p.block = b; p.side = rng.int(0, 3); p.t = rng(); p.dir = rng.chance(0.5) ? 1 : -1;
      p.speed = rng.range(1.05, 1.55);
      p.state = 'walk'; p.fear = 0; p.downTime = 0; p.active = true;
      p.mesh.visible = true; p.mesh.rotation.x = 0;
      const q = this.perimeter(b, p.side, p.t);
      p.x = q.x; p.z = q.z; p.yaw = q.yaw;
      return true;
    }
    return false;
  }

  // Saca a alguien del auto y lo deja corriendo. Se usa al robar un fierro
  // con el conductor adentro.
  expulsar(x, z) {
    const p = this.list.find(q => !q.active) || this.list[0];
    p.active = true; p.mesh.visible = true; p.mesh.rotation.x = 0;
    p.state = 'flee'; p.fear = 5.5; p.downTime = 0;
    p.x = x; p.z = z; p.yaw = this.rng() * TAU;
    p.block = this.city.blockAt(x, z) || p.block;
    p.side = 0; p.t = 0.5; p.dir = 1; p.speed = 1.3;
    return p;
  }

  update(dt, world) {
    const { px, pz, threats } = world;
    const q = {};
    for (const p of this.list) {
      if (!p.active) {
        if (this.rng.chance(0.25)) this.spawnNear(p, px, pz);
        continue;
      }
      const dist = Math.hypot(p.x - px, p.z - pz);
      if (dist > CFG.DESPAWN_RADIUS && p.state !== 'down') { p.active = false; p.mesh.visible = false; continue; }

      // ¿Hay algo que me quiera pisar?
      let danger = 0, dgx = 0, dgz = 0;
      for (const t of threats) {
        const dx = p.x - t.x, dz = p.z - t.z;
        const d = Math.hypot(dx, dz);
        const menace = t.speed * 0.55 + 4;
        if (d < menace) {
          const w = (menace - d) / menace * clamp(t.speed / 4, 0.3, 3);
          if (w > danger) { danger = w; dgx = dx / (d || 1); dgz = dz / (d || 1); }
        }
      }
      if (danger > 0.25 && p.state !== 'down') { p.state = 'flee'; p.fear = Math.max(p.fear, 2.4); }

      if (p.state === 'down') {
        p.downTime += dt;
        animateHuman(p.mesh, dt, 0, 'down');
        p.mesh.position.set(p.x, 0, p.z);
        if (p.downTime > 22) { p.active = false; p.mesh.visible = false; }
        continue;
      }

      if (p.state === 'flee') {
        p.fear -= dt;
        const sp = 3.4;
        // Corro en dirección contraria al peligro, pegado a la vereda.
        const tx = danger > 0 ? dgx : Math.sin(p.yaw), tz = danger > 0 ? dgz : Math.cos(p.yaw);
        const want = Math.atan2(tx, tz);
        p.yaw += angDelta(p.yaw, want) * Math.min(1, dt * 7);
        p.x += Math.sin(p.yaw) * sp * dt;
        p.z += Math.cos(p.yaw) * sp * dt;
        animateHuman(p.mesh, dt, sp, 'panic');
        if (p.fear <= 0 && danger === 0) {
          const b = this.city.blockAt(p.x, p.z);
          if (b) { p.block = b; p.side = 0; p.t = 0.5; }
          p.state = 'walk';
        }
      } else {
        p.t += (p.speed / (p.side % 2 === 0 ? p.block.w : p.block.d)) * p.dir * dt;
        if (p.t > 1 || p.t < 0) {
          // Esquina: doblo o cruzo a la manzana de enfrente.
          const wrap = p.t > 1;
          p.t = wrap ? 0 : 1;
          if (this.rng.chance(0.25)) {
            const nb = this.city.blockAt(p.block.cx + (this.rng.chance(0.5) ? 1 : -1) * (p.block.w + 30),
                                          p.block.cz + (this.rng.chance(0.5) ? 1 : -1) * (p.block.d + 30));
            if (nb) { p.block = nb; p.side = this.rng.int(0, 3); p.t = this.rng(); }
          } else {
            p.side = (p.side + (wrap ? p.dir : -p.dir) + 4) % 4;
          }
        }
        this.perimeter(p.block, p.side, p.t, q);
        p.x = q.x; p.z = q.z;
        const want = q.yaw + (p.dir > 0 ? 0 : Math.PI);
        p.yaw += angDelta(p.yaw, want) * Math.min(1, dt * 8);
        animateHuman(p.mesh, dt, p.speed, 'walk');
      }
      p.mesh.position.set(p.x, 0, p.z);
      p.mesh.rotation.y = p.yaw;
    }
  }

  // Devuelve cuántos peatones fueron atropellados en este frame.
  runOver(cars) {
    let n = 0;
    for (const p of this.list) {
      if (!p.active || p.state === 'down') continue;
      for (const c of cars) {
        if (c.speed < 2.2) continue;
        const dx = p.x - c.x, dz = p.z - c.z;
        if (dx * dx + dz * dz > (c.spec.L * 0.55) ** 2) continue;
        const f = c.forward();
        const along = dx * f.x + dz * f.z, side = dx * (-f.z) + dz * f.x;
        if (Math.abs(along) < c.spec.L / 2 + 0.3 && Math.abs(side) < c.spec.W / 2 + 0.3) {
          p.state = 'down'; p.downTime = 0; n++;
          p.x += f.x * 1.4; p.z += f.z * 1.4;
          break;
        }
      }
    }
    return n;
  }
}
