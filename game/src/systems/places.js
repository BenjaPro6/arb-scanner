import * as THREE from 'three';

// Puntos de interés del mapa: cuevas para cambiar, talleres para sacarse la
// cana de encima, y el punto de laburo.
const TYPES = {
  cueva:  { color: 0x35d07f, label: 'Cueva', r: 3.4 },
  taller: { color: 0x3aa0ff, label: 'Taller', r: 4.2 },
  laburo: { color: 0xffb020, label: 'Laburo', r: 3.6 },
  meta:   { color: 0xff5470, label: 'Destino', r: 4.0 },
};

export class Places {
  constructor(scene, city, rng) {
    this.city = city; this.rng = rng;
    this.group = new THREE.Group(); scene.add(this.group);
    this.list = [];

    // Las cuevas viven en la City y en Once, como en la vida real.
    for (let i = 0; i < 6; i++)
      this.add('cueva', city.randomBlock(b => b.district === 'microcentro' || b.district === 'once'));
    for (let i = 0; i < 5; i++)
      this.add('taller', city.randomBlock(b => b.kind === 'edificado'));
    this.laburo = this.add('laburo', city.randomBlock(b => b.kind === 'edificado'));
  }

  add(type, block, x, z) {
    const t = TYPES[type];
    const pos = this.streetSpot(block, x, z);
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(t.r, t.r, 7, 20, 1, true),
      new THREE.MeshBasicMaterial({ color: t.color, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false, toneMapped: false })
    );
    mesh.position.set(pos.x, 3.5, pos.z);
    this.group.add(mesh);
    const p = { type, x: pos.x, z: pos.z, r: t.r, mesh, label: t.label, color: t.color };
    this.list.push(p);
    return p;
  }

  // Lo pongo sobre la calle, pegado al cordón de la manzana.
  streetSpot(block, x, z) {
    if (x !== undefined) return { x, z };
    const side = this.rng.int(0, 3);
    const o = 5.5;
    if (side === 0) return { x: block.cx, z: block.z0 - o };
    if (side === 1) return { x: block.x1 + o, z: block.cz };
    if (side === 2) return { x: block.cx, z: block.z1 + o };
    return { x: block.x0 - o, z: block.cz };
  }

  move(place, x, z) { place.x = x; place.z = z; place.mesh.position.set(x, 3.5, z); }
  show(place, on) { place.mesh.visible = on; }

  near(x, z, type) {
    for (const p of this.list) {
      if (type && p.type !== type) continue;
      if (!p.mesh.visible) continue;
      if (Math.hypot(p.x - x, p.z - z) < p.r + 2.5) return p;
    }
    return null;
  }

  update(dt) {
    for (const p of this.list) p.mesh.rotation.y += dt * 0.6;
  }
}
