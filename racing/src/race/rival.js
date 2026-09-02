import { clamp } from '../core/utils.js';
import { construirAuto } from '../sim/malla.js';

// Rivales cinemáticos: corren sobre la traza con un perfil de velocidad
// calculado por curvatura, en vez de simular física completa.
//
// Es una decisión, no una excusa: un piloto con física completa que sepa
// recuperarse de un trompo es un proyecto en sí mismo, y esto es lo que usan
// los arcades de verdad. Se ve bien, no se va nunca de pista, y pelea.
const COLORES = [0x3aa0ff, 0x35d07f, 0xffc447, 0xb06cff, 0xff6b4a, 0xe8e4d8, 0x18b6a6, 0xff4d8d];
const NOMBRES = ['Barrales', 'Ferrante', 'Godoy', 'Sarti', 'Ledesma', 'Quiroga', 'Nieto', 'Ávila'];

export class Rival {
  constructor(circuito, escena, i, opciones = {}) {
    this.c = circuito;
    this.i = i;
    this.nombre = NOMBRES[i % NOMBRES.length];
    this.destreza = opciones.destreza ?? (0.90 + (i % 4) * 0.025);
    this.topeKmh = opciones.topeKmh ?? 225;
    this.acel = opciones.acel ?? 7.4;         // m/s² efectivos en salida
    this.mu = opciones.mu ?? 1.34;
    this.malla = construirAuto(COLORES[i % COLORES.length]);
    escena.add(this.malla);

    this.s = 0; this.v = 0; this.carril = 0; this.carrilObj = 0;
    this.vuelta = 0; this.yaw = 0; this.x = 0; this.z = 0;
    this.terminado = false; this.tiempo = 0;
    this.giroRueda = 0;
  }

  colocar(s, carril) {
    this.s = ((s % this.c.largo) + this.c.largo) % this.c.largo;
    this.carril = this.carrilObj = carril;
    this.v = 0; this.vuelta = 0; this.terminado = false; this.tiempo = 0;
    this.sincronizar();
  }

  vMax(curv) {
    const k = Math.abs(curv);
    if (k < 1e-5) return 999;
    return Math.sqrt(this.mu * 9.81 / k) * this.destreza;
  }

  // Velocidad objetivo: la menor que permita la curva más exigente que viene,
  // considerando cuánto se puede frenar de acá hasta ahí.
  objetivo() {
    const tope = this.topeKmh / 3.6;
    let v = tope;
    const desac = this.mu * 8.5;
    for (let d = 4; d < 260; d += 6) {
      const vc = this.vMax(this.c.linea.en(this.s + d).curv);
      if (vc >= tope) continue;
      // Velocidad máxima ahora para poder llegar a vc dentro de d metros.
      const permitida = Math.sqrt(vc * vc + 2 * desac * Math.max(0, d - 5));
      v = Math.min(v, permitida);
    }
    return Math.min(v, this.vMax(this.c.linea.en(this.s + 5).curv));
  }

  update(dt, mundo) {
    if (this.terminado) { this.sincronizar(); return; }
    this.tiempo += dt;
    const L = this.c.largo;

    let obj = this.objetivo();

    // Tráfico: si tengo a alguien pegado adelante en mi mismo carril, levanto
    // y busco otro carril para pasarlo.
    let bloqueo = null, gap = 1e9;
    for (const o of mundo.otros) {
      if (o === this) continue;
      let d = o.s - this.s;
      if (d < -L / 2) d += L;
      if (d > L / 2) d -= L;
      if (d > 0 && d < 34 && Math.abs(o.carril - this.carril) < 2.4 && d < gap) { gap = d; bloqueo = o; }
    }
    if (bloqueo) {
      obj = Math.min(obj, bloqueo.v + Math.max(0, (gap - 7)) * 0.55);
      const ancho = this.c.anchoEn(this.s) / 2 - 1.6;
      const lado = bloqueo.carril >= 0 ? -1 : 1;
      this.carrilObj = clamp(bloqueo.carril + lado * 3.0, -ancho, ancho);
    } else {
      this.carrilObj *= 0.94;      // vuelve a la traza
    }

    const acel = obj > this.v ? this.acel * clamp(1 - this.v / (this.topeKmh / 3.6), 0.18, 1)
                              : -this.mu * 9.0;
    this.v = Math.max(2, this.v + acel * dt);
    if (acel < 0) this.v = Math.max(obj, this.v);
    else this.v = Math.min(obj, this.v);

    const antes = this.s;
    this.s += this.v * dt;
    if (this.s >= L) { this.s -= L; this.vuelta++; }
    this.carril += (this.carrilObj - this.carril) * Math.min(1, dt * 2.2);
    this.giroRueda += (this.v / 0.315) * dt;
    this.sincronizar();
  }

  sincronizar() {
    const m = this.c.linea.en(this.s);
    this.x = m.x + m.nx * this.carril;
    this.z = m.z + m.nz * this.carril;
    this.yaw = Math.atan2(m.tx, m.tz);
    this.malla.position.set(this.x, 0, this.z);
    this.malla.rotation.y = this.yaw;
    for (const k in this.malla.userData.ruedas)
      this.malla.userData.ruedas[k].rotation.x = this.giroRueda;
  }

  get avance() { return this.vuelta * this.c.largo + this.s; }
  get kmh() { return this.v * 3.6; }
}
