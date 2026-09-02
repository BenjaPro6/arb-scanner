import { reloj } from '../race/timing.js';

const CSS = `
#hud{position:fixed;inset:0;pointer-events:none;color:#eef1f5;
  font:500 13px/1.35 ui-sans-serif,system-ui,'Segoe UI',Roboto,sans-serif;
  text-shadow:0 1px 3px rgba(0,0,0,.8)}
#hud .p{position:absolute;background:rgba(10,13,18,.55);backdrop-filter:blur(7px);
  border:1px solid rgba(255,255,255,.10);border-radius:10px;padding:10px 13px}
#tiempos{top:14px;left:14px;min-width:210px}
#tiempos .f{display:flex;justify-content:space-between;gap:16px;margin:2px 0}
#tiempos .k{opacity:.6;font-weight:400}
#tiempos .v{font-variant-numeric:tabular-nums;font-weight:650}
#tiempos .act{font-size:24px;font-weight:750;letter-spacing:-.5px}
#tiempos .rec{color:#b98cff}
#tacho{bottom:16px;right:16px;text-align:right;min-width:230px}
#tacho .vel{font-size:52px;font-weight:800;line-height:.95;font-variant-numeric:tabular-nums}
#tacho .vel i{font-style:normal;font-size:13px;font-weight:500;opacity:.55;margin-left:5px}
#tacho .marcha{font-size:34px;font-weight:800;color:#ffc447}
#tacho .rpm{height:7px;background:rgba(255,255,255,.13);border-radius:4px;overflow:hidden;margin-top:7px}
#tacho .rpm i{display:block;height:100%;width:0%;background:linear-gradient(90deg,#5ad1a0,#ffc447 72%,#ff4d4d 92%)}
#gomas{bottom:16px;left:16px;display:grid;grid-template-columns:52px 52px;gap:6px;padding:11px}
#gomas b{display:block;height:34px;border-radius:5px;background:#2a2f38;position:relative;overflow:hidden}
#gomas b i{position:absolute;inset:auto 0 0 0;display:block;background:#5ad1a0}
#gomas .rot{grid-column:1 / span 2;text-align:center;font-size:10px;opacity:.55;letter-spacing:.6px}
#mapa{top:14px;right:14px;padding:8px;line-height:0}
#aviso{top:22%;left:50%;transform:translate(-50%,-50%);text-align:center;font-size:19px;
  font-weight:700;opacity:0;transition:opacity .25s;padding:12px 22px}
#volante{bottom:16px;left:50%;transform:translateX(-50%);font-size:11px;opacity:.75;text-align:center}
#volante .b{width:210px;height:5px;background:rgba(255,255,255,.14);border-radius:3px;margin:5px auto 0;position:relative}
#volante .b i{position:absolute;top:-3px;width:3px;height:11px;background:#ffc447;border-radius:2px;left:50%}
#carrera{top:14px;left:50%;transform:translateX(-50%);text-align:center;padding:9px 18px;display:none}
#carrera.on{display:block}
#carrera .pos{font-size:30px;font-weight:800;line-height:1}
#carrera .pos i{font-style:normal;font-size:14px;opacity:.55;font-weight:600}
#carrera .vta{opacity:.65;font-size:12px;margin-top:2px;font-variant-numeric:tabular-nums}
#cuenta{top:34%;left:50%;transform:translate(-50%,-50%);font-size:92px;font-weight:900;
  color:#ffc447;display:none;padding:0;background:none;border:none;text-shadow:0 4px 24px rgba(0,0,0,.7)}
#cuenta.on{display:block}
#tabla{top:190px;left:14px;min-width:200px;display:none;padding:9px 11px}
#tabla.on{display:block}
#tabla .r{display:flex;gap:9px;font-size:12px;padding:2px 0;font-variant-numeric:tabular-nums}
#tabla .r.yo{color:#ffc447;font-weight:700}
#tabla .r .n{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#cadena{bottom:214px;right:16px;text-align:right;display:none;padding:9px 13px;min-width:132px}
#cadena.on{display:block}
#cadena .pts{font-size:26px;font-weight:800;font-variant-numeric:tabular-nums;color:#ffc447;line-height:1.1}
#cadena .m{font-size:13px;opacity:.75}
#cadena .q{font-size:11px;opacity:.6;margin-top:3px}
#ayuda{position:absolute;top:14px;left:50%;transform:translateX(-50%);font-size:11px;opacity:.5}
kbd{background:rgba(255,255,255,.14);border-radius:3px;padding:1px 5px;font:inherit;font-size:10px}
`;

export class Hud {
  constructor() {
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    const r = document.createElement('div'); r.id = 'hud';
    r.innerHTML = `
      <div class="p" id="tiempos">
        <div class="act" id="v-act">0:00.000</div>
        <div class="f"><span class="k">Mejor</span><span class="v rec" id="v-mejor">--:--.---</span></div>
        <div class="f"><span class="k">Última</span><span class="v" id="v-ult">--:--.---</span></div>
        <div class="f"><span class="k">Vuelta</span><span class="v" id="v-vta">1</span></div>
      </div>
      <div class="p" id="tacho">
        <div><span class="marcha" id="v-marcha">1</span></div>
        <div class="vel"><span id="v-kmh">0</span><i>km/h</i></div>
        <div class="rpm"><i id="v-rpm"></i></div>
      </div>
      <div class="p" id="gomas">
        <b><i id="v-DI"></i></b><b><i id="v-DD"></i></b>
        <b><i id="v-TI"></i></b><b><i id="v-TD"></i></b>
        <div class="rot">CARGA POR RUEDA</div>
      </div>
      <div class="p" id="mapa"><canvas id="v-mapa" width="190" height="190"></canvas></div>
      <div class="p" id="aviso"><span id="v-aviso"></span></div>
      <div class="p" id="carrera">
        <div class="pos"><span id="v-pos">1</span><i>/<span id="v-total">6</span></i></div>
        <div class="vta">VUELTA <span id="v-lap">1</span>/<span id="v-laps">3</span></div>
      </div>
      <div id="cuenta"><span id="v-cuenta">3</span></div>
      <div class="p" id="tabla"><div id="v-tabla"></div></div>
      <div class="p" id="cadena">
        <div class="pts" id="v-cad">0</div>
        <div class="m">x<span id="v-mult">1.0</span></div>
        <div class="q" id="v-quehizo"></div>
      </div>
      <div class="p" id="volante">
        <span id="v-vol">Teclado</span>
        <div class="b"><i id="v-volpos"></i></div>
      </div>
      <div id="ayuda"><kbd>Tab</kbd> menú y garage · <kbd>W A S D</kbd> manejar · <kbd>R</kbd> volver a pista · <kbd>C</kbd> calibrar volante</div>`;
    document.body.appendChild(r);
    this.el = (id) => document.getElementById(id);
    this.ctx = this.el('v-mapa').getContext('2d');
  }

  update(g) {
    const v = g.auto, t = g.timing;
    this.el('v-act').textContent = reloj(t.tiempo);
    this.el('v-mejor').textContent = reloj(t.mejor);
    this.el('v-ult').textContent = reloj(t.ultima);
    this.el('v-vta').textContent = Math.max(1, t.vuelta);

    this.el('v-kmh').textContent = Math.round(Math.max(0, v.kmh));
    this.el('v-marcha').textContent = v.marcha;
    const frac = Math.min(1, (v.rpm - v.s.rpmRalenti) / (v.s.rpmCorte - v.s.rpmRalenti));
    this.el('v-rpm').style.width = (frac * 100) + '%';

    // Carga por rueda: se ve la transferencia de peso en vivo.
    for (const k of ['DI', 'DD', 'TI', 'TD']) {
      const e = this.el('v-' + k);
      const carga = Math.min(1, v.Fz[k] / (v.estatico[k] * 2.1));
      e.style.height = (carga * 100) + '%';
      const uso = v.uso[k];
      e.style.background = uso > 1.02 ? '#ff4d4d' : uso > 0.88 ? '#ffc447' : '#5ad1a0';
    }

    this.el('v-vol').textContent = g.wheel.conectado
      ? (g.wheel.esVolante ? 'Volante: ' + g.wheel.id.slice(0, 34) : 'Mando: ' + g.wheel.id.slice(0, 30))
      : 'Teclado (no hay volante conectado)';
    this.el('v-volpos').style.left = `calc(${50 + v.mandos.volante * 48}% - 1.5px)`;

    const av = this.el('aviso');
    av.style.opacity = g.avisoT > 0 ? '1' : '0';
    if (g.avisoT > 0) this.el('v-aviso').innerHTML = g.aviso;

    // --- Carrera ---
    const c = g.carrera;
    const enCarrera = c.estado === 'corriendo' || c.estado === 'cuenta' || c.estado === 'final';
    this.el('carrera').classList.toggle('on', enCarrera);
    this.el('tabla').classList.toggle('on', enCarrera && !!c.orden);
    this.el('cuenta').classList.toggle('on', c.estado === 'cuenta');
    if (c.estado === 'cuenta') {
      const n = Math.ceil(c.cuenta);
      this.el('v-cuenta').textContent = n > 3 ? '3' : n <= 0 ? '¡YA!' : String(n);
    }
    if (enCarrera) {
      this.el('v-pos').textContent = c.jugador.puesto;
      this.el('v-total').textContent = (c.rivales.length + 1);
      this.el('v-lap').textContent = Math.min(c.vueltas, c.jugador.vuelta + 1);
      this.el('v-laps').textContent = c.vueltas;
      if (c.orden) {
        this.el('v-tabla').innerHTML = c.orden.map((o, i) =>
          `<div class="r ${o.jugador ? 'yo' : ''}"><span>${i + 1}</span><span class="n">${o.nombre}</span><span>v${o.vuelta + 1}</span></div>`
        ).join('');
      }
    }

    // --- Cadena de habilidad ---
    const pj = g.puntaje;
    const activa = pj.cadena > 0 || pj.ultimoT > 0;
    this.el('cadena').classList.toggle('on', activa);
    if (activa) {
      this.el('v-cad').textContent = Math.round(pj.cadena).toLocaleString('es-AR');
      this.el('v-mult').textContent = pj.mult.toFixed(1);
      this.el('v-quehizo').textContent = pj.ultimoT > 0 ? pj.ultimo : '';
    }

    this.dibujarMapa(g);
  }

  dibujarMapa(g) {
    const c = this.ctx, W = 190;
    c.clearRect(0, 0, W, W);
    const L = g.circuito.linea;
    let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
    if (!this._lim) {
      for (const p of L.tabla) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
      this._lim = { x0, x1, z0, z1 };
    }
    const l = this._lim, m = 12;
    const k = Math.min((W - m * 2) / (l.x1 - l.x0), (W - m * 2) / (l.z1 - l.z0));
    const tf = (x, z) => [m + (x - l.x0) * k, m + (z - l.z0) * k];

    c.strokeStyle = '#59606d'; c.lineWidth = 4; c.lineJoin = 'round';
    c.beginPath();
    L.tabla.forEach((p, i) => { const q = tf(p.x, p.z); i ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1]); });
    c.closePath(); c.stroke();

    const meta = tf(L.tabla[0].x, L.tabla[0].z);
    c.strokeStyle = '#f2efe6'; c.lineWidth = 2;
    c.beginPath(); c.arc(meta[0], meta[1], 3.5, 0, Math.PI * 2); c.stroke();

    for (const r of g.carrera.rivales) {
      const q = tf(r.x, r.z);
      c.fillStyle = '#7fd4ff';
      c.beginPath(); c.arc(q[0], q[1], 2.8, 0, Math.PI * 2); c.fill();
    }
    const p = tf(g.auto.x, g.auto.z);
    c.fillStyle = '#ffc447';
    c.beginPath(); c.arc(p[0], p[1], 4, 0, Math.PI * 2); c.fill();
  }
}
