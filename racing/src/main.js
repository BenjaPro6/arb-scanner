import * as THREE from 'three';
import { Vehicle } from './sim/vehicle.js';
import { AUTOS, aplicarMejoras } from './sim/catalogo.js';
import { construirAuto } from './sim/malla.js';
import { generarCircuito, superficie } from './track/track.js';
import { construirCircuito } from './track/mesh.js';
import { Wheel } from './input/wheel.js';
import { Timing, reloj } from './race/timing.js';
import { Carrera } from './race/carrera.js';
import { Puntaje } from './race/puntaje.js';
import { Progreso } from './race/progreso.js';
import { Hud } from './ui/hud.js';
import { Menu, EVENTOS } from './ui/menu.js';
import { clamp, lerp } from './core/utils.js';

// La física corre a paso FIJO de 400 Hz, desacoplada del dibujo: a 60 Hz el
// volante se siente gomoso y el neumático pierde el pico de agarre.
const HZ = 400, DT = 1 / HZ;

class Juego {
  async init() {
    const paso = (t) => new Promise(r => {
      document.getElementById('carga').textContent = t;
      requestAnimationFrame(() => requestAnimationFrame(r));
    });

    await paso('Abriendo el garage…');
    this.progreso = new Progreso();

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    document.body.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x8fb6d9);
    this.scene.fog = new THREE.Fog(0x8fb6d9, 340, 1600);
    this.camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.3, 3000);
    this.scene.add(new THREE.HemisphereLight(0xbdd6f5, 0x4a5240, 1.15));
    const sol = new THREE.DirectionalLight(0xfff2d8, 1.9);
    sol.position.set(220, 340, 140); this.scene.add(sol);
    this.mallaPista = null;
    // Se crea antes de rearmarAuto(): colocarEnGrilla lo usa.
    this.camPos = new THREE.Vector3();
    this.sActual = 0; this.acumulado = 0; this.choque = 0;

    await paso('Trazando el circuito…');
    this.pista = 7;
    this.cargarPista(7);

    await paso('Bajando el auto del camión…');
    this.auto = null; this.mallaAuto = null;
    this.rearmarAuto();

    this.wheel = new Wheel();
    this.hud = new Hud();
    this.menu = new Menu(this);
    this.carrera = new Carrera(this.circuito, this.scene);
    this.puntaje = new Puntaje();
    this.aviso = ''; this.avisoT = 0;
    this.modo = 'practica';

    addEventListener('resize', () => this.onResize());
    addEventListener('keydown', (e) => {
      if (e.code === 'Tab') { e.preventDefault(); this.alternarMenu(); }
      if (e.code === 'KeyR') this.volverAPista();
      if (e.code === 'KeyC') this.calibrar();
      if (e.code === 'Escape' && this.carrera.estado !== 'libre') this.terminarCarrera(true);
    });

    document.getElementById('splash').classList.add('listo');
    this.menu.abrir(true);
    this.last = performance.now();
    requestAnimationFrame(this.loop.bind(this));
  }

  decir(t, s = 2.5) { this.aviso = t; this.avisoT = s; }

  specActual() {
    const k = this.progreso.actual;
    return aplicarMejoras(AUTOS[k], this.progreso.mejorasDe(k));
  }

  cargarPista(semilla) {
    if (this.mallaPista) { this.scene.remove(this.mallaPista); }
    this.pista = semilla;
    this.circuito = generarCircuito(semilla);
    this.mallaPista = construirCircuito(this.circuito, this.scene);
    this.timing = new Timing(this.circuito, semilla);
    if (this.carrera) this.carrera.c = this.circuito;
    this.hud && (this.hud._lim = null);
  }

  // Rearma el auto del jugador con el modelo y las mejoras actuales.
  rearmarAuto() {
    const spec = this.specActual();
    const x = this.auto ? this.auto.x : 0, z = this.auto ? this.auto.z : 0, yaw = this.auto ? this.auto.yaw : 0;
    this.auto = new Vehicle(spec, x, z, yaw);
    if (this.mallaAuto) this.scene.remove(this.mallaAuto);
    this.mallaAuto = construirAuto(AUTOS[this.progreso.actual].color);
    this.scene.add(this.mallaAuto);
    this.ruedas = this.mallaAuto.userData.ruedas;
    if (this.circuito) this.colocarEnGrilla();
  }

  alternarMenu() {
    const abrir = !this.menu.abierto;
    this.menu.abrir(abrir);
    if (abrir && this.carrera.corriendo) this.decir('La carrera sigue corriendo', 2);
  }

  colocarEnGrilla(s = null, carril = 0) {
    const m = this.circuito.linea.en(s == null ? this.circuito.largo - 26 : s);
    this.auto.x = m.x + m.nx * carril; this.auto.z = m.z + m.nz * carril;
    this.auto.yaw = Math.atan2(m.tx, m.tz);
    this.auto.u = 0; this.auto.v = 0; this.auto.r = 0;
    this.auto.marcha = 1;
    for (const k in this.auto.w) this.auto.w[k] = 0;
    this.sActual = ((this.circuito.largo + (s == null ? -26 : s)) % this.circuito.largo);
    this.camPos.set(0, 0, 0);
  }

  volverAPista() {
    const m = this.circuito.linea.en(this.sActual);
    this.auto.x = m.x; this.auto.z = m.z;
    this.auto.yaw = Math.atan2(m.tx, m.tz);
    this.auto.u = Math.min(this.auto.u, 14); this.auto.v = 0; this.auto.r = 0;
    this.auto.zs = this.auto.pitch = this.auto.roll = 0;
    this.auto.dzs = this.auto.dpitch = this.auto.droll = 0;
    for (const k in this.auto.w) this.auto.w[k] = this.auto.u / this.auto.s.rueda;
    this.timing.valida = false;
    this.puntaje.romper('Volviste a pista');
    this.decir('De vuelta en pista (vuelta invalidada)', 2);
  }

  practicar(id) {
    const ev = EVENTOS.find(e => e.id === id);
    this.carrera.abandonar();
    this.modo = 'practica';
    if (ev.pista !== this.pista) this.cargarPista(ev.pista);
    this.colocarEnGrilla();
    this.decir(`Práctica libre · ${ev.nombre}`, 3);
  }

  empezarCarrera(id) {
    const ev = EVENTOS.find(e => e.id === id);
    if (ev.pista !== this.pista) this.cargarPista(ev.pista);
    this.modo = 'carrera';
    this.evento = ev;
    const g = this.carrera.preparar(ev, this.specActual());
    this.colocarEnGrilla(g.s, g.carril);
    this.puntaje = new Puntaje();
    this.progreso.carreras.corridas++;
    this.decir(`${ev.nombre} · ${ev.vueltas} vueltas`, 3);
  }

  terminarCarrera(abandono) {
    if (abandono) this.decir('Abandonaste la carrera', 3);
    this.carrera.abandonar();
    this.modo = 'practica';
  }

  onResize() {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
  }

  calibrar() {
    if (this.wheel.calibrando) return;
    this.wheel.empezarCalibracion();
    this.decir('CALIBRANDO: girá el volante de tope a tope y pisá los tres pedales', 6);
    setTimeout(() => {
      const ejes = this.wheel.terminarCalibracion();
      this.decir(ejes && ejes.length
        ? `Calibrado: ${ejes.length} ejes reconocidos`
        : 'No se movió ningún eje. ¿Está conectado el volante?', 5);
    }, 6000);
  }

  fisica(dt) {
    const a = this.auto;
    const largando = this.carrera.largando;
    const e = this.wheel.estado(a.kmh);
    // La convención interna es que volante positivo dobla a la izquierda.
    a.mandos.volante = -e.volante;
    a.mandos.acelerador = largando ? 0 : e.acelerador;
    a.mandos.freno = largando ? 1 : e.freno;
    a.mandos.mano = e.mano;

    const p = this.circuito.linea.proyectar(a.x, a.z, this.sActual);
    this.sActual = ((p.s % this.circuito.largo) + this.circuito.largo) % this.circuito.largo;
    const sup = superficie(this.circuito, p.lateral, this.sActual);
    this.superficie = sup;
    const base = this.specActual();
    a.s = { ...base, mu: base.mu * sup.mu };

    a.paso(dt);
    this.enPista = sup.tipo === 'asfalto' || sup.tipo === 'piano';
    this.timing.update(dt, this.sActual, this.enPista);

    const r = this.carrera.update(dt, this.sActual);
    if (r) this.cerrarResultado(r);

    // Choques contra los rivales: te empujan y te cortan la cadena.
    this.choque = Math.max(0, this.choque - dt * 8);
    for (const riv of this.carrera.rivales) {
      const dx = a.x - riv.x, dz = a.z - riv.z;
      const d = Math.hypot(dx, dz);
      if (d < 3.4 && d > 0.01) {
        const nx = dx / d, nz = dz / d, pen = 3.4 - d;
        a.x += nx * pen * 0.8; a.z += nz * pen * 0.8;
        const vn = a.u * 0.2;
        a.v += nx * 2.4; a.u *= 0.985;
        this.choque = Math.max(this.choque, Math.abs(vn) * 0.6 + 3);
        riv.v *= 0.985;
      }
    }
  }

  cerrarResultado(r) {
    this.puntaje.cobrar();
    this.progreso.sumarPuntos(this.puntaje.banco);
    const bonoPuntos = Math.round(this.puntaje.banco / 12);
    this.progreso.premiar(r.plata + bonoPuntos, r.xp);
    if (r.puesto === 1) this.progreso.carreras.ganadas++;
    this.progreso.guardar();
    this.resultado = { ...r, puntos: this.puntaje.banco, bonoPuntos };
    this.decir(`${r.puesto}º de ${r.total} · ${reloj(r.tiempo)} · +${(r.plata + bonoPuntos).toLocaleString('es-AR')}`, 8);
    setTimeout(() => { this.terminarCarrera(false); this.menu.abrir(true); }, 5200);
  }

  update(dtReal) {
    if (this.wheel.calibrando) this.wheel.pasoCalibracion(dtReal);
    this.avisoT = Math.max(0, this.avisoT - dtReal);

    if (!this.menu.abierto) {
      this.acumulado += Math.min(dtReal, 0.25);
      let pasos = 0;
      while (this.acumulado >= DT && pasos < 240) {
        const antes = this.timing.vuelta;
        this.fisica(DT);
        if (this.timing.vuelta > antes && this.timing.ultima != null) {
          const v = this.timing.vueltas[this.timing.vueltas.length - 1];
          if (v.valida && this.progreso.registrarVuelta(this.pista, v.t))
            this.decir(`RÉCORD · ${reloj(v.t)}`, 3);
          else if (v.valida) this.decir(`Vuelta ${reloj(v.t)}`, 2.5);
          else this.decir(`Vuelta inválida (${reloj(v.t)})`, 2.5);
        }
        this.acumulado -= DT;
        pasos++;
      }
      this.puntaje.update(dtReal, {
        auto: this.auto, enPista: this.enPista !== false,
        rivales: this.carrera.rivales, choque: this.choque,
      });
    }

    const a = this.auto;
    this.mallaAuto.position.set(a.x, -a.zs * 0.6, a.z);
    this.mallaAuto.rotation.set(a.pitch * 0.55, a.yaw, -a.roll * 0.85, 'YXZ');
    for (const k in this.ruedas) {
      const w = this.ruedas[k];
      w.rotation.x = a.w[k] * 0.35;
      w.rotation.y = k[0] === 'D' ? a.mandos.volante * a.s.volanteMax : 0;
    }

    this.camara(dtReal);
    this.hud.update(this);
  }

  camara(dt) {
    const a = this.auto, f = a.adelante();
    const vel = clamp(a.velocidad / 60, 0, 1);
    const dist = lerp(8.2, 11.4, vel), alto = lerp(3.3, 4.0, vel);
    const obj = new THREE.Vector3(a.x - f.x * dist, alto, a.z - f.z * dist);
    if (this.camPos.lengthSq() === 0) this.camPos.copy(obj);
    this.camPos.lerp(obj, Math.min(1, dt * 7));
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(a.x + f.x * 9, 0.9, a.z + f.z * 9);
    const fov = lerp(60, 76, vel);
    if (Math.abs(this.camera.fov - fov) > 0.15) { this.camera.fov = fov; this.camera.updateProjectionMatrix(); }
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
