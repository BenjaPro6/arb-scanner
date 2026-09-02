import { clamp } from '../core/utils.js';

// Curva cerrada Catmull-Rom remuestreada por longitud de arco. Que esté
// parametrizada por METROS y no por el parámetro de la curva es lo que hace
// que después funcionen los tiempos por vuelta, los sectores, la traza de la
// IA y saber si estás dentro o fuera de la pista.
export class Spline {
  constructor(puntos, muestras = 12) {
    this.p = puntos;
    this.tabla = [];
    let acum = 0;
    const n = puntos.length;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < muestras; j++) {
        const t = j / muestras;
        const a = this.crom(i, t);
        const b = this.crom(i, t + 1 / muestras);
        const d = Math.hypot(b.x - a.x, b.z - a.z);
        this.tabla.push({ s: acum, i, t, x: a.x, z: a.z });
        acum += d;
      }
    }
    this.largo = acum;
    // Tangente y normal en cada muestra, ya normalizadas.
    for (let k = 0; k < this.tabla.length; k++) {
      const a = this.tabla[k], b = this.tabla[(k + 1) % this.tabla.length];
      let dx = b.x - a.x, dz = b.z - a.z;
      const l = Math.hypot(dx, dz) || 1;
      a.tx = dx / l; a.tz = dz / l;
      a.nx = -a.tz; a.nz = a.tx;         // normal a la izquierda de la marcha
    }
    for (let k = 0; k < this.tabla.length; k++) {
      const a = this.tabla[k], b = this.tabla[(k + 1) % this.tabla.length];
      // Curvatura: cuánto gira la tangente por metro. La IA la usa para frenar.
      const cross = a.tx * b.tz - a.tz * b.tx;
      const ds = Math.max(0.5, (b.s - a.s + this.largo) % this.largo);
      a.curv = cross / ds;
    }
  }

  // Índice de tabla para una distancia dada, por búsqueda binaria.
  indiceDe(s) {
    const largo = this.largo;
    s = ((s % largo) + largo) % largo;
    const T = this.tabla;
    let lo = 0, hi = T.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (T[m].s <= s) lo = m; else hi = m - 1; }
    return lo;
  }

  crom(i, t) {
    const p = this.p, n = p.length;
    const p0 = p[(i - 1 + n) % n], p1 = p[i % n], p2 = p[(i + 1) % n], p3 = p[(i + 2) % n];
    const t2 = t * t, t3 = t2 * t;
    const f = (a, b, c, d) => 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
    return { x: f(p0.x, p1.x, p2.x, p3.x), z: f(p0.z, p1.z, p2.z, p3.z) };
  }

  // Muestra correspondiente a una distancia s en METROS.
  // Las muestras están espaciadas por parámetro de curva, no por longitud, así
  // que interpolar por índice da un punto equivocado: hay que buscar en el
  // campo s. Esto lo usan el cronómetro, la IA y la detección de pista.
  en(s) {
    const largo = this.largo;
    s = ((s % largo) + largo) % largo;
    const T = this.tabla;
    let lo = 0, hi = T.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (T[m].s <= s) lo = m; else hi = m - 1;
    }
    // Se interpola entre las dos muestras que envuelven a s. Sin esto el punto
    // se engancha a la muestra anterior y da un error de hasta un espaciado.
    const a = T[lo], b = T[(lo + 1) % T.length];
    let ds = b.s - a.s;
    if (ds <= 0) ds += largo;
    const f = ds > 1e-6 ? (s - a.s) / ds : 0;
    return {
      s, i: a.i, t: a.t,
      x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f,
      tx: a.tx, tz: a.tz, nx: a.nx, nz: a.nz,
      curv: a.curv + ((b.curv - a.curv) || 0) * f,
    };
  }

  // Proyecta un punto del mundo sobre la traza. Devuelve la distancia s
  // recorrida y el desvío lateral: con eso se sabe si estás en pista.
  proyectar(x, z, cerca = null) {
    let mejor = null, mejorD = Infinity;
    const T = this.tabla, n = T.length;
    // Si sabemos dónde estaba antes, sólo se mira alrededor: O(1) por frame.
    const desde = cerca == null ? 0 : this.indiceDe(cerca) - 24;
    const cuantos = cerca == null ? n : 48;
    for (let j = 0; j < cuantos; j++) {
      const a = T[((desde + j) % n + n) % n];
      const d = (a.x - x) ** 2 + (a.z - z) ** 2;
      if (d < mejorD) { mejorD = d; mejor = a; }
    }
    const dx = x - mejor.x, dz = z - mejor.z;
    return {
      s: mejor.s + dx * mejor.tx + dz * mejor.tz,
      lateral: dx * mejor.nx + dz * mejor.nz,
      muestra: mejor,
    };
  }
}
