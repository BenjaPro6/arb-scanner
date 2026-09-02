// Lectura del volante por Gamepad API, con teclado como respaldo.
//
// AVISO HONESTO: esto se escribió sin un G29 a mano para probarlo. El mapeo
// por defecto es el habitual en Chrome, pero varía según sistema operativo y
// según si los pedales están en modo combinado. Por eso hay calibración: se
// aprende qué eje mueve cada pedal y su recorrido real, y se guarda.
const GUARDADO = 'trazada.volante.v1';

const PREDET = {
  ejeVolante: 0,
  ejeAcelerador: 1, ejeFreno: 2, ejeEmbrague: 3,
  invAcelerador: true, invFreno: true, invEmbrague: true,
  rangoGrados: 540,       // recorrido del volante usado de tope a tope
  zonaMuerta: 0.012,
};

export class Wheel {
  constructor() {
    this.cfg = { ...PREDET, ...this.leer() };
    this.gp = null;
    this.id = '';
    this.crudos = [];
    this.calibrando = null;
    this.rangos = {};       // eje -> {min, max} aprendidos
    this.teclas = new Set();
    addEventListener('keydown', (e) => { this.teclas.add(e.code); });
    addEventListener('keyup', (e) => { this.teclas.delete(e.code); });
    addEventListener('gamepadconnected', (e) => { this.id = e.gamepad.id; });
  }

  leer() { try { return JSON.parse(localStorage.getItem(GUARDADO) || '{}'); } catch (_) { return {}; } }
  guardar() { try { localStorage.setItem(GUARDADO, JSON.stringify(this.cfg)); } catch (_) {} }

  buscar() {
    const lista = navigator.getGamepads ? navigator.getGamepads() : [];
    let mejor = null;
    for (const g of lista) {
      if (!g) continue;
      const esVolante = /g29|g920|g27|driving force|logitech|wheel|thrustmaster|fanatec/i.test(g.id);
      if (esVolante) { mejor = g; break; }
      if (!mejor) mejor = g;
    }
    this.gp = mejor;
    if (mejor) { this.id = mejor.id; this.crudos = Array.from(mejor.axes); }
    return mejor;
  }

  get conectado() { return !!this.gp; }
  get esVolante() { return !!this.gp && /g29|g920|g27|driving force|wheel|thrustmaster|fanatec/i.test(this.id); }

  pedal(eje, invertir) {
    if (!this.gp || eje == null || this.gp.axes[eje] === undefined) return 0;
    let v = this.gp.axes[eje];
    const r = this.rangos[eje];
    if (r && r.max - r.min > 0.4) v = (v - r.min) / (r.max - r.min) * 2 - 1;
    // Los pedales de Logitech descansan en +1 y llegan a -1 al fondo.
    const u = invertir ? (1 - v) / 2 : (v + 1) / 2;
    return Math.max(0, Math.min(1, u));
  }

  // Estado normalizado que consume el juego. `kmh` sólo se usa para suavizar
  // la dirección por teclado; con volante de verdad el mando va uno a uno.
  estado(kmh = 0) {
    this.buscar();
    const c = this.cfg;
    const s = { volante: 0, acelerador: 0, freno: 0, embrague: 0, mano: false, volanteReal: false };

    if (this.gp) {
      const bruto = this.gp.axes[c.ejeVolante] || 0;
      // El recorrido físico es de 900°; se usa sólo el tramo configurado.
      const escala = 900 / Math.max(90, c.rangoGrados);
      let v = bruto * escala;
      if (Math.abs(v) < c.zonaMuerta) v = 0;
      s.volante = Math.max(-1, Math.min(1, v));
      s.acelerador = this.pedal(c.ejeAcelerador, c.invAcelerador);
      s.freno = this.pedal(c.ejeFreno, c.invFreno);
      s.embrague = this.pedal(c.ejeEmbrague, c.invEmbrague);
      s.volanteReal = this.esVolante;
      // Levas y botones: subir y bajar cambio.
      s.subir = !!(this.gp.buttons[4] && this.gp.buttons[4].pressed);
      s.bajar = !!(this.gp.buttons[5] && this.gp.buttons[5].pressed);
    }

    // Teclado: siempre disponible, y suma al volante si no hay nada conectado.
    const t = this.teclas;
    const kx = (t.has('KeyD') || t.has('ArrowRight') ? 1 : 0) - (t.has('KeyA') || t.has('ArrowLeft') ? 1 : 0);
    // A 200 km/h nadie clava el volante a tope: con teclado hay que limitarlo
    // o el auto se pasa de deriva y ara de trompa en cada curva.
    const tope = Math.max(0.16, 1 / (1 + kmh * 0.011));
    if (kx) {
      this.tecladoVolante = Math.max(-tope, Math.min(tope, (this.tecladoVolante || 0) + kx * 0.055));
    } else {
      this.tecladoVolante = (this.tecladoVolante || 0) * 0.80;
    }
    this.tecladoVolante = Math.max(-tope, Math.min(tope, this.tecladoVolante));
    if (!s.volanteReal && Math.abs(this.tecladoVolante) > 0.001) s.volante = this.tecladoVolante;
    if (t.has('KeyW') || t.has('ArrowUp')) s.acelerador = 1;
    if (t.has('KeyS') || t.has('ArrowDown')) s.freno = 1;
    if (t.has('Space')) s.mano = true;
    return s;
  }

  // Calibración: se aprende el recorrido de cada eje mientras el jugador
  // mueve volante y pedales, y después se asigna el eje que más se movió.
  empezarCalibracion() {
    this.calibrando = { t: 0, rangos: {} };
    this.rangos = {};
  }
  pasoCalibracion(dt) {
    if (!this.calibrando) return null;
    this.buscar();
    this.calibrando.t += dt;
    if (this.gp) {
      this.gp.axes.forEach((v, i) => {
        const r = this.calibrando.rangos[i] || (this.calibrando.rangos[i] = { min: v, max: v });
        r.min = Math.min(r.min, v); r.max = Math.max(r.max, v);
      });
    }
    return this.calibrando.t;
  }
  terminarCalibracion() {
    if (!this.calibrando) return null;
    const r = this.calibrando.rangos;
    const movidos = Object.entries(r)
      .map(([i, v]) => ({ i: +i, rec: v.max - v.min, ...v }))
      .filter(e => e.rec > 0.35)
      .sort((a, b) => b.rec - a.rec);
    this.rangos = {};
    for (const e of movidos) this.rangos[e.i] = { min: e.min, max: e.max };
    this.calibrando = null;
    return movidos;
  }

  asignar(campo, eje) { this.cfg[campo] = eje; this.guardar(); }
}
