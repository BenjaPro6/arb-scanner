// Empaqueta el juego en un único HTML autocontenido. Aplana los módulos ESM en
// un solo ámbito, renombrando las constantes privadas que colisionan, y trae
// Three.js por import dinámico desde un CDN con otro de respaldo.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';

const ORDEN = [
  'core/utils.js', 'core/rng.js', 'core/meshbuilder.js',
  'sim/tire.js', 'sim/vehicle.js',
  'track/spline.js', 'track/track.js', 'track/mesh.js',
  'input/wheel.js',
  'race/timing.js', 'race/piloto.js',
  'ui/hud.js', 'main.js',
];
// vehicle.js hace `import * as T from './tire.js'`: al aplanar hay que
// reconstruir ese objeto a mano.
const NAMESPACES = {
  'sim/tire.js': ['T', ['LATERAL', 'LONGITUDINAL', 'lateral', 'longitudinal', 'combinado', 'muEfectivo']],
};

const CDN = process.argv.includes('--local')
  ? ["'../vendor/three.module.js'"]
  : ["'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.160.0/three.module.min.js'",
     "'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js'"];

{
  const raiz = new URL('../src/', import.meta.url);
  const hallados = [];
  const recorrer = async (dir, pre = '') => {
    for (const e of await readdir(new URL(dir, raiz), { withFileTypes: true })) {
      if (e.isDirectory()) await recorrer(e.name + '/', pre + e.name + '/');
      else if (e.name.endsWith('.js')) hallados.push(pre + e.name);
    }
  };
  await recorrer('./');
  const faltan = hallados.filter(f => !ORDEN.includes(f));
  if (faltan.length) { console.error('Módulos fuera del bundle:\n  ' + faltan.join('\n  ')); process.exit(1); }
  const sobran = ORDEN.filter(f => !hallados.includes(f));
  if (sobran.length) { console.error('ORDEN nombra módulos inexistentes:\n  ' + sobran.join('\n  ')); process.exit(1); }
}

const partes = [];
const yaDeclarado = new Set();
for (const rel of ORDEN) {
  const src = await readFile(new URL('../src/' + rel, import.meta.url), 'utf8');
  let limpio = src.split('\n').filter(l => !/^\s*import\s/.test(l)).join('\n');
  const exportados = new Set();
  for (const m of limpio.matchAll(/^export\s+(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm))
    exportados.add(m[1]);
  limpio = limpio.replace(/^export\s+(?=(const|let|var|function|class)\b)/gm, '');
  const declarados = new Set();
  for (const m of limpio.matchAll(/^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm))
    declarados.add(m[1]);
  const tag = '_' + rel.replace(/[^a-z]/gi, '').slice(-9);
  for (const nombre of declarados) {
    if (exportados.has(nombre)) { yaDeclarado.add(nombre); continue; }
    if (!yaDeclarado.has(nombre)) { yaDeclarado.add(nombre); continue; }
    limpio = limpio.replace(new RegExp('\\b' + nombre + '\\b', 'g'), nombre + tag);
    yaDeclarado.add(nombre + tag);
    console.log(`  renombrado por colisión: ${nombre} -> ${nombre}${tag}  (${rel})`);
  }
  partes.push(`// ===== ${rel} =====\n${limpio.trim()}`);
  const ns = NAMESPACES[rel];
  if (ns) partes.push(`const ${ns[0]} = { ${ns[1].join(', ')} };`);
}

const cuerpo = partes.join('\n\n');
const sueltos = cuerpo.split('\n').filter(l => /^\s*export\s/.test(l));
if (sueltos.length) { console.error('Exports sin aplanar:\n' + sueltos.join('\n')); process.exit(1); }

const carga = CDN.length === 1
  ? `const THREE = await import(${CDN[0]});`
  : `let THREE;\ntry { THREE = await import(${CDN[0]}); }\ncatch (e) { THREE = await import(${CDN[1]}); }`;

const esLocal = process.argv.includes('--local');
const html = (esLocal ? '<!doctype html>\n<html lang="es"><head><meta charset="utf-8">\n<link rel="icon" href="data:,">\n' : '') + `<title>Trazada</title>
<style>
  html,body{margin:0;height:100%;background:#0e1218;overflow:hidden;
    font:500 14px/1.4 ui-sans-serif,system-ui,'Segoe UI',Roboto,sans-serif;color:#eef1f5}
  canvas{display:block}
  #splash{position:fixed;inset:0;z-index:50;display:grid;place-content:center;text-align:center;gap:14px;
    background:radial-gradient(ellipse at 50% 38%,#1d2a3a,#080b10 72%);transition:opacity .6s}
  #splash.listo{opacity:0;pointer-events:none}
  #splash h1{margin:0;font-size:clamp(36px,8vw,62px);font-weight:800;letter-spacing:-2.5px;
    background:linear-gradient(180deg,#ffd88a,#e0913a);-webkit-background-clip:text;background-clip:text;color:transparent}
  #splash p{margin:0;opacity:.62;max-width:450px;padding:0 20px}
  .barra{width:280px;height:3px;background:rgba(255,255,255,.12);border-radius:2px;overflow:hidden;margin:0 auto}
  .barra i{display:block;height:100%;width:35%;background:#ffc447;animation:l 1.1s ease-in-out infinite}
  @keyframes l{0%{transform:translateX(-100%)}100%{transform:translateX(320%)}}
  #foco{position:fixed;inset:0;z-index:60;display:grid;place-content:center;text-align:center;gap:10px;
    background:rgba(6,9,15,.72);cursor:pointer;transition:opacity .3s}
  #foco.oculto{opacity:0;pointer-events:none}
  #foco b{font-size:22px;font-weight:750}
  #foco span{opacity:.62;font-size:13px;max-width:430px;padding:0 20px}
</style>

<div id="splash">
  <h1>TRAZADA</h1>
  <p>Simulador de circuito con física de neumático real. Volante o teclado.</p>
  <div class="barra"><i></i></div>
  <div id="carga">Arrancando…</div>
</div>
<div id="foco" class="oculto">
  <b>Hacé clic para manejar</b>
  <span>W A S D con teclado. Si tenés volante conectado, apretá <b>C</b> y movelo de tope a tope y pisá los pedales para calibrarlo.</span>
</div>

<script type="module">
${carga}

${cuerpo}

{
  const foco = document.getElementById('foco');
  const arrancar = () => { window.focus(); foco.classList.add('oculto'); };
  foco.addEventListener('click', arrancar);
  addEventListener('keydown', () => foco.classList.add('oculto'), { once: true });
  const esperar = setInterval(() => {
    if (window.juego && window.juego.auto) { clearInterval(esperar); foco.classList.remove('oculto'); }
  }, 250);
}
</script>
` + (esLocal ? '</body></html>' : '');

await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
const salida = esLocal ? '../dist/local.html' : '../dist/trazada.html';
await writeFile(new URL(salida, import.meta.url), html);
console.log(`escrito ${salida.replace('../','')}  ${(html.length/1024).toFixed(0)} KB  (${ORDEN.length} módulos)`);
