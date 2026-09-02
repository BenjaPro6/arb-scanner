import { clamp } from '../core/utils.js';

// Cadenas de habilidad, al estilo Horizon: derrapar, pasar cerca y sostener
// velocidad suman puntos con un multiplicador que crece mientras no cortes.
// Chocar o irte al pasto te lo baja. Es lo que hace que manejar sea un juego
// y no una vuelta de reconocimiento.
export class Puntaje {
  constructor() {
    this.banco = 0;          // puntos ya asegurados
    this.cadena = 0;         // puntos de la cadena en curso
    this.mult = 1;
    this.ocio = 0;
    this.ultimo = '';
    this.ultimoT = 0;
    this.cerca = new Map();  // rival -> tiempo del último "casi"
    this.mejorCadena = 0;
  }

  aviso(texto) { this.ultimo = texto; this.ultimoT = 1.6; }

  sumar(p, texto) {
    if (p <= 0) return;
    this.cadena += p * this.mult;
    this.mult = Math.min(10, this.mult + p / 900);
    this.ocio = 0;
    if (texto) this.aviso(texto);
  }

  romper(motivo) {
    if (this.cadena > 0) this.aviso(motivo);
    this.cadena = 0; this.mult = 1; this.ocio = 0;
  }

  cobrar() {
    if (this.cadena > 0) {
      this.banco += Math.round(this.cadena);
      this.mejorCadena = Math.max(this.mejorCadena, Math.round(this.cadena));
    }
    this.cadena = 0; this.mult = 1;
  }

  update(dt, mundo) {
    this.ultimoT = Math.max(0, this.ultimoT - dt);
    const { auto, enPista, rivales, choque } = mundo;
    const kmh = auto.kmh;

    if (choque > 4) { this.romper('¡Golpe! Cadena perdida'); return; }
    if (!enPista) { this.romper('Fuera de pista'); return; }

    // Derrape: ángulo de deriva trasero sostenido con velocidad.
    const deriva = Math.abs(auto.slipL.TI + auto.slipL.TD) / 2 * 57.3;
    if (deriva > 11 && kmh > 45 && auto.uso.TI > 0.85) {
      this.sumar(deriva * kmh * dt * 0.055, null);
      if (this.ultimoT <= 0) this.aviso('Derrape');
    }

    // Pasar cerca: te cruzás a menos de 4 metros a buena velocidad.
    for (const r of rivales) {
      const d = Math.hypot(r.x - auto.x, r.z - auto.z);
      const t = this.cerca.get(r) || 0;
      if (d < 4.2 && kmh > 70 && performance.now() - t > 2200) {
        this.cerca.set(r, performance.now());
        this.sumar(240, '¡Casi!');
      }
    }

    // Velocidad sostenida.
    if (kmh > 175) this.sumar((kmh - 175) * dt * 2.2, null);

    // La cadena se cobra sola si dejás de hacer cosas.
    this.ocio += dt;
    if (this.ocio > 2.4 && this.cadena > 0) {
      const p = Math.round(this.cadena);
      this.cobrar();
      this.aviso(`+${p.toLocaleString('es-AR')} puntos`);
    }
    this.mult = Math.max(1, this.mult - dt * 0.14);
  }

  get total() { return this.banco + Math.round(this.cadena); }
}
