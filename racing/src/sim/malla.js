import * as THREE from 'three';
import { MeshBuilder } from '../core/meshbuilder.js';

// Carrocería del auto, compartida entre el jugador y los rivales.
let cache = null;
function geometria() {
  if (cache) return cache;
  const b = new MeshBuilder();
  const hw = 0.76, hl = 2.15;
  b.box(-hw, -hl, hw, hl, 0.28, 0.72, 2, 2, 2);
  b.box(-hw * 0.82, -hl * 0.34, hw * 0.82, hl * 0.52, 0.72, 1.12, 2, 2, 2);
  b.box(-hw * 1.02, hl - 0.28, hw * 1.02, hl, 0.30, 0.55, 2, 2, 2);
  const rg = new THREE.CylinderGeometry(0.315, 0.315, 0.26, 14);
  rg.rotateZ(Math.PI / 2);
  cache = { cuerpo: b.toGeometry(), rueda: rg };
  return cache;
}

const matVidrio = new THREE.MeshLambertMaterial({ color: 0x101418 });
const matRueda = new THREE.MeshLambertMaterial({ color: 0x15171b });
const matAla = new THREE.MeshLambertMaterial({ color: 0x1c1f24 });

export function construirAuto(color) {
  const g = geometria();
  const raiz = new THREE.Group();
  const pintura = new THREE.MeshLambertMaterial({ color: new THREE.Color(color) });
  const cuerpo = new THREE.Mesh(g.cuerpo, pintura);
  cuerpo.castShadow = true; raiz.add(cuerpo);

  const vidrio = new THREE.Mesh(new THREE.BoxGeometry(1.28, 0.34, 0.9), matVidrio);
  vidrio.position.set(0, 0.94, 0.42); raiz.add(vidrio);
  const ala = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.07, 0.36), matAla);
  ala.position.set(0, 1.14, -1.97); raiz.add(ala);

  const ruedas = {};
  for (const [k, lo, la] of [['DI', 1.28, -0.86], ['DD', 1.28, 0.86], ['TI', -1.34, -0.86], ['TD', -1.34, 0.86]]) {
    const w = new THREE.Mesh(g.rueda, matRueda);
    w.position.set(la, 0.315, lo);
    raiz.add(w); ruedas[k] = w;
  }
  raiz.userData = { ruedas, pintura };
  return raiz;
}
