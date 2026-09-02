import * as THREE from 'three';
import { Vehicle, TC } from './sim/vehicle.js';
import { generarCircuito, superficie } from './track/track.js';
import { construirCircuito } from './track/mesh.js';
import { Wheel } from './input/wheel.js';
import { Timing, reloj } from './race/timing.js';
import { Hud } from './ui/hud.js';
import { clamp, lerp, angDelta } from './core/utils.js';
import { MeshBuilder } from './core/meshbuilder.js';

// La física corre a paso FIJO de 400 Hz, desacoplada del dibujo. Esto no es
// un capricho: a 60 Hz el volante se siente gomoso y el neumático pierde el
// pico. Es la diferencia entre un simulador y un jueguito.
const HZ = 400, DT = 1 / HZ;
const SEMILLA = Number(new URLSearchParams(location.search).get('pista') || 7);

class Juego {
  async init() {
    const paso = (t) => new Promise(r => {
      document.getElementById('carga').textContent = t;
      requestAnimationFrame(() => requestAnimationFrame(r));
    });

    await paso('Trazando el circuito…');
    this.circuito = generarCircuito(SEMILLA);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    document.body.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x8fb6d9);
    this.scene.fog = new THREE.Fog(0x8fb6d9, 320, 1500);
    this.camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.3, 3000);

    await paso('Asfaltando…');
    construirCircuito(this.circuito, this.scene);

    this.scene.add(new THREE.HemisphereLight(0xbdd6f5, 0x4a5240, 1.15));
    const sol = new THREE.DirectionalLight(0xfff2d8, 1.9);
    sol.position.set(220, 340, 140);
    this.scene.add(sol);

    await paso('Bajando el auto del camión…');
    this.auto = new Vehicle(TC);
    this.colocarEnGrilla();
    this.mallaAuto = this.construirAuto();
    this.scene.add(this.mallaAuto);

    this.wheel = new Wheel();
    this.timing = new Timing(this.circuito, SEMILLA);
    this.hud = new Hud();
    this.aviso = ''; this.avisoT = 0;
    this.sActual = 0;
    this.acumulado = 0;
    this.camPos = new THREE.Vector3();

    addEventListener('resize', () => this.onResize());
    addEventListener('keydown', (e) => {
      if (e.code === 'KeyR') this.colocarEnPista();
      if (e.code === 'KeyC') this.calibrar();
    });

    document.getElementById('splash').classList.add('listo');
    this.decir(this.wheel.conectado ? 'Volante detectado' : 'Sin volante: se juega con W A S D', 3);
    this.last = performance.now();
    requestAnimationFrame(this.loop.bind(this));
  }

  decir(t, s = 2.5) { this.aviso = t; this.avisoT = s; }

  colocarEnGrilla() {
    const m = this.circuito.linea.en(this.circuito.largo - 40);
    this.auto.x = m.x; this.auto.z = m.z;
    this.auto.yaw = Math.atan2(m.tx, m.tz);
    this.auto.u = 0; this.auto.v = 0; this.auto.r = 0;
  }

  // Volver a pista mirando hacia adelante, sin perder la posición de vuelta.
  colocarEnPista() {
    const m = this.circuito.linea.en(this.sActual);
    this.auto.x = m.x; this.auto.z = m.z;
    this.auto.yaw = Math.atan2(m.tx, m.tz);
    this.auto.u = 0; this.auto.v = 0; this.auto.r = 0;
    this.auto.roll = this.auto.pitch = this.auto.zs = 0;
    this.auto.droll = this.auto.dpitch = this.auto.dzs = 0;
    for (const k of ['DI', 'DD', 'TI', 'TD']) this.auto.w[k] = 0;
    this.timing.valida = false;
    this.decir('De vuelta en pista (vuelta invalidada)', 2);
  }

  construirAuto() {
    const g = new THREE.Group();
    const b = new MeshBuilder();
    const hw = 0.76, hl = 2.15;   // más angosta que la trocha: las ruedas tienen que asomar
    b.box(-hw, -hl, hw, hl, 0.28, 0.72, 2, 2, 2);
    b.box(-hw * 0.82, -hl * 0.34, hw * 0.82, hl * 0.52, 0.72, 1.12, 2, 2, 2);
    b.box(-hw * 1.02, hl - 0.28, hw * 1.02, hl, 0.30, 0.55, 2, 2, 2);
    const cuerpo = new THREE.Mesh(b.toGeometry(), new THREE.MeshLambertMaterial({ color: 0xd8382f }));
    cuerpo.castShadow = true; g.add(cuerpo);

    const vidrio = new THREE.Mesh(new THREE.BoxGeometry(1.28, 0.34, 0.9),
      new THREE.MeshLambertMaterial({ color: 0x101418 }));
    vidrio.position.set(0, 0.94, 0.42); g.add(vidrio);

    const alerón = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.07, 0.36),
      new THREE.MeshLambertMaterial({ color: 0x1c1f24 }));
    alerón.position.set(0, 1.14, -hl + 0.18); g.add(alerón);

    const rg = new THREE.CylinderGeometry(0.315, 0.315, 0.26, 14);
    rg.rotateZ(Math.PI / 2);
    const rm = new THREE.MeshLambertMaterial({ color: 0x15171b });
    this.ruedas = {};
    for (const [k, lo, la] of [['DI', 1.28, -0.86], ['DD', 1.28, 0.86], ['TI', -1.34, -0.86], ['TD', -1.34, 0.86]]) {
      const w = new THREE.Mesh(rg, rm);
      w.position.set(la, 0.315, lo);
      g.add(w); this.ruedas[k] = w;
    }
    return g;
  }

  onResize() {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
  }

  calibrar() {
    if (this.wheel.calibrando) return;
    this.wheel.empezarCalibracion();
    this.decir('CALIBRANDO: girá el volante de tope a tope y pisá los tres pedales a fondo', 6);
    setTimeout(() => {
      const ejes = this.wheel.terminarCalibracion();
      this.decir(ejes && ejes.length
        ? `Calibrado: ${ejes.length} ejes reconocidos (${ejes.map(e => 'eje ' + e.i).join(', ')})`
        : 'No se movió ningún eje. ¿Está conectado el volante?', 5);
    }, 6000);
  }

  fisica(dt) {
    const e = this.wheel.estado(this.auto.kmh);
    const a = this.auto;
    // La convención interna es que mandos.volante positivo dobla a la
    // izquierda; el jugador espera que girar a la derecha doble a la derecha.
    a.mandos.volante = -e.volante;
    a.mandos.acelerador = e.acelerador;
    a.mandos.freno = e.freno;
    a.mandos.mano = e.mano;

    // El agarre cambia según dónde estén las ruedas: asfalto, piano o pasto.
    const p = this.circuito.linea.proyectar(a.x, a.z, this.sActual);
    this.sActual = ((p.s % this.circuito.largo) + this.circuito.largo) % this.circuito.largo;
    const sup = superficie(this.circuito, p.lateral, this.sActual);
    a.s = { ...TC, mu: TC.mu * sup.mu };
    this.superficie = sup;

    a.paso(dt);
    this.timing.update(dt, this.sActual, sup.tipo === 'asfalto' || sup.tipo === 'piano');
  }

  update(dtReal) {
    if (this.wheel.calibrando) this.wheel.pasoCalibracion(dtReal);
    this.avisoT = Math.max(0, this.avisoT - dtReal);

    // Acumulador de paso fijo: la física no depende de los cuadros por segundo.
    this.acumulado += Math.min(dtReal, 0.25);
    let pasos = 0;
    while (this.acumulado >= DT && pasos < 240) {
      const antes = this.timing.vuelta;
      this.fisica(DT);
      if (this.timing.vuelta > antes && this.timing.ultima != null) {
        const r = this.timing.vueltas[this.timing.vueltas.length - 1];
        this.decir(r.valida
          ? (this.timing.mejor === r.t ? `RÉCORD · ${reloj(r.t)}` : `Vuelta ${reloj(r.t)}`)
          : `Vuelta inválida (${reloj(r.t)}) — te fuiste de pista`, 3.5);
      }
      this.acumulado -= DT;
      pasos++;
    }

    const a = this.auto;
    this.mallaAuto.position.set(a.x, -a.zs * 0.6, a.z);
    this.mallaAuto.rotation.set(a.pitch * 0.55, a.yaw, -a.roll * 0.85, 'YXZ');
    for (const k of ['DI', 'DD', 'TI', 'TD']) {
      const w = this.ruedas[k];
      w.rotation.x = a.w[k] * 0.35;
      w.rotation.y = k[0] === 'D' ? a.mandos.volante * TC.volanteMax : 0;
    }

    this.camara(dtReal);
    this.hud.update(this);
  }

  camara(dt) {
    const a = this.auto;
    const f = a.adelante();
    const vel = clamp(a.velocidad / 60, 0, 1);
    const dist = lerp(8.2, 11.4, vel);
    const alto = lerp(3.3, 4.0, vel);
    const objetivo = new THREE.Vector3(a.x - f.x * dist, alto, a.z - f.z * dist);
    if (this.camPos.lengthSq() === 0) this.camPos.copy(objetivo);
    this.camPos.lerp(objetivo, Math.min(1, dt * 7));
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(a.x + f.x * 9, 0.9, a.z + f.z * 9);
    // El campo de visión se abre con la velocidad: da sensación de vértigo.
    const fov = lerp(60, 76, vel);
    if (Math.abs(this.camera.fov - fov) > 0.15) {
      this.camera.fov = fov; this.camera.updateProjectionMatrix();
    }
  }

  loop(now) {
    requestAnimationFrame(this.loop.bind(this));
    let dt = (now - this.last) / 1000;
    this.last = now;
    if (dt <= 0) return;
    this.update(Math.min(dt, 0.1));
    this.renderer.render(this.scene, this.camera);
  }
}

const juego = new Juego();
window.juego = juego;
juego.init().catch(e => {
  document.getElementById('carga').textContent = 'Se rompió: ' + e.message;
  console.error(e);
});
