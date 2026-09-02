// Cronómetro: vueltas, parciales y mejor vuelta guardada.
const CLAVE = 'trazada.mejores.v1';

export class Timing {
  constructor(circuito, semilla) {
    this.c = circuito;
    this.clave = 'pista' + semilla;
    this.vuelta = 0;
    this.tiempo = 0;
    this.mejor = this.leerMejor();
    this.ultima = null;
    this.sPrev = 0;
    this.parciales = [0, 0, 0];
    this.sector = 0;
    this.vueltas = [];
    this.valida = true;
  }

  leerMejor() {
    try { return JSON.parse(localStorage.getItem(CLAVE) || '{}')[this.clave] ?? null; }
    catch (_) { return null; }
  }
  guardarMejor(t) {
    try {
      const d = JSON.parse(localStorage.getItem(CLAVE) || '{}');
      d[this.clave] = t;
      localStorage.setItem(CLAVE, JSON.stringify(d));
    } catch (_) {}
  }

  update(dt, s, enPista) {
    this.tiempo += dt;
    if (!enPista) this.valida = false;
    const L = this.c.largo;
    const tercio = L / 3;
    const secActual = Math.min(2, Math.floor(s / tercio));
    if (secActual !== this.sector && secActual === this.sector + 1) {
      this.parciales[this.sector] = this.tiempo;
      this.sector = secActual;
    }
    // Cruce de meta hacia adelante: s pasa de casi L a casi 0.
    const cruzo = this.sPrev > L * 0.75 && s < L * 0.25;
    this.sPrev = s;
    if (!cruzo) return null;

    const t = this.tiempo;
    this.tiempo = 0; this.sector = 0;
    this.vuelta++;
    if (this.vuelta > 1) {
      this.ultima = t;
      this.vueltas.push({ t, valida: this.valida });
      if (this.valida && (this.mejor === null || t < this.mejor)) {
        this.mejor = t; this.guardarMejor(t);
        this.valida = true;
        return { tiempo: t, record: true };
      }
      const r = { tiempo: t, record: false, invalida: !this.valida };
      this.valida = true;
      return r;
    }
    this.valida = true;
    return null;
  }
}

export function reloj(t) {
  if (t == null) return '--:--.---';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}
