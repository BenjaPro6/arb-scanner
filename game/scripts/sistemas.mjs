// Pruebas de simulación sin browser: economía, tráfico y policía.
// Corren la lógica real del juego, no maquetas.
import * as THREE from 'three';
import { City } from '../src/world/city.js';
import { RoadNet } from '../src/world/roads.js';
import { Traffic } from '../src/vehicles/traffic.js';
import { Police } from '../src/systems/police.js';
import { Economy } from '../src/systems/economy.js';
import { makeRng } from '../src/core/rng.js';
import { CFG } from '../src/core/config.js';

let fallos = 0;
const ok = (cond, msg, extra = '') => {
  console.log((cond ? '  OK  ' : ' FALLA') + '  ' + msg + (extra ? '   ' + extra : ''));
  if (!cond) fallos++;
};

const rng = makeRng(1987);
const city = new City(1987);
const roads = new RoadNet(city);
const scene = new THREE.Scene();
const DT = 1 / 60;
const solidsNear = () => [];

console.log('\n=== ECONOMÍA (inflación) ===');
{
  const e = new Economy(makeRng(3));
  const inicial = e.power;
  for (let i = 0; i < 60 * 60; i++) e.update(DT);      // un minuto
  const subida = (e.priceIndex - 1) * 100;
  ok(Math.abs(subida - CFG.INFLATION_PER_MIN * 100) < 0.4,
     'los precios suben lo declarado en 1 minuto', `+${subida.toFixed(2)}%`);
  ok(e.power < inicial * 0.96, 'quedarse en pesos cuesta poder adquisitivo',
     `${Math.round(inicial)} -> ${Math.round(e.power)}`);

  const e2 = new Economy(makeRng(3));
  const antes = e2.realWealth;
  e2.buyUsd(e2.pesos);                                  // se pasa a dólares
  for (let i = 0; i < 60 * 60 * 5; i++) e2.update(DT);   // cinco minutos
  ok(e2.realWealth > antes * 0.96, 'el dólar preserva el valor a 5 minutos',
     `${Math.round(antes)} -> ${Math.round(e2.realWealth)}`);

  const e3 = new Economy(makeRng(3));
  for (let i = 0; i < 60 * 60 * 5; i++) e3.update(DT);
  ok(e3.realWealth < antes * 0.80, 'quedarse en pesos 5 minutos duele de verdad',
     `${Math.round(antes)} -> ${Math.round(e3.realWealth)}`);

  const e4 = new Economy(makeRng(9));
  const usd = e4.buyUsd(20000);
  const vuelta = e4.sellUsd(usd);
  ok(vuelta < 20000 && vuelta > 20000 * 0.93, 'la cueva se queda con el spread',
     `20.000 -> ${Math.round(vuelta)}`);
}

console.log('\n=== TRÁFICO ===');
{
  const t = new Traffic(scene, city, roads, makeRng(11));
  const px = city.center.x, pz = city.center.z;
  for (let i = 0; i < 60 * 12; i++)
    t.update(DT, { px, pz, obstacles: [], solidsNear });
  const vivos = t.cars.filter(c => c.active);
  ok(vivos.length > CFG.TRAFFIC_CARS * 0.7, 'se puebla la calle de autos',
     `${vivos.length}/${CFG.TRAFFIC_CARS}`);
  const moviendo = vivos.filter(c => c.v > 1).length;
  ok(moviendo > vivos.length * 0.5, 'la mayoría circula, no está toda trabada',
     `${moviendo} en movimiento`);
  // Ningún auto puede terminar arriba de una manzana: eso sería atravesar edificios.
  const adentro = vivos.filter(c => {
    const b = city.blockAt(c.car.x, c.car.z);
    return b && b.kind === 'edificado' &&
      c.car.x > b.x0 + 1 && c.car.x < b.x1 - 1 && c.car.z > b.z0 + 1 && c.car.z < b.z1 - 1;
  });
  ok(adentro.length === 0, 'ningún auto del tráfico quedó adentro de una manzana',
     `${adentro.length} adentro`);
  // Respeto de semáforos: en rojo, cerca de la esquina, tiene que ir frenando.
  let enRojo = 0, frenando = 0;
  for (const c of vivos) {
    if (c.mode !== 'lane') continue;
    const node = roads.nodes[c.dir > 0 ? c.e.b : c.e.a];
    if (c.e.len - c.s < 20 && !roads.hasGreen(node, c.e)) { enRojo++; if (c.v < 6) frenando++; }
  }
  ok(enRojo === 0 || frenando / enRojo > 0.7, 'frenan en el semáforo en rojo',
     `${frenando}/${enRojo}`);
}

console.log('\n=== POLICÍA ===');
{
  const pol = new Police(scene, city, roads, makeRng(5));
  let px = city.center.x, pz = city.center.z;
  ok(pol.wanted() === 0, 'se arranca limpio');
  pol.crime('atropello'); pol.crime('atropello');
  ok(pol.wanted() >= 1, 'atropellar gente levanta estrellas', `${pol.wanted()} estrellas`);

  const world = { px, pz, playerCar: { vx: 0, vz: 0 }, playerSpeed: 0, solidsNear };
  let dMin = Infinity;
  for (let i = 0; i < 60 * 45; i++) {
    pol.update(DT, world);
    for (const u of pol.units) if (u.active)
      dMin = Math.min(dMin, Math.hypot(u.car.x - px, u.car.z - pz));
  }
  ok(pol.units.some(u => u.active), 'salen patrulleros a buscarte',
     `${pol.units.filter(u => u.active).length} unidades`);
  ok(dMin < 40, 'la persecución efectivamente te alcanza', `se acercó a ${dMin.toFixed(1)} m`);

  // Con más estrellas tiene que venir más gente.
  pol.heat = 5;
  for (let i = 0; i < 60 * 40; i++) pol.update(DT, world);
  const conCinco = pol.units.filter(u => u.active).length;
  ok(conCinco >= 5, 'a 5 estrellas viene un ejército', `${conCinco} unidades`);
  ok(pol.units.some(u => u.force === 'bonaerense'), 'aparece la Bonaerense en estrellas altas');

  // Escondido, la estrella baja sola.
  pol.clear(); pol.heat = 2.5;
  const world2 = { px: px + 4000, pz: pz + 4000, playerCar: null, playerSpeed: 0, solidsNear };
  for (let i = 0; i < 60 * 90; i++) pol.update(DT, world2);
  ok(pol.heat < 2.5, 'la estrella baja si te escondés', `heat ${pol.heat.toFixed(2)}`);
}

console.log('\n=== GRAFO DE CALLES ===');
{
  const a = roads.nodeNear(120, 120), b = roads.nodeNear(city.width - 120, city.depth - 120);
  const p = roads.path(a, b);
  ok(p && p.length > 10, 'hay ruta de punta a punta de la ciudad', `${p ? p.length : 0} nodos`);
  // Un piquete tiene que forzar otro camino.
  const e = roads.edges.find(x => x.big);
  const antes = roads.path(e.a, e.b);
  roads.blocked.add(e.id);
  const desp = roads.path(e.a, e.b);
  ok(desp && desp.length > antes.length, 'el piquete obliga a desviarse',
     `${antes.length} -> ${desp ? desp.length : 'sin ruta'} nodos`);
  roads.blocked.delete(e.id);
}

console.log(fallos ? `\n${fallos} PRUEBAS FALLADAS\n` : '\nTODAS LAS PRUEBAS PASARON\n');
process.exit(fallos ? 1 : 0);
