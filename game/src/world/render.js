import * as THREE from 'three';
import { CFG, DISTRICTS } from '../core/config.js';
import { MeshBuilder } from './meshbuilder.js';
import * as TX from './textures.js';

const GROUND_H = 4.6;      // altura de la planta baja (locales)
const SIDEWALK = 2.6;
const SECTOR = 6;          // manzanas por sector; sirve para el frustum culling

// Agrupa geometría por clave "material|sector". Sin esto la ciudad entera
// sería un solo mesh gigante que no se puede cullear y se dibuja siempre.
class Bank {
  constructor() { this.map = new Map(); }
  at(kind, x, z) {
    const k = `${kind}|${Math.floor(x / (SECTOR * 120))},${Math.floor(z / (SECTOR * 120))}`;
    let b = this.map.get(k);
    if (!b) { b = new MeshBuilder(); this.map.set(k, b); }
    return b;
  }
  emit(group, matFor, opts = {}) {
    const out = [];
    for (const [key, b] of this.map) {
      if (!b.count) continue;
      const kind = key.split('|')[0];
      const m = new THREE.Mesh(b.toGeometry(), matFor(kind));
      m.receiveShadow = opts.receive !== false;
      m.castShadow = false;   // los edificios no proyectan sombra: sale carísimo
      group.add(m); out.push(m);
    }
    return out;
  }
}

export function buildWorld(city, roads, rng) {
  const group = new THREE.Group();
  const nightMats = [];

  // ---------- Asfalto ----------
  const asphaltTex = TX.asphalt();
  asphaltTex.repeat.set(city.width / 7, city.depth / 7);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(city.width + 600, city.depth + 600),
    new THREE.MeshLambertMaterial({ map: asphaltTex })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(city.width / 2, 0, city.depth / 2);
  ground.receiveShadow = true;
  group.add(ground);

  const bank = new Bank();
  const solids = [];

  for (const b of city.blocks) {
    bank.at('walk', b.cx, b.cz)
      .box(b.x0 - SIDEWALK, b.z0 - SIDEWALK, b.x1 + SIDEWALK, b.z1 + SIDEWALK, 0, 0.16, 4, 4, 4);

    if (b.kind === 'parque' || b.kind === 'plaza' || b.kind === 'cancha') {
      bank.at('park', b.cx, b.cz).slab(b.x0, b.z0, b.x1, b.z1, 0.17);
      scatterTrees(bank, b, rng, b.kind === 'cancha' ? 3 : 14);
      if (b.kind === 'cancha') pitch(bank.at('mark', b.cx, b.cz), b);
      continue;
    }
    if (b.kind === 'obelisco') {
      obelisk(bank.at('prop', b.cx, b.cz), bank.at('roof', b.cx, b.cz), b);
      solids.push(rect(b)); continue;
    }
    fillBlock(b, rng, bank);
    solids.push(rect(b));
  }

  drawMarkings(roads, bank);
  medians(roads, bank, rng);
  streetLights(roads, bank);

  // ---------- Materiales ----------
  const facadeMats = {};
  for (const k in DISTRICTS) {
    const t = TX.facade(DISTRICTS[k], k.length * 977 + k.charCodeAt(0) * 31 + 13);
    facadeMats[k] = new THREE.MeshLambertMaterial({
      map: t.map, emissiveMap: t.emissive, emissive: new THREE.Color(0, 0, 0),
    });
    nightMats.push(facadeMats[k]);
  }
  const sf = TX.shopfront(31337);
  const shopMat = new THREE.MeshLambertMaterial({
    map: sf.map, emissiveMap: sf.emissive, emissive: new THREE.Color(0, 0, 0),
  });
  nightMats.push(shopMat);

  const mats = {
    shop: shopMat,
    roof: new THREE.MeshLambertMaterial({ map: TX.flat('#5a5a5c', 0.10) }),
    walk: new THREE.MeshLambertMaterial({ map: TX.sidewalk() }),
    park: new THREE.MeshLambertMaterial({ map: TX.grass() }),
    mark: new THREE.MeshBasicMaterial({ color: 0xbdb9ac, toneMapped: false }),
    prop: new THREE.MeshLambertMaterial({ map: TX.flat('#4a4d52', 0.12) }),
    lamp: new THREE.MeshLambertMaterial({ color: 0x9a9384, emissive: new THREE.Color(0, 0, 0) }),
    tree: new THREE.MeshLambertMaterial({ map: TX.flat('#39512f', 0.16) }),
  };
  nightMats.push(mats.lamp);
  const meshes = bank.emit(group, (kind) => facadeMats[kind] || mats[kind] || mats.prop);

  return { group, nightMats, solids, meshes, sectorCount: bank.map.size };
}

const rect = (b) => ({ x0: b.x0, z0: b.z0, x1: b.x1, z1: b.z1 });

// Manzana perimetral: los edificios se pegan al frente y dejan el patio de aire
// en el medio, como una manzana porteña de verdad.
function fillBlock(b, rng, bank) {
  const sp = b.spec;
  const tower = bank.at(b.district, b.cx, b.cz);
  const shops = bank.at('shop', b.cx, b.cz);
  const roofs = bank.at('roof', b.cx, b.cz);
  const prominence = rng.range(0.55, 1.0) ** 1.6;

  const run = (axis, fixed, from, to, inward) => {
    let p = from;
    while (to - p > 6) {
      const w = Math.min(to - p, rng.range(9, 22));
      if (rng.chance(sp.dens)) {
        const dep = rng.range(15, 24);
        let h = rng.range(sp.h[0], sp.h[1]) * (0.75 + prominence * 0.5);
        if (rng.chance(0.05)) h *= rng.range(1.4, 2.1);     // una torre que rompe la línea
        h = Math.max(7, h);
        let x0, x1, z0, z1;
        if (axis === 'x') {
          x0 = p; x1 = p + w;
          z0 = inward > 0 ? fixed : fixed - dep;
          z1 = inward > 0 ? fixed + dep : fixed;
        } else {
          z0 = p; z1 = p + w;
          x0 = inward > 0 ? fixed : fixed - dep;
          x1 = inward > 0 ? fixed + dep : fixed;
        }
        shops.box(x0, z0, x1, z1, 0.16, GROUND_H, 16, 13.2, 6);
        tower.box(x0 + 0.02, z0 + 0.02, x1 - 0.02, z1 - 0.02, GROUND_H, h, TX.WIN_U, TX.WIN_V, 6);
        // Tanque de agua en la terraza. No hay terraza en Buenos Aires sin uno.
        if (rng.chance(0.55)) {
          const tw = rng.range(1.6, 2.6), cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
          roofs.box(cx - tw / 2, cz - tw / 2, cx + tw / 2, cz + tw / 2, h, h + rng.range(1.8, 3.0), 3, 3, 3);
        }
      }
      p += w;
    }
  };

  const inset = 26;
  run('x', b.z0, b.x0, b.x1, +1);
  run('x', b.z1, b.x0, b.x1, -1);
  run('z', b.x0, b.z0 + inset, b.z1 - inset, +1);
  run('z', b.x1, b.z0 + inset, b.z1 - inset, -1);
}

function scatterTrees(bank, b, rng, n) {
  for (let k = 0; k < n; k++) {
    const x = rng.range(b.x0 + 4, b.x1 - 4), z = rng.range(b.z0 + 4, b.z1 - 4);
    treeAt(bank, x, z, rng.range(0.8, 1.35));
  }
}

function obelisk(props, roofs, b) {
  const cx = b.cx, cz = b.cz;
  for (const [r, y0, y1] of [[7.5, 0.17, 8], [6.2, 8, 34], [4.4, 34, 56], [2.4, 56, 67.5]])
    props.box(cx - r, cz - r, cx + r, cz + r, y0, y1, 6, 12, 6);
  roofs.box(cx - 1.1, cz - 1.1, cx + 1.1, cz + 1.1, 67.5, 71, 3, 3, 3);
}

function pitch(marks, b) {
  const m = 6, y = 0.19;
  const x0 = b.x0 + m, x1 = b.x1 - m, z0 = b.z0 + m, z1 = b.z1 - m;
  const line = (a, c, d, e) => marks.slab(a, c, d, e, y, 4);
  line(x0, z0, x1, z0 + 0.4); line(x0, z1 - 0.4, x1, z1);
  line(x0, z0, x0 + 0.4, z1); line(x1 - 0.4, z0, x1, z1);
  line(x0, (z0 + z1) / 2 - 0.2, x1, (z0 + z1) / 2 + 0.2);
}

function drawMarkings(roads, bank) {
  const y = 0.06;   // apenas por encima del asfalto, para no pelear el z-buffer
  for (const e of roads.edges) {
    const A = roads.nodes[e.a];
    const mb = bank.at('mark', A.x + e.fx * e.len / 2, A.z + e.fz * e.len / 2);
    const nx = -e.fz, nz = e.fx;
    const put = (t0, t1, off, half) => {
      const ax = A.x + e.fx * e.len * t0 + nx * off, az = A.z + e.fz * e.len * t0 + nz * off;
      const bx = A.x + e.fx * e.len * t1 + nx * off, bz = A.z + e.fz * e.len * t1 + nz * off;
      mb.quad(
        ax + nx * half, y, az + nz * half, bx + nx * half, y, bz + nz * half,
        bx - nx * half, y, bz - nz * half, ax - nx * half, y, az - nz * half, 1, 1
      );
    };
    const marginT = 9 / e.len;
    const borde = e.median / 2;
    if (e.median > 0) {
      // Con cantero no va doble amarilla: va la línea de borde contra el cordón.
      put(marginT, 1 - marginT, borde, 0.11); put(marginT, 1 - marginT, -borde, 0.11);
    } else put(marginT, 1 - marginT, 0, 0.10);
    for (let k = 1; k < e.lanes; k++) {
      const off = borde + k * e.laneW;
      const dashes = Math.floor(e.len / 9);
      for (let d = 0; d < dashes; d++) {
        const t0 = (d * 9 + 2) / e.len, t1 = (d * 9 + 6) / e.len;
        if (t0 < marginT || t1 > 1 - marginT) continue;
        put(t0, t1, off, 0.09); put(t0, t1, -off, 0.09);
      }
    }
  }
  // Sendas peatonales en las esquinas con semáforo.
  for (const n of roads.nodes) {
    if (!n.light) continue;
    const mb = bank.at('mark', n.x, n.z);
    for (const eid of n.edges) {
      const e = roads.edges[eid];
      const dir = e.a === n.id ? 1 : -1;
      const fx = e.fx * dir, fz = e.fz * dir, nx2 = -fz, nz2 = fx;
      const half = e.width / 2 - 1.2;
      for (let s = -3; s <= 3; s++) {
        const off = s * 1.5;
        if (Math.abs(off) > half) continue;
        const bx = n.x + fx * 7.5 + nx2 * off, bz = n.z + fz * 7.5 + nz2 * off;
        mb.quad(
          bx - fx * 2.2 + nx2 * 0.42, y, bz - fz * 2.2 + nz2 * 0.42,
          bx + fx * 2.2 + nx2 * 0.42, y, bz + fz * 2.2 + nz2 * 0.42,
          bx + fx * 2.2 - nx2 * 0.42, y, bz + fz * 2.2 - nz2 * 0.42,
          bx - fx * 2.2 - nx2 * 0.42, y, bz - fz * 2.2 - nz2 * 0.42, 1, 1
        );
      }
    }
  }
}

// Franja levantada a lo largo de un tramo, a cierta distancia del eje.
function strip(mb, roads, e, o0, o1, y0, y1) {
  const A = roads.nodes[e.a], B = roads.nodes[e.b];
  const t = 9;                       // se corta antes de la esquina
  if (e.len < t * 2.4) return null;
  const nx = -e.fz, nz = e.fx;
  const xs = [], zs = [];
  for (const [px, pz] of [[A.x + e.fx * t, A.z + e.fz * t], [B.x - e.fx * t, B.z - e.fz * t]])
    for (const o of [o0, o1]) { xs.push(px + nx * o); zs.push(pz + nz * o); }
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const z0 = Math.min(...zs), z1 = Math.max(...zs);
  mb.box(x0, z0, x1, z1, y0, y1, 4, 4, 4);
  return { x0, z0, x1, z1 };
}

// El cantero central es lo que hace que una avenida se lea como avenida.
// Sin esto la 9 de Julio era una plancha de asfalto de 110 metros.
function medians(roads, bank, rng) {
  for (const e of roads.edges) {
    if (e.median < 1.5) continue;
    const cx = (roads.nodes[e.a].x + roads.nodes[e.b].x) / 2;
    const cz = (roads.nodes[e.a].z + roads.nodes[e.b].z) / 2;
    const franjas = [[-e.median / 2, e.median / 2]];
    if (e.outer > 1.5) {
      const borde = e.median / 2 + e.lanes * e.laneW;
      franjas.push([borde, borde + e.outer], [-borde - e.outer, -borde]);
    }
    for (const [o0, o1] of franjas) {
      const r = strip(bank.at('walk', cx, cz), roads, e, o0, o1, 0, 0.16);
      if (!r) continue;
      bank.at('park', cx, cz).slab(r.x0 + 0.3, r.z0 + 0.3, r.x1 - 0.3, r.z1 - 0.3, 0.17);
      // Árboles a lo largo, y un farol cada dos.
      const largo = Math.max(r.x1 - r.x0, r.z1 - r.z0);
      const ancho = Math.min(r.x1 - r.x0, r.z1 - r.z0);
      const horiz = (r.x1 - r.x0) > (r.z1 - r.z0);
      const paso = 13;
      for (let d = paso * 0.6; d < largo - paso * 0.4; d += paso) {
        const x = horiz ? r.x0 + d : (r.x0 + r.x1) / 2;
        const z = horiz ? (r.z0 + r.z1) / 2 : r.z0 + d;
        if (ancho < 3) continue;
        const jx = x + (rng() - 0.5) * Math.min(4, ancho - 2);
        const jz = z + (rng() - 0.5) * Math.min(4, ancho - 2);
        treeAt(bank, jx, jz, rng.range(0.9, 1.4));
      }
    }
  }
}

function treeAt(bank, x, z, s) {
  bank.at('prop', x, z).box(x - 0.22 * s, z - 0.22 * s, x + 0.22 * s, z + 0.22 * s, 0.17, 3.2 * s, 2, 2, 2);
  const r = 2.0 * s;
  bank.at('tree', x, z).box(x - r, z - r, x + r, z + r, 3.0 * s, 6.4 * s, 4, 4, 4);
}

function streetLights(roads, bank) {
  for (const e of roads.edges) {
    if (!e.big) continue;
    const A = roads.nodes[e.a];
    for (let d = 34; d < e.len - 17; d += 34) {
      for (const side of [-1, 1]) {
        const off = (e.median > 6 ? e.median / 2 - 1.2 : e.width / 2 - 1.0) * side;
        const x = A.x + e.fx * d + (-e.fz) * off;
        const z = A.z + e.fz * d + (e.fx) * off;
        bank.at('prop', x, z).box(x - 0.13, z - 0.13, x + 0.13, z + 0.13, 0.17, 8.4, 2, 6, 2);
        const ax = -e.fz * side, az = e.fx * side;
        // La cabeza del farol va en su propio material: de noche se prende.
        bank.at('lamp', x, z).box(x - 0.9 - ax * 0.9, z - 0.9 - az * 0.9,
                                  x + 0.9 - ax * 0.9, z + 0.9 - az * 0.9, 8.1, 8.5, 2, 2, 2);
      }
    }
  }
}
