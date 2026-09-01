import * as THREE from 'three';
import { makeRng } from '../core/rng.js';

const TILE = 256;          // px por tile de textura
export const WIN_U = 16;   // metros de fachada por tile horizontal (4 ventanas de 4m)
export const WIN_V = 13.2; // metros de altura por tile (4 pisos de 3.3m)

function canvas(size = TILE) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

function tex(c, repeatWrap = true) {
  const t = new THREE.CanvasTexture(c);
  if (repeatWrap) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  t.anisotropy = 4;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Fachada: pared + grilla de 4x4 ventanas. Devuelve el mapa de color y el
// emisivo (las luces prendidas de noche, con un porcentaje al azar apagadas).
export function facade(spec, seed) {
  const rng = makeRng(seed);
  const c = canvas(), x = c.getContext('2d');
  const ce = canvas(), xe = ce.getContext('2d');

  x.fillStyle = spec.hue; x.fillRect(0, 0, TILE, TILE);
  xe.fillStyle = '#000'; xe.fillRect(0, 0, TILE, TILE);

  // Grano de revoque
  for (let i = 0; i < 2600; i++) {
    x.fillStyle = `rgba(0,0,0,${rng.range(0.02, 0.09)})`;
    x.fillRect(rng.range(0, TILE), rng.range(0, TILE), rng.range(1, 3), rng.range(1, 3));
  }
  // Bandas de losa entre pisos
  for (let r = 0; r < 4; r++) {
    x.fillStyle = 'rgba(0,0,0,0.16)';
    x.fillRect(0, r * 64 + 58, TILE, 4);
  }

  const cw = 64, ch = 64;
  for (let r = 0; r < 4; r++) {
    for (let k = 0; k < 4; k++) {
      const px = k * cw + 14, py = r * ch + 12, pw = cw - 28, ph = ch - 30;
      x.fillStyle = 'rgba(0,0,0,0.30)';
      x.fillRect(px - 2, py - 2, pw + 4, ph + 4);
      x.fillStyle = spec.win;
      x.globalAlpha = 0.42; x.fillRect(px, py, pw, ph); x.globalAlpha = 1;
      // reflejo diagonal
      x.strokeStyle = 'rgba(255,255,255,0.18)'; x.lineWidth = 3;
      x.beginPath(); x.moveTo(px, py + ph); x.lineTo(px + pw, py); x.stroke();
      // balcón, muy de Buenos Aires
      if (rng.chance(0.35)) {
        x.fillStyle = 'rgba(0,0,0,0.22)';
        x.fillRect(px - 5, py + ph + 1, pw + 10, 5);
      }
      if (rng.chance(0.62)) {
        const warm = rng.chance(0.78);
        xe.fillStyle = warm ? '#ffca7a' : '#bcd8ff';
        xe.globalAlpha = rng.range(0.55, 1.0);
        xe.fillRect(px, py, pw, ph);
        xe.globalAlpha = 1;
      }
    }
  }
  return { map: tex(c), emissive: tex(ce) };
}

// Planta baja: locales, persianas, marquesinas. Es lo que ves manejando.
export function shopfront(seed) {
  const rng = makeRng(seed);
  const c = canvas(), x = c.getContext('2d');
  const ce = canvas(), xe = ce.getContext('2d');
  xe.fillStyle = '#000'; xe.fillRect(0, 0, TILE, TILE);

  const cols = ['#7d3b33', '#2f4f5e', '#5c5340', '#3d5a44', '#6b4a63', '#8a5a2b'];
  for (let k = 0; k < 4; k++) {
    const base = cols[rng.int(0, cols.length - 1)];
    x.fillStyle = base; x.fillRect(k * 64, 0, 64, TILE);
    x.fillStyle = 'rgba(0,0,0,0.35)'; x.fillRect(k * 64 + 60, 0, 4, TILE);
    if (rng.chance(0.7)) {
      // vidriera
      x.fillStyle = 'rgba(20,26,34,0.85)';
      x.fillRect(k * 64 + 8, 60, 48, 150);
      xe.fillStyle = rng.chance(0.5) ? '#ffe08a' : '#9ff0ff';
      xe.globalAlpha = rng.range(0.5, 1); xe.fillRect(k * 64 + 8, 60, 48, 150); xe.globalAlpha = 1;
      // marquesina
      x.fillStyle = rng.chance(0.5) ? '#c33' : '#2b6cb0';
      x.fillRect(k * 64 + 4, 34, 56, 22);
    } else {
      // persiana baja
      x.fillStyle = '#4a4a4a'; x.fillRect(k * 64 + 8, 60, 48, 150);
      for (let y = 62; y < 210; y += 7) { x.fillStyle = 'rgba(0,0,0,0.30)'; x.fillRect(k * 64 + 8, y, 48, 3); }
      if (rng.chance(0.6)) { x.fillStyle = `hsla(${rng.range(0, 360)},60%,50%,0.45)`; x.fillRect(k * 64 + 10, 90, 44, 60); }
    }
  }
  return { map: tex(c), emissive: tex(ce) };
}

export function flat(color, noise = 0.05, size = 64) {
  const c = canvas(size), x = c.getContext('2d');
  x.fillStyle = color; x.fillRect(0, 0, size, size);
  const rng = makeRng(7);
  for (let i = 0; i < size * size * 0.3; i++) {
    x.fillStyle = `rgba(0,0,0,${rng.range(0, noise)})`;
    x.fillRect(rng.range(0, size), rng.range(0, size), 1, 1);
  }
  return tex(c);
}

export function asphalt() {
  const c = canvas(128), x = c.getContext('2d');
  const rng = makeRng(42);
  x.fillStyle = '#3e4147'; x.fillRect(0, 0, 128, 128);
  // Grano neutro: el asfalto es gris sucio, no confeti.
  for (let i = 0; i < 4200; i++) {
    const g = rng.range(0, 1) < 0.5 ? 0 : 255;
    x.fillStyle = `rgba(${g},${g},${g},${rng.range(0.02, 0.07)})`;
    x.fillRect(rng.range(0, 128), rng.range(0, 128), rng.range(1, 3), rng.range(1, 2));
  }
  // Parches de bacheo, suaves: son remiendos, no pozos.
  for (let i = 0; i < 7; i++) {
    x.fillStyle = `rgba(0,0,0,${rng.range(0.05, 0.10)})`;
    x.fillRect(rng.range(0, 106), rng.range(0, 108), rng.range(12, 24), rng.range(8, 18));
  }
  return tex(c);
}

export function sidewalk() {
  const c = canvas(128), x = c.getContext('2d');
  const rng = makeRng(99);
  x.fillStyle = '#8d8b84'; x.fillRect(0, 0, 128, 128);
  // baldosón calcáreo de vereda porteña
  for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) {
    x.fillStyle = `rgba(255,255,255,${rng.range(0.01, 0.07)})`;
    x.fillRect(a * 32 + 1, b * 32 + 1, 30, 30);
    x.strokeStyle = 'rgba(0,0,0,0.22)'; x.lineWidth = 1.5;
    x.strokeRect(a * 32 + 1, b * 32 + 1, 30, 30);
  }
  for (let i = 0; i < 900; i++) {
    x.fillStyle = `rgba(0,0,0,${rng.range(0, 0.08)})`;
    x.fillRect(rng.range(0, 128), rng.range(0, 128), 2, 2);
  }
  return tex(c);
}

export function grass() {
  const c = canvas(128), x = c.getContext('2d');
  const rng = makeRng(5);
  x.fillStyle = '#3d5c34'; x.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 6000; i++) {
    x.fillStyle = `hsla(${rng.range(78, 108)},${rng.range(22, 46)}%,${rng.range(18, 36)}%,0.6)`;
    x.fillRect(rng.range(0, 128), rng.range(0, 128), 2, 3);
  }
  return tex(c);
}
