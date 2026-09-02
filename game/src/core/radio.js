// Radio del auto, sintetizada en vivo. No hay un solo archivo de audio: cada
// emisora es un tempo, una escala, una progresión y un patrón de percusión,
// agendados sobre el reloj de WebAudio con anticipación.
//
// No reemplaza música grabada, pero le da al manejo lo que le faltaba: que
// pase algo mientras vas por la avenida.
const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);

// Progresión menor clásica: i - VI - III - VII. Sirve para las cuatro.
const PROG = [0, 8, 3, 10];

export const EMISORAS = [
  {
    id: 'cumbia', nombre: 'FM Bombón · cumbia', bpm: 96, raiz: 45, onda: 'square',
    bajo: [0, 0, 7, 0, 0, 7, 0, 0, 0, 0, 7, 0, 0, 7, 0, 0].map(v => v === 0 ? 0 : 7),
    bajoHit: [1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0],
    acordeHit: [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0],
    bombo: [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0],
    hat: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], hatVol: 0.05,
    redoble: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
  },
  {
    id: 'rock', nombre: 'Rock Nacional 101.5', bpm: 132, raiz: 40, onda: 'sawtooth',
    bajoHit: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 1],
    acordeHit: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0],
    bombo: [1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0],
    hat: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0], hatVol: 0.07,
    redoble: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
    quinta: true,
  },
  {
    id: 'tango', nombre: 'Tango de la Ciudad', bpm: 68, raiz: 45, onda: 'triangle',
    bajoHit: [1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 0, 0],
    acordeHit: [1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0],
    bombo: [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
    hat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], hatVol: 0,
    redoble: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1],
    staccato: true,
  },
  {
    id: 'electro', nombre: 'Subte FM · electrónica', bpm: 124, raiz: 38, onda: 'sawtooth',
    bajoHit: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    acordeHit: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
    bombo: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
    hat: [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0], hatVol: 0.09,
    redoble: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  },
];

export class Radio {
  constructor(ctx, destino, ruido) {
    this.ctx = ctx; this.ruido = ruido;
    this.out = ctx.createGain(); this.out.gain.value = 0;
    // Un pasabajos suave: suena como saliendo de los parlantes de un Falcon.
    this.filtro = ctx.createBiquadFilter();
    this.filtro.type = 'lowpass'; this.filtro.frequency.value = 3200;
    this.filtro.connect(this.out); this.out.connect(destino);

    this.emisora = 0;
    this.paso = 0;
    this.compas = 0;
    this.proximo = 0;
    this.encendida = false;
    this.volumen = 0.16;
  }

  prender(on) {
    this.encendida = on;
    this.out.gain.setTargetAtTime(on ? this.volumen : 0, this.ctx.currentTime, 0.25);
    if (on && this.proximo < this.ctx.currentTime) this.proximo = this.ctx.currentTime + 0.06;
  }

  cambiar() {
    this.emisora = (this.emisora + 1) % EMISORAS.length;
    this.paso = 0; this.compas = 0;
    this.proximo = this.ctx.currentTime + 0.06;
    return EMISORAS[this.emisora].nombre;
  }

  get nombre() { return EMISORAS[this.emisora].nombre; }

  nota(freq, t, dur, tipo, vol, filtro) {
    const ctx = this.ctx;
    const o = ctx.createOscillator(); o.type = tipo; o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    o.connect(g); g.connect(filtro || this.filtro);
    o.start(t); o.stop(t + dur + 0.03);
  }

  percusion(t, tipo) {
    const ctx = this.ctx;
    if (tipo === 'bombo') {
      const o = ctx.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(120, t);
      o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.5, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
      o.connect(g); g.connect(this.filtro); o.start(t); o.stop(t + 0.26);
      return;
    }
    const s = ctx.createBufferSource(); s.buffer = this.ruido;
    const f = ctx.createBiquadFilter();
    f.type = tipo === 'hat' ? 'highpass' : 'bandpass';
    f.frequency.value = tipo === 'hat' ? 7000 : 1900;
    const g = ctx.createGain();
    const dur = tipo === 'hat' ? 0.045 : 0.16;
    g.gain.setValueAtTime(tipo === 'hat' ? 0.10 : 0.26, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    s.connect(f); f.connect(g); g.connect(this.filtro);
    s.start(t); s.stop(t + dur + 0.02);
  }

  // Agenda los pasos que caen dentro de la ventana de anticipación.
  update() {
    if (!this.encendida) return;
    const ctx = this.ctx;
    const e = EMISORAS[this.emisora];
    const paso16 = 60 / e.bpm / 4;
    const horizonte = ctx.currentTime + 0.28;

    while (this.proximo < horizonte) {
      const t = Math.max(this.proximo, ctx.currentTime + 0.02);
      const i = this.paso;
      const grado = PROG[this.compas % PROG.length];
      const raiz = e.raiz + grado;

      if (e.bajoHit[i]) {
        const salto = (i % 8 === 6) ? 7 : 0;
        this.nota(midi(raiz + salto), t, e.staccato ? 0.16 : paso16 * 1.7, e.onda, 0.20);
      }
      if (e.acordeHit[i]) {
        const dur = e.staccato ? 0.14 : paso16 * 2.2;
        const acorde = e.quinta ? [0, 7] : [0, 3, 7];   // menor, o quinta pelada en el rock
        for (const iv of acorde)
          this.nota(midi(raiz + 12 + iv), t, dur, e.onda === 'sawtooth' ? 'sawtooth' : 'triangle', 0.075);
      }
      if (e.bombo[i]) this.percusion(t, 'bombo');
      if (e.hat[i] && e.hatVol > 0) this.percusion(t, 'hat');
      if (e.redoble[i]) this.percusion(t, 'redoble');

      this.proximo += paso16;
      this.paso++;
      if (this.paso >= 16) { this.paso = 0; this.compas++; }
    }
  }
}
