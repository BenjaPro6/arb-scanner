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
    this.armor = 0;
    // Pistola en la mano derecha: sólo se ve cuando estás armado.
    this.gun = new THREE.Mesh(
      new THREE.BoxGeometry(0.08, 0.13, 0.26),
      new THREE.MeshLambertMaterial({ color: 0x22252b })
    );
    this.gun.position.set(0.30, 1.06, 0.16);
    this.gun.visible = false;
    this.mesh.add(this.gun);

    this.camYaw = 0; this.camPitch = 0.44; this.camDist = 8; this.camZoom = 1; this.lookIdle = 0;
    this.shake = 0;
  }

  get pos() { return this.mode === 'drive' ? { x: this.car.x, z: this.car.z } : { x: this.x, z: this.z }; }

  // Temporizadores que corren en los dos modos. Sin esto, enterCooldown se
  // quedaba en 0.4 para siempre y nunca más podías bajarte del auto.
  tick(dt) {
    this.enterCooldown = Math.max(0, this.enterCooldown - dt);
  }

  // El chaleco se come el daño primero; lo que sobra va a la salud.
  danar(n) {
    if (this.armor > 0) {
      const absorbe = Math.min(this.armor, n * 0.75);
      this.armor -= absorbe; n -= absorbe;
    }
    this.health -= n;
  }
  get speed() { return this.mode === 'drive' ? this.car.speed : Math.hypot(this.vx, this.vz); }

  updateFoot(dt, input, camAngle, solids) {
    const ax = input.axisX(), ay = input.axisY();
    const sprint = input.is('sprint');
    const maxV = sprint ? 5.6 : 2.4;
    let want = 0, has = false;
    if (ax || ay) {
      // Relativo a la cámara: W va hacia donde mirás, A y D caminan de costado.
      // El eje X va negado porque la derecha de la cámara es (-cos, sin).
      want = Math.atan2(-ax, ay) + camAngle;
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

  // Cámara en órbita, movida con el mouse. Antes seguía sola al personaje y
  // el personaje seguía a la cámara: esa realimentación era la que te hacía
  // girar 360 grados solo al caminar.
  updateCamera(camera, dt, input) {
    const p = this.pos;
    const m = input.consumeMouse ? input.consumeMouse() : { dx: 0, dy: 0, wheel: 0 };

    const sens = 0.0024;
    if (m.dx || m.dy) {
      this.camYaw -= m.dx * sens;
      this.camPitch = clamp(this.camPitch + m.dy * sens, -0.42, 1.05);
      this.lookIdle = 0;
    } else {
      this.lookIdle = (this.lookIdle || 0) + dt;
    }
    if (input.is && input.is('camleft')) { this.camYaw += dt * 2.0; this.lookIdle = 0; }
    if (input.is && input.is('camright')) { this.camYaw -= dt * 2.0; this.lookIdle = 0; }
    if (m.wheel) this.camZoom = clamp((this.camZoom || 1) + m.wheel * 0.12, 0.6, 2.0);

    const driving = this.mode === 'drive';
    // Manejando, si soltás el mouse la cámara vuelve sola atrás del auto.
    if (driving && this.lookIdle > 1.1) {
      const k = Math.min(1, dt * 2.2);
      this.camYaw += angDelta(this.camYaw, this.car.yaw) * k;
      this.camPitch += (0.44 - this.camPitch) * k;
    }

    const v = driving ? this.car.speed : 0;
    const dist = (driving
      ? lerp(8.8, 13.2, clamp(v / 34, 0, 1)) * (this.car.spec.L / 4.6)
      : 5.0) * (this.camZoom || 1);
    this.camDist = lerp(this.camDist, dist, Math.min(1, dt * 4));

    const ty = driving ? 1.25 : 1.35;
    const cp = Math.cos(this.camPitch), sp = Math.sin(this.camPitch);
    let sh = 0;
    if (this.shake > 0) { sh = this.shake; this.shake = Math.max(0, this.shake - dt * 2.2); }

    camera.position.set(
      p.x - Math.sin(this.camYaw) * this.camDist * cp + (Math.random() - 0.5) * sh * 1.2,
      Math.max(0.9, ty + this.camDist * sp) + (Math.random() - 0.5) * sh * 0.8,
      p.z - Math.cos(this.camYaw) * this.camDist * cp + (Math.random() - 0.5) * sh * 1.2
    );
    camera.lookAt(p.x, ty, p.z);
  }

}
