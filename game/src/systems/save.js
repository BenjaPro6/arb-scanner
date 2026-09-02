// Guardado en el navegador. Se autoguarda cada tanto y al cerrar la pestaña.
// Todo va envuelto en try/catch: en ventana privada localStorage puede tirar.
const CLAVE = 'sudestada.v1';

export class Save {
  constructor(game) { this.g = game; this.t = 0; }

  instantanea() {
    const g = this.g, p = g.player.pos;
    return {
      v: 1,
      economia: g.economy.guardar(),
      armas: g.weapons.guardar(),
      salud: g.player.health, chaleco: g.player.armor,
      x: p.x, z: p.z, hora: g.hour,
      stats: g.stats,
      misiones: { hechas: g.missions.done, falladas: g.missions.failed },
      negocios: g.places.negocios.filter(n => n.dueno).map(n => n.nombre),
    };
  }

  guardar() {
    try { localStorage.setItem(CLAVE, JSON.stringify(this.instantanea())); return true; }
    catch (_) { return false; }
  }

  hay() {
    try { return !!localStorage.getItem(CLAVE); } catch (_) { return false; }
  }

  cargar() {
    let d;
    try { d = JSON.parse(localStorage.getItem(CLAVE) || 'null'); } catch (_) { return false; }
    if (!d || d.v !== 1) return false;
    const g = this.g;
    g.economy.cargar(d.economia);
    g.weapons.cargar(d.armas);
    g.player.health = d.salud ?? 100;
    g.player.armor = d.chaleco ?? 0;
    g.hour = d.hora ?? g.hour;
    g.stats = d.stats || g.stats;
    g.missions.done = d.misiones?.hechas || 0;
    g.missions.failed = d.misiones?.falladas || 0;
    for (const n of g.places.negocios)
      if ((d.negocios || []).includes(n.nombre)) { n.dueno = true; n.mesh.material.color.setHex(0x35d07f); }
    if (typeof d.x === 'number') {
      g.player.x = d.x; g.player.z = d.z;
      g.ownCar.car.x = d.x + 6; g.ownCar.car.z = d.z;
    }
    return true;
  }

  borrar() { try { localStorage.removeItem(CLAVE); } catch (_) {} }

  update(dt) {
    this.t += dt;
    if (this.t > 20) { this.t = 0; this.guardar(); }
  }
}
