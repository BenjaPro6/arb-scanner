import * as THREE from 'three';

// Constructor de geometría cruda. Escribo los vértices a mano en vez de
// mergear BoxGeometry porque necesito control exacto de las UV: los ventanales
// tienen que medir siempre lo mismo en metros, sin importar el tamaño del edificio.
export class MeshBuilder {
  constructor() { this.pos = []; this.nor = []; this.uv = []; }

  get count() { return this.pos.length / 3; }

  quad(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, u, v) {
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = dx - ax, e2y = dy - ay, e2z = dz - az;
    let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    const P = this.pos, N = this.nor, U = this.uv;
    const push = (x, y, z, s, t) => { P.push(x, y, z); N.push(nx, ny, nz); U.push(s, t); };
    push(ax, ay, az, 0, 0); push(bx, by, bz, u, 0); push(cx, cy, cz, u, v);
    push(ax, ay, az, 0, 0); push(cx, cy, cz, u, v); push(dx, dy, dz, 0, v);
  }

  // Caja apoyada en y0, con UV en "unidades de textura" reales (metros / escala).
  box(x0, z0, x1, z1, y0, y1, us, vs, capUs = us) {
    const w = x1 - x0, d = z1 - z0, h = y1 - y0;
    const uw = w / us, ud = d / us, vh = h / vs;
    // Cuatro caras laterales, cada una con la normal apuntando hacia AFUERA.
    // norte (-z)
    this.quad(x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0, uw, vh);
    // sur (+z)
    this.quad(x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1, uw, vh);
    // oeste (-x)
    this.quad(x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0, ud, vh);
    // este (+x)
    this.quad(x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1, ud, vh);
    // techo
    this.quad(x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0, w / capUs, d / capUs);
  }

  // Losa horizontal (vereda, plaza, cancha).
  slab(x0, z0, x1, z1, y, us = 8) {
    this.quad(x0, y, z1, x1, y, z1, x1, y, z0, x0, y, z0, (x1 - x0) / us, (z1 - z0) / us);
  }

  toGeometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.computeBoundingSphere();
    return g;
  }
}
