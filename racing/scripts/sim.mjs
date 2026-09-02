// Pruebas de la simulación, sin navegador. Verifican que el auto se comporte
// como un auto: números de rendimiento, curva de neumático, transferencia de
// peso y estabilidad. Son las que encontraron el corte de vueltas que no
// cortaba y la falta de inercia del tren motriz.
import { Vehicle, TC } from '../src/sim/vehicle.js';
import * as T from '../src/sim/tire.js';
import { generarCircuito, superficie } from '../src/track/track.js';

const DT = 1 / 400;
let fallos = 0;
const ok = (c, msg, extra = '') => {
  console.log((c ? '  OK  ' : ' FALLA') + '  ' + msg + (extra ? '   ' + extra : ''));
  if (!c) fallos++;
};

console.log('\n=== NEUMÁTICO ===');
{
  let pico = 0, ang = 0;
  for (let g = 0; g <= 30; g += 0.1) {
    const f = Math.abs(T.lateral(g * Math.PI / 180, 4000, 1.35));
    if (f > pico) { pico = f; ang = g; }
  }
  ok(ang > 5 && ang < 11, 'la curva lateral tiene pico entre 5° y 11° de deriva', `pico a ${ang.toFixed(1)}°`);
  const caida = Math.abs(T.lateral(25 * Math.PI / 180, 4000, 1.35)) / pico;
  ok(caida < 0.85, 'y cae pasado el pico: eso es sentir que el auto se va',
     `a 25° queda ${(caida * 100).toFixed(0)}%`);
  ok(Math.abs(pico / 4000 - 1.35) < 0.02, 'el pico vale mu por la carga', `${(pico / 4000).toFixed(2)} g`);

  const c = T.combinado(0.13, 0.11, 4000, 1.35);
  ok(Math.hypot(c.fx, c.fy) <= pico * 1.03,
     'la elipse de fricción impide sumar agarre lateral y longitudinal',
     `${Math.hypot(c.fx, c.fy).toFixed(0)} N vs pico ${pico.toFixed(0)} N`);
}

console.log('\n=== RENDIMIENTO ===');
{
  const cero100 = () => { const a = new Vehicle(); a.mandos.acelerador = 1; let t = 0;
    while (a.kmh < 100 && t < 40) { a.paso(DT); t += DT; } return t; };
  const t100 = cero100();
  ok(t100 > 4 && t100 < 8, '0 a 100 en tiempo de auto de carrera', `${t100.toFixed(2)} s`);

  const a = new Vehicle(); a.mandos.acelerador = 1;
  while (a.kmh < 100) a.paso(DT);
  a.mandos.acelerador = 0; a.mandos.freno = 1;
  const x0 = a.x, z0 = a.z;
  while (a.kmh > 2) a.paso(DT);
  const d = Math.hypot(a.x - x0, a.z - z0);
  ok(d > 25 && d < 45, 'frena de 100 a 0 en distancia creíble', `${d.toFixed(1)} m`);

  const b = new Vehicle(); b.mandos.acelerador = 1;
  for (let i = 0; i < 400 * 120; i++) b.paso(DT);
  ok(b.kmh > 190 && b.kmh < 280, 'velocidad máxima coherente con la caja y el arrastre', `${b.kmh.toFixed(0)} km/h`);
  ok(b.rpm <= TC.rpmCorte + 1, 'el corte de vueltas actúa', `${b.rpm.toFixed(0)} rpm`);
}

console.log('\n=== TRANSFERENCIA DE PESO ===');
{
  const a = new Vehicle(); a.mandos.acelerador = 1;
  while (a.kmh < 120) a.paso(DT);
  const delAntes = a.Fz.DI + a.Fz.DD;
  a.mandos.acelerador = 0; a.mandos.freno = 1;
  for (let i = 0; i < 400 * 0.6; i++) a.paso(DT);
  ok(a.Fz.DI + a.Fz.DD > delAntes * 1.2, 'frenando se carga el tren delantero',
     `${delAntes.toFixed(0)} -> ${(a.Fz.DI + a.Fz.DD).toFixed(0)} N`);

  // Esta comprobación NO depende de ninguna convención interna: se mide hacia
  // dónde curva la trayectoria y de ahí se deduce cuál es la rueda de afuera.
  // Escrita al revés, una prueba puede "pasar" con la física invertida.
  const doblar = (volante) => {
    const b = new Vehicle(); b.u = 28; b.yaw = 0; b.mandos.acelerador = 0.3;
    for (let i = 0; i < 400; i++) b.paso(DT);
    const x0 = b.x;
    b.mandos.volante = volante;
    for (let i = 0; i < 400 * 1.2; i++) b.paso(DT);
    const aLaDerecha = (b.x - x0) < 0;          // con yaw 0, la derecha de marcha es -X
    const afuera = aLaDerecha ? 'DI' : 'DD';
    const adentro = aLaDerecha ? 'DD' : 'DI';
    return { b, afuera, adentro, lado: aLaDerecha ? 'derecha' : 'izquierda' };
  };
  for (const vol of [0.2, -0.2]) {
    const d = doblar(vol);
    ok(d.b.Fz[d.afuera] > d.b.Fz[d.adentro] * 1.1,
       `en curva a la ${d.lado} carga la rueda de afuera, no la de adentro`,
       `afuera ${d.b.Fz[d.afuera].toFixed(0)} vs adentro ${d.b.Fz[d.adentro].toFixed(0)} N`);
  }

  const b = doblar(0.2).b;
  const suma = b.Fz.DI + b.Fz.DD + b.Fz.TI + b.Fz.TD;
  ok(Math.abs(suma - TC.masa * 9.81) / (TC.masa * 9.81) < 0.35,
     'la suma de cargas sigue siendo el peso del auto', `${suma.toFixed(0)} N`);
}

console.log('\n=== ESTABILIDAD ===');
{
  for (const vol of [0.05, 0.1, 0.2]) {
    const a = new Vehicle(); a.u = 27.8; a.mandos.acelerador = 0.25;
    for (let i = 0; i < 400; i++) a.paso(DT);
    a.mandos.volante = vol;
    const r = [];
    for (let t = 0; t < 3; t++) { for (let i = 0; i < 400; i++) a.paso(DT); r.push(a.r); }
    ok(Math.abs(r[2]) < 2.0 && Math.abs(r[2] - r[1]) < 0.28,
       `con volante ${vol} el auto se asienta en giro constante y no hace trompo`,
       `guiñada ${r.map(x => x.toFixed(2)).join(' -> ')}`);
  }
}

console.log('\n=== CIRCUITO ===');
{
  for (const s of [7, 21, 99]) {
    const c = generarCircuito(s);
    let maxK = 0;
    for (let d = 0; d < c.largo; d += 4) maxK = Math.max(maxK, Math.abs(c.linea.en(d).curv || 0));
    const R = 1 / maxK;
    ok(c.largo > 2000 && c.largo < 4500, `la pista ${s} mide lo que mide un circuito`, `${(c.largo / 1000).toFixed(2)} km`);
    ok(R > 25 && R < 90, `y tiene al menos una curva lenta de verdad`, `radio mínimo ${R.toFixed(0)} m`);
  }
  const c = generarCircuito(7);
  let err = 0;
  for (let d = 0; d < c.largo; d += 97) {
    const m = c.linea.en(d);
    const p = c.linea.proyectar(m.x + 3 * m.nx, m.z + 3 * m.nz);
    err = Math.max(err, Math.min(Math.abs(p.s - d), Math.abs(Math.abs(p.s - d) - c.largo)));
  }
  ok(err < 1.5, 'proyectar un punto sobre la traza devuelve la distancia correcta', `error ${err.toFixed(2)} m`);
  ok(superficie(c, 0, 0).tipo === 'asfalto' && superficie(c, 30, 0).tipo === 'afuera',
     'se distingue asfalto de escapatoria');
}

console.log(fallos ? `\n${fallos} PRUEBAS FALLADAS\n` : '\nTODAS LAS PRUEBAS PASARON\n');
process.exit(fallos ? 1 : 0);
