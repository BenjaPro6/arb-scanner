import * as THREE from 'three';
import { MeshBuilder } from '../core/meshbuilder.js';
import { makeRng } from '../core/rng.js';

// Geometría del circuito: cinta de asfalto, pianitos rojos y blancos,
// escapatoria de pasto, guardrails y una largada pintada.
const PASO = 6;              // metros entre secciones transversales
const PIANO = 1.6;
const ESCAPE = 13;

function textura(color, ruido = 0.06, size = 64, semilla = 3) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const x = c.getContext('2d');
  x.fillStyle = color; x.fillRect(0, 0, size, size);
  const rng = makeRng(semilla);
  for (let i = 0; i < size * size * 0.45; i++) {
    const g = rng.chance(0.5) ? 255 : 0;
    x.fillStyle = `rgba(${g},${g},${g},${rng.range(0, ruido)})`;
    x.fillRect(rng.range(0, size), rng.range(0, size), 1, 1);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function construirCircuito(circuito, escena) {
  const grupo = new THREE.Group();
  const asf = new MeshBuilder(), pianoA = new MeshBuilder(), pianoB = new MeshBuilder();
  const pasto = new MeshBuilder(), rail = new MeshBuilder(), linea = new MeshBuilder();
  const L = circuito.largo;
  const n = Math.floor(L / PASO);

  const banda = (mb, s0, s1, o0, o1, y) => {
    const a = circuito.linea.en(s0), b = circuito.linea.en(s1);
    mb.quad(
      a.x + a.nx * o0, y, a.z + a.nz * o0,
      a.x + a.nx * o1, y, a.z + a.nz * o1,
      b.x + b.nx * o1, y, b.z + b.nz * o1,
      b.x + b.nx * o0, y, b.z + b.nz * o0,
      (o1 - o0) / 4, PASO / 4
    );
  };

  for (let i = 0; i < n; i++) {
    const s0 = i * PASO, s1 = (i + 1) * PASO;
    const w0 = circuito.anchoEn(s0) / 2;
    banda(asf, s0, s1, -w0, w0, 0.02);
    banda(pasto, s0, s1, w0 + PIANO, w0 + PIANO + ESCAPE, 0.0);
    banda(pasto, s0, s1, -w0 - PIANO - ESCAPE, -w0 - PIANO, 0.0);
    // Pianito alternando color cada dos secciones.
    const mb = (i % 2 === 0) ? pianoA : pianoB;
    banda(mb, s0, s1, w0, w0 + PIANO, 0.05);
    banda(mb, s0, s1, -w0 - PIANO, -w0, 0.05);

    // Guardrail: postes y una chapa continua.
    if (i % 2 === 0) {
      for (const lado of [1, -1]) {
        const o = (w0 + PIANO + ESCAPE) * lado;
        const a = circuito.linea.en(s0), b = circuito.linea.en(s1 + PASO);
        const ax = a.x + a.nx * o, az = a.z + a.nz * o;
        const bx = b.x + b.nx * o, bz = b.z + b.nz * o;
        rail.quad(ax, 0.45, az, bx, 0.45, bz, bx, 1.05, bz, ax, 1.05, az, 3, 1);
        rail.quad(bx, 0.45, bz, ax, 0.45, az, ax, 1.05, az, bx, 1.05, bz, 3, 1);
      }
    }
  }

  // Largada: una franja blanca cruzando la pista.
  {
    const w = circuito.anchoEn(0) / 2;
    banda(linea, 0, 2.2, -w, w, 0.06);
  }

  const material = (map, extra = {}) =>
    new THREE.MeshLambertMaterial({ map, ...extra });
  const agregar = (mb, mat) => {
    if (!mb.count) return;
    const m = new THREE.Mesh(mb.toGeometry(), mat);
    m.receiveShadow = true;
    grupo.add(m);
  };

  const tAsf = textura('#3c3f45', 0.09, 64, 11); tAsf.repeat.set(1, 1);
  agregar(asf, material(tAsf));
  agregar(pasto, material(textura('#33502c', 0.14, 64, 5)));
  agregar(pianoA, new THREE.MeshLambertMaterial({ color: 0xcf3b30 }));
  agregar(pianoB, new THREE.MeshLambertMaterial({ color: 0xe8e4d8 }));
  agregar(rail, new THREE.MeshLambertMaterial({ color: 0xb9bcc2, side: THREE.DoubleSide }));
  agregar(linea, new THREE.MeshBasicMaterial({ color: 0xf2efe6 }));

  // Piso general más allá de la escapatoria.
  const piso = new THREE.Mesh(
    new THREE.PlaneGeometry(6000, 6000),
    material(textura('#2c4426', 0.12, 64, 9))
  );
  piso.rotation.x = -Math.PI / 2;
  piso.position.y = -0.05;
  piso.material.map.repeat.set(300, 300);
  grupo.add(piso);

  escena.add(grupo);
  return grupo;
}
