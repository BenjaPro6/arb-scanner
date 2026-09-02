import { pesos } from '../core/utils.js';

const CSS = `
#hud{position:fixed;inset:0;pointer-events:none;font:500 13px/1.35 ui-sans-serif,system-ui,'Segoe UI',Roboto,sans-serif;color:#f2efe8;text-shadow:0 1px 3px rgba(0,0,0,.85)}
#hud .panel{position:absolute;background:rgba(10,12,16,.52);backdrop-filter:blur(7px);border:1px solid rgba(255,255,255,.10);border-radius:10px;padding:10px 12px}
#guita{top:14px;left:14px;min-width:210px}
#guita .row{display:flex;justify-content:space-between;gap:18px;margin:2px 0}
#guita .k{opacity:.62;font-weight:400}
#guita .v{font-variant-numeric:tabular-nums;font-weight:650}
#guita .usd{color:#6fe3a0}
#guita .bad{color:#ff7d6b}
#guita hr{border:0;border-top:1px solid rgba(255,255,255,.12);margin:7px 0}
#infl{height:3px;background:rgba(255,255,255,.13);border-radius:2px;overflow:hidden;margin-top:6px}
#infl i{display:block;height:100%;background:linear-gradient(90deg,#ffb020,#ff5470);width:0%}
#estrellas{top:14px;right:14px;text-align:right;font-size:20px;letter-spacing:3px;padding:6px 12px;min-width:120px}
#estrellas .off{opacity:.16}
#mapa{top:64px;right:14px;padding:6px;line-height:0}
#velo{bottom:16px;right:14px;text-align:right;min-width:150px}
#velo .kmh{font-size:34px;font-weight:750;font-variant-numeric:tabular-nums;line-height:1}
#velo .kmh span{font-size:12px;font-weight:500;opacity:.6;margin-left:4px}
#velo .auto{opacity:.7;font-size:12px;margin-bottom:4px}
#dano{height:4px;background:rgba(255,255,255,.14);border-radius:2px;margin-top:8px;overflow:hidden}
#dano i{display:block;height:100%;background:#6fe3a0;width:100%}
#mision{bottom:16px;left:50%;transform:translateX(-50%);text-align:center;max-width:520px}
#mision .t{font-weight:700;font-size:14px}
#aviso{bottom:74px;left:50%;transform:translateX(-50%);text-align:center;max-width:560px;font-size:14px;opacity:0;transition:opacity .25s;background:rgba(10,12,16,.7)}
#objetivo{position:absolute;bottom:104px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:10px;padding:8px 14px}
#objetivo svg{display:block}
#objetivo .d{font-variant-numeric:tabular-nums;font-weight:700}
#objetivo .q{opacity:.6;font-size:12px}
#arma{position:absolute;bottom:112px;right:14px;text-align:right;padding:8px 12px;display:none}
#arma .m{font-size:22px;font-weight:750;font-variant-numeric:tabular-nums}
#arma .m i{font-style:normal;opacity:.5;font-size:14px}
#preso{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center;padding:14px 22px;display:none}
#preso b{font-size:18px;letter-spacing:1px}
#preso .b{height:5px;width:200px;background:rgba(255,255,255,.18);border-radius:3px;margin-top:8px;overflow:hidden}
#preso .b i{display:block;height:100%;background:#ff5470;width:0%}
#ayuda{position:absolute;bottom:16px;left:14px;background:rgba(10,12,16,.42);border-radius:8px;padding:9px 12px;font-size:11px;opacity:.6;max-width:350px;line-height:1.75}
#reloj{top:14px;left:50%;transform:translateX(-50%);font-variant-numeric:tabular-nums;opacity:.85}
kbd{background:rgba(255,255,255,.14);border-radius:3px;padding:1px 4px;font:inherit;font-size:10px}
`;

export class Hud {
  constructor() {
    const style = document.createElement('style');
    style.textContent = CSS; document.head.appendChild(style);
    const root = document.createElement('div'); root.id = 'hud';
    root.innerHTML = `
      <div class="panel" id="guita">
        <div class="row"><span class="k">Pesos</span><span class="v" id="v-pesos">$0</span></div>
        <div class="row"><span class="k">Dólares</span><span class="v usd" id="v-usd">US$0</span></div>
        <hr>
        <div class="row"><span class="k">Poder adquisitivo</span><span class="v" id="v-poder">$0</span></div>
        <div class="row"><span class="k">Blue</span><span class="v" id="v-blue">$0</span></div>
        <div class="row"><span class="k">Precios</span><span class="v bad" id="v-ipc">+0%</span></div>
        <div id="infl"><i id="v-inflbar"></i></div>
      </div>
      <div class="panel" id="reloj"><span id="v-hora">00:00</span></div>
      <div class="panel" id="estrellas"><span id="v-stars"></span></div>
      <div class="panel" id="mapa"><canvas id="minimapa" width="190" height="190"></canvas></div>
      <div class="panel" id="velo">
        <div class="auto" id="v-auto">A pie</div>
        <div class="kmh"><span id="v-kmh">0</span><span>km/h</span></div>
        <div id="dano"><i id="v-dano"></i></div>
      </div>
      <div class="panel" id="mision" style="display:none"><div class="t" id="v-mision"></div></div>
      <div class="panel" id="aviso"><span id="v-aviso"></span></div>
      <div class="panel" id="objetivo">
        <svg width="22" height="22" viewBox="-11 -11 22 22" id="v-flecha">
          <path d="M0 -9 L6 7 L0 3.4 L-6 7 Z" fill="#ffb020"></path>
        </svg>
        <div><div class="d" id="v-dist">—</div><div class="q" id="v-que">—</div></div>
      </div>
      <div class="panel" id="arma">
        <div class="q" id="v-arma">Pistola</div>
        <div class="m"><span id="v-cargador">0</span><i>/<span id="v-balas">0</span></i></div>
      </div>
      <div class="panel" id="preso"><b id="v-preso">TE ESTÁN POR AGARRAR</b><div class="b"><i id="v-presobar"></i></div></div>
      <div id="ayuda">
        <kbd>Mouse</kbd> mirar · <kbd>W A S D</kbd> caminar y manejar<br>
        <kbd>Espacio</kbd> freno de mano · <kbd>F</kbd> subir / bajar · <kbd>Shift</kbd> correr<br>
        <kbd>Clic izq</kbd> disparar · <kbd>Rueda</kbd> acercar · <kbd>Q</kbd> <kbd>E</kbd> cámara<br>
        Naranja = laburo · Verde = cueva · Azul = taller · Rojo = armería<br>
        Seguí la flecha naranja para agarrar la primera changa.
      </div>`;
    document.body.appendChild(root);
    this.el = (id) => document.getElementById(id);
    this.canvas = this.el('minimapa');
    this.ctx = this.canvas.getContext('2d');
  }

  update(g) {
    const e = g.economy;
    this.el('v-pesos').textContent = pesos(e.pesos);
    this.el('v-usd').textContent = 'US$' + e.usd.toFixed(0);
    this.el('v-poder').textContent = pesos(e.power);
    this.el('v-blue').textContent = pesos(e.blue);
    const ipc = (e.priceIndex - 1) * 100;
    this.el('v-ipc').textContent = '+' + ipc.toFixed(0) + '%';
    this.el('v-inflbar').style.width = Math.min(100, ipc / 4) + '%';

    const s = g.police.wanted();
    let stars = '';
    for (let i = 0; i < 5; i++) stars += i < s ? '★' : '<span class="off">★</span>';
    this.el('v-stars').innerHTML = stars;

    const h = Math.floor(g.hour), m = Math.floor((g.hour % 1) * 60);
    this.el('v-hora').textContent = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');

    const drive = g.player.mode === 'drive';
    this.el('v-auto').textContent = drive ? g.player.car.spec.name : 'A pie';
    this.el('v-kmh').textContent = Math.round(drive ? g.player.car.kmh : g.player.speed * 3.6);
    const dmg = drive ? 100 - g.player.car.damage : g.player.health;
    const bar = this.el('v-dano');
    bar.style.width = Math.max(0, dmg) + '%';
    bar.style.background = dmg > 60 ? '#6fe3a0' : dmg > 25 ? '#ffb020' : '#ff5470';

    // Flecha al objetivo. Sin esto las misiones eran invisibles: el marcador
    // caía en cualquier lado del mapa y no había forma de saber para dónde ir.
    const obj = g.missions.current && g.meta.mesh.visible ? g.meta : g.places.laburo;
    const oq = g.missions.current ? g.missions.current.def.title : 'Laburo';
    const dx = obj.x - g.player.pos.x, dz = obj.z - g.player.pos.z;
    const dist = Math.hypot(dx, dz);
    const rel = Math.atan2(dx, dz) - g.player.camYaw;
    this.el('v-flecha').style.transform = `rotate(${(-rel * 180 / Math.PI)}deg)`;
    this.el('v-dist').textContent = dist > 999 ? (dist / 1000).toFixed(2) + ' km' : Math.round(dist) + ' m';
    this.el('v-que').textContent = oq;

    const arma = this.el('arma');
    arma.style.display = g.weapons.armado && g.player.mode === 'foot' ? 'block' : 'none';
    if (g.weapons.armado) {
      this.el('v-cargador').textContent = g.weapons.enCargador;
      this.el('v-balas').textContent = g.weapons.balas;
    }

    const preso = this.el('preso');
    const pb = g.police.busted;
    preso.style.display = pb > 0.35 ? 'block' : 'none';
    if (pb > 0.35) this.el('v-presobar').style.width = Math.min(100, (pb / 2.2) * 100) + '%';

    const line = g.missions.hudLine();
    const mi = this.el('mision');
    mi.style.display = line ? 'block' : 'none';
    if (line) this.el('v-mision').textContent = line;

    const av = this.el('aviso');
    av.style.opacity = g.missions.toastT > 0 ? '1' : '0';
    if (g.missions.toastT > 0) this.el('v-aviso').textContent = g.missions.toast;

    this.drawMap(g);
  }

  // Minimapa rotado: el norte del mapa es hacia dónde mirás vos.
  drawMap(g) {
    const c = this.ctx, W = 190, R = 95, scale = 0.16;   // 1px ≈ 6m
    c.clearRect(0, 0, W, W);
    c.save();
    c.beginPath(); c.arc(R, R, R - 1, 0, Math.PI * 2); c.clip();
    c.fillStyle = '#14161b'; c.fillRect(0, 0, W, W);

    const p = g.player.pos;
    const rot = -g.player.camYaw;
    const range = (R / scale);
    const tf = (x, z) => {
      const dx = (x - p.x) * scale, dz = (z - p.z) * scale;
      return [R + dx * Math.cos(rot) - dz * Math.sin(rot), R + dx * Math.sin(rot) + dz * Math.cos(rot)];
    };

    // manzanas
    c.fillStyle = '#22252c';
    for (const b of g.city.blocks) {
      if (Math.abs(b.cx - p.x) > range || Math.abs(b.cz - p.z) > range) continue;
      const pts = [[b.x0, b.z0], [b.x1, b.z0], [b.x1, b.z1], [b.x0, b.z1]].map(([x, z]) => tf(x, z));
      c.fillStyle = b.kind === 'parque' || b.kind === 'cancha' ? '#25361f' : '#22252c';
      c.beginPath(); c.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < 4; i++) c.lineTo(pts[i][0], pts[i][1]);
      c.closePath(); c.fill();
    }
    // avenidas resaltadas
    for (const e of g.roads.edges) {
      const A = g.roads.nodes[e.a], B = g.roads.nodes[e.b];
      if (Math.abs((A.x + B.x) / 2 - p.x) > range + 120 || Math.abs((A.z + B.z) / 2 - p.z) > range + 120) continue;
      const a = tf(A.x, A.z), b = tf(B.x, B.z);
      c.strokeStyle = g.roads.isBlocked(e) ? '#c0392b' : e.big ? '#454b58' : '#31353e';
      c.lineWidth = e.big ? 3 : 1.4;
      c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke();
    }
    // marcadores
    for (const pl of g.places.list) {
      if (!pl.mesh.visible) continue;
      const [x, y] = tf(pl.x, pl.z);
      c.fillStyle = '#' + pl.color.toString(16).padStart(6, '0');
      c.beginPath(); c.arc(x, y, 3.4, 0, Math.PI * 2); c.fill();
    }
    // canas
    c.fillStyle = '#ff4a3d';
    for (const u of g.police.units) {
      if (!u.active) continue;
      const [x, y] = tf(u.car.x, u.car.z);
      c.beginPath(); c.arc(x, y, 2.6, 0, Math.PI * 2); c.fill();
    }
    c.restore();

    // el jugador siempre mirando arriba
    c.fillStyle = '#ffffff';
    c.beginPath(); c.moveTo(R, R - 6); c.lineTo(R - 4.5, R + 5); c.lineTo(R + 4.5, R + 5);
    c.closePath(); c.fill();
    c.strokeStyle = 'rgba(255,255,255,.18)'; c.lineWidth = 1;
    c.beginPath(); c.arc(R, R, R - 1, 0, Math.PI * 2); c.stroke();
  }
}
