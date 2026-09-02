import { AUTOS, MEJORAS, costoMejora } from '../sim/catalogo.js';

// Plata, experiencia y garage, guardados en el navegador.
const CLAVE = 'trazada.progreso.v1';

export class Progreso {
  constructor() {
    this.plata = 180000;
    this.xp = 0;
    this.autos = { calle: { mejoras: {} } };   // arrancás con el compacto
    this.actual = 'calle';
    this.mejores = {};
    this.puntos = 0;
    this.carreras = { corridas: 0, ganadas: 0 };
    this.cargar();
  }

  get nivel() { return Math.floor(Math.sqrt(this.xp / 120)) + 1; }
  get xpNivel() { const n = this.nivel; return { hecho: this.xp - 120 * (n - 1) ** 2, falta: 120 * (n ** 2 - (n - 1) ** 2) }; }

  tiene(k) { return !!this.autos[k]; }
  mejorasDe(k) { return (this.autos[k] || {}).mejoras || {}; }

  comprarAuto(k) {
    const a = AUTOS[k];
    if (!a || this.tiene(k)) return 'ya lo tenés';
    if (this.plata < a.precio) return 'sin plata';
    this.plata -= a.precio;
    this.autos[k] = { mejoras: {} };
    this.actual = k;
    this.guardar();
    return 'comprado';
  }

  mejorar(k, clave) {
    if (!this.tiene(k)) return 'no es tuyo';
    const m = this.autos[k].mejoras;
    const nivel = m[clave] || 0;
    const costo = costoMejora(clave, nivel);
    if (costo === null) return 'al máximo';
    if (this.plata < costo) return 'sin plata';
    this.plata -= costo;
    m[clave] = nivel + 1;
    this.guardar();
    return 'mejorado';
  }

  premiar(plata, xp) { this.plata += plata; this.xp += xp; this.guardar(); }
  sumarPuntos(p) { this.puntos += p; }

  registrarVuelta(pista, t) {
    const k = 'p' + pista;
    if (this.mejores[k] == null || t < this.mejores[k]) { this.mejores[k] = t; this.guardar(); return true; }
    return false;
  }

  guardar() {
    try {
      localStorage.setItem(CLAVE, JSON.stringify({
        v: 1, plata: this.plata, xp: this.xp, autos: this.autos,
        actual: this.actual, mejores: this.mejores, puntos: this.puntos, carreras: this.carreras,
      }));
    } catch (_) {}
  }

  cargar() {
    let d;
    try { d = JSON.parse(localStorage.getItem(CLAVE) || 'null'); } catch (_) { return; }
    if (!d || d.v !== 1) return;
    this.plata = d.plata ?? this.plata;
    this.xp = d.xp ?? 0;
    this.autos = d.autos || this.autos;
    this.actual = this.autos[d.actual] ? d.actual : Object.keys(this.autos)[0];
    this.mejores = d.mejores || {};
    this.puntos = d.puntos || 0;
    this.carreras = d.carreras || this.carreras;
  }
}
