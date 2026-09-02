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
try { await p.waitForFunction(() => window.juego && window.juego.auto, null, { timeout: 120000 }); }
catch (_) { errs.push('TIMEOUT esperando el arranque'); }
console.log('carga:', JSON.stringify(await p.evaluate(() => document.getElementById('carga')?.textContent)));
if (errs.length) { console.log('\n=== ERRORES ===\n' + errs.join('\n')); await b.close(); process.exit(1); }

await p.waitForTimeout(1500);
console.log('\n=== CIRCUITO ===');
console.log(await p.evaluate(() => {
  const g = window.juego;
  return `  largo ${(g.circuito.largo/1000).toFixed(2)} km · draws ${g.renderer.info.render.calls} · triángulos ${g.renderer.info.render.triangles}`;
}));

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

const fps = await p.evaluate(() => new Promise(r => { let n = 0; const t0 = performance.now();
  const t = () => { n++; performance.now() - t0 < 3000 ? requestAnimationFrame(t) : r((n / ((performance.now()-t0)/1000)).toFixed(1)); };
  requestAnimationFrame(t); }));
console.log('\n  fps (swiftshader)', fps);
// Foto en pista: el test maneja recto y se va al pasto, así que para la
// captura se coloca el auto sobre la traza a velocidad de carrera.
await p.evaluate(() => {
  const g = window.juego, a = g.auto;
  const m = g.circuito.linea.en(g.circuito.largo * 0.42);
  a.x = m.x; a.z = m.z; a.yaw = Math.atan2(m.tx, m.tz);
  a.u = 39; a.v = 0; a.r = 0;
  a.zs = a.pitch = a.roll = a.dzs = a.dpitch = a.droll = 0;
  a.marcha = 4;
  for (const k of ['DI','DD','TI','TD']) a.w[k] = 39 / 0.315;
  g.camPos.set(0,0,0);
});
await p.waitForTimeout(700);
await p.screenshot({ path: shot });
if (errs.length) { console.log('\n=== ERRORES ===\n' + errs.join('\n')); await b.close(); process.exit(1); }
console.log('\nSIN ERRORES');
await b.close();
