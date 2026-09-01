// Teclado + estado de acciones. Soporta WASD y flechas.
const MAP = {
  KeyW: 'up', ArrowUp: 'up',
  KeyS: 'down', ArrowDown: 'down',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
  Space: 'handbrake',
  ShiftLeft: 'sprint', ShiftRight: 'sprint',
  KeyF: 'use', KeyE: 'use',
  KeyH: 'horn',
  KeyR: 'radio',
  KeyC: 'camera',
  Tab: 'map',
};

export class Input {
  constructor(dom) {
    this.down = new Set();
    this.pressed = new Set();     // se limpia cada frame
    this.paused = false;
    addEventListener('keydown', (e) => {
      const a = MAP[e.code];
      if (a) { e.preventDefault(); if (!this.down.has(a)) this.pressed.add(a); this.down.add(a); }
      if (e.code === 'Escape') this.pressed.add('pause');
    });
    addEventListener('keyup', (e) => {
      const a = MAP[e.code];
      if (a) { e.preventDefault(); this.down.delete(a); }
    });
    addEventListener('blur', () => this.down.clear());
  }
  is(a) { return this.down.has(a); }
  hit(a) { return this.pressed.has(a); }
  axisY() { return (this.is('up') ? 1 : 0) - (this.is('down') ? 1 : 0); }
  axisX() { return (this.is('right') ? 1 : 0) - (this.is('left') ? 1 : 0); }
  endFrame() { this.pressed.clear(); }
}
