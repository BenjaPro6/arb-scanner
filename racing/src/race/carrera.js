import { Rival } from './rival.js';

// Estructura de carrera: grilla, largada, vueltas, posiciones y llegada.
// Sin esto el juego era una pista vacía con un cronómetro.
export class Carrera {
  constructor(circuito, escena) {
    this.c = circuito;
    this.escena = escena;
    this.rivales = [];
    this.estado = 'libre';       // libre | cuenta | corriendo | final
    this.vueltas = 3;
    this.cuenta = 0;
    this.tiempo = 0;
    this.jugador = { vuelta: 0, s: 0, sPrev: 0, terminado: false, tiempo: 0, puesto: 1 };
    this.resultado = null;
  }

  preparar(config, jugadorSpec) {
    const n = config.rivales ?? 5;
    this.vueltas = config.vueltas ?? 3;
    this.nombreEvento = config.nombre || 'Carrera';
    this.premio = config.premio ?? 60000;

    for (const r of this.rivales) this.escena.remove(r.malla);
    this.rivales = [];
    const L = this.c.largo;
    // El jugador larga último: es más divertido tener a quién pasar.
    for (let i = 0; i < n; i++) {
      const r = new Rival(this.c, this.escena, i, {
        destreza: (config.destreza ?? 0.92) + (i - n / 2) * 0.012,
        topeKmh: config.topeKmh ?? 215,
        mu: config.mu ?? 1.34,
        acel: config.acel ?? 7.2,
      });
      const fila = Math.floor(i / 2), lado = (i % 2) ? 1 : -1;
      r.colocar(L - 14 - fila * 9, lado * 2.4);
      this.rivales.push(r);
    }
    const filaJ = Math.floor(n / 2);
    this.grillaJugador = {
      s: L - 14 - filaJ * 9,
      carril: (n % 2) ? 1 * 2.4 : -2.4,
    };
    this.estado = 'cuenta';
    this.cuenta = 3.999;
    this.tiempo = 0;
    this.resultado = null;
    this.jugador = { vuelta: 0, s: this.grillaJugador.s, sPrev: this.grillaJugador.s, terminado: false, tiempo: 0, puesto: n + 1 };
    return this.grillaJugador;
  }

  abandonar() {
    for (const r of this.rivales) this.escena.remove(r.malla);
    this.rivales = [];
    this.estado = 'libre';
    this.resultado = null;
  }

  get corriendo() { return this.estado === 'corriendo'; }
  get largando() { return this.estado === 'cuenta'; }

  update(dt, sJugador) {
    if (this.estado === 'libre' || this.estado === 'final') return null;

    if (this.estado === 'cuenta') {
      this.cuenta -= dt;
      if (this.cuenta <= 0) { this.estado = 'corriendo'; this.cuenta = 0; }
      return null;
    }

    this.tiempo += dt;
    const L = this.c.largo;
    for (const r of this.rivales) r.update(dt, { otros: this.rivales });

    // Vueltas del jugador: cruzar meta hacia adelante.
    const j = this.jugador;
    if (!j.terminado) {
      j.tiempo += dt;
      if (j.sPrev > L * 0.75 && sJugador < L * 0.25) j.vuelta++;
      j.sPrev = sJugador;
      j.s = sJugador;
    }

    const avanceJ = j.vuelta * L + j.s;
    const todos = [
      { nombre: 'VOS', avance: avanceJ, vuelta: j.vuelta, jugador: true, terminado: j.terminado, tiempo: j.tiempo },
      ...this.rivales.map(r => ({ nombre: r.nombre, avance: r.avance, vuelta: r.vuelta, jugador: false, terminado: r.terminado, tiempo: r.tiempo })),
    ];
    todos.sort((a, b) => (b.terminado - a.terminado) || (b.avance - a.avance));
    this.orden = todos;
    j.puesto = todos.findIndex(t => t.jugador) + 1;

    // Llegada
    for (const r of this.rivales)
      if (!r.terminado && r.vuelta >= this.vueltas) r.terminado = true;
    if (!j.terminado && j.vuelta >= this.vueltas) {
      j.terminado = true;
      this.estado = 'final';
      const puesto = j.puesto;
      const factor = [1, 0.62, 0.42, 0.3, 0.22, 0.16, 0.12, 0.1][puesto - 1] ?? 0.08;
      this.resultado = {
        puesto, total: todos.length, tiempo: j.tiempo,
        plata: Math.round(this.premio * factor),
        xp: Math.round(180 * factor + 40),
      };
      return this.resultado;
    }
    return null;
  }
}
