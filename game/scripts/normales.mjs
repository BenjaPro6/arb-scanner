// Chequeo de que toda la geometría de MeshBuilder mira hacia afuera.
import { MeshBuilder } from '../src/world/meshbuilder.js';
const mb = new MeshBuilder();
mb.box(-1, -2, 1, 2, 0, 3, 4, 4, 4);       // caja centrada en el origen
let malas = 0;
for (let v = 0; v < mb.count; v++) {
  const p = [mb.pos[v*3], mb.pos[v*3+1], mb.pos[v*3+2]];
  const n = [mb.nor[v*3], mb.nor[v*3+1], mb.nor[v*3+2]];
  // Vector desde el centro de la caja hacia el vértice; debe dar positivo con la normal.
  const c = [0, 1.5, 0];
  const d = [p[0]-c[0], p[1]-c[1], p[2]-c[2]];
  if (d[0]*n[0] + d[1]*n[1] + d[2]*n[2] <= 0) malas++;
}
console.log(`vértices: ${mb.count}, con normal hacia adentro: ${malas}`);
if (malas) { console.error('FALLA: hay caras invertidas'); process.exit(1); }
console.log('OK: todas las caras miran hacia afuera');
