import * as THREE from 'three';
import { MeshBuilder } from '../world/meshbuilder.js';

const glassMat = new THREE.MeshLambertMaterial({ color: 0x161c24 });
const tyreMat = new THREE.MeshLambertMaterial({ color: 0x14161a });
const trimMat = new THREE.MeshLambertMaterial({ color: 0x30343a });
const lampMat = new THREE.MeshBasicMaterial({ color: 0xfff0c0, toneMapped: false });
const redMat = new THREE.MeshBasicMaterial({ color: 0xff2a12, toneMapped: false });

const geoCache = new Map();

// Carrocería a partir de cajas: chasis, capot, baúl y techo.
// El modelo mira hacia +Z, que es el mismo criterio que usa la física.
function bodyGeometry(spec) {
  const key = spec.name;
  if (geoCache.has(key)) return geoCache.get(key);
  const L = spec.L, W = spec.W, H = spec.H;
  const hw = W / 2, hl = L / 2;
  const [r0, r1] = spec.roofBox;          // cabina, en fracción del largo desde atrás
  const zc0 = -hl + L * r0, zc1 = -hl + L * r1;

  const body = new MeshBuilder();   // chapa: va con el color del auto
  const roof = new MeshBuilder();   // techo: color propio (taxi, patrullero)
  const glass = new MeshBuilder();  // vidrios
  const trim = new MeshBuilder();   // paragolpes y zócalos, siempre oscuros

  const sillY = 0.32, beltY = H * 0.60;
  body.box(-hw, -hl, hw, hl, sillY, beltY, 4, 4, 4);
  trim.box(-hw * 0.96, -hl * 0.99, hw * 0.96, hl * 0.99, 0.24, sillY, 4, 4, 4);

  if (spec.class === 'bus') {
    glass.box(-hw * 0.99, zc0, hw * 0.99, zc1, beltY, H * 0.92, 4, 4, 4);
    roof.box(-hw, -hl, hw, hl, H * 0.92, H, 4, 4, 4);
  } else if (spec.class === 'pickup') {
    // Caja de carga atrás, cabina adelante: al revés no es una F100.
    body.box(-hw * 0.97, -hl + L * 0.05, hw * 0.97, zc0, beltY, beltY + 0.34, 4, 4, 4);
    glass.box(-hw * 0.92, zc0, hw * 0.92, zc1, beltY, H - 0.06, 4, 4, 4);
    roof.box(-hw * 0.90, zc0 + 0.06, hw * 0.90, zc1 - 0.06, H - 0.06, H, 4, 4, 4);
  } else {
    glass.box(-hw * 0.91, zc0, hw * 0.91, zc1, beltY, H - 0.06, 4, 4, 4);
    roof.box(-hw * 0.89, zc0 + 0.08, hw * 0.89, zc1 - 0.08, H - 0.06, H, 4, 4, 4);
  }
  // Paragolpes delantero y trasero.
  trim.box(-hw * 0.98, hl - 0.12, hw * 0.98, hl + 0.05, 0.28, 0.60, 4, 4, 4);
  trim.box(-hw * 0.98, -hl - 0.05, hw * 0.98, -hl + 0.12, 0.28, 0.60, 4, 4, 4);

  const out = { body: body.toGeometry(), roof: roof.toGeometry(),
                glass: glass.toGeometry(), trim: trim.toGeometry(), spec };
  geoCache.set(key, out);
  return out;
}

let wheelGeo = null;
function getWheelGeo() {
  if (!wheelGeo) {
    wheelGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.24, 12);
    wheelGeo.rotateZ(Math.PI / 2);
  }
  return wheelGeo;
}

export function buildVehicle(spec, color, roofColor) {
  const g = bodyGeometry(spec);
  const root = new THREE.Group();

  const paint = new THREE.MeshLambertMaterial({ color: new THREE.Color(color) });
  // Sin color de techo definido, el techo es del color del auto.
  const roofPaint = (roofColor || spec.roofColor)
    ? new THREE.MeshLambertMaterial({ color: new THREE.Color(roofColor || spec.roofColor) })
    : paint;

  const b = new THREE.Mesh(g.body, paint); b.castShadow = true; root.add(b);
  const rf = new THREE.Mesh(g.roof, roofPaint); rf.castShadow = true; root.add(rf);
  root.add(new THREE.Mesh(g.glass, glassMat));
  root.add(new THREE.Mesh(g.trim, trimMat));

  // Ruedas: se giran para la dirección y ruedan según la velocidad.
  const wr = spec.class === 'bus' ? 0.50 : 0.34;
  const wheels = [];
  const ax = spec.W / 2 - 0.06, az = spec.L * 0.33;
  for (const [sx, sz, steer] of [[-1, 1, true], [1, 1, true], [-1, -1, false], [1, -1, false]]) {
    const w = new THREE.Mesh(getWheelGeo(), tyreMat);
    w.scale.set(1, wr / 0.34, wr / 0.34);
    w.position.set(sx * ax, wr, sz * az);
    w.userData.steer = steer;
    root.add(w); wheels.push(w);
  }

  // Faros y luces de freno
  const hl = spec.L / 2, hw = spec.W / 2;
  const lamps = [], brakes = [];
  for (const sx of [-1, 1]) {
    const l = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.16, 0.06), lampMat);
    l.position.set(sx * hw * 0.66, spec.H * 0.46, hl); root.add(l); lamps.push(l);
    const r = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.14, 0.06), redMat);
    r.position.set(sx * hw * 0.66, spec.H * 0.48, -hl); root.add(r); brakes.push(r);
    r.visible = false;
  }

  let beacon = null;
  if (spec.police) {
    beacon = new THREE.Mesh(
      new THREE.BoxGeometry(spec.W * 0.62, 0.14, 0.20),
      new THREE.MeshBasicMaterial({ color: 0xff2020, toneMapped: false })
    );
    beacon.position.set(0, spec.H + 0.08, spec.L * 0.06);
    root.add(beacon);
  }

  root.userData = { wheels, lamps, brakes, beacon, spec, paint };
  return root;
}
