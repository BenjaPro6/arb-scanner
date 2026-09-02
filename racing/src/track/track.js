import { Spline } from './spline.js';
import { makeRng } from '../core/rng.js';

// Circuito procedural: puntos de control sobre un anillo deformado, suavizados
// en una curva cerrada. Cada semilla da un trazado distinto, con rectas,
// curvas rápidas y algo lento donde frenar de verdad.
export function generarCircuito(semilla = 7, opciones = {}) {
  const rng = makeRng(semilla);
  const n = opciones.curvas || 16;
  const radio = opciones.radio || 470;
  // Radios al azar pero SUAVIZADOS: sin este paso salen quiebres con radios de
  // doce metros, más cerrados que una playa de estacionamiento.
  let radios = [];
  for (let i = 0; i < n; i++) radios.push(rng.range(0.52, 1.46));
  const angulos = [];
  for (let i = 0; i < n; i++) angulos.push(rng.range(0.66, 1.34));
  const sumaAng = angulos.reduce((a, b) => a + b, 0);

  const armar = () => {
    const pts = [];
    let acum = 0;
    for (let i = 0; i < n; i++) {
      const a = (acum / sumaAng) * Math.PI * 2;
      acum += angulos[i];
      const r = radio * radios[i];
      pts.push({ x: Math.cos(a) * r, z: Math.sin(a) * r * 0.84 });
    }
    return new Spline(pts, 26);
  };
  const radioMinimo = (sp) => {
    let c = 0;
    for (let d = 0; d < sp.largo; d += 4) c = Math.max(c, Math.abs(sp.en(d).curv || 0));
    return c > 0 ? 1 / c : 1e9;
  };

  // Se suaviza sólo lo necesario: demasiado suave da un óvalo sin frenadas,
  // demasiado crudo da quiebres imposibles. Se busca un radio mínimo de
  // horquilla de verdad, entre 28 y 45 metros.
  let linea = armar();
  for (let intento = 0; intento < 8 && radioMinimo(linea) < 28; intento++) {
    radios = radios.map((v, i) => (radios[(i - 1 + n) % n] + v * 3.2 + radios[(i + 1) % n]) / 5.2);
    linea = armar();
  }

  // Ancho variable: se abre en las rectas y se cierra en lo lento.
  const anchoEn = (s) => {
    const m = linea.en(s);
    const c = Math.abs(m.curv || 0);
    return 10.5 + Math.max(0, 4.2 - c * 260);
  };

  return { linea, anchoEn, semilla, largo: linea.largo };
}

// Dónde está el auto respecto de la pista: en asfalto, en el piano, o afuera.
export function superficie(circuito, lateral, s) {
  const w = circuito.anchoEn(s) / 2;
  const d = Math.abs(lateral);
  if (d < w) return { tipo: 'asfalto', mu: 1.0 };
  if (d < w + 1.6) return { tipo: 'piano', mu: 0.92 };
  if (d < w + 12) return { tipo: 'pasto', mu: 0.55 };
  return { tipo: 'afuera', mu: 0.45 };
}
