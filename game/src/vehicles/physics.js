import { clamp } from '../core/utils.js';

// Modelo de neumático de dos ejes con ángulo de deriva. Es el que da la
// sensación arcade correcta: el tren trasero se suelta, el auto contradirige
// y con el freno de mano derrapás de verdad.
//
// El auto mira hacia +Z. Adelante f = (sin yaw, cos yaw), derecha r = (-cos yaw, sin yaw).
export class Car {
  constructor(spec, x, z, yaw = 0) {
    this.spec = spec;
    this.x = x; this.z = z; this.yaw = yaw;
    this.vx = 0; this.vz = 0; this.yawRate = 0;
    this.steer = 0; this.throttle = 0; this.brake = 0; this.handbrake = false;
    this.damage = 0; this.wheelSpin = 0; this.slip = 0;
    this.a = spec.L * 0.42; this.b = spec.L * 0.42;
    this.Izz = spec.mass * (spec.L * spec.L + spec.W * spec.W) / 12;
    this.cd = spec.power / (spec.topSpeed * spec.topSpeed);   // arrastre coherente con la velocidad máxima
    this.rr = this.cd * 9;
    this.radius = spec.W * 0.52;
    this.alive = true;
  }

  get speed() { return Math.hypot(this.vx, this.vz); }
  get kmh() { return this.speed * 3.6; }

  forward() { return { x: Math.sin(this.yaw), z: Math.cos(this.yaw) }; }
  right() { return { x: -Math.cos(this.yaw), z: Math.sin(this.yaw) }; }

  step(dt) {
    const s = this.spec;
    const f = this.forward(), r = this.right();
    let vLong = this.vx * f.x + this.vz * f.z;
    let vLat = this.vx * r.x + this.vz * r.z;
    const speed = Math.hypot(vLong, vLat);

    // A más velocidad, menos ángulo de volante: si no, es imposible de manejar.
    const steerFade = 1 / (1 + speed * 0.055);
    const delta = this.steer * s.steerMax * steerFade;

    const vRef = Math.max(Math.abs(vLong), 2.2);
    const sgn = vLong >= 0 ? 1 : -1;
    const alphaF = Math.atan((vLat + this.yawRate * this.a) / vRef) - delta * sgn;
    const alphaR = Math.atan((vLat - this.yawRate * this.b) / vRef);

    const g = 9.81;
    const wb = this.a + this.b;
    const loadF = s.mass * g * (this.b / wb);
    const loadR = s.mass * g * (this.a / wb);
    const Cs = 12;                                   // rigidez en curva (rad^-1)
    const muF = s.grip;
    const muR = s.grip * (this.handbrake ? 0.36 : 1.0);

    const Fyf = clamp(-Cs * alphaF * loadF, -muF * loadF, muF * loadF);
    const Fyr = clamp(-Cs * alphaR * loadR, -muR * loadR, muR * loadR);

    // Longitudinal: acelerador, freno, arrastre y rodadura.
    let Flong = 0;
    if (this.throttle > 0) Flong += s.power * this.throttle * (vLong < s.topSpeed ? 1 : 0);
    if (this.throttle < 0) {
      // Freno si voy para adelante, marcha atrás si ya estoy casi parado.
      if (vLong > 0.6) Flong -= s.brake * -this.throttle;
      else Flong += s.power * 0.45 * this.throttle;
    }
    if (this.handbrake) Flong -= Math.sign(vLong) * s.brake * 0.55;
    Flong -= this.cd * vLong * Math.abs(vLong);
    Flong -= this.rr * vLong;

    const accLong = Flong / s.mass + (this.yawRate * vLat);
    const accLat = (Fyf * Math.cos(delta) + Fyr) / s.mass - (this.yawRate * vLong);
    const torque = this.a * Fyf * Math.cos(delta) - this.b * Fyr;

    vLong += accLong * dt;
    vLat += accLat * dt;
    this.yawRate += (torque / this.Izz) * dt;
    this.yawRate *= Math.exp(-dt * (1.4 + 6 / (1 + speed)));   // amortiguación de guiñada

    if (Math.abs(vLong) < 0.25 && this.throttle === 0) { vLong *= 0.80; this.yawRate *= 0.6; }

    this.yaw += this.yawRate * dt;
    this.vx = vLong * f.x + vLat * r.x;
    this.vz = vLong * f.z + vLat * r.z;
    this.x += this.vx * dt;
    this.z += this.vz * dt;

    // Para efectos: humo de goma y ruido de derrape.
    this.slip = clamp((Math.abs(vLat) - 1.5) / 8, 0, 1) * clamp(speed / 6, 0, 1);
    this.wheelSpin += (vLong / 0.34) * dt;
    this.accLong = accLong; this.accLat = accLat;
    this.vLong = vLong; this.vLat = vLat;
  }

  applyImpulse(nx, nz, mag, px, pz) {
    this.vx += nx * mag; this.vz += nz * mag;
    if (px !== undefined) {
      const ox = px - this.x, oz = pz - this.z;
      this.yawRate += (ox * (nz * mag) - oz * (nx * mag)) / this.Izz * this.spec.mass * 0.12;
    }
  }
}

// Tres círculos a lo largo del eje del auto: barato y se porta bien con
// vehículos largos como el bondi.
export function collideWorld(car, solids, hash) {
  const f = car.forward();
  const hl = car.spec.L / 2 - car.radius;
  let hit = 0;
  for (const s of [-1, 0, 1]) {
    const px = car.x + f.x * hl * s, pz = car.z + f.z * hl * s;
    for (const box of solids) {
      if (px < box.x0 - car.radius || px > box.x1 + car.radius ||
          pz < box.z0 - car.radius || pz > box.z1 + car.radius) continue;
      const cx = clamp(px, box.x0, box.x1), cz = clamp(pz, box.z0, box.z1);
      let dx = px - cx, dz = pz - cz;
      let d = Math.hypot(dx, dz);
      if (d >= car.radius) continue;
      let nx, nz;
      if (d > 1e-4) { nx = dx / d; nz = dz / d; }
      else {
        // Centro adentro de la caja: empujo por la cara más cercana.
        const dl = px - box.x0, dr = box.x1 - px, dt = pz - box.z0, db = box.z1 - pz;
        const m = Math.min(dl, dr, dt, db);
        nx = m === dl ? -1 : m === dr ? 1 : 0;
        nz = m === dt ? -1 : m === db ? 1 : 0;
        d = 0;
      }
      const pen = car.radius - d;
      car.x += nx * pen; car.z += nz * pen;
      const vn = car.vx * nx + car.vz * nz;
      if (vn < 0) {
        hit = Math.max(hit, -vn);
        car.applyImpulse(nx, nz, -vn * 1.25, px, pz);
        // fricción tangencial contra la pared
        car.vx *= 0.90; car.vz *= 0.90;
        car.yawRate *= 0.72;
      }
    }
  }
  if (hit > 3) car.damage = Math.min(100, car.damage + hit * 1.4);
  return hit;
}

export function collideCars(a, b) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const ra = (a.spec.L + a.spec.W) / 4, rb = (b.spec.L + b.spec.W) / 4;
  const min = ra + rb;
  const d2 = dx * dx + dz * dz;
  if (d2 > min * min || d2 < 1e-6) return 0;
  const d = Math.sqrt(d2);
  const nx = dx / d, nz = dz / d, pen = min - d;
  const ma = a.spec.mass, mb = b.spec.mass, mt = ma + mb;
  a.x -= nx * pen * (mb / mt); a.z -= nz * pen * (mb / mt);
  b.x += nx * pen * (ma / mt); b.z += nz * pen * (ma / mt);
  const rel = (b.vx - a.vx) * nx + (b.vz - a.vz) * nz;
  if (rel > 0) return 0;
  const j = -(1.35) * rel / (1 / ma + 1 / mb);
  a.applyImpulse(-nx, -nz, j / ma, (a.x + b.x) / 2, (a.z + b.z) / 2);
  b.applyImpulse(nx, nz, j / mb, (a.x + b.x) / 2, (a.z + b.z) / 2);
  const sev = -rel;
  a.damage = Math.min(100, a.damage + sev * 1.1);
  b.damage = Math.min(100, b.damage + sev * 1.1);
  return sev;
}
