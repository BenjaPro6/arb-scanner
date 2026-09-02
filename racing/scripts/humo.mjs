import { chromium } from 'playwright';
const url = process.argv[2], shot = process.argv[3] || '/tmp/trazada.png';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
p.on('pageerror', e => errs.push('PAGEERROR: ' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 4).join('\n')));
p.on('console', m => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });
p.on('response', r => { if (r.status() >= 400 && !/favicon/.test(r.url())) errs.push(`HTTP ${r.status()} ${r.url()}`); });

await p.goto(url, { waitUntil: 'load' });
try { await p.waitForFunction(() => window.juego && window.juego.auto && window.juego.menu, null, { timeout: 120000 }); }
catch (_) { errs.push('TIMEOUT esperando el arranque'); }
console.log('carga:', JSON.stringify(await p.evaluate(() => document.getElementById('carga')?.textContent)));
if (errs.length) { console.log('\n=== ERRORES ===\n' + errs.join('\n')); await b.close(); process.exit(1); }

await p.waitForTimeout(1500);
console.log('\n=== CIRCUITO ===');
console.log(await p.evaluate(() => {
  const g = window.juego;
  return `  largo ${(g.circuito.largo/1000).toFixed(2)} km · draws ${g.renderer.info.render.calls} · triángulos ${g.renderer.info.render.triangles}`;
}));

// Arrancar una carrera de verdad: menú -> evento -> grilla -> largada.
await p.evaluate(() => { window.juego.empezarCarrera(1); window.juego.menu.abrir(false); });
await p.waitForTimeout(600);
const grilla = await p.evaluate(() => {
  const g = window.juego;
  return { estado: g.carrera.estado, rivales: g.carrera.rivales.length,
           vueltas: g.carrera.vueltas, cuenta: +g.carrera.cuenta.toFixed(1) };
});
console.log('\n=== LARGADA ===');
for (const [k, v] of Object.entries(grilla)) console.log('  ' + k.padEnd(9), v);

await p.waitForTimeout(4200);
const corriendo = await p.evaluate(() => ({ estado: window.juego.carrera.estado,
  puesto: window.juego.carrera.jugador.puesto,
  rivalKmh: Math.round(window.juego.carrera.rivales[0].kmh) }));
console.log('\n=== TRAS LA CUENTA ===');
for (const [k, v] of Object.entries(corriendo)) console.log('  ' + k.padEnd(9), v);

// Acelerar en recta y después frenar y doblar, para ejercitar toda la física.
await p.keyboard.down('KeyW');
await p.waitForTimeout(4500);
const rec = await p.evaluate(() => ({ kmh: +window.juego.auto.kmh.toFixed(1), marcha: window.juego.auto.marcha,
  rpm: Math.round(window.juego.auto.rpm), s: Math.round(window.juego.sActual), sup: window.juego.superficie.tipo }));
console.log('\n=== TRAS 4,5 s A FONDO ===');
for (const [k, v] of Object.entries(rec)) console.log('  ' + k.padEnd(8), v);

await p.keyboard.down('KeyD');
await p.waitForTimeout(1800);
const gir = await p.evaluate(() => {
  const a = window.juego.auto;
  return { kmh: +a.kmh.toFixed(1), gLat: +(Math.abs(a.aLat)/9.81).toFixed(2),
    derivaDel: +(a.slipL.DI*57.3).toFixed(1), cargaDelDer: Math.round(a.Fz.DD), cargaDelIzq: Math.round(a.Fz.DI),
    roll: +(a.roll*57.3).toFixed(2), ffb: +a.ffb.toFixed(2) };
});
console.log('\n=== DOBLANDO A LA DERECHA ===');
for (const [k, v] of Object.entries(gir)) console.log('  ' + k.padEnd(12), v);
await p.keyboard.up('KeyD'); await p.keyboard.up('KeyW');

const car = await p.evaluate(() => {
  const g = window.juego;
  return { puesto: g.carrera.jugador.puesto, orden: (g.carrera.orden||[]).map(o=>o.nombre).join(' '),
           puntos: Math.round(g.puntaje.total), plata: g.progreso.plata, nivel: g.progreso.nivel };
});
console.log('\n=== CARRERA EN CURSO ===');
for (const [k, v] of Object.entries(car)) console.log('  ' + k.padEnd(8), v);

const fps = await p.evaluate(() => new Promise(r => { let n = 0; const t0 = performance.now();
  const t = () => { n++; performance.now() - t0 < 3000 ? requestAnimationFrame(t) : r((n / ((performance.now()-t0)/1000)).toFixed(1)); };
  requestAnimationFrame(t); }));
console.log('\n  fps (swiftshader)', fps);
// Foto de carrera: el jugador en medio del pelotón, sobre la traza.
await p.evaluate(() => {
  const g = window.juego, a = g.auto, C = g.circuito;
  const base = C.largo * 0.42;
  const m = C.linea.en(base);
  a.x = m.x + m.nx * 1.2; a.z = m.z + m.nz * 1.2;
  a.yaw = Math.atan2(m.tx, m.tz);
  a.u = 38; a.v = 0; a.r = 0;
  a.zs = a.pitch = a.roll = a.dzs = a.dpitch = a.droll = 0;
  a.marcha = 4;
  for (const k of ['DI','DD','TI','TD']) a.w[k] = 38 / a.s.rueda;
  // Rivales adelante y al costado, para que se vea la pelea.
  g.carrera.rivales.forEach((r, i) => {
    r.colocar(base + 12 + i * 11, ((i % 2) ? 1 : -1) * 2.6);
    r.v = 37;
  });
  g.carrera.jugador.vuelta = 1;
  g.carrera.jugador.puesto = 3;
  g.puntaje.cadena = 4820; g.puntaje.mult = 3.4; g.puntaje.aviso('¡Casi!');
  g.camPos.set(0,0,0);
});
await p.waitForTimeout(800);
await p.screenshot({ path: shot });
if (errs.length) { console.log('\n=== ERRORES ===\n' + errs.join('\n')); await b.close(); process.exit(1); }
console.log('\nSIN ERRORES');
await b.close();
