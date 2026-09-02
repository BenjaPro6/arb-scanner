import { TC } from './vehicle.js';

// Garage. Cada auto es un juego de parámetros que entra directo al simulador,
// así que las diferencias se sienten manejando y no son sólo un número.
export const AUTOS = {
  calle: {
    ...TC, nombre: 'Compacto', clase: 'D', precio: 0,
    masa: 1090, masaSusp: 940, parMax: 195, rpmPar: 4600, rpmCorte: 6200,
    marchas: [3.55, 2.05, 1.38, 1.03, 0.82], final: 3.94,
    traccion: 'delantera', mu: 1.02, cargaAero: 0.18, arrastre: 0.86,
    frenoMax: 2900, kF: 34000, kR: 31000, arbF: 11000, arbR: 7000, h: 0.52,
    color: 0x9fb2c4,
  },
  tc: {
    ...TC, nombre: 'TC 2000', clase: 'B', precio: 320000, color: 0xd8382f,
  },
  gt: {
    ...TC, nombre: 'GT3', clase: 'A', precio: 780000,
    masa: 1290, masaSusp: 1105, parMax: 520, rpmPar: 6100, rpmCorte: 7800,
    marchas: [2.92, 2.05, 1.58, 1.28, 1.06, 0.90], final: 3.44,
    mu: 1.52, cargaAero: 1.95, arrastre: 0.88, frenoMax: 5600,
    kF: 74000, kR: 68000, arbF: 26000, arbR: 17000, h: 0.40,
    color: 0x2f6fd8,
  },
  proto: {
    ...TC, nombre: 'Prototipo', clase: 'S', precio: 1900000,
    masa: 900, masaSusp: 760, parMax: 610, rpmPar: 7200, rpmCorte: 9200,
    marchas: [2.75, 1.98, 1.56, 1.29, 1.09, 0.94], final: 3.30,
    mu: 1.68, cargaAero: 3.4, arrastre: 0.80, frenoMax: 7200,
    kF: 96000, kR: 90000, arbF: 34000, arbR: 22000, h: 0.33,
    color: 0xf0c419,
  },
};

export const ORDEN_AUTOS = ['calle', 'tc', 'gt', 'proto'];

// Mejoras: cada nivel cuesta más y toca el parámetro que corresponde del
// simulador. No son porcentajes decorativos, cambian cómo anda el auto.
export const MEJORAS = {
  motor:      { nombre: 'Motor',        max: 5, base: 42000,  desc: 'Más par en todo el régimen' },
  gomas:      { nombre: 'Gomas',        max: 5, base: 38000,  desc: 'Más agarre en seco' },
  suspension: { nombre: 'Suspensión',   max: 4, base: 30000,  desc: 'Menos balanceo, apoya antes' },
  frenos:     { nombre: 'Frenos',       max: 4, base: 26000,  desc: 'Frena más corto' },
  aero:       { nombre: 'Aerodinámica', max: 4, base: 46000,  desc: 'Más carga en curva rápida' },
  peso:       { nombre: 'Aligerado',    max: 3, base: 58000,  desc: 'Menos kilos, más de todo' },
};

export function costoMejora(clave, nivelActual) {
  const m = MEJORAS[clave];
  if (!m || nivelActual >= m.max) return null;
  return Math.round(m.base * Math.pow(1.62, nivelActual));
}

export function aplicarMejoras(base, mejoras = {}) {
  const s = { ...base };
  const n = (k) => mejoras[k] || 0;
  s.parMax = base.parMax * (1 + n('motor') * 0.075);
  s.mu = base.mu * (1 + n('gomas') * 0.042);
  const sus = 1 + n('suspension') * 0.14;
  s.kF = base.kF * sus; s.kR = base.kR * sus;
  s.arbF = base.arbF * sus; s.arbR = base.arbR * sus;
  s.cF = base.cF * (1 + n('suspension') * 0.09);
  s.cR = base.cR * (1 + n('suspension') * 0.09);
  s.frenoMax = base.frenoMax * (1 + n('frenos') * 0.10);
  s.cargaAero = base.cargaAero * (1 + n('aero') * 0.30);
  s.arrastre = base.arrastre * (1 + n('aero') * 0.04);
  const quita = 1 - n('peso') * 0.045;
  s.masa = base.masa * quita; s.masaSusp = base.masaSusp * quita;
  s.Izz = base.Izz * quita;
  return s;
}

// Puntaje de rendimiento, para emparejar rivales y ordenar el garage.
export function indice(spec) {
  const potencia = spec.parMax / spec.masa * 1000;
  const agarre = spec.mu * 100 + spec.cargaAero * 12;
  const freno = spec.frenoMax / spec.masa * 10;
  return Math.round(potencia * 1.15 + agarre + freno);
}
