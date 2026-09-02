import { AUTOS, ORDEN_AUTOS, MEJORAS, costoMejora, aplicarMejoras, indice } from '../sim/catalogo.js';
import { reloj } from '../race/timing.js';

const plata = (n) => '$' + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');

// Eventos del campeonato. Cada uno es una pista distinta (la semilla manda) con
// su clase mínima, sus vueltas y su premio.
export const EVENTOS = [
  { id: 1, nombre: 'Debut en el autódromo', pista: 7,  vueltas: 2, clase: 'D', premio: 90000,  destreza: 0.80, topeKmh: 165, mu: 1.08, acel: 5.4 },
  { id: 2, nombre: 'Copa Costanera',        pista: 21, vueltas: 3, clase: 'D', premio: 140000, destreza: 0.85, topeKmh: 180, mu: 1.16, acel: 6.0 },
  { id: 3, nombre: 'Trofeo Sudestada',      pista: 99, vueltas: 3, clase: 'B', premio: 260000, destreza: 0.91, topeKmh: 212, mu: 1.34, acel: 7.2 },
  { id: 4, nombre: 'Gran Premio del Río',   pista: 4,  vueltas: 4, clase: 'B', premio: 380000, destreza: 0.94, topeKmh: 222, mu: 1.40, acel: 7.6 },
  { id: 5, nombre: 'Mil Kilómetros',        pista: 55, vueltas: 5, clase: 'A', premio: 640000, destreza: 0.96, topeKmh: 246, mu: 1.52, acel: 8.6 },
  { id: 6, nombre: 'Desafío Prototipos',    pista: 12, vueltas: 4, clase: 'S', premio: 1100000, destreza: 0.98, topeKmh: 272, mu: 1.66, acel: 9.8 },
];
const RANGO = { D: 0, C: 1, B: 2, A: 3, S: 4 };
export const habilitado = (ev, spec) => RANGO[spec.clase] >= RANGO[ev.clase];

const CSS = `
#menu{position:fixed;inset:0;z-index:70;display:none;place-content:center;
  background:rgba(8,11,16,.9);overflow:auto;padding:24px 0}
#menu.on{display:grid}
#menu .caja{width:min(860px,92vw);pointer-events:auto}
#menu h2{margin:0 0 4px;font-size:26px;font-weight:800;letter-spacing:-.6px}
#menu .sub{opacity:.6;font-size:13px;margin-bottom:18px}
#menu .barra{display:flex;gap:18px;align-items:center;margin-bottom:18px;flex-wrap:wrap}
#menu .chip{background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.10);
  border-radius:9px;padding:8px 13px;font-variant-numeric:tabular-nums}
#menu .chip b{color:#ffc447}
#menu .tabs{display:flex;gap:8px;margin-bottom:16px}
#menu .tabs button{flex:0 0 auto}
#menu button{font:inherit;color:#eef1f5;background:rgba(255,255,255,.08);
  border:1px solid rgba(255,255,255,.12);border-radius:9px;padding:9px 15px;cursor:pointer;transition:.15s}
#menu button:hover{background:rgba(255,255,255,.15)}
#menu button.on{background:#ffc447;color:#1b1408;border-color:#ffc447;font-weight:700}
#menu button:disabled{opacity:.35;cursor:not-allowed}
#menu .lista{display:grid;gap:9px}
#menu .fila{display:flex;align-items:center;gap:14px;background:rgba(255,255,255,.05);
  border:1px solid rgba(255,255,255,.09);border-radius:11px;padding:12px 15px}
#menu .fila .crece{flex:1;min-width:0}
#menu .fila .t{font-weight:700}
#menu .fila .d{opacity:.58;font-size:12px;margin-top:2px}
#menu .fila.bloq{opacity:.42}
#menu .pill{font-size:11px;font-weight:700;padding:3px 8px;border-radius:20px;background:rgba(255,196,71,.22);color:#ffc447}
#menu .num{font-variant-numeric:tabular-nums;font-weight:700}
#menu .cerrar{margin-top:18px;opacity:.6;font-size:12px;text-align:center}
`;

export class Menu {
  constructor(juego) {
    this.g = juego;
    this.tab = 'eventos';
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    this.el = document.createElement('div'); this.el.id = 'menu';
    document.body.appendChild(this.el);
    this.el.addEventListener('click', (e) => this.click(e));
  }

  abrir(on) { this.el.classList.toggle('on', on); if (on) this.render(); }
  get abierto() { return this.el.classList.contains('on'); }

  click(e) {
    const b = e.target.closest('button');
    if (!b) return;
    const { accion, valor, extra } = b.dataset;
    const g = this.g, p = g.progreso;
    if (accion === 'tab') { this.tab = valor; this.render(); return; }
    if (accion === 'correr') { g.empezarCarrera(+valor); this.abrir(false); return; }
    if (accion === 'practicar') { g.practicar(+valor); this.abrir(false); return; }
    if (accion === 'usar') { p.actual = valor; p.guardar(); g.rearmarAuto(); this.render(); return; }
    if (accion === 'comprar') { g.decir(this.texto(p.comprarAuto(valor), AUTOS[valor].nombre), 3); g.rearmarAuto(); this.render(); return; }
    if (accion === 'mejorar') { g.decir(this.texto(p.mejorar(valor, extra), MEJORAS[extra].nombre), 3); g.rearmarAuto(); this.render(); return; }
    if (accion === 'cerrar') { this.abrir(false); }
  }

  texto(r, que) {
    if (r === 'comprado') return `Compraste el ${que}`;
    if (r === 'mejorado') return `${que} mejorado`;
    if (r === 'sin plata') return 'No te alcanza';
    if (r === 'al máximo') return `${que} ya está al máximo`;
    return r;
  }

  render() {
    const g = this.g, p = g.progreso;
    const spec = g.specActual();
    const xn = p.xpNivel;
    const tabs = [['eventos', 'Eventos'], ['garage', 'Garage'], ['taller', 'Taller']];

    let cuerpo = '';
    if (this.tab === 'eventos') {
      cuerpo = `<div class="lista">` + EVENTOS.map(ev => {
        const ok = habilitado(ev, spec);
        const mejor = p.mejores['p' + ev.pista];
        return `<div class="fila ${ok ? '' : 'bloq'}">
          <div class="crece">
            <div class="t">${ev.nombre} <span class="pill">clase ${ev.clase}</span></div>
            <div class="d">Pista ${ev.pista} · ${ev.vueltas} vueltas · premio ${plata(ev.premio)}${mejor ? ' · tu mejor vuelta ' + reloj(mejor) : ''}</div>
          </div>
          <button data-accion="practicar" data-valor="${ev.id}">Practicar</button>
          <button class="on" data-accion="correr" data-valor="${ev.id}" ${ok ? '' : 'disabled'}>Correr</button>
        </div>`;
      }).join('') + `</div>`;
      if (!EVENTOS.some(ev => habilitado(ev, spec)))
        cuerpo += `<div class="cerrar">Necesitás un auto de clase superior. Pasá al Garage.</div>`;
    } else if (this.tab === 'garage') {
      cuerpo = `<div class="lista">` + ORDEN_AUTOS.map(k => {
        const a = AUTOS[k], tengo = p.tiene(k), usando = p.actual === k;
        const idx = indice(tengo ? aplicarMejoras(a, p.mejorasDe(k)) : a);
        return `<div class="fila">
          <div class="crece">
            <div class="t">${a.nombre} <span class="pill">clase ${a.clase}</span></div>
            <div class="d">Índice ${idx} · ${a.traccion} · ${Math.round(a.masa)} kg${tengo ? '' : ' · ' + plata(a.precio)}</div>
          </div>
          ${tengo
            ? `<button class="${usando ? 'on' : ''}" data-accion="usar" data-valor="${k}">${usando ? 'En uso' : 'Usar'}</button>`
            : `<button data-accion="comprar" data-valor="${k}" ${p.plata >= a.precio ? '' : 'disabled'}>Comprar</button>`}
        </div>`;
      }).join('') + `</div>`;
    } else {
      const k = p.actual, mej = p.mejorasDe(k);
      cuerpo = `<div class="lista">` + Object.entries(MEJORAS).map(([clave, m]) => {
        const nivel = mej[clave] || 0;
        const costo = costoMejora(clave, nivel);
        return `<div class="fila">
          <div class="crece">
            <div class="t">${m.nombre} <span class="num">${'▮'.repeat(nivel)}${'▯'.repeat(m.max - nivel)}</span></div>
            <div class="d">${m.desc}${costo === null ? ' · al máximo' : ' · ' + plata(costo)}</div>
          </div>
          <button data-accion="mejorar" data-valor="${k}" data-extra="${clave}"
            ${costo !== null && p.plata >= costo ? '' : 'disabled'}>Mejorar</button>
        </div>`;
      }).join('') + `</div>
        <div class="cerrar">Índice actual del ${AUTOS[k].nombre}: <b>${indice(spec)}</b> (de fábrica ${indice(AUTOS[k])})</div>`;
    }

    this.el.innerHTML = `<div class="caja">
      <h2>TRAZADA</h2>
      <div class="sub">Campeonato · nivel ${p.nivel}</div>
      <div class="barra">
        <div class="chip">Plata <b>${plata(p.plata)}</b></div>
        <div class="chip">Nivel <b>${p.nivel}</b> · ${xn.hecho}/${xn.falta} xp</div>
        <div class="chip">Puntos <b>${p.puntos.toLocaleString('es-AR')}</b></div>
        <div class="chip">Auto <b>${AUTOS[p.actual].nombre}</b></div>
        <div class="chip">Carreras <b>${p.carreras.ganadas}</b>/${p.carreras.corridas}</div>
      </div>
      <div class="tabs">${tabs.map(([id, t]) =>
        `<button class="${this.tab === id ? 'on' : ''}" data-accion="tab" data-valor="${id}">${t}</button>`).join('')}
        <button data-accion="cerrar" style="margin-left:auto">Cerrar (Tab)</button>
      </div>
      ${cuerpo}
    </div>`;
  }
}
