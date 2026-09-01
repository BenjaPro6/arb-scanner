import { CFG } from '../core/config.js';

const SIDEWALK = 2.6;

// Grafo de calles sobre la grilla de la ciudad.
// Un tramo (edge) va de un nodo a otro; cada tramo tiene manos y carriles.
// En Argentina se maneja por la derecha: el vector "derecha" de un sentido
// es (-fz, 0, fx), y los carriles se cuelgan de ahí.
export class RoadNet {
  constructor(city) {
    this.city = city;
    this.nodes = [];
    this.edges = [];
    this.nodeIndex = new Map();

    for (let j = 0; j <= city.rows; j++) {
      for (let i = 0; i <= city.cols; i++) {
        const id = this.nodes.length;
        this.nodeIndex.set(i + ',' + j, id);
        this.nodes.push({
          id, i, j, x: city.colX[i], z: city.rowZ[j],
          edges: [],
          // Semáforo sólo donde cruza al menos una avenida.
          light: (city.isAvenueCol(i) || city.isAvenueRow(j)),
          phase: ((i * 3 + j * 5) % 2),      // desfasados para que no cambien todos juntos
          timer: ((i * 7 + j * 11) % 100) / 100 * 16,
        });
      }
    }

    // Tramos horizontales (corren sobre la fila j, ancho = rowW[j]).
    for (let j = 0; j <= city.rows; j++)
      for (let i = 0; i < city.cols; i++)
        this.addEdge(i, j, i + 1, j, city.rowW[j], 'h');
    // Tramos verticales (corren sobre la columna i, ancho = colW[i]).
    for (let i = 0; i <= city.cols; i++)
      for (let j = 0; j < city.rows; j++)
        this.addEdge(i, j, i, j + 1, city.colW[i], 'v');

    this.blocked = new Set();   // piquetes
  }

  addEdge(i0, j0, i1, j1, width, axis) {
    const a = this.nodeIndex.get(i0 + ',' + j0);
    const b = this.nodeIndex.get(i1 + ',' + j1);
    const A = this.nodes[a], B = this.nodes[b];
    const dx = B.x - A.x, dz = B.z - A.z;
    const len = Math.hypot(dx, dz);
    const lanes = width >= CFG.MEGA ? 4 : width >= CFG.AVENUE ? 2 : 1;
    const laneW = (width - SIDEWALK * 2) / (lanes * 2);
    const e = {
      id: this.edges.length, a, b, axis, width, lanes, laneW, len,
      fx: dx / len, fz: dz / len,
      rx: -dz / len, rz: dx / len,        // derecha del sentido a->b
      big: width >= CFG.AVENUE,
    };
    this.edges.push(e);
    A.edges.push(e.id); B.edges.push(e.id);
  }

  other(e, nodeId) { return e.a === nodeId ? e.b : e.a; }

  // Posición de un punto sobre un carril.
  // dir = +1 recorre a->b, dir = -1 recorre b->a. t va de 0 a 1 en ese sentido.
  lanePos(e, dir, lane, t, out = { x: 0, z: 0 }) {
    const A = this.nodes[dir > 0 ? e.a : e.b];
    const fx = e.fx * dir, fz = e.fz * dir;
    const off = (0.5 + lane) * e.laneW;
    out.x = A.x + fx * e.len * t + (-fz) * off;
    out.z = A.z + fz * e.len * t + (fx) * off;
    return out;
  }

  laneHeading(e, dir) { return Math.atan2(e.fx * dir, e.fz * dir); }

  isBlocked(e) { return this.blocked.has(e.id); }

  // Salidas válidas desde un nodo, sin contramano y sin volver por donde vine.
  exitsFrom(nodeId, cameFromEdge) {
    const out = [];
    for (const eid of this.nodes[nodeId].edges) {
      if (eid === cameFromEdge) continue;
      const e = this.edges[eid];
      if (this.isBlocked(e)) continue;
      out.push({ e, dir: e.a === nodeId ? 1 : -1 });
    }
    return out;
  }

  // Verde para este tramo en este nodo. Las horizontales van en fase 1.
  hasGreen(node, edge) {
    if (!node.light) return true;
    const want = edge.axis === 'h' ? 1 : 0;
    return node.phase === want && node.amber < 0.5;
  }

  update(dt) {
    for (const n of this.nodes) {
      if (!n.light) { n.amber = 0; continue; }
      n.timer += dt;
      const green = 11, amber = 2.4;
      if (n.timer > green + amber) { n.timer = 0; n.phase ^= 1; }
      n.amber = n.timer > green ? amber - (n.timer - green) : 99;
    }
  }

  // Tramo y posición más cercanos a un punto del mundo (para spawnear).
  nearestEdge(x, z) {
    const c = this.city;
    let i = Math.max(0, Math.min(c.cols - 1, this.approxIndex(c.colX, x)));
    let j = Math.max(0, Math.min(c.rows - 1, this.approxIndex(c.rowZ, z)));
    let best = null, bestD = Infinity;
    for (let dj = 0; dj <= 1; dj++) for (let di = 0; di <= 1; di++) {
      for (const eid of this.nodes[this.nodeIndex.get((i + di) + ',' + (j + dj))].edges) {
        const e = this.edges[eid];
        const A = this.nodes[e.a];
        const t = Math.max(0, Math.min(1, ((x - A.x) * e.fx + (z - A.z) * e.fz) / e.len));
        const px = A.x + e.fx * e.len * t, pz = A.z + e.fz * e.len * t;
        const d = (px - x) ** 2 + (pz - z) ** 2;
        if (d < bestD) { bestD = d; best = { e, t }; }
      }
    }
    return best;
  }

  approxIndex(arr, v) {
    let lo = 0, hi = arr.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (arr[m] <= v) lo = m; else hi = m - 1; }
    return lo;
  }

  // A* sobre el grafo. Lo usan la policía y las misiones.
  path(fromNode, toNode) {
    const N = this.nodes.length;
    const g = new Float64Array(N).fill(Infinity);
    const prev = new Int32Array(N).fill(-1);
    const seen = new Uint8Array(N);
    const T = this.nodes[toNode];
    const h = (n) => Math.hypot(n.x - T.x, n.z - T.z);
    const open = [[h(this.nodes[fromNode]), fromNode]];
    g[fromNode] = 0;
    while (open.length) {
      let bi = 0;
      for (let k = 1; k < open.length; k++) if (open[k][0] < open[bi][0]) bi = k;
      const [, cur] = open.splice(bi, 1)[0];
      if (cur === toNode) break;
      if (seen[cur]) continue;
      seen[cur] = 1;
      for (const eid of this.nodes[cur].edges) {
        const e = this.edges[eid];
        if (this.isBlocked(e)) continue;
        const nx = this.other(e, cur);
        // Las avenidas "pesan" menos: la IA prefiere ir por Corrientes que por una callecita.
        const cost = e.len * (e.big ? 0.72 : 1.0);
        if (g[cur] + cost < g[nx]) {
          g[nx] = g[cur] + cost; prev[nx] = cur;
          open.push([g[nx] + h(this.nodes[nx]), nx]);
        }
      }
    }
    if (prev[toNode] < 0 && fromNode !== toNode) return null;
    const out = [toNode];
    let c = toNode;
    while (c !== fromNode && prev[c] >= 0) { c = prev[c]; out.push(c); }
    return out.reverse();
  }

  nodeNear(x, z) {
    const c = this.city;
    const i = Math.max(0, Math.min(c.cols, this.approxIndex(c.colX, x) + (x - c.colX[this.approxIndex(c.colX, x)] > CFG.BLOCK / 2 ? 1 : 0)));
    const j = Math.max(0, Math.min(c.rows, this.approxIndex(c.rowZ, z) + (z - c.rowZ[this.approxIndex(c.rowZ, z)] > CFG.BLOCK / 2 ? 1 : 0)));
    return this.nodeIndex.get(i + ',' + j);
  }
}
