// Empaqueta el juego en un único archivo HTML autocontenido, para poder
// abrirlo de un click sin servidor ni instalación.
//
// Los módulos ESM se concatenan en un solo ámbito: se borran las líneas de
// import y el prefijo export. Three.js se trae por import dinámico desde un
// CDN, con un segundo CDN de respaldo.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';

const ORDEN = [
  'core/config.js', 'core/rng.js', 'core/utils.js', 'core/input.js', 'core/audio.js',
  'world/meshbuilder.js', 'world/textures.js', 'world/city.js', 'world/roads.js', 'world/render.js',
  'vehicles/catalog.js', 'vehicles/model.js', 'vehicles/physics.js', 'vehicles/traffic.js',
  'actors/human.js', 'actors/peds.js', 'actors/player.js',
  'systems/economy.js', 'systems/places.js', 'systems/weapons.js', 'systems/missions.js',
  'systems/police.js',
  'ui/hud.js', 'main.js',
];

// render.js hace `import * as TX from './textures.js'`; al aplanar todo en un
// solo ámbito hay que reconstruir ese objeto a mano.
const NAMESPACES = {
  'world/textures.js': ['TX', ['facade', 'shopfront', 'flat', 'asphalt', 'sidewalk', 'grass', 'WIN_U', 'WIN_V']],
};

const CDN = process.argv.includes('--local')
  ? ["'../vendor/three.module.js'"]
  : ["'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.160.0/three.module.min.js'",
     "'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js'"];

// Si alguien agrega un módulo y se olvida de ponerlo acá, el bundle salía sin
// él y sólo fallaba al abrirlo. Ahora se aborta con el nombre del que falta.
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
  if (faltan.length) {
    console.error('Módulos que no están en ORDEN y quedarían afuera del bundle:\n  ' + faltan.join('\n  '));
    process.exit(1);
  }
  const sobran = ORDEN.filter(f => !hallados.includes(f));
  if (sobran.length) { console.error('ORDEN nombra módulos que no existen:\n  ' + sobran.join('\n  ')); process.exit(1); }
}

const partes = [];
const yaDeclarado = new Set();   // nombres ya tomados en el ámbito común
let renombrados = 0;

for (const rel of ORDEN) {
  const src = await readFile(new URL('../src/' + rel, import.meta.url), 'utf8');
  let limpio = src
    .split('\n')
    .filter(l => !/^\s*import\s/.test(l))
    .join('\n');

  // Qué exporta el módulo: esos nombres son públicos y no se tocan.
  const exportados = new Set();
  for (const m of limpio.matchAll(/^export\s+(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm))
    exportados.add(m[1]);

  limpio = limpio.replace(/^export\s+(?=(const|let|var|function|class)\b)/gm, '');

  // Aplanar todo en un ámbito hace que dos módulos con la misma constante
  // privada choquen. Se renombra la segunda, no la exportada.
  const declarados = new Set();
  for (const m of limpio.matchAll(/^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm))
    declarados.add(m[1]);

  const tag = '_' + rel.replace(/[^a-z]/gi, '').slice(-8);
  for (const nombre of declarados) {
    if (exportados.has(nombre)) { yaDeclarado.add(nombre); continue; }
    if (!yaDeclarado.has(nombre)) { yaDeclarado.add(nombre); continue; }
    limpio = limpio.replace(new RegExp('\\b' + nombre + '\\b', 'g'), nombre + tag);
    yaDeclarado.add(nombre + tag);
    renombrados++;
    console.log(`  renombrado por colisión: ${nombre} -> ${nombre}${tag}  (${rel})`);
  }

  partes.push(`// ===== ${rel} =====\n${limpio.trim()}`);
  const ns = NAMESPACES[rel];
  if (ns) partes.push(`const ${ns[0]} = { ${ns[1].join(', ')} };`);
}

// Nadie puede quedar con un `export` suelto: rompería el bundle en silencio.
const cuerpo = partes.join('\n\n');
const sueltos = cuerpo.split('\n').filter(l => /^\s*export\s/.test(l));
if (sueltos.length) {
  console.error('Quedaron exports sin aplanar:\n' + sueltos.join('\n'));
  process.exit(1);
}

const carga = CDN.length === 1
  ? `const THREE = await import(${CDN[0]});`
  : `let THREE;
try { THREE = await import(${CDN[0]}); }
catch (e) { THREE = await import(${CDN[1]}); }`;

const esLocal = process.argv.includes('--local');
const html = (esLocal ? '<!doctype html>\n<html lang="es"><head><meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n' : '') + `<title>Sudestada</title>
<style>
  html,body{margin:0;height:100%;background:#0d1220;overflow:hidden;
    font:500 14px/1.4 ui-sans-serif,system-ui,'Segoe UI',Roboto,sans-serif;color:#f2efe8}
  canvas{display:block}
  #splash{position:fixed;inset:0;z-index:50;display:grid;place-content:center;text-align:center;
    background:radial-gradient(ellipse at 50% 40%,#1c2942,#080b12 70%);gap:14px;transition:opacity .6s}
  #splash.listo{opacity:0;pointer-events:none}
  #splash h1{margin:0;font-size:clamp(34px,7vw,58px);font-weight:800;letter-spacing:-2px;
    background:linear-gradient(180deg,#9fd8ff,#6ba7d8);-webkit-background-clip:text;background-clip:text;color:transparent}
  #splash p{margin:0;opacity:.62;max-width:430px;padding:0 20px}
  #carga{opacity:.85;font-variant-numeric:tabular-nums;min-height:1.4em}
  .barra{width:280px;height:3px;background:rgba(255,255,255,.12);border-radius:2px;overflow:hidden;margin:0 auto}
  .barra i{display:block;height:100%;width:35%;background:#6fe3a0;animation:l 1.1s ease-in-out infinite}
  @keyframes l{0%{transform:translateX(-100%)}100%{transform:translateX(320%)}}
  #foco{position:fixed;inset:0;z-index:60;display:grid;place-content:center;text-align:center;gap:10px;
    background:rgba(6,9,15,.72);backdrop-filter:blur(3px);cursor:pointer;transition:opacity .3s}
  #foco.oculto{opacity:0;pointer-events:none}
  #foco b{font-size:22px;font-weight:750}
  #foco span{opacity:.6;font-size:13px}
</style>

<div id="splash">
  <h1>SUDESTADA</h1>
  <p>Buenos Aires, 3&nbsp;km². Manejá, robá, y cambiá los pesos antes de que se derritan.</p>
  <div class="barra"><i></i></div>
  <div id="carga">Arrancando…</div>
</div>

<div id="foco" class="oculto">
  <b>Hacé clic para jugar</b>
  <span>W A S D manejar · Espacio freno de mano · F subir/bajar del auto · Shift correr</span>
</div>

<script type="module">
${carga}

${cuerpo}

// El juego vive dentro de un iframe: sin un clic no recibe el teclado.
{
  const foco = document.getElementById('foco');
  const listo = () => {
    foco.classList.remove('oculto');
  };
  const arrancar = () => { window.focus(); foco.classList.add('oculto'); };
  foco.addEventListener('click', arrancar);
  addEventListener('keydown', () => foco.classList.add('oculto'), { once: true });
  const esperar = setInterval(() => {
    if (window.game && window.game.player) { clearInterval(esperar); listo(); }
  }, 250);
}
</script>
` + (esLocal ? '</body></html>' : '');

await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
const salida = esLocal ? '../dist/local.html' : '../dist/sudestada.html';
await writeFile(new URL(salida, import.meta.url), html);
console.log(`escrito ${salida.replace('../','')}  ${(html.length / 1024).toFixed(0)} KB  (${ORDEN.length} módulos)`);
