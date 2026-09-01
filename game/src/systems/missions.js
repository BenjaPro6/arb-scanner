import { VEHICLES } from '../vehicles/catalog.js';

// Misiones como máquina de estados. Cada una define arranque, chequeo por
// frame y cierre. La plata siempre se paga indexada por la Economy.
const POOL = [
  {
    id: 'reparto', title: 'Reparto',
    brief: (m) => `Llevá el paquete a destino. Tenés ${Math.ceil(m.limit)} segundos.`,
    setup(m, g) {
      m.limit = 95; m.reward = 22000;
      const b = g.city.randomBlock(b => b.kind === 'edificado' && Math.hypot(b.cx - g.player.pos.x, b.cz - g.player.pos.z) > 500);
      const s = g.places.streetSpot(b);
      g.places.move(g.meta, s.x, s.z); g.places.show(g.meta, true);
      m.needCar = true;
    },
    tick(m, g, dt) {
      m.limit -= dt;
      if (m.limit <= 0) return 'fail';
      const p = g.player.pos;
      if (Math.hypot(p.x - g.meta.x, p.z - g.meta.z) < g.meta.r + 3 && g.player.mode === 'drive') return 'win';
      return null;
    },
    hud: (m) => `Destino  ·  ${m.limit.toFixed(0)}s`,
  },
  {
    id: 'chorro', title: 'Afanar un fierro',
    brief: (m) => `Conseguí un ${VEHICLES[m.want].name} y metelo en el taller.`,
    setup(m, g) {
      m.want = g.rng.pick(['falcon', 'r12', 'taxi', 'pickup', 'deportivo']);
      m.reward = 34000; m.limit = 210; m.stage = 0;
      const t = g.rng.pick(g.places.list.filter(p => p.type === 'taller'));
      m.taller = t;
      g.places.show(g.meta, false);
    },
    tick(m, g, dt) {
      m.limit -= dt;
      if (m.limit <= 0) return 'fail';
      if (m.stage === 0) {
        if (g.player.mode === 'drive' && g.player.car.spec.name === VEHICLES[m.want].name) {
          m.stage = 1;
          g.places.move(g.meta, m.taller.x, m.taller.z); g.places.show(g.meta, true);
        }
      } else {
        if (g.player.mode !== 'drive' || g.player.car.spec.name !== VEHICLES[m.want].name) { m.stage = 0; g.places.show(g.meta, false); return null; }
        const p = g.player.pos;
        if (Math.hypot(p.x - m.taller.x, p.z - m.taller.z) < m.taller.r + 3) return 'win';
      }
      return null;
    },
    hud: (m) => m.stage === 0
      ? `Buscá un ${VEHICLES[m.want].name}  ·  ${m.limit.toFixed(0)}s`
      : `Al taller  ·  ${m.limit.toFixed(0)}s`,
  },
  {
    id: 'aguantar', title: 'Aguantar la cana',
    brief: () => 'Te marcaron. Bancá la persecución sin que te agarren.',
    setup(m, g) {
      m.limit = 80; m.reward = 48000;
      g.police.heat = Math.max(g.police.heat, 3);
      g.places.show(g.meta, false);
    },
    tick(m, g, dt) {
      m.limit -= dt;
      if (g.police.busted > 1.6) return 'fail';
      if (m.limit <= 0) return 'win';
      return null;
    },
    hud: (m) => `Aguantá  ·  ${m.limit.toFixed(0)}s`,
  },
  {
    id: 'mandado', title: 'Mandado a la cueva',
    brief: () => 'Te dieron pesos. Cambialos a dólares antes de que se derritan.',
    setup(m, g) {
      m.limit = 110; m.reward = 0;
      m.given = g.economy.pay(60000);
      m.realAtStart = 60000;
      const c = g.rng.pick(g.places.list.filter(p => p.type === 'cueva'));
      m.cueva = c;
      g.places.move(g.meta, c.x, c.z); g.places.show(g.meta, true);
    },
    tick(m, g, dt) {
      m.limit -= dt;
      if (m.limit <= 0) return 'fail';
      const p = g.player.pos;
      if (Math.hypot(p.x - m.cueva.x, p.z - m.cueva.z) < m.cueva.r + 3) {
        g.economy.buyUsd(m.given);
        m.kept = g.economy.power;
        return 'win';
      }
      return null;
    },
    hud: (m) => `A la cueva  ·  ${m.limit.toFixed(0)}s`,
  },
];

export class Missions {
  constructor(game) {
    this.g = game;
    this.current = null;
    this.cooldown = 0;
    this.done = 0; this.failed = 0;
    this.toast = ''; this.toastT = 0;
  }

  say(text, secs = 4) { this.toast = text; this.toastT = secs; }

  offer() {
    if (this.current || this.cooldown > 0) return;
    const def = this.g.rng.pick(POOL);
    const m = { def, started: 0 };
    def.setup(m, this.g);
    this.current = m;
    this.say(`${def.title}. ${def.brief(m)}`, 6);
  }

  update(dt) {
    this.toastT = Math.max(0, this.toastT - dt);
    this.cooldown = Math.max(0, this.cooldown - dt);
    const m = this.current;
    if (!m) {
      // Entrar al marcador de laburo ofrece una changa nueva.
      const p = this.g.player.pos;
      const l = this.g.places.laburo;
      if (Math.hypot(p.x - l.x, p.z - l.z) < l.r + 2.5) this.offer();
      return;
    }
    m.started += dt;
    const r = m.def.tick(m, this.g, dt);
    if (r === 'win') {
      const nominal = m.def.id === 'mandado' ? 0 : this.g.economy.pay(m.reward);
      this.done++;
      this.say(m.def.id === 'mandado'
        ? 'Cambiaste a tiempo. Los verdes no se derriten.'
        : `Listo. Cobraste ${Math.round(nominal).toLocaleString('es-AR')} pesos.`, 5);
      this.finish();
    } else if (r === 'fail') {
      this.failed++;
      this.say('Se te fue al carajo. Volvé al laburo cuando quieras.', 4);
      this.finish();
    }
  }

  finish() {
    this.g.places.show(this.g.meta, false);
    this.current = null;
    this.cooldown = 6;
  }

  hudLine() {
    if (!this.current) return null;
    return `${this.current.def.title}  —  ${this.current.def.hud(this.current)}`;
  }
}
