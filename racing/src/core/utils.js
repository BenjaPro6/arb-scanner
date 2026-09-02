export const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (a, b, t, dt) => a + (b - a) * (1 - Math.pow(1 - t, dt * 60));
export const TAU = Math.PI * 2;

// Diferencia angular más corta, en (-PI, PI].
export function angDelta(from, to) {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d <= -Math.PI) d += TAU;
  return d;
}

export function approach(cur, target, rate, dt) {
  const d = target - cur;
  const step = rate * dt;
  return Math.abs(d) <= step ? target : cur + Math.sign(d) * step;
}

// Formato de guita al estilo argentino: $1.234.567
export function pesos(n) {
  const s = Math.round(Math.abs(n)).toString();
  return (n < 0 ? '-$' : '$') + s.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

// Hash espacial simple para consultas de vecindad O(1).
export class SpatialHash {
  constructor(cell = 40) { this.cell = cell; this.map = new Map(); }
  key(x, z) { return ((x / this.cell) | 0) * 73856093 ^ ((z / this.cell) | 0) * 19349663; }
  clear() { this.map.clear(); }
  insert(x, z, item) {
    const k = this.key(x, z);
    let b = this.map.get(k);
    if (!b) { b = []; this.map.set(k, b); }
    b.push(item);
  }
  query(x, z, r, out = []) {
    out.length = 0;
    const c = this.cell, n = Math.ceil(r / c);
    for (let dx = -n; dx <= n; dx++) for (let dz = -n; dz <= n; dz++) {
      const b = this.map.get(this.key(x + dx * c, z + dz * c));
      if (b) for (const it of b) out.push(it);
    }
    return out;
  }
}
