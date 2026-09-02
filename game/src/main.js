import * as THREE from 'three';
import { CFG } from './core/config.js';
import { makeRng } from './core/rng.js';
import { Input } from './core/input.js';
import { Audio } from './core/audio.js';
import { clamp, lerp, pesos } from './core/utils.js';
import { City } from './world/city.js';
import { RoadNet } from './world/roads.js';
import { buildWorld } from './world/render.js';
import { Traffic } from './vehicles/traffic.js';
import { VEHICLES } from './vehicles/catalog.js';
import { buildVehicle } from './vehicles/model.js';
import { Car, collideCars, collideWorld } from './vehicles/physics.js';
import { Peds } from './actors/peds.js';
import { Player } from './actors/player.js';
import { Police } from './systems/police.js';
import { Economy } from './systems/economy.js';
import { Places } from './systems/places.js';
import { Missions } from './systems/missions.js';
import { Weapons, ARMAS, ORDEN_ARMAS } from './systems/weapons.js';
import { Hud } from './ui/hud.js';
import { Save } from './systems/save.js';

const SEED = 1987;

class Game {
  async init() {
    const status = document.getElementById('carga');
    const step = (t) => new Promise(r => { status.textContent = t; requestAnimationFrame(() => requestAnimationFrame(r)); });

    this.rng = makeRng(SEED);
    this.input = new Input();
    this.audio = new Audio();

    await step('Trazando la grilla…');
    this.city = new City(SEED);
    this.roads = new RoadNet(this.city);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // ACES levanta las sombras sin quemar los carteles ni las ventanas.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.35;
    document.body.appendChild(this.renderer.domElement);
    this.input.attach(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.4, 2600);

    await step('Levantando la ciudad…');
    const world = buildWorld(this.city, this.roads, this.rng);
    this.scene.add(world.group);
    this.nightMats = world.nightMats;
    this.buildSolidGrid(world.solids);

    await step('Prendiendo las luces…');
    this.setupLights();

    await step('Sacando los autos a la calle…');
    this.traffic = new Traffic(this.scene, this.city, this.roads, this.rng);
    this.peds = new Peds(this.scene, this.city, this.rng);
    this.police = new Police(this.scene, this.city, this.roads, this.rng);
    this.economy = new Economy(this.rng);
    this.places = new Places(this.scene, this.city, this.rng);
    this.meta = this.places.add('meta', this.city.blocks[0]);
    this.places.show(this.meta, false);

    // Arranco al lado del Obelisco, con un Falcon esperándome.
    const c = this.city.center;
    this.player = new Player(this.scene, this.rng, c.x + 26, c.z + 40);
    this.ownCar = this.spawnOwnCar(c.x + 30, c.z + 44);

    this.weapons = new Weapons(this.scene, this);
    this.missions = new Missions(this);
    this.hud = new Hud();
    this.save = new Save(this);
    this.gps = { ruta: null, t: 0 };
    this.mapaAbierto = false;

    this.hour = CFG.START_HOUR;
    if (this.save.cargar()) this.missions.say('Partida cargada. Se autoguarda sola.', 4);
    addEventListener('beforeunload', () => this.save.guardar());
    this.piquete = { edge: null, t: 26, mesh: null };
    this.tmpCars = [];
    this.stats = { robos: 0, misiones: 0 };

    addEventListener('resize', () => this.onResize());
    const kick = () => { this.audio.start(); removeEventListener('pointerdown', kick); removeEventListener('keydown', kick); };
    addEventListener('pointerdown', kick); addEventListener('keydown', kick);

    document.getElementById('splash').classList.add('listo');
    this.last = performance.now();
    requestAnimationFrame(this.loop.bind(this));
  }

  spawnOwnCar(x, z) {
    const spec = VEHICLES.falcon;
    const mesh = buildVehicle(spec, '#6f7a55');
    this.scene.add(mesh);
    const car = new Car(spec, x, z, Math.PI);
    return { mesh, car, mine: true, mode: 'own' };
  }

  // Grilla de colisión: las manzanas sólidas indexadas por celda de 120m.
  buildSolidGrid(solids) {
    this.solidCell = 120;
    this.solidGrid = new Map();
    for (const s of solids) {
      const i0 = Math.floor(s.x0 / 120), i1 = Math.floor(s.x1 / 120);
      const j0 = Math.floor(s.z0 / 120), j1 = Math.floor(s.z1 / 120);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const k = i * 10007 + j;
        let b = this.solidGrid.get(k);
        if (!b) { b = []; this.solidGrid.set(k, b); }
        b.push(s);
      }
    }
    this._near = [];
    this.solidsNear = (x, z) => {
      const out = this._near; out.length = 0;
      const i0 = Math.floor(x / 120), j0 = Math.floor(z / 120);
      for (let i = i0 - 1; i <= i0 + 1; i++) for (let j = j0 - 1; j <= j0 + 1; j++) {
        const b = this.solidGrid.get(i * 10007 + j);
        if (b) for (const s of b) if (!out.includes(s)) out.push(s);
      }
      return out;
    };
  }

  setupLights() {
    this.hemi = new THREE.HemisphereLight(0xbcd4ff, 0x40372c, 0.7);
    this.amb = new THREE.AmbientLight(0x6e7fa8, 0.0);
    this.scene.add(this.amb);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffd9a8, 1.4);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const d = 55;
    Object.assign(this.sun.shadow.camera, { left: -d, right: d, top: d, bottom: -d, near: 1, far: 320 });
    this.sun.shadow.bias = -0.0009;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    this.scene.fog = new THREE.Fog(0x1a2030, 190, 940);
    this.scene.background = new THREE.Color(0x1a2030);

    // Faros del auto del jugador: dos conos que se prenden de noche.
    this.headlights = [];
    for (let i = 0; i < 2; i++) {
      const s = new THREE.SpotLight(0xfff0cc, 0, 95, 0.46, 0.5, 1.1);
      s.visible = false;
      this.scene.add(s); this.scene.add(s.target);
      this.headlights.push(s);
    }
  }

  onResize() {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
  }

  // 0 = noche cerrada, 1 = mediodía.
  dayness() {
    const h = this.hour;
    if (h > 7 && h < 18) return 1;
    if (h > 5.5 && h <= 7) return (h - 5.5) / 1.5;
    if (h >= 18 && h < 20) return 1 - (h - 18) / 2;
    return 0;
  }

  updateSky(dt) {
    this.hour = (this.hour + dt * (24 / CFG.DAY_LENGTH)) % 24;
    const d = this.dayness();
    const p = this.player.pos;

    const dayCol = new THREE.Color(0x9fc4e8), nightCol = new THREE.Color(0x0d1220);
    const sky = nightCol.clone().lerp(dayCol, d * d);
    this.scene.background = sky;
    this.scene.fog.color = sky;
    this.scene.fog.near = lerp(120, 260, d);
    this.scene.fog.far = lerp(620, 1250, d);

    // De noche la ciudad se ilumina sola: faroles, vidrieras y cielo urbano.
    this.hemi.intensity = lerp(0.80, 1.05, d);
    this.hemi.color.setHex(d > 0.5 ? 0xbcd4ff : 0x4d5f8c);
    this.hemi.groundColor.setHex(d > 0.5 ? 0x40372c : 0x2b2a33);
    this.amb.intensity = lerp(1.05, 0.08, d);
    this.sun.intensity = d * 1.5;
    const ang = ((this.hour - 6) / 12) * Math.PI;
    this.sun.position.set(p.x + Math.cos(ang) * 90, 40 + Math.sin(ang) * 110, p.z - 60);
    this.sun.target.position.set(p.x, 0, p.z);
    this.sun.color.setHex(d < 0.35 ? 0xffb070 : 0xffe9c4);

    // Ventanas y vidrieras encendidas.
    const glow = clamp(1 - d * 1.25, 0, 1);
    for (const mm of this.nightMats) mm.emissive.setScalar(glow * 0.95);

    // Faros
    const on = d < 0.5 && this.player.mode === 'drive';
    for (let i = 0; i < 2; i++) {
      const s = this.headlights[i];
      s.visible = on; s.intensity = on ? 900 : 0;
      if (!on) continue;
      const c = this.player.car;
      const f = c.forward(), r = c.right();
      const sx = (i ? 1 : -1) * c.spec.W * 0.34;
      s.position.set(c.x + f.x * c.spec.L * 0.48 + r.x * sx, 0.72, c.z + f.z * c.spec.L * 0.48 + r.z * sx);
      s.target.position.set(c.x + f.x * 30 + r.x * sx * 3, 0.1, c.z + f.z * 30 + r.z * sx * 3);
    }
  }

  // Cada tanto se corta una avenida. El tráfico y la policía recalculan solos,
  // porque los piquetes se marcan como tramos bloqueados en el grafo.
  updatePiquete(dt) {
    this.piquete.t -= dt;
    if (this.piquete.t > 0) return;
    if (this.piquete.edge) {
      this.roads.blocked.delete(this.piquete.edge.id);
      this.scene.remove(this.piquete.mesh);
      this.piquete.mesh.geometry.dispose();
      this.piquete.edge = null;
      this.piquete.t = this.rng.range(45, 90);
      this.missions.say('Se liberó el corte.', 2.5);
      return;
    }
    const p = this.player.pos;
    for (let k = 0; k < 20; k++) {
      const ang = this.rng() * Math.PI * 2, r = this.rng.range(150, 380);
      const hit = this.roads.nearestEdge(p.x + Math.cos(ang) * r, p.z + Math.sin(ang) * r);
      if (!hit || !hit.e.big) continue;
      const e = hit.e;
      this.roads.blocked.add(e.id);
      const A = this.roads.nodes[e.a];
      const mx = A.x + e.fx * e.len * 0.5, mz = A.z + e.fz * e.len * 0.5;
      const g = new THREE.BoxGeometry(e.width, 1.1, 1.4);
      const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: 0xc0392b }));
      m.position.set(mx, 0.55, mz);
      m.rotation.y = Math.atan2(e.fx, e.fz);
      this.scene.add(m);
      this.piquete.edge = e; this.piquete.mesh = m; this.piquete.t = this.rng.range(35, 60);
      this.missions.say('Cortaron una avenida. Buscá otra por dónde salir.', 3.5);
      return;
    }
    this.piquete.t = 12;
  }

  playerCarSlot() {
    return this.player.mode === 'drive' ? this.player.vehicle : null;
  }

  tryEnterExit() {
    const p = this.player;
    if (p.enterCooldown > 0) return;
    if (p.mode === 'drive') {
      if (p.car.speed > 4) { this.missions.say('Frená primero.', 1.5); return; }
      // Devuelvo el auto al mundo: si era del tráfico, sigue suelto en la calle.
      const slot = p.vehicle;
      if (slot && slot.mode !== 'own') { slot.mode = 'loose'; slot.looseT = 0; }
      p.exit();
      return;
    }
    // A pie: busco el fierro más cercano.
    let best = null, bd = 4.2;
    const consider = (obj, car, kind) => {
      const d = Math.hypot(car.x - p.x, car.z - p.z) - car.spec.L * 0.35;
      if (d < bd) { bd = d; best = { obj, car, kind }; }
    };
    consider(this.ownCar, this.ownCar.car, 'own');
    for (const t of this.traffic.cars) if (t.active) consider(t, t.car, 'traffic');
    for (const u of this.police.units) if (u.active) consider(u, u.car, 'police');
    if (!best) return;

    if (best.kind === 'traffic') {
      // Si estaba andando, adentro había alguien: sale disparado a la vereda.
      const conductor = best.obj.mode === 'lane' && best.car.speed > 0.4;
      best.obj.mode = 'own';
      best.obj.active = true;
      this.police.crime('robo', conductor ? 1.35 : 1);
      if (conductor) {
        const r = best.car.right();
        this.peds.expulsar(best.car.x + r.x * 2.2, best.car.z + r.z * 2.2);
        this.missions.say(`Bajaste al chofer y te llevaste el ${best.car.spec.name}.`, 3);
      } else this.missions.say(`Te llevaste un ${best.car.spec.name}.`, 2.2);
    } else if (best.kind === 'police') {
      this.police.crime('robo', 2);
      this.police.retire(best.obj);
      this.missions.say('Le afanaste el patrullero a la cana. Buena idea, seguro.', 3);
    }
    this.player.enter(best.obj, best.car);
  }

  // Un solo lugar decide qué ofrece el punto en el que estás parado. El texto
  // del cartel sale de acá, así que nunca dice una cosa y hace otra.
  interactPlaces() {
    const p = this.player.pos;
    const usar = this.input.hit('use');
    const aPie = this.player.mode === 'foot';
    let cartel = null;

    const cueva = this.places.near(p.x, p.z, 'cueva');
    if (cueva) {
      cartel = `Cueva · F comprar dólares a ${pesos(this.economy.blue * 1.025)} · H vender`;
      if (usar) {
        const got = this.economy.buyUsd(this.economy.pesos);
        if (got > 0) this.missions.say(`Compraste US$${got.toFixed(0)}.`, 3);
        else this.missions.say('No tenés pesos para cambiar.', 2);
      }
      if (this.input.hit('horn')) {
        const got = this.economy.sellUsd(this.economy.usd);
        if (got > 0) this.missions.say(`Vendiste y te llevaste ${pesos(got)}.`, 3);
      }
    }

    const arm = this.places.near(p.x, p.z, 'armeria');
    if (arm && aPie) {
      const k = this.compraArma();
      const s = ARMAS[k];
      const precio = this.weapons.tiene(k) ? s.bala * s.cargador * 2 : s.precio;
      cartel = `Armería · F: ${this.weapons.tiene(k) ? 'munición de ' + s.nombre : s.nombre} (${pesos(precio * this.economy.priceIndex)})`
             + (this.weapons.armado ? ' · G robar' : '');
      if (usar) {
        const r = this.weapons.comprar(k, this.economy);
        if (r === 'comprada') this.missions.say(`${s.nombre} comprada. Teclas 1-3 para cambiar de arma.`, 4);
        else if (r === 'municion') this.missions.say(`Cargaste munición de ${s.nombre}.`, 2.5);
        else this.missions.say('No te alcanza.', 2.5);
      }
      if (this.input.hit('robar')) this.robar(arm, 90000, 2.4);
    }

    const kio = this.places.near(p.x, p.z, 'kiosco');
    if (kio && aPie) {
      cartel = `Kiosco · F comer (${pesos(6000 * this.economy.priceIndex)}) · B chaleco (${pesos(34000 * this.economy.priceIndex)})`
             + (this.weapons.armado ? ' · G robar' : '');
      if (usar) {
        if (this.player.health > 96) this.missions.say('Estás entero, no hace falta.', 2);
        else if (this.economy.charge(6000)) {
          this.player.health = Math.min(100, this.player.health + 35);
          this.missions.say('Comiste algo. Recuperaste salud.', 2.5);
        } else this.missions.say('No te alcanza ni para un alfajor.', 2.5);
      }
      if (this.input.hit('chaleco')) {
        if (this.player.armor > 96) this.missions.say('Ya tenés el chaleco puesto.', 2);
        else if (this.economy.charge(34000)) {
          this.player.armor = 100;
          this.missions.say('Chaleco puesto. Aguanta el primer cargador.', 3);
        } else this.missions.say('No te alcanza para el chaleco.', 2.5);
      }
      if (this.input.hit('robar')) this.robar(kio, 26000, 1.6);
    }

    const neg = this.places.near(p.x, p.z, 'negocio');
    if (neg) {
      cartel = neg.dueno
        ? `${neg.nombre} · tuyo · rinde ${pesos(neg.renta * this.economy.priceIndex)} por minuto`
        : `${neg.nombre} en venta · F comprar (${pesos(neg.precio * this.economy.priceIndex)}) · rinde ${pesos(neg.renta * this.economy.priceIndex)}/min`;
      if (usar && !neg.dueno) {
        const r = this.economy.comprar(neg);
        if (r === 'comprado') {
          neg.mesh.material.color.setHex(0x35d07f);
          this.missions.say(`Compraste ${neg.nombre}. Ahora te entra plata sola.`, 4.5);
        } else this.missions.say('No te alcanza para ese negocio.', 3);
      }
    }

    const taller = this.places.near(p.x, p.z, 'taller');
    if (taller && this.player.mode === 'drive' && this.player.car.speed < 6) {
      cartel = 'Taller · chapa, pintura y te sacan la cana de encima';
      if (this.tallerCool <= 0) {
        if (this.economy.charge(15000)) {
          this.player.car.damage = 0;
          const had = this.police.wanted();
          this.police.clear();
          this.tallerCool = 4;
          this.missions.say(had ? 'Chapa, pintura y a otra cosa. Se te fue la cana.' : 'Quedó como nuevo.', 3.5);
        } else if (!this.tallerWarn) {
          this.missions.say('No te alcanza para el taller.', 2.5); this.tallerWarn = true;
        }
      }
    } else this.tallerWarn = false;

    this.cartel = cartel;
  }

  // Qué arma te vende la armería: la siguiente que no tengas.
  compraArma() {
    for (const k of ORDEN_ARMAS) if (!this.weapons.tiene(k)) return k;
    return this.weapons.actual || 'pistola';
  }

  // Atraco a mano armada: plata en el acto y la cana encima.
  robar(lugar, montoReal, estrellas) {
    if (!this.weapons.armado) { this.missions.say('Para robar hace falta un fierro.', 2.5); return; }
    if (lugar.robadoT > 0) { this.missions.say('Acá ya cobraste. Volvé más tarde.', 2.5); return; }
    const botin = this.economy.pay(montoReal * this.rng.range(0.7, 1.35));
    lugar.robadoT = 150;
    this.police.heat = Math.max(this.police.heat, estrellas);
    this.missions.say(`Te llevaste ${pesos(botin)}. Salí de acá.`, 4);
    this.audio.bang(6);
    this.stats.robos = (this.stats.robos || 0) + 1;
  }

  bustedOrDead() {
    if (this.police.busted > 2.2) {
      this.police.busted = 0;
      const fine = this.economy.pesos * 0.35;
      this.economy.pesos -= fine;
      this.police.clear();
      this.respawn();
      this.weapons.enCargador = 0;
      this.missions.say(`Te levantaron. Se fueron ${pesos(fine)} en coimas, y te secuestraron el fierro cargado.`, 5);
      if (this.missions.current) { this.missions.failed++; this.missions.finish(); }
    }
    if (this.player.health <= 0) {
      this.player.health = 100; this.player.armor = 0;
      const fine = this.economy.pesos * 0.20;
      this.economy.pesos -= fine;
      this.police.clear();
      this.respawn();
      this.missions.say('Zafaste de milagro. La cuenta del hospital no.', 5);
      if (this.missions.current) { this.missions.failed++; this.missions.finish(); }
    }
  }

  // Ruta por calles hasta el objetivo, recalculada de a poco. Reusa el mismo
  // A* que usa la policía, así que el GPS te manda por donde se puede ir de
  // verdad: esquiva los piquetes.
  actualizarGps(dt) {
    this.gps.t -= dt;
    if (this.gps.t > 0) return;
    this.gps.t = 1.5;
    const obj = this.objetivo();
    if (!obj) { this.gps.ruta = null; return; }
    const p = this.player.pos;
    const desde = this.roads.nodeNear(p.x, p.z);
    const hasta = this.roads.nodeNear(obj.x, obj.z);
    const ruta = this.roads.path(desde, hasta);
    this.gps.ruta = ruta ? ruta.map(id => this.roads.nodes[id]) : null;
  }

  objetivo() {
    if (this.missions.current && this.meta.mesh.visible) return this.meta;
    return this.places.laburo;
  }

  respawn() {
    if (this.player.mode === 'drive') this.player.exit();
    const b = this.city.randomBlock(bb => bb.district === 'sanTelmo' || bb.district === 'once');
    const s = this.places.streetSpot(b);
    this.player.x = s.x; this.player.z = s.z;
    this.player.vx = 0; this.player.vz = 0;
    this.ownCar.car.x = s.x + 6; this.ownCar.car.z = s.z;
    this.ownCar.car.vx = 0; this.ownCar.car.vz = 0; this.ownCar.car.damage = 0;
    this.player.health = 100;
  }

  update(dt) {
    const input = this.input;
    if (input.hit('mapa')) this.mapaAbierto = !this.mapaAbierto;
    if (this.mapaAbierto) {
      // Con el mapa abierto el mundo se congela, como corresponde.
      this.hud.update(this); input.endFrame();
      return;
    }
    if (input.hit('use')) this.pendingUse = true;

    this.economy.update(dt);
    this.roads.update(dt);
    this.updateSky(dt);
    this.updatePiquete(dt);
    this.places.update(dt);
    this.tallerCool = Math.max(0, (this.tallerCool || 0) - dt);

    this.player.tick(dt);
    const p = this.player.pos;
    const solids = this.solidsNear(p.x, p.z);

    if (this.player.mode === 'drive') this.player.updateDrive(dt, input, solids);
    else this.player.updateFoot(dt, input, this.player.camYaw, solids);

    if (this.pendingUse) { this.tryEnterExit(); this.pendingUse = false; }
    this.interactPlaces();

    // El auto propio sigue existiendo aunque me baje. La física sólo corre si
    // no lo estoy manejando yo, pero la malla se sincroniza SIEMPRE: tenerla
    // adentro del if hacía que al manejarlo la carrocería se quedara atrás y
    // sólo se movieran los faros.
    {
      const c = this.ownCar.car;
      if (this.player.vehicle !== this.ownCar) {
        c.throttle = 0; c.steer = 0; c.step(dt);
        collideWorld(c, this.solidsNear(c.x, c.z), null);
      }
      const m = this.ownCar.mesh;
      m.position.set(c.x, 0, c.z);
      m.rotation.y = c.yaw;
      for (const w of m.userData.wheels) {
        w.rotation.x = c.wheelSpin;
        if (w.userData.steer) w.rotation.y = c.steer * 0.4;
      }
      for (const b of m.userData.brakes) b.visible = c.throttle < 0;
    }

    // Obstáculos que el tráfico tiene que ver: yo, mi auto y los patrulleros.
    const obstacles = [];
    const pc = this.player.mode === 'drive' ? this.player.car : null;
    if (pc) obstacles.push({ x: pc.x, z: pc.z });
    if (this.ownCar.car !== pc) obstacles.push({ x: this.ownCar.car.x, z: this.ownCar.car.z });
    for (const u of this.police.units) if (u.active) obstacles.push({ x: u.car.x, z: u.car.z });

    this.traffic.update(dt, {
      px: p.x, pz: p.z, obstacles, solidsNear: this.solidsNear,
      conducido: this.player.vehicle,   // el slot que maneja el jugador, si es del tráfico
    });

    // Los peatones se asustan de todo lo que se mueve rápido.
    const threats = [];
    if (pc) threats.push({ x: pc.x, z: pc.z, speed: pc.speed });
    for (const u of this.police.units) if (u.active) threats.push({ x: u.car.x, z: u.car.z, speed: u.car.speed });
    if (this.police.wanted() > 0 && this.player.mode === 'foot') threats.push({ x: p.x, z: p.z, speed: 6 });
    this.peds.update(dt, { px: p.x, pz: p.z, threats });

    this.police.update(dt, {
      px: p.x, pz: p.z, playerCar: pc, playerSpeed: this.player.speed, solidsNear: this.solidsNear,
    });

    // --- Choques ---
    const cars = this.tmpCars; cars.length = 0;
    if (pc) cars.push(pc);
    for (const t of this.traffic.cars) if (t.active && t !== this.player.vehicle) cars.push(t.car);
    for (const u of this.police.units) if (u.active) cars.push(u.car);
    if (this.ownCar.car !== pc) cars.push(this.ownCar.car);

    let loudest = 0;
    for (let i = 0; i < cars.length; i++) {
      for (let j = i + 1; j < cars.length; j++) {
        const sev = collideCars(cars[i], cars[j]);
        if (sev > 1) {
          loudest = Math.max(loudest, sev);
          for (const t of this.traffic.cars)
            if (t.active && (t.car === cars[i] || t.car === cars[j])) this.traffic.knock(t);
          if (pc && (cars[i] === pc || cars[j] === pc)) {
            const other = cars[i] === pc ? cars[j] : cars[i];
            const isCop = this.police.units.some(u => u.active && u.car === other);
            if (sev > 3.5) this.police.crime(isCop ? 'chocarPatrullero' : 'choque', clamp(sev / 7, 0.4, 2.2));
            this.player.shake = Math.max(this.player.shake, clamp(sev / 12, 0, 1));
          }
        }
      }
    }
    if (loudest > 2) this.audio.bang(loudest);

    // Sólo te cae la cana por los que atropellás vos. Si un patrullero se
    // lleva puesto a alguien en la persecución, el peatón cae igual pero
    // las estrellas no son tuyas.
    if (pc) {
      const mios = this.peds.runOver([pc]);
      if (mios > 0) {
        this.police.crime('atropello', mios);
        this.missions.say(mios > 1 ? '¡Te llevaste puestos a varios!' : 'Atropellaste a alguien.', 2.2);
      }
    }
    this.peds.runOver(pc ? cars.filter(c => c !== pc) : cars);

    // Cambio de arma y disparo.
    if (input.hit('arma1')) this.weapons.elegir('pistola');
    if (input.hit('arma2')) this.weapons.elegir('escopeta');
    if (input.hit('arma3')) this.weapons.elegir('uzi');
    if (input.hit('recargar')) this.weapons.siguiente();
    if (input.hit('radio') && this.audio.radio)
      this.missions.say('Radio: ' + this.audio.radio.cambiar(), 3);

    if (input.is('fire')) {
      const r = this.weapons.disparar(dt, !input.hit('fire'));
      if (r === 'sin balas' && !this.avisoBalas) {
        this.avisoBalas = true; this.missions.say('Sin balas. Comprá munición en la armería.', 3);
      }
      if (r && r !== 'sin balas') this.avisoBalas = false;
    } else { this.weapons.soltar(); this.weapons.cool = Math.max(0, this.weapons.cool - dt); }
    this.weapons.update(dt);

    for (const t of this.police.disparos) {
      if (this.weapons.bloqueado(t.x, t.z, t.tx, t.tz, this.solidsNear)) continue;
      this.player.danar(t.dano);
      this.player.shake = Math.max(this.player.shake, 0.35);
      this.audio.bang(5);
    }

    // Los negocios robados se enfrían solos.
    for (const pl of this.places.list) if (pl.robadoT > 0) pl.robadoT -= dt;

    this.actualizarGps(dt);
    this.save.update(dt);
    this.missions.update(dt);
    this.bustedOrDead();
    this.player.updateCamera(this.camera, dt, input);

    // Audio
    let sirenProx = 0;
    for (const u of this.police.units) {
      if (!u.active) continue;
      const d = Math.hypot(u.car.x - p.x, u.car.z - p.z);
      sirenProx = Math.max(sirenProx, clamp(1 - d / 130, 0, 1));
    }
    this.audio.update(dt, {
      driving: !!pc, kmh: pc ? pc.kmh : 0, throttle: pc ? pc.throttle : 0,
      slip: pc ? pc.slip : 0, sirenProximity: sirenProx,
    });

    this.player.gun.visible = this.weapons.armado && this.player.mode === 'foot';
    this.hud.update(this);
    input.endFrame();
  }

  loop(now) {
    requestAnimationFrame(this.loop.bind(this));
    let dt = (now - this.last) / 1000;
    this.last = now;
    if (dt > 0.08) dt = 0.08;          // si la pestaña estuvo en segundo plano
    if (dt <= 0) return;
    this.update(dt);
    this.renderer.render(this.scene, this.camera);
  }
}

const game = new Game();
window.game = game;
game.init().catch(err => {
  document.getElementById('carga').textContent = 'Se rompió: ' + err.message;
  console.error(err);
});
