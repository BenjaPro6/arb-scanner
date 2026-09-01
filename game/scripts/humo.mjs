import { chromium } from 'playwright';

const url = process.argv[2] || 'http://127.0.0.1:8123/';
const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--no-sandbox'],
});
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
p.on('console', m => { if (m.type() === 'error' && !m.text().includes('favicon')) errs.push('CONSOLE: ' + m.text()); });
p.on('pageerror', e => errs.push('PAGEERROR: ' + e.message + '\n' + (e.stack||'').split('\n').slice(0,4).join('\n')));

await p.goto(url, { waitUntil: 'load' });
// Espero a que el juego termine de generar la ciudad.
try {
  await p.waitForFunction(() => window.game && window.game.player, null, { timeout: 120000 });
} catch (e) { errs.push('TIMEOUT esperando el arranque'); }

const boot = await p.evaluate(() => document.getElementById('carga')?.textContent);
console.log('estado de carga:', JSON.stringify(boot));

if (errs.length) { console.log('\n=== ERRORES ===\n' + errs.join('\n')); await b.close(); process.exit(1); }

// Dejo correr y mido.
await p.waitForTimeout(2500);
const stats = await p.evaluate(() => {
  const g = window.game;
  return {
    manzanas: g.city.blocks.length,
    tramos: g.roads.edges.length,
    draws: g.renderer.info.render.calls,
    triangulos: g.renderer.info.render.triangles,
    texturas: g.renderer.info.memory.textures,
    geometrias: g.renderer.info.memory.geometries,
    traficoActivo: g.traffic.cars.filter(c => c.active).length,
    peatonesActivos: g.peds.list.filter(x => x.active).length,
    hora: g.hour.toFixed(2),
    pesos: Math.round(g.economy.pesos),
    ipc: ((g.economy.priceIndex - 1) * 100).toFixed(1) + '%',
  };
});
console.log('\n=== ESTADO ===');
for (const [k, v] of Object.entries(stats)) console.log('  ' + k.padEnd(16), v);

// Mido FPS reales sobre 3 segundos.
const fps = await p.evaluate(() => new Promise(res => {
  let n = 0; const t0 = performance.now();
  const tick = () => { n++; if (performance.now() - t0 < 3000) requestAnimationFrame(tick); else res((n / ((performance.now()-t0)/1000)).toFixed(1)); };
  requestAnimationFrame(tick);
}));
console.log('  fps (swiftshader)', fps);

// Manejo un rato: acelerar y doblar, para ejercitar física, tráfico y policía.
await p.evaluate(() => { window.game.player.enterCooldown = 0; window.game.pendingUse = true; });
await p.waitForTimeout(300);
const enAuto = await p.evaluate(() => window.game.player.mode);
console.log('  tras apretar F   ', enAuto);

await p.keyboard.down('KeyW');
await p.waitForTimeout(2600);
await p.keyboard.down('KeyD');
await p.waitForTimeout(1400);
await p.keyboard.up('KeyD');
await p.waitForTimeout(1600);
await p.keyboard.up('KeyW');

const drive = await p.evaluate(() => {
  const g = window.game;
  return {
    modo: g.player.mode,
    kmh: g.player.mode === 'drive' ? +g.player.car.kmh.toFixed(1) : 0,
    daño: g.player.mode === 'drive' ? +g.player.car.damage.toFixed(0) : 0,
    estrellas: g.police.wanted(),
    canasActivas: g.police.units.filter(u => u.active).length,
    misionActiva: g.missions.current?.def.id || 'ninguna',
  };
});
const cam = await p.evaluate(() => {
  const g = window.game, c = g.camera, q = g.player.pos;
  return { camY: +c.position.y.toFixed(2), dist: +Math.hypot(c.position.x-q.x, c.position.z-q.z).toFixed(2),
           camDist: +g.player.camDist.toFixed(2), camHeight: +g.player.camHeight.toFixed(2) };
});
console.log('\n=== CAMARA ===');
for (const [k,v] of Object.entries(cam)) console.log('  ' + k.padEnd(16), v);
console.log('\n=== TRAS MANEJAR 5s ===');
for (const [k, v] of Object.entries(drive)) console.log('  ' + k.padEnd(16), v);

const shot = process.argv[3] || '/tmp/shot.png';
await p.screenshot({ path: shot });
// Segunda foto de día, que es donde se ve el arte de las fachadas.
await p.evaluate(() => { window.game.hour = 12.5; });
await p.waitForTimeout(900);
await p.screenshot({ path: shot.replace('.png', '-dia.png') });
// Tercera foto: bajarse del auto, para ver el modelo del vehículo y el del personaje.
await p.evaluate(() => { window.game.player.enterCooldown = 0; window.game.pendingUse = true; });
await p.waitForTimeout(1200);
const modo = await p.evaluate(() => window.game.player.mode);
await p.screenshot({ path: shot.replace('.png', '-pie.png') });
console.log('capturas:', shot, '| -dia | -pie (modo:', modo + ')');
if (errs.length) { console.log('\n=== ERRORES ===\n' + errs.join('\n')); await b.close(); process.exit(1); }
console.log('\nSIN ERRORES');
await b.close();
