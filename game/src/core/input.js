// Teclado + mouse. La cámara se mueve con el mouse y el WASD camina relativo
// a hacia dónde estás mirando, como en cualquier tercera persona moderna.
const MAP = {
  KeyW: 'up', ArrowUp: 'up',
  KeyS: 'down', ArrowDown: 'down',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
  Space: 'handbrake',
  ShiftLeft: 'sprint', ShiftRight: 'sprint',
  KeyF: 'use',
  KeyQ: 'camleft', KeyE: 'camright',
  KeyH: 'horn',
  KeyM: 'radio',
  ControlLeft: 'fire', ControlRight: 'fire',   // alternativa al clic
  KeyR: 'recargar',
  KeyG: 'robar',
  KeyB: 'chaleco',
  Tab: 'mapa',
  Digit1: 'arma1', Digit2: 'arma2', Digit3: 'arma3',
  KeyC: 'camera',
};

export class Input {
  constructor() {
    this.down = new Set();
    this.pressed = new Set();
    this.mx = 0; this.my = 0;      // desplazamiento de mouse acumulado
    this.wheel = 0;
    this.locked = false;
    this.dragging = false;
    this.invertY = false;

    addEventListener('keydown', (e) => {
      const a = MAP[e.code];
      if (a) { e.preventDefault(); if (!this.down.has(a)) this.pressed.add(a); this.down.add(a); }
      if (e.code === 'Escape') this.pressed.add('pause');
    });
    addEventListener('keyup', (e) => {
      const a = MAP[e.code];
      if (a) { e.preventDefault(); this.down.delete(a); }
    });
    addEventListener('blur', () => { this.down.clear(); this.dragging = false; });
  }

  // El bloqueo de puntero es lo ideal, pero dentro de un iframe puede estar
  // prohibido. Si falla, se puede mirar arrastrando con el botón apretado.
  attach(canvas) {
    this.canvas = canvas;
    canvas.style.cursor = 'crosshair';
    // Botón izquierdo dispara. Para mirar está el mouse con el puntero
    // capturado; si el navegador no lo permite (pasa dentro de un iframe),
    // se mira arrastrando con el botón derecho.
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 2) { this.dragging = true; return; }
      if (e.button !== 0) return;
      if (!this.locked && canvas.requestPointerLock) {
        try { canvas.requestPointerLock(); } catch (_) { /* iframe sin permiso */ }
      }
      this.down.add('fire'); this.pressed.add('fire');
    });
    addEventListener('mouseup', (e) => {
      if (e.button === 2) this.dragging = false;
      if (e.button === 0) this.down.delete('fire');
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      canvas.style.cursor = this.locked ? 'none' : 'crosshair';
    });
    document.addEventListener('pointerlockerror', () => { this.locked = false; });
    addEventListener('mousemove', (e) => {
      if (!this.locked && !this.dragging) return;
      this.mx += e.movementX || 0;
      this.my += e.movementY || 0;
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.wheel += Math.sign(e.deltaY);
    }, { passive: false });
  }

  // Devuelve el movimiento del mouse desde el frame anterior y lo resetea.
  consumeMouse() {
    const r = { dx: this.mx, dy: this.my * (this.invertY ? -1 : 1), wheel: this.wheel };
    this.mx = 0; this.my = 0; this.wheel = 0;
    return r;
  }

  is(a) { return this.down.has(a); }
  hit(a) { return this.pressed.has(a); }
  axisY() { return (this.is('up') ? 1 : 0) - (this.is('down') ? 1 : 0); }
  axisX() { return (this.is('right') ? 1 : 0) - (this.is('left') ? 1 : 0); }
  endFrame() { this.pressed.clear(); }
}
