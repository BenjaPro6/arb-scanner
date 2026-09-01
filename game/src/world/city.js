import { CFG, DISTRICTS } from '../core/config.js';
import { makeRng } from '../core/rng.js';

// Genera la trama de Buenos Aires: la grilla de manzanas de 100m, con
// avenidas cada tantas cuadras y la 9 de Julio partiendo el centro al medio.
//
// colX[i] = coordenada X del eje de la calle vertical i
// colW[i] = ancho de esa calle
// Una manzana (i,j) vive ENTRE las calles i / i+1 y j / j+1.
export class City {
  constructor(seed = 1987) {
    this.rng = makeRng(seed);
    this.cols = CFG.COLS; this.rows = CFG.ROWS;

    // La 9 de Julio y Corrientes cruzan cerca del centro: ahí va el Obelisco.
    this.mega = { i: Math.floor(this.cols * 0.46), j: Math.floor(this.rows * 0.5) };

    this.colW = []; this.rowW = [];
    for (let i = 0; i <= this.cols; i++) this.colW.push(this.streetWidth(i, this.mega.i));
    for (let j = 0; j <= this.rows; j++) this.rowW.push(this.streetWidth(j, -1));

    this.colX = [0]; this.rowZ = [0];
    for (let i = 1; i <= this.cols; i++)
      this.colX.push(this.colX[i - 1] + CFG.BLOCK + (this.colW[i - 1] + this.colW[i]) / 2);
    for (let j = 1; j <= this.rows; j++)
      this.rowZ.push(this.rowZ[j - 1] + CFG.BLOCK + (this.rowW[j - 1] + this.rowW[j]) / 2);

    this.width = this.colX[this.cols];
    this.depth = this.rowZ[this.rows];
    this.center = { x: this.colX[this.mega.i], z: this.rowZ[this.mega.j] };

    this.blocks = this.buildBlocks();
  }

  streetWidth(k, megaIndex) {
    if (k === megaIndex) return CFG.MEGA;
    return (k % CFG.AVENUE_EVERY === 0) ? CFG.AVENUE : CFG.STREET;
  }

  isAvenueCol(i) { return this.colW[i] >= CFG.AVENUE; }
  isAvenueRow(j) { return this.rowW[j] >= CFG.AVENUE; }

  // Límites de la manzana (i,j) en coordenadas de mundo.
  blockBounds(i, j) {
    return {
      x0: this.colX[i] + this.colW[i] / 2,
      x1: this.colX[i + 1] - this.colW[i + 1] / 2,
      z0: this.rowZ[j] + this.rowW[j] / 2,
      z1: this.rowZ[j + 1] - this.rowW[j + 1] / 2,
    };
  }

  // Qué barrio le toca a cada manzana, según su posición relativa al centro.
  districtAt(i, j) {
    const u = i / this.cols, v = j / this.rows;
    const dx = u - 0.46, dz = v - 0.5;
    const d = Math.hypot(dx * 1.15, dz);
    if (u > 0.86 && v > 0.34 && v < 0.72) return 'maderos';   // el río, al este
    if (d < 0.11) return 'microcentro';
    if (v > 0.80 && u > 0.60) return 'boca';                  // sur profundo
    if (v > 0.62 && d < 0.34) return 'sanTelmo';              // sur del centro
    if (u < 0.30 && v > 0.30 && v < 0.72) return 'once';      // oeste denso
    if (v < 0.34) return 'palermo';                           // norte
    return 'barrio';
  }

  buildBlocks() {
    const out = [];
    for (let j = 0; j < this.rows; j++) {
      for (let i = 0; i < this.cols; i++) {
        const b = this.blockBounds(i, j);
        const key = this.districtAt(i, j);
        const kind = this.blockKind(i, j, key);
        out.push({
          i, j, district: key, spec: DISTRICTS[key], kind,
          x0: b.x0, x1: b.x1, z0: b.z0, z1: b.z1,
          cx: (b.x0 + b.x1) / 2, cz: (b.z0 + b.z1) / 2,
          w: b.x1 - b.x0, d: b.z1 - b.z0,
          lots: [],
        });
      }
    }
    return out;
  }

  blockKind(i, j, district) {
    if (i === this.mega.i - 1 && j === this.mega.j - 1) return 'obelisco';
    const r = this.rng;
    if (district === 'palermo' && r.chance(0.16)) return 'parque';
    if (district === 'boca' && r.chance(0.10)) return 'cancha';
    if (r.chance(0.045)) return 'plaza';
    return 'edificado';
  }

  blockAt(x, z) {
    let i = -1, j = -1;
    for (let k = 0; k < this.cols; k++) if (x >= this.colX[k] && x < this.colX[k + 1]) { i = k; break; }
    for (let k = 0; k < this.rows; k++) if (z >= this.rowZ[k] && z < this.rowZ[k + 1]) { j = k; break; }
    if (i < 0 || j < 0) return null;
    return this.blocks[j * this.cols + i];
  }

  randomBlock(pred) {
    for (let t = 0; t < 200; t++) {
      const b = this.blocks[this.rng.int(0, this.blocks.length - 1)];
      if (!pred || pred(b)) return b;
    }
    return this.blocks[0];
  }
}
