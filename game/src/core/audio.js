// Todo el sonido es sintetizado en vivo con WebAudio: no hay un solo archivo
// de audio en el repo. Motor por oscilador, sirena de dos tonos, goma quemada
// por ruido filtrado y golpes por ráfaga de ruido.
import { Radio } from './radio.js';

export class Audio {
  constructor() { this.ready = false; }

  start() {
    if (this.ready) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain(); this.master.gain.value = 0.55;
    this.master.connect(ctx.destination);

    // --- Motor: dos dientes de sierra desafinados + filtro pasabajos ---
    this.eng = ctx.createGain(); this.eng.gain.value = 0;
    this.engFilter = ctx.createBiquadFilter();
    this.engFilter.type = 'lowpass'; this.engFilter.frequency.value = 900;
    this.oscA = ctx.createOscillator(); this.oscA.type = 'sawtooth';
    this.oscB = ctx.createOscillator(); this.oscB.type = 'square';
    this.oscA.frequency.value = 60; this.oscB.frequency.value = 61.5;
    const gb = ctx.createGain(); gb.gain.value = 0.35;
    this.oscA.connect(this.engFilter); this.oscB.connect(gb); gb.connect(this.engFilter);
    this.engFilter.connect(this.eng); this.eng.connect(this.master);
    this.oscA.start(); this.oscB.start();

    // --- Ruido blanco reutilizable (derrape y golpes) ---
    const n = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = n.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = n;

    this.skid = ctx.createGain(); this.skid.gain.value = 0;
    const sf = ctx.createBiquadFilter(); sf.type = 'bandpass'; sf.frequency.value = 1750; sf.Q.value = 1.2;
    const sn = ctx.createBufferSource(); sn.buffer = n; sn.loop = true;
    sn.connect(sf); sf.connect(this.skid); this.skid.connect(this.master); sn.start();

    // --- Sirena ---
    this.siren = ctx.createGain(); this.siren.gain.value = 0;
    this.sirenOsc = ctx.createOscillator(); this.sirenOsc.type = 'triangle';
    this.sirenOsc.frequency.value = 700;
    this.sirenOsc.connect(this.siren); this.siren.connect(this.master); this.sirenOsc.start();

    this.radio = new Radio(ctx, this.master, n);

    this.t = 0;
    this.ready = true;
  }

  bang(force) {
    if (!this.ready) return;
    const ctx = this.ctx, now = ctx.currentTime;
    const g = ctx.createGain();
    const f = ctx.createBiquadFilter(); f.type = 'lowpass';
    f.frequency.setValueAtTime(2400, now);
    f.frequency.exponentialRampToValueAtTime(180, now + 0.28);
    const s = ctx.createBufferSource(); s.buffer = this.noiseBuf;
    const v = Math.min(0.9, force * 0.09);
    g.gain.setValueAtTime(v, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.34);
    s.connect(f); f.connect(g); g.connect(this.master);
    s.start(now); s.stop(now + 0.4);
  }

  update(dt, st) {
    if (!this.ready) return;
    this.t += dt;
    const now = this.ctx.currentTime;
    // rpm falso: la velocidad "reducida" a una caja de 4 marchas.
    const kmh = st.kmh || 0;
    const gear = Math.min(4, Math.floor(kmh / 42));
    const inGear = (kmh - gear * 42) / 42;
    const rpm = 0.22 + inGear * 0.78;
    const base = st.driving ? 48 + rpm * 150 : 0;
    if (st.driving) {
      this.oscA.frequency.setTargetAtTime(base, now, 0.05);
      this.oscB.frequency.setTargetAtTime(base * 1.01 + 1.5, now, 0.05);
      this.engFilter.frequency.setTargetAtTime(420 + rpm * 1500 + (st.throttle > 0 ? 700 : 0), now, 0.08);
      this.eng.gain.setTargetAtTime(0.055 + rpm * 0.10 + (st.throttle > 0 ? 0.05 : 0), now, 0.1);
    } else {
      this.eng.gain.setTargetAtTime(0, now, 0.15);
    }
    this.skid.gain.setTargetAtTime((st.slip || 0) * 0.20, now, 0.06);

    if (this.radio) {
      this.radio.prender(!!st.driving);
      this.radio.update();
    }

    const sp = st.sirenProximity || 0;
    if (sp > 0) {
      // Dos tonos alternados, como la sirena de un patrullero.
      const hi = (this.t * 1.35) % 1 < 0.5;
      this.sirenOsc.frequency.setTargetAtTime(hi ? 780 : 560, now, 0.02);
      this.siren.gain.setTargetAtTime(sp * 0.075, now, 0.1);
    } else this.siren.gain.setTargetAtTime(0, now, 0.2);
  }
}
