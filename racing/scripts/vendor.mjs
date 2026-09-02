// Copia el build de Three.js desde node_modules a vendor/ para que el juego
// se abra sin instalar nada ni depender de un CDN.
import { cp, readdir, mkdir } from 'node:fs/promises';
const from = 'node_modules/three/build', to = 'vendor';
await mkdir(to, { recursive: true });
const files = (await readdir(from)).filter(f => f === 'three.module.js' || f === 'three.core.js');
if (!files.length) { console.error('Falta node_modules/three. Corré: npm install'); process.exit(1); }
for (const f of files) { await cp(`${from}/${f}`, `${to}/${f}`); console.log('vendorizado', f); }
await cp('node_modules/three/LICENSE', `${to}/THREE.LICENSE`);
