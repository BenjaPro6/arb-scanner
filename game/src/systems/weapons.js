import * as THREE from 'three';
import { clamp } from '../core/utils.js';

// Tiro con hitscan: se dispara un rayo desde el pecho hacia donde mira la
// cámara y se busca el blanco más cercano dentro de un cono angosto, sin
// atravesar edificios. El trazador y el fogonazo son geometría propia.
const ALCANCE = 70;
const CONO = Math.cos(0.045);      // ~2.6 grados de tolerancia
const PISTOLA = { nombre: 'Pistola', dano: 34, cadencia: 0.26, cargador: 12, precio: 26000, bala: 380 };

export class Weapons {
  constructor(scene, game) {
    this.g = game;
    this.armado = false;
    this.balas = 0;
    this.enCargador = 0;
    this.cool = 0;
    this.recarga = 0;

    // Trazadores reutilizables: una tira de líneas con vida corta.
    this.trazas = [];
    const mat = new THREE.LineBasicMaterial({ color: 0xffd489, transparent: true, opacity: 0.9 });
    for (let i = 0; i < 12; i++) {
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
      const l = new THREE.Line(g, mat.clone());
      l.visible = false; scene.add(l);
      this.trazas.push({ l, t: 0 });
    }
    this.fogonazo = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 6, 5),
      new THREE.MeshBasicMaterial({ color: 0xffe6a0, transparent: true, opacity: 0.95, toneMapped: false })
    );
    this.fogonazo.visible = false;
    scene.add(this.fogonazo);
    this.flashT = 0;
  }

  comprar(economia) {
    if (!this.armado) {
      if (!economia.charge(PISTOLA.precio)) return 'sin plata';
      this.armado = true; this.enCargador = PISTOLA.cargador; this.balas = 12;
      return 'comprada';
    }
    const faltan = 24;
    if (!economia.charge(PISTOLA.bala * faltan)) return 'sin plata';
    this.balas += faltan;
    return 'municion';
  }

  get municionTotal() { return this.enCargador + this.balas; }

  // ¿Choca el segmento contra alguna manzana? Si sí, no hay tiro limpio.
  bloqueado(x0, z0, x1, z1, solidsNear) {
    const pasos = 14;
    for (let i = 1; i <= pasos; i++) {
      const t = i / pasos;
      const x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t;
      for (const b of solidsNear(x, z))
        if (x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1) return true;
    }
    return false;
  }

  disparar(dt) {
    const g = this.g, p = g.player;
    this.cool = Math.max(0, this.cool - dt);
    if (!this.armado || this.cool > 0 || p.mode !== 'foot') return null;
    if (this.enCargador <= 0) {
      if (this.balas <= 0) return 'sin balas';
      const carga = Math.min(PISTOLA.cargador, this.balas);
      this.enCargador = carga; this.balas -= carga; this.cool = 1.1;
      return 'recargando';
    }
    this.enCargador--; this.cool = PISTOLA.cadencia;

    const dx = Math.sin(p.camYaw), dz = Math.cos(p.camYaw);
    const ox = p.x + dx * 0.4, oz = p.z + dz * 0.4, oy = 1.35;
    p.yaw = p.camYaw;                       // el personaje encara hacia donde tira

    let mejor = null, mejorD = ALCANCE;
    const mirar = (tx, tz, obj, tipo) => {
      const vx = tx - ox, vz = tz - oz;
      const d = Math.hypot(vx, vz);
      if (d < 0.8 || d > ALCANCE) return;
      if ((vx / d) * dx + (vz / d) * dz < CONO) return;
      if (d < mejorD) { mejorD = d; mejor = { obj, tipo, x: tx, z: tz }; }
    };
    for (const ped of g.peds.list)
      if (ped.active && ped.state !== 'down') mirar(ped.x, ped.z, ped, 'peaton');
    for (const u of g.police.units)
      if (u.active) mirar(u.car.x, u.car.z, u, 'cana');
    for (const t of g.traffic.cars)
      if (t.active && t !== p.vehicle) mirar(t.car.x, t.car.z, t, 'auto');

    if (mejor && this.bloqueado(ox, oz, mejor.x, mejor.z, g.solidsNear)) mejor = null;

    const fin = mejor ? { x: mejor.x, z: mejor.z } : { x: ox + dx * ALCANCE, z: oz + dz * ALCANCE };
    this.traza(ox, oy, oz, fin.x, mejor ? 1.1 : 1.4, fin.z);
    this.fogonazo.position.set(ox + dx * 0.5, oy, oz + dz * 0.5);
    this.fogonazo.visible = true; this.flashT = 0.05;
    g.audio.bang(7);

    if (!mejor) return 'tiro';
    if (mejor.tipo === 'peaton') {
      mejor.obj.state = 'down'; mejor.obj.downTime = 0;
      g.police.crime('atropello', 1.4);
      return 'peaton';
    }
    if (mejor.tipo === 'cana') {
      mejor.obj.vida = (mejor.obj.vida ?? 100) - PISTOLA.dano;
      g.police.crime('chocarPatrullero', 0.5);
      if (mejor.obj.vida <= 0) { g.police.retire(mejor.obj); g.police.crime('chocarPatrullero', 1.2); return 'cana'; }
      return 'tiro';
    }
    mejor.obj.car.damage = Math.min(100, mejor.obj.car.damage + 12);
    g.traffic.knock(mejor.obj);
    return 'auto';
  }

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
}

export const ARMA = PISTOLA;
