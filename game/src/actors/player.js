import * as THREE from 'three';
import { buildHuman, animateHuman } from './human.js';
import { Car, collideWorld } from '../vehicles/physics.js';
import { clamp, angDelta, lerp } from '../core/utils.js';

// El jugador alterna entre dos modos: a pie y al volante. La cámara y el
// control cambian, la posición es continua — entrar y salir no corta nada.
export class Player {
  constructor(scene, rng, startX, startZ) {
    this.mesh = buildHuman(rng, { shirt: '#d8d3c4', pants: '#20242c', scale: 1.0 });
    scene.add(this.mesh);
    this.x = startX; this.z = startZ; this.yaw = 0;
    this.vx = 0; this.vz = 0;
    this.mode = 'foot';
    this.vehicle = null;        // slot de tráfico o auto propio
    this.car = null;            // instancia de Car cuando manejo
    this.enterCooldown = 0;
    this.health = 100;
    this.camYaw = 0; this.camDist = 8; this.camHeight = 3.2;
    this.shake = 0;
  }

  get pos() { return this.mode === 'drive' ? { x: this.car.x, z: this.car.z } : { x: this.x, z: this.z }; }
  get speed() { return this.mode === 'drive' ? this.car.speed : Math.hypot(this.vx, this.vz); }

  updateFoot(dt, input, camAngle, solids) {
    const ax = input.axisX(), ay = input.axisY();
    const sprint = input.is('sprint');
    const maxV = sprint ? 5.6 : 2.4;
    let want = 0, has = false;
    if (ax || ay) {
      // Movimiento relativo a la cámara, como corresponde en tercera persona.
      want = Math.atan2(ax, ay) + camAngle;
      has = true;
    }
    const accel = 22;
    if (has) {
      const tx = Math.sin(want) * maxV, tz = Math.cos(want) * maxV;
      this.vx += clamp(tx - this.vx, -accel * dt, accel * dt);
      this.vz += clamp(tz - this.vz, -accel * dt, accel * dt);
      this.yaw += angDelta(this.yaw, Math.atan2(this.vx, this.vz)) * Math.min(1, dt * 12);
    } else {
      this.vx *= Math.exp(-dt * 12); this.vz *= Math.exp(-dt * 12);
    }
    this.x += this.vx * dt; this.z += this.vz * dt;

    // Colisión contra los edificios: círculo de 0.4m.
    for (const b of solids) {
      if (this.x < b.x0 - 0.4 || this.x > b.x1 + 0.4 || this.z < b.z0 - 0.4 || this.z > b.z1 + 0.4) continue;
      const cx = clamp(this.x, b.x0, b.x1), cz = clamp(this.z, b.z0, b.z1);
      let dx = this.x - cx, dz = this.z - cz, d = Math.hypot(dx, dz);
      if (d >= 0.4) continue;
      if (d < 1e-4) {
        const dl = this.x - b.x0, dr = b.x1 - this.x, dtp = this.z - b.z0, db = b.z1 - this.z;
        const m = Math.min(dl, dr, dtp, db);
        dx = m === dl ? -1 : m === dr ? 1 : 0; dz = m === dtp ? -1 : m === db ? 1 : 0; d = 1;
      }
      this.x += (dx / d) * (0.4 - d); this.z += (dz / d) * (0.4 - d);
    }

    const sp = Math.hypot(this.vx, this.vz);
    animateHuman(this.mesh, dt, sp, sp > 3.2 ? 'run' : sp > 0.15 ? 'walk' : 'idle');
    this.mesh.position.set(this.x, 0, this.z);
    this.mesh.rotation.y = this.yaw;
    this.mesh.visible = true;
  }

  updateDrive(dt, input, solids) {
    const c = this.car;
    c.throttle = input.axisY();
    c.steer = -input.axisX();
    c.handbrake = input.is('handbrake');
    c.step(dt);
    const hit = collideWorld(c, solids, null);
    if (hit > 6) { this.health -= (hit - 6) * 1.4; this.shake = Math.max(this.shake, clamp(hit / 14, 0, 1)); }
    this.x = c.x; this.z = c.z; this.yaw = c.yaw;
    this.mesh.visible = false;
  }

  enter(slot, car) {
    this.mode = 'drive'; this.vehicle = slot; this.car = car;
    this.enterCooldown = 0.4;
  }

  exit() {
    const c = this.car;
    const r = c.right();
    this.x = c.x - r.x * (c.spec.W / 2 + 0.8);
    this.z = c.z - r.z * (c.spec.W / 2 + 0.8);
    this.yaw = c.yaw;
    this.vx = 0; this.vz = 0;
    this.mode = 'foot'; this.vehicle = null; this.car = null;
    this.enterCooldown = 0.4;
  }

  // Cámara de persecución con adelanto por velocidad: es la mitad de la
  // sensación de manejo. Mira hacia donde vas, no hacia donde estás.
  updateCamera(camera, dt, input) {
    const p = this.pos;
    let targetYaw, dist, height, look;
    if (this.mode === 'drive') {
      const c = this.car;
      const v = c.speed;
      // Al ir marcha atrás, la cámara no se da vuelta: sigue el morro.
      targetYaw = c.yaw;
      dist = lerp(8.4, 13.6, clamp(v / 34, 0, 1)) * (c.spec.L / 4.6);
      height = lerp(4.4, 5.6, clamp(v / 34, 0, 1)) * (c.spec.H / 1.45);
      look = 3.4 + v * 0.34;
    } else {
      targetYaw = this.yaw;
      dist = 5.6; height = 3.4; look = 2.4;
    }
    const k = this.mode === 'drive' ? 4.2 : 6.5;
    this.camYaw += angDelta(this.camYaw, targetYaw) * Math.min(1, dt * k);
    this.camDist = lerp(this.camDist, dist, Math.min(1, dt * 4));
    this.camHeight = lerp(this.camHeight, height, Math.min(1, dt * 4));

    const bx = p.x - Math.sin(this.camYaw) * this.camDist;
    const bz = p.z - Math.cos(this.camYaw) * this.camDist;
    let sh = 0;
    if (this.shake > 0) {
      sh = this.shake; this.shake = Math.max(0, this.shake - dt * 2.2);
    }
    camera.position.set(
      bx + (Math.random() - 0.5) * sh * 1.2,
      this.camHeight + 0.6 + (Math.random() - 0.5) * sh * 0.8,
      bz + (Math.random() - 0.5) * sh * 1.2
    );
    camera.lookAt(
      p.x + Math.sin(this.camYaw) * look,
      this.mode === 'drive' ? 1.5 : 1.2,
      p.z + Math.cos(this.camYaw) * look
    );
  }
}
