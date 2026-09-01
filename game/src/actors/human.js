import * as THREE from 'three';

// Humanoide low-poly con animación 100% procedural: no hay rig ni esqueleto,
// los miembros oscilan por seno y los pies se plantan por fase. A la distancia
// de cámara de un GTA se lee perfecto, y no depende de ningún asset externo.
const SKIN = ['#c99f79', '#8d5a3b', '#e0b894', '#6b432a', '#a97852'];
const SHIRT = ['#3b5a7a', '#7a2f2f', '#3f6b4a', '#2b2b30', '#8a7038', '#5a3a6b', '#b5b0a4'];
const PANTS = ['#2c3038', '#43301f', '#1f3350', '#4a4a44'];

const geo = {
  torso: new THREE.BoxGeometry(0.42, 0.60, 0.24),
  hip: new THREE.BoxGeometry(0.38, 0.20, 0.24),
  head: new THREE.BoxGeometry(0.24, 0.26, 0.24),
  limb: new THREE.BoxGeometry(0.14, 0.42, 0.16),
};
// Los miembros pivotean desde arriba, así que corro la geometría hacia abajo.
geo.limb.translate(0, -0.21, 0);

const matCache = new Map();
const mat = (c) => {
  if (!matCache.has(c)) matCache.set(c, new THREE.MeshLambertMaterial({ color: new THREE.Color(c) }));
  return matCache.get(c);
};

export function buildHuman(rng, opts = {}) {
  const skin = opts.skin || rng.pick(SKIN);
  const shirt = opts.shirt || rng.pick(SHIRT);
  const pants = opts.pants || rng.pick(PANTS);
  const scale = opts.scale || rng.range(0.94, 1.06);

  const g = new THREE.Group();
  const torso = new THREE.Mesh(geo.torso, mat(shirt));
  torso.position.y = 1.24; torso.castShadow = true; g.add(torso);
  const hip = new THREE.Mesh(geo.hip, mat(pants));
  hip.position.y = 0.90; g.add(hip);
  const head = new THREE.Mesh(geo.head, mat(skin));
  head.position.y = 1.68; g.add(head);

  const limbs = {};
  for (const [key, x, y, m] of [
    ['armL', -0.28, 1.50, shirt], ['armR', 0.28, 1.50, shirt],
    ['legL', -0.11, 0.90, pants], ['legR', 0.11, 0.90, pants],
  ]) {
    const l = new THREE.Mesh(geo.limb, mat(m));
    l.position.set(x, y, 0);
    g.add(l); limbs[key] = l;
  }
  g.scale.setScalar(scale);
  g.userData = { limbs, torso, head, hip, phase: rng() * 10, scale };
  return g;
}

// speed en m/s. mode: 'walk' | 'run' | 'idle' | 'panic' | 'down'
export function animateHuman(h, dt, speed, mode = 'walk') {
  const u = h.userData, L = u.limbs;
  if (mode === 'down') {
    h.rotation.x = Math.min(h.rotation.x + dt * 6, Math.PI / 2);
    u.torso.position.y = 1.24;
    for (const k in L) L[k].rotation.x = 0;
    return;
  }
  h.rotation.x = 0;
  const cadence = mode === 'run' || mode === 'panic' ? 9.5 : 6.4;
  const stride = Math.min(speed / (mode === 'idle' ? 1 : 1.4), 1.5);
  u.phase += dt * cadence * Math.max(0.18, stride);
  const s = Math.sin(u.phase), c = Math.cos(u.phase * 2);
  const amp = 0.62 * stride + (mode === 'idle' ? 0.02 : 0);

  L.legL.rotation.x = s * amp;
  L.legR.rotation.x = -s * amp;
  L.armL.rotation.x = -s * amp * 0.82;
  L.armR.rotation.x = s * amp * 0.82;
  if (mode === 'panic') {
    // Manos a la cabeza: la pose de "me quieren matar".
    L.armL.rotation.x = -2.4 + s * 0.25; L.armR.rotation.x = -2.4 - s * 0.25;
    L.armL.rotation.z = 0.4; L.armR.rotation.z = -0.4;
  } else { L.armL.rotation.z = 0; L.armR.rotation.z = 0; }
  u.torso.position.y = 1.24 + c * 0.028 * stride;
  u.head.position.y = 1.68 + c * 0.030 * stride;
  u.torso.rotation.z = s * 0.045 * stride;
}
