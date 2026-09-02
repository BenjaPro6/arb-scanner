import * as T from './tire.js';
import { clamp } from '../core/utils.js';

// Auto de simulación, no arcade. Seis grados de libertad:
//   plano  -> avance, lateral y guiñada
//   masa suspendida -> hundimiento, cabeceo y balanceo
// Más la velocidad de giro de cada rueda, que es lo que permite patinar en
// aceleración y bloquear en frenada.
//
// La transferencia de peso NO es una fórmula instantánea: sale de la dinámica
// de resortes y amortiguadores. Por eso el auto tarda en apoyarse al entrar a
// una curva, y por eso se puede desestabilizar levantando de golpe.
//
// Ejes locales: adelante = (sin yaw, cos yaw); derecha = (-cos yaw, sin yaw).

export const TC = {
  nombre: 'TC 2000',
  masa: 1180, masaSusp: 1010,
  a: 1.28, b: 1.34,            // distancia del centro de gravedad a cada eje
  vias: 1.56, h: 0.46,         // trocha y altura del centro de gravedad
  Izz: 1620, Ipitch: 1500, Iroll: 480,
  kF: 52000, kR: 48000,        // resortes por rueda (N/m)
  cF: 4600, cR: 4300,          // amortiguadores (Ns/m)
  arbF: 19500, arbR: 12500,    // barra delantera más dura: el auto avisa antes de irse
  rueda: 0.315, Iw: 1.3, Imotor: 0.19, mu: 1.38,
  parMax: 340, rpmPar: 5200, rpmCorte: 7000, rpmRalenti: 900,
  marchas: [3.36, 2.14, 1.58, 1.24, 1.00, 0.84], final: 3.62,
  traccion: 'trasera',
  frenoMax: 4200, repFreno: 0.63,
  arrastre: 0.72,              // N por (m/s)^2
  cargaAero: 0.85,             // downforce por (m/s)^2
  volanteMax: 0.52,            // radianes de giro de rueda a tope de volante
};

const ORDEN = ['DI', 'DD', 'TI', 'TD'];   // delantera izq/der, trasera izq/der

export class Vehicle {
  constructor(spec = TC, x = 0, z = 0, yaw = 0) {
    this.s = spec;
    this.x = x; this.z = z; this.yaw = yaw;
    this.u = 0; this.v = 0; this.r = 0;          // avance, lateral, guiñada
    this.zs = 0; this.dzs = 0;                   // hundimiento
    this.pitch = 0; this.dpitch = 0;
    this.roll = 0; this.droll = 0;
    this.marcha = 1; this.rpm = spec.rpmRalenti;
    this.cambio = 0;

    // Geometría de cada rueda en ejes locales: [longitudinal, lateral]
    this.pos = {
      DI: [+spec.a, -spec.vias / 2], DD: [+spec.a, +spec.vias / 2],
      TI: [-spec.b, -spec.vias / 2], TD: [-spec.b, +spec.vias / 2],
    };
    // Carga estática: el eje delantero soporta según el reparto de pesos.
    const g = 9.81, L = spec.a + spec.b;
    const Ff = spec.masa * g * (spec.b / L) / 2;
    const Fr = spec.masa * g * (spec.a / L) / 2;
    this.estatico = { DI: Ff, DD: Ff, TI: Fr, TD: Fr };
    this.w = { DI: 0, DD: 0, TI: 0, TD: 0 };       // velocidad angular de rueda
    this.Fz = { ...this.estatico };
    this.slipL = { DI: 0, DD: 0, TI: 0, TD: 0 };   // deriva
    this.slipK = { DI: 0, DD: 0, TI: 0, TD: 0 };   // deslizamiento
    this.uso = { DI: 0, DD: 0, TI: 0, TD: 0 };     // 1 = al límite

    this.mandos = { acelerador: 0, freno: 0, volante: 0, mano: false, embrague: 0 };
    this.ffb = 0;             // par de autoalineación: la señal para el volante
    this.aLong = 0; this.aLat = 0;
  }

  get velocidad() { return Math.hypot(this.u, this.v); }
  get kmh() { return this.velocidad * 3.6; }
  adelante() { return { x: Math.sin(this.yaw), z: Math.cos(this.yaw) }; }
  derecha() { return { x: -Math.cos(this.yaw), z: Math.sin(this.yaw) }; }

  parMotor(rpm) {
    const s = this.s;
    if (rpm > s.rpmCorte) return 0;
    // Curva simple con pico y caída, más un valle abajo de vueltas.
    const x = (rpm - s.rpmPar) / (s.rpmPar * 0.95);
    const f = clamp(1 - x * x * 0.72, 0.18, 1);
    const arranque = clamp(rpm / 1400, 0.25, 1);
    return s.parMax * f * arranque;
  }

  relacion() { return this.s.marchas[this.marcha - 1] * this.s.final; }

  // Caja automática sencilla: sube cerca del corte, baja cuando cae de vueltas.
  cambiar(dt) {
    this.cambio = Math.max(0, this.cambio - dt);
    if (this.cambio > 0) return;
    const s = this.s;
    if (this.rpm > s.rpmCorte * 0.96 && this.marcha < s.marchas.length) { this.marcha++; this.cambio = 0.18; }
    else if (this.rpm < 2600 && this.marcha > 1) { this.marcha--; this.cambio = 0.18; }
  }

  paso(dt) {
    if (this.rpmReal === undefined) this.rpmReal = this.s.rpmRalenti;
    const s = this.s, g = 9.81;
    const m = this.mandos;
    const vel = this.velocidad;

    // --- Cargas verticales por rueda (dinámica de suspensión) ---
    const zc = {}, dzc = {};
    for (const k of ORDEN) {
      const [lo, la] = this.pos[k];
      zc[k] = this.zs + lo * this.pitch - la * this.roll;
      dzc[k] = this.dzs + lo * this.dpitch - la * this.droll;
    }
    const kOf = (k) => k[0] === 'D' ? s.kF : s.kR;
    const cOf = (k) => k[0] === 'D' ? s.cF : s.cR;
    const dF = {};
    for (const k of ORDEN) dF[k] = -kOf(k) * zc[k] - cOf(k) * dzc[k];
    // Barras estabilizadoras: reparten el balanceo entre ejes.
    const arb = (izq, der, kb) => {
      const t = kb * (zc[izq] - zc[der]);
      dF[izq] -= t; dF[der] += t;
    };
    arb('DI', 'DD', s.arbF); arb('TI', 'TD', s.arbR);

    for (const k of ORDEN) this.Fz[k] = Math.max(0, this.estatico[k] + dF[k]
      + s.cargaAero * vel * vel / 4);

    // --- Fuerzas de neumático ---
    const delta = m.volante * s.volanteMax;
    let Fx = 0, Fy = 0, Mz = 0, alineacion = 0;
    const parFreno = m.freno * s.frenoMax;
    const motriz = this.parMotriz(dt);

    for (const k of ORDEN) {
      const [lo, la] = this.pos[k];
      // Velocidad en el punto de contacto. El signo de lo·r es el que da el
      // amortiguamiento de guiñada: con el contrario, un auto que empieza a
      // girar se realimenta y hace trompo con cualquier entrada. Verificado
      // con la prueba de escalón de volante.
      const uW = this.u - this.r * la;
      const vW = this.v + this.r * lo;
      const frente = k[0] === 'D';
      const dir = frente ? delta : 0;

      // Deriva y deslizamiento en ejes de la rueda.
      const uR = uW * Math.cos(dir) + vW * Math.sin(dir);
      const vR = -uW * Math.sin(dir) + vW * Math.cos(dir);
      const ref = Math.max(Math.abs(uR), 1.6);
      const alpha = Math.atan2(vR, ref);
      const kappa = (this.w[k] * s.rueda - uR) / ref;
      this.slipL[k] = alpha; this.slipK[k] = kappa;

      const mu = T.muEfectivo(s.mu, this.Fz[k]);
      const f = T.combinado(alpha, kappa, this.Fz[k], mu);
      this.uso[k] = f.uso;

      // Dinámica de la rueda: el par del motor y el freno contra el suelo.
      const motrizK = motriz[k] || 0;
      const frenoK = parFreno * (frente ? s.repFreno : 1 - s.repFreno) / 2
        * (m.mano && !frente ? 2.2 : 1);
      const parSuelo = f.fx * s.rueda;
      const motriz_k = motrizK !== 0 || (s.traccion === 'trasera' ? !frente : true);
      const rel = this.relacion();
      const Ief = s.Iw + (motriz_k ? s.Imotor * rel * rel / 2 : 0);
      const frenoAplicado = Math.sign(this.w[k]) * Math.min(frenoK, Math.abs(this.w[k]) * Ief / dt + Math.abs(parSuelo));
      const dw = (motrizK - parSuelo - frenoAplicado) / Ief;
      this.w[k] += dw * dt;
      if (Math.abs(this.w[k]) < 0.4 && frenoK > 0) this.w[k] = 0;

      // De ejes de rueda a ejes del auto.
      const fx = f.fx * Math.cos(dir) - f.fy * Math.sin(dir);
      const fy = f.fx * Math.sin(dir) + f.fy * Math.cos(dir);
      Fx += fx; Fy += fy;
      Mz += fy * lo - fx * la;
      // El par de autoalineación de las delanteras ES la señal de force
      // feedback: el avance del neumático por la fuerza lateral.
      if (frente) alineacion += f.fy * 0.028;
    }

    Fx -= s.arrastre * this.u * Math.abs(this.u);
    Fy -= 0.6 * this.v * Math.abs(this.v);

    this.aLong = Fx / s.masa;
    this.aLat = Fy / s.masa;
    this.ffb = clamp(alineacion / 330, -1, 1);

    // --- Integración del plano ---
    this.u += (this.aLong + this.r * this.v) * dt;
    this.v += (this.aLat - this.r * this.u) * dt;
    this.r += (Mz / s.Izz) * dt;
    this.r *= Math.exp(-dt * 0.35);

    const f2 = this.adelante(), d2 = this.derecha();
    this.x += (this.u * f2.x + this.v * d2.x) * dt;
    this.z += (this.u * f2.z + this.v * d2.z) * dt;
    this.yaw += this.r * dt;

    // --- Integración de la masa suspendida ---
    const ms = s.masaSusp;
    let sumF = 0, momP = 0, momR = 0;
    for (const k of ORDEN) {
      const [lo, la] = this.pos[k];
      sumF += dF[k]; momP += dF[k] * lo; momR -= dF[k] * la;
    }
    this.dzs += (sumF / ms) * dt;
    this.dpitch += ((momP + ms * this.aLong * s.h) / s.Ipitch) * dt;
    // El signo del término inercial del balanceo: verificado con un invariante
    // geométrico (la rueda de AFUERA de la curva tiene que cargar más), no por
    // razonamiento sobre convenciones.
    this.droll += ((momR + ms * this.aLat * s.h) / s.Iroll) * dt;
    this.zs += this.dzs * dt;
    this.pitch += this.dpitch * dt;
    this.roll += this.droll * dt;

    // --- Motor ---
    const wMotriz = s.traccion === 'trasera' ? (this.w.TI + this.w.TD) / 2
      : s.traccion === 'delantera' ? (this.w.DI + this.w.DD) / 2
      : (this.w.DI + this.w.DD + this.w.TI + this.w.TD) / 4;
    // Se guarda el régimen REAL: recortarlo antes del limitador hacía que el
    // corte no actuara nunca y el motor siguiera empujando sin techo.
    this.rpmReal = Math.abs(wMotriz) * this.relacion() * 60 / (2 * Math.PI);
    this.rpm = clamp(this.rpmReal, s.rpmRalenti, s.rpmCorte);
    this.cambiar(dt);
  }

  // Par que llega a cada rueda motriz.
  parMotriz(dt) {
    const s = this.s, m = this.mandos;
    if (this.cambio > 0 || m.acelerador <= 0) return {};
    if (this.rpmReal > s.rpmCorte) return {};        // limitador
    const par = this.parMotor(this.rpm) * m.acelerador * this.relacion() * 0.92;
    if (s.traccion === 'trasera') return { TI: par / 2, TD: par / 2 };
    if (s.traccion === 'delantera') return { DI: par / 2, DD: par / 2 };
    return { DI: par / 4, DD: par / 4, TI: par / 4, TD: par / 4 };
  }
}
