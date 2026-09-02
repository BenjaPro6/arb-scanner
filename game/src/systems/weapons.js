import * as THREE from 'three';
import { clamp } from '../core/utils.js';

// Arsenal con tiro hitscan. Cada arma define daño, cadencia, dispersión,
// alcance y cuántos proyectiles salen por disparo: la escopeta tira seis
// perdigones abiertos, el subfusil uno solo pero muy rápido.
export const ARMAS = {
  pistola:  { nombre: 'Pistola',  dano: 34, cadencia: 0.26,  cargador: 12, disp: 0.030, alcance: 70, precio: 26000,  bala: 380, perdigones: 1, auto: false },
  escopeta: { nombre: 'Escopeta', dano: 17, cadencia: 0.85,  cargador: 6,  disp: 0.115, alcance: 26, precio: 78000,  bala: 900, perdigones: 6, auto: false },
  uzi:      { nombre: 'Subfusil', dano: 18, cadencia: 0.085, cargador: 30, disp: 0.055, alcance: 55, precio: 145000, bala: 520, perdigones: 1, auto: true },
};
export const ORDEN_ARMAS = ['pistola', 'escopeta', 'uzi'];

export class Weapons {
  constructor(scene, game) {
    this.g = game;
    this.inv = {};   // arma -> { balas, cargador }
    this.actual = null;
    this.cool = 0;

    this.trazas = [];
    for (let i = 0; i < 20; i++) {
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
      const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xffd489, transparent: true, opacity: 0.9 }));
      l.visible = false; scene.add(l);
      this.trazas.push({ l, t: 0 });
    }
    this.fogonazo = new THREE.Mesh(
      new THREE.SphereGeometry(0.24, 6, 5),
      new THREE.MeshBasicMaterial({ color: 0xffe6a0, transparent: true, opacity: 0.95, toneMapped: false })
    );
    this.fogonazo.visible = false; scene.add(this.fogonazo);
    this.flashT = 0;
  }

  get spec() { return this.actual ? ARMAS[this.actual] : null; }
  get armado() { return !!this.actual; }
  get enCargador() { return this.actual ? this.inv[this.actual].cargador : 0; }
  get balas() { return this.actual ? this.inv[this.actual].balas : 0; }
  tiene(k) { return !!this.inv[k]; }

  elegir(k) {
    if (!this.inv[k]) return false;
    this.actual = k; this.cool = Math.max(this.cool, 0.2);
    return true;
  }
  siguiente() {
    const tengo = ORDEN_ARMAS.filter(k => this.inv[k]);
    if (!tengo.length) return;
    const i = tengo.indexOf(this.actual);
    this.elegir(tengo[(i + 1) % tengo.length]);
  }

  comprar(k, economia) {
    const s = ARMAS[k];
    if (!s) return 'no hay';
    if (!this.inv[k]) {
      if (!economia.charge(s.precio)) return 'sin plata';
      this.inv[k] = { balas: s.cargador, cargador: s.cargador };
      this.actual = k;
      return 'comprada';
    }
    const lote = s.cargador * 2;
    if (!economia.charge(s.bala * lote)) return 'sin plata';
    this.inv[k].balas += lote;
    return 'municion';
  }

  // Munición total del arma en mano, para el HUD.
  get municionTotal() { return this.enCargador + this.balas; }

  bloqueado(x0, z0, x1, z1, solidsNear) {
    const pasos = 16;
    for (let i = 1; i <= pasos; i++) {
      const t = i / pasos;
      const x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t;
      for (const b of solidsNear(x, z))
        if (x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1) return true;
    }
    return false;
  }

  disparar(dt, mantenido) {
    const g = this.g, p = g.player;
    this.cool = Math.max(0, this.cool - dt);
    if (!this.actual || p.mode !== 'foot') return null;
    const s = this.spec;
    if (mantenido && !s.auto && this.yaDisparo) return null;
    if (this.cool > 0) return null;

    const car = this.inv[this.actual];
    if (car.cargador <= 0) {
      if (car.balas <= 0) return 'sin balas';
      const carga = Math.min(s.cargador, car.balas);
      car.cargador = carga; car.balas -= carga; this.cool = 1.2;
      return 'recargando';
    }
    car.cargador--; this.cool = s.cadencia; this.yaDisparo = true;
    p.yaw = p.camYaw;

    const ox = p.x + Math.sin(p.camYaw) * 0.4, oz = p.z + Math.cos(p.camYaw) * 0.4, oy = 1.35;
    let impacto = null, bajas = 0;

    for (let n = 0; n < s.perdigones; n++) {
      const ang = p.camYaw + (n === 0 ? 0 : (Math.random() - 0.5) * s.disp * 2);
      const dx = Math.sin(ang), dz = Math.cos(ang);
      const cono = Math.cos(s.disp + 0.02);
      let mejor = null, mejorD = s.alcance;
      const mirar = (tx, tz, obj, tipo) => {
        const vx = tx - ox, vz = tz - oz, d = Math.hypot(vx, vz);
        if (d < 0.8 || d > s.alcance) return;
        if ((vx / d) * dx + (vz / d) * dz < cono) return;
        if (d < mejorD) { mejorD = d; mejor = { obj, tipo, x: tx, z: tz }; }
      };
      for (const ped of g.peds.list) if (ped.active && ped.state !== 'down') mirar(ped.x, ped.z, ped, 'peaton');
      for (const u of g.police.units) if (u.active) mirar(u.car.x, u.car.z, u, 'cana');
      for (const t of g.traffic.cars) if (t.active && t !== p.vehicle) mirar(t.car.x, t.car.z, t, 'auto');
      if (mejor && this.bloqueado(ox, oz, mejor.x, mejor.z, g.solidsNear)) mejor = null;

      const fin = mejor ? mejor : { x: ox + dx * s.alcance, z: oz + dz * s.alcance };
      this.traza(ox, oy, oz, fin.x, mejor ? 1.1 : 1.5, fin.z);
      if (!mejor) continue;
      impacto = impacto || mejor.tipo;

      if (mejor.tipo === 'peaton') {
        mejor.obj.state = 'down'; mejor.obj.downTime = 0; bajas++;
      } else if (mejor.tipo === 'cana') {
        mejor.obj.vida = (mejor.obj.vida ?? 100) - s.dano;
        if (mejor.obj.vida <= 0) { g.police.retire(mejor.obj); bajas++; g.police.crime('chocarPatrullero', 1.4); }
        else g.police.crime('chocarPatrullero', 0.16);
      } else {
        mejor.obj.car.damage = Math.min(100, mejor.obj.car.damage + s.dano * 0.4);
        g.traffic.knock(mejor.obj);
      }
    }

    if (bajas > 0 && impacto === 'peaton') g.police.crime('atropello', 1.4 * bajas);
    this.fogonazo.position.set(ox + Math.sin(p.camYaw) * 0.5, oy, oz + Math.cos(p.camYaw) * 0.5);
    this.fogonazo.visible = true; this.flashT = 0.05;
    g.audio.bang(this.actual === 'escopeta' ? 12 : 7);
    return impacto || 'tiro';
  }

  soltar() { this.yaDisparo = false; }

  update(dt) {
    this.flashT -= dt;
    if (this.flashT <= 0) this.fogonazo.visible = false;
    for (const tr of this.trazas) {
      if (!tr.l.visible) continue;
      tr.t -= dt;
      tr.l.material.opacity = clamp(tr.t / 0.09, 0, 1) * 0.9;
      if (tr.t <= 0) tr.l.visible = false;
    }
  }

  traza(x0, y0, z0, x1, y1, z1) {
    const tr = this.trazas.find(t => !t.l.visible) || this.trazas[0];
    const pos = tr.l.geometry.attributes.position;
    pos.setXYZ(0, x0, y0, z0); pos.setXYZ(1, x1, y1, z1);
    pos.needsUpdate = true;
    tr.l.geometry.computeBoundingSphere();
    tr.l.visible = true; tr.t = 0.09;
  }

  guardar() { return { inv: this.inv, actual: this.actual }; }
  cargar(d) {
    if (!d || !d.inv) return;
    this.inv = d.inv;
    this.actual = d.actual && this.inv[d.actual] ? d.actual : (Object.keys(this.inv)[0] || null);
  }
}
