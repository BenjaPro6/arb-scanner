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
import { Hud } from './ui/hud.js';

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

    this.missions = new Missions(this);
    this.hud = new Hud();

    this.hour = CFG.START_HOUR;
    this.piquete = { edge: null, t: 26, mesh: null };
    this.tmpCars = [];
    this.stats = { fps: 60, acc: 0, frames: 0 };

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
      best.obj.mode = 'own';
      best.obj.active = true;
      this.police.crime('robo');
      this.missions.say(`Te llevaste un ${best.car.spec.name}.`, 2.2);
    } else if (best.kind === 'police') {
      this.police.crime('robo', 2);
      this.police.retire(best.obj);
      this.missions.say('Le afanaste el patrullero a la cana. Buena idea, seguro.', 3);
    }
    this.player.enter(best.obj, best.car);
  }

  interactPlaces() {
    const p = this.player.pos;
    const cueva = this.places.near(p.x, p.z, 'cueva');
    if (cueva) {
      if (this.input.hit('use')) {
        const got = this.economy.buyUsd(this.economy.pesos);
        if (got > 0) this.missions.say(`Compraste US$${got.toFixed(0)} a ${pesos(this.economy.blue * 1.025)}.`, 3);
      }
      if (this.input.hit('horn')) {
        const got = this.economy.sellUsd(this.economy.usd);
        if (got > 0) this.missions.say(`Vendiste y te llevaste ${pesos(got)}.`, 3);
      }
      if (!this.cuevaHint) { this.missions.say('Cueva: F para comprar dólares, H para vender.', 2.5); this.cuevaHint = true; }
    } else this.cuevaHint = false;

    const taller = this.places.near(p.x, p.z, 'taller');
    if (taller && this.player.mode === 'drive' && this.player.car.speed < 6) {
      if (this.tallerCool > 0) return;
      const cost = 15000;
      if (this.economy.charge(cost)) {
        this.player.car.damage = 0;
        const had = this.police.wanted();
        this.police.clear();
        this.tallerCool = 4;
        this.missions.say(had ? 'Chapa, pintura y a otra cosa. Se te fue la cana.' : 'Quedó como nuevo.', 3.5);
      } else if (!this.tallerWarn) {
        this.missions.say('No te alcanza para el taller.', 2.5); this.tallerWarn = true;
      }
    } else this.tallerWarn = false;
  }

  bustedOrDead() {
    if (this.police.busted > 2.2) {
      this.police.busted = 0;
      const fine = this.economy.pesos * 0.35;
      this.economy.pesos -= fine;
      this.police.clear();
      this.respawn();
      this.missions.say(`Te levantaron. Se fueron ${pesos(fine)} en coimas y trámites.`, 5);
      if (this.missions.current) { this.missions.failed++; this.missions.finish(); }
    }
    if (this.player.health <= 0) {
      this.player.health = 100;
      const fine = this.economy.pesos * 0.20;
      this.economy.pesos -= fine;
      this.police.clear();
      this.respawn();
      this.missions.say('Zafaste de milagro. La cuenta del hospital no.', 5);
      if (this.missions.current) { this.missions.failed++; this.missions.finish(); }
    }
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

    // El auto propio sigue existiendo aunque me baje.
    if (this.player.vehicle !== this.ownCar) {
      const c = this.ownCar.car;
      c.throttle = 0; c.steer = 0; c.step(dt);
      collideWorld(c, this.solidsNear(c.x, c.z), null);
      this.ownCar.mesh.position.set(c.x, 0, c.z);
      this.ownCar.mesh.rotation.y = c.yaw;
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
