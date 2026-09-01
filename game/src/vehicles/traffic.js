import * as THREE from 'three';
import { CFG } from '../core/config.js';
import { VEHICLES, pickCivilian } from './catalog.js';
import { buildVehicle } from './model.js';
import { Car, collideWorld } from './physics.js';
import { clamp, angDelta } from '../core/utils.js';

// El tráfico corre sobre carriles de forma cinemática mientras nadie lo toca:
// así se ve ordenado y no tiembla. Cuando lo chocás pasa a física completa
// ("loose"), sale despedido, y si sobrevive intenta volver a la mano.
export class Traffic {
  constructor(scene, city, roads, rng) {
    this.city = city; this.roads = roads; this.rng = rng;
    this.group = new THREE.Group(); scene.add(this.group);
    this.cars = [];
    this.buckets = new Map();
    for (let i = 0; i < CFG.TRAFFIC_CARS; i++) this.cars.push(this.makeSlot());
  }

  makeSlot() {
    return { active: false, mesh: null, car: null, kind: null, mode: 'lane', e: null, dir: 1, lane: 0, s: 0, v: 0, target: 0, wait: 0, looseT: 0, wreck: false, honk: 0 };
  }

  limit(e) { return e.big ? 15.5 : 10.5; }

  spawn(t, px, pz) {
    const rng = this.rng;
    for (let k = 0; k < 14; k++) {
      const ang = rng() * Math.PI * 2;
      const r = rng.range(CFG.SIM_RADIUS * 0.45, CFG.SIM_RADIUS);
      const hit = this.roads.nearestEdge(px + Math.cos(ang) * r, pz + Math.sin(ang) * r);
      if (!hit || this.roads.isBlocked(hit.e)) continue;
      const e = hit.e;
      const kind = pickCivilian(rng);
      const spec = VEHICLES[kind];
      if (spec.class === 'bus' && !e.big) continue;
      const dir = rng.chance(0.5) ? 1 : -1;
      const lane = rng.int(0, e.lanes - 1);
      const s = clamp(hit.t, 0.08, 0.92) * e.len;
      const p = this.roads.lanePos(e, dir, lane, s / e.len);
      if (Math.hypot(p.x - px, p.z - pz) < 45) continue;

      if (!t.mesh || t.kind !== kind) {
        if (t.mesh) this.group.remove(t.mesh);
        const color = spec.colors[rng.int(0, spec.colors.length - 1)];
        t.mesh = buildVehicle(spec, color);
        this.group.add(t.mesh);
        t.kind = kind;
      }
      t.car = new Car(spec, p.x, p.z, this.roads.laneHeading(e, dir));
      t.active = true; t.mode = 'lane'; t.e = e; t.dir = dir; t.lane = lane; t.s = s;
      t.v = this.limit(e) * rng.range(0.7, 1.0); t.wreck = false; t.looseT = 0; t.honk = 0;
      t.mesh.visible = true;
      return true;
    }
    return false;
  }

  key(e, dir, lane) { return e.id * 16 + (dir > 0 ? 8 : 0) + lane; }

  update(dt, world) {
    const { px, pz, obstacles } = world;

    // Índice por carril para saber quién tengo adelante.
    this.buckets.clear();
    for (const t of this.cars) {
      if (!t.active || t.mode !== 'lane') continue;
      const k = this.key(t.e, t.dir, t.lane);
      let b = this.buckets.get(k);
      if (!b) { b = []; this.buckets.set(k, b); }
      b.push(t);
    }

    for (const t of this.cars) {
      if (!t.active) { if (this.rng.chance(0.5)) this.spawn(t, px, pz); continue; }
      const c = t.car;
      const far = Math.hypot(c.x - px, c.z - pz);
      if (far > CFG.DESPAWN_RADIUS) { t.active = false; t.mesh.visible = false; continue; }

      if (t.mode === 'loose') { this.stepLoose(t, dt, world); }
      else { this.stepLane(t, dt, world, obstacles); }

      const m = t.mesh;
      m.position.set(c.x, 0, c.z);
      m.rotation.y = c.yaw;
      const wd = m.userData;
      for (const w of wd.wheels) {
        w.rotation.x = c.wheelSpin;
        if (w.userData.steer) w.rotation.y = c.steer * 0.4;
      }
      for (const b of wd.brakes) b.visible = t.mode === 'lane' && t.decel > 1.2;
    }
  }

  stepLane(t, dt, world, obstacles) {
    const R = this.roads, e = t.e;
    const lim = this.limit(e) * (t.car.spec.class === 'bus' ? 0.78 : 1);
    let target = lim;

    const toEnd = e.len - t.s;
    const node = R.nodes[t.dir > 0 ? e.b : e.a];

    // Semáforo
    if (toEnd < 42 && !R.hasGreen(node, e)) target = Math.min(target, Math.max(0, (toEnd - 8) * 0.34));
    // Bajo un poco antes de cruzar, aunque tenga verde
    if (toEnd < 16) target = Math.min(target, lim * 0.6);

    // Auto adelante en mi mismo carril
    const b = this.buckets.get(this.key(e, t.dir, t.lane));
    if (b) {
      let gap = Infinity, lead = null;
      for (const o of b) {
        if (o === t) continue;
        const d = o.s - t.s;
        if (d > 0 && d < gap) { gap = d; lead = o; }
      }
      if (lead) {
        const clear = gap - (t.car.spec.L / 2 + lead.car.spec.L / 2 + 1.6);
        if (clear < 26) target = Math.min(target, Math.max(0, lead.v * 0.92 + (clear - 7) * 0.5));
      }
    }

    // Cualquier cosa parada adelante (el jugador, un patrullero, un choque)
    const f = { x: Math.sin(t.car.yaw), z: Math.cos(t.car.yaw) };
    for (const o of obstacles) {
      const dx = o.x - t.car.x, dz = o.z - t.car.z;
      const along = dx * f.x + dz * f.z;
      if (along < 0 || along > 24) continue;
      const side = Math.abs(dx * (-f.z) + dz * f.x);
      if (side > 2.6) continue;
      target = Math.min(target, Math.max(0, (along - 6.5) * 0.55));
      if (along < 12 && t.v < 2) t.honk = Math.max(t.honk, 0.8);
    }

    const accel = target > t.v ? 3.6 : 8.5;
    const prev = t.v;
    t.v += clamp(target - t.v, -accel * dt, accel * dt);
    t.v = Math.max(0, t.v);
    t.decel = (prev - t.v) / dt;
    t.honk = Math.max(0, t.honk - dt);

    t.s += t.v * dt;
    if (t.s >= e.len) {
      // Llegué a la esquina: elijo salida sin contramano ni vuelta en U.
      const nodeId = t.dir > 0 ? e.b : e.a;
      const exits = R.exitsFrom(nodeId, e.id);
      if (!exits.length) { t.active = false; t.mesh.visible = false; return; }
      // Preferencia por seguir derecho y por avenidas.
      const h0 = R.laneHeading(e, t.dir);
      let best = null, bestW = -1;
      for (const ex of exits) {
        const h = R.laneHeading(ex.e, ex.dir);
        const turn = Math.abs(angDelta(h0, h));
        let w = (turn < 0.3 ? 3.2 : turn < 1.9 ? 1.0 : 0.15) * (ex.e.big ? 1.5 : 1) * this.rng.range(0.6, 1.4);
        if (w > bestW) { bestW = w; best = ex; }
      }
      t.s -= e.len;
      t.e = best.e; t.dir = best.dir;
      t.lane = Math.min(t.lane, best.e.lanes - 1);
      t.s = Math.min(t.s, best.e.len * 0.5);
    }

    const p = R.lanePos(t.e, t.dir, t.lane, t.s / t.e.len);
    const c = t.car;
    const wantYaw = R.laneHeading(t.e, t.dir);
    c.x = p.x; c.z = p.z;
    c.yaw += angDelta(c.yaw, wantYaw) * Math.min(1, dt * 6);
    c.vx = Math.sin(wantYaw) * t.v; c.vz = Math.cos(wantYaw) * t.v;
    c.wheelSpin += (t.v / 0.34) * dt;
    c.steer = angDelta(c.yaw, wantYaw) * 2;
  }

  stepLoose(t, dt, world) {
    const c = t.car;
    c.throttle = 0; c.steer = 0;
    c.step(dt);
    collideWorld(c, world.solidsNear(c.x, c.z), null);
    t.looseT += dt;
    t.v = c.speed;
    if (t.looseT > 3.5 && c.speed < 1.4) {
      if (c.damage > 55) { t.wreck = true; return; }   // quedó para el desarmadero
      const hit = this.roads.nearestEdge(c.x, c.z);
      if (hit) {
        const e = hit.e;
        // Vuelvo a la mano cuyo rumbo se parezca más al que tengo.
        const d1 = Math.abs(angDelta(c.yaw, this.roads.laneHeading(e, 1)));
        const dir = d1 < Math.PI / 2 ? 1 : -1;
        t.e = e; t.dir = dir; t.lane = 0;
        t.s = clamp(hit.t, 0.05, 0.95) * e.len;
        t.mode = 'lane'; t.v = 0; t.looseT = 0;
      }
    }
  }

  knock(t) {
    if (t.mode === 'lane') { t.mode = 'loose'; t.looseT = 0; }
  }

  active() { return this.cars.filter(t => t.active); }
}
