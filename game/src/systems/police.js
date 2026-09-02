import * as THREE from 'three';
import { CFG } from '../core/config.js';
import { VEHICLES } from '../vehicles/catalog.js';
import { buildVehicle } from '../vehicles/model.js';
import { Car, collideWorld } from '../vehicles/physics.js';
import { clamp, angDelta } from '../core/utils.js';

const CRIME = {
  atropello: 0.95,
  robo: 0.60,
  chocarPatrullero: 0.85,
  choque: 0.10,
  contramano: 0.02,
};

// Cinco estrellas. La Federal patrulla el centro y persigue prolijo;
// la Bonaerense aparece de tres estrellas para arriba y te va a chocar.
export class Police {
  constructor(scene, city, roads, rng) {
    this.city = city; this.roads = roads; this.rng = rng;
    this.group = new THREE.Group(); scene.add(this.group);
    this.units = [];
    this.heat = 0;
    this.unseen = 0;
    this.blinker = 0;
    this.busted = 0;
    this.disparos = [];   // tiros de la cana pendientes de resolver este frame
  }

  crime(kind, mult = 1) {
    const v = (CRIME[kind] || 0.1) * mult;
    this.heat = Math.min(CFG.WANTED_MAX, this.heat + v);
    this.unseen = 0;
  }

  get stars() { return Math.ceil(this.heat - 1e-6); }

  wanted() { return Math.max(0, Math.min(CFG.WANTED_MAX, Math.ceil(this.heat - 1e-6))); }

  clear() { this.heat = 0; this.unseen = 0; for (const u of this.units) this.retire(u); }

  desiredUnits() {
    const s = this.wanted();
    return [0, 1, 2, 4, 6, 8][s] || 0;
  }

  retire(u) { u.active = false; if (u.mesh) u.mesh.visible = false; }

  spawn(px, pz, aggressive) {
    const rng = this.rng;
    const kind = aggressive && rng.chance(0.55) ? 'bonaerense' : 'patrullero';
    const spec = VEHICLES[kind];
    for (let k = 0; k < 16; k++) {
      const ang = rng() * Math.PI * 2, r = rng.range(120, 240);
      const hit = this.roads.nearestEdge(px + Math.cos(ang) * r, pz + Math.sin(ang) * r);
      if (!hit) continue;
      const dir = rng.chance(0.5) ? 1 : -1;
      const p = this.roads.lanePos(hit.e, dir, 0, clamp(hit.t, 0.1, 0.9));
      if (Math.hypot(p.x - px, p.z - pz) < 90) continue;
      let u = this.units.find(x => !x.active && x.kind === kind);
      if (!u) {
        u = { kind, mesh: buildVehicle(spec, spec.colors[0]), active: false, path: null, pi: 0, repath: 0, siren: 0 };
        this.group.add(u.mesh);
        this.units.push(u);
      }
      u.car = new Car(spec, p.x, p.z, this.roads.laneHeading(hit.e, dir));
      u.vida = 100; u.tiro = this.rng.range(0.4, 1.6);
      u.active = true; u.mesh.visible = true; u.path = null; u.repath = 0;
      u.force = kind === 'bonaerense' ? 'bonaerense' : 'federal';
      return u;
    }
    return null;
  }

  update(dt, world) {
    const { px, pz, playerCar, playerSpeed, solidsNear } = world;
    this.blinker += dt;
    this.disparos.length = 0;

    // Enfriamiento: si nadie te ve, la estrella baja sola.
    let seen = false;
    for (const u of this.units) {
      if (!u.active) continue;
      if (Math.hypot(u.car.x - px, u.car.z - pz) < 95) seen = true;
    }
    if (!seen && this.heat > 0) {
      this.unseen += dt;
      if (this.unseen > CFG.HIDE_TIME) this.heat = Math.max(0, this.heat - CFG.HEAT_DECAY * dt * (1 + this.heat * 0.4));
    } else if (seen) this.unseen = 0;

    const want = this.desiredUnits();
    let live = 0;
    for (const u of this.units) if (u.active) live++;
    if (live < want && this.rng.chance(0.6)) this.spawn(px, pz, this.wanted() >= 3);
    if (live > want) {
      for (const u of this.units) {
        if (!u.active) continue;
        if (Math.hypot(u.car.x - px, u.car.z - pz) > 220) { this.retire(u); break; }
      }
    }

    for (const u of this.units) {
      if (!u.active) continue;
      const c = u.car;
      const d = Math.hypot(px - c.x, pz - c.z);
      if (d > 520) { this.retire(u); continue; }

      // Objetivo: lejos sigo el grafo de calles, cerca voy directo con adelanto.
      let tx = px, tz = pz;
      if (d > 55) {
        u.repath -= dt;
        if (!u.path || u.repath <= 0) {
          const from = this.roads.nodeNear(c.x, c.z), to = this.roads.nodeNear(px, pz);
          u.path = this.roads.path(from, to); u.pi = 0; u.repath = 1.6;
        }
        if (u.path && u.path.length) {
          while (u.pi < u.path.length - 1) {
            const n = this.roads.nodes[u.path[u.pi]];
            if (Math.hypot(n.x - c.x, n.z - c.z) < 16) u.pi++; else break;
          }
          const n = this.roads.nodes[u.path[Math.min(u.pi, u.path.length - 1)]];
          tx = n.x; tz = n.z;
        }
      } else if (playerCar) {
        const lead = this.wanted() >= 3 ? 0.55 : 0.25;
        tx = px + playerCar.vx * lead; tz = pz + playerCar.vz * lead;
      }

      const want2 = Math.atan2(tx - c.x, tz - c.z);
      const err = angDelta(c.yaw, want2);
      // Un volante positivo hace crecer el yaw, así que el error va con su signo.
      c.steer = clamp(err * 1.9, -1, 1);

      const aggro = u.force === 'bonaerense' ? 1.15 : 1.0;
      const cruise = clamp(c.spec.topSpeed * aggro, 10, 60);
      // Freno para las curvas: si estoy muy cruzado y rápido, levanto.
      const turnBrake = clamp(1 - Math.abs(err) * 0.9, -1, 1);
      let thr = c.speed > cruise ? -0.3 : turnBrake;
      if (d < 9 && this.wanted() >= 3) thr = 1;            // embestida
      if (d < 6 && this.wanted() < 3) thr = -1;            // corte de ruta
      c.throttle = clamp(thr, -1, 1);
      c.handbrake = Math.abs(err) > 1.5 && c.speed > 14;

      c.step(dt);
      collideWorld(c, solidsNear(c.x, c.z), null);

      const m = u.mesh;
      m.position.set(c.x, 0, c.z);
      m.rotation.y = c.yaw;
      for (const w of m.userData.wheels) {
        w.rotation.x = c.wheelSpin;
        if (w.userData.steer) w.rotation.y = c.steer * 0.4;
      }
      if (m.userData.beacon) {
        const on = (this.blinker * 6) % 2 < 1;
        m.userData.beacon.material.color.setHex(on ? 0xff2020 : 0x2040ff);
      }

      // Te arrestan si estás quieto y te tienen encima: a pie o con el auto
      // parado. Antes sólo contaba a pie, así que arriba del auto nunca
      // pasaba nada por más que te rodearan.
      const quieto = playerSpeed < (playerCar ? 3.5 : 2);
      if (d < (playerCar ? 7 : 4.8) && quieto && c.speed < 4) this.busted += dt;

      // De dos estrellas para arriba te tiran si estás a pie y cerca.
      if (!playerCar && this.wanted() >= 2 && d < 34) {
        u.tiro -= dt;
        if (u.tiro <= 0) {
          u.tiro = this.rng.range(0.7, 1.8);
          this.disparos.push({ x: c.x, z: c.z, tx: px, tz: pz, dano: this.rng.range(5, 11) });
        }
      }
    }
    if (!this.units.some(u => u.active && Math.hypot(u.car.x - px, u.car.z - pz) < (world.playerCar ? 8 : 6)))
      this.busted = 0;
  }

  activeCars() { return this.units.filter(u => u.active).map(u => u.car); }
}
