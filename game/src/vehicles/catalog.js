// El parque automotor porteño. Las medidas están en metros y son las reales
// aproximadas: un Falcon mide 4.7m, un bondi 12m.
export const VEHICLES = {
  falcon: {
    name: 'Falcon', L: 4.70, W: 1.80, H: 1.42, mass: 1290,
    power: 4200, brake: 11000, grip: 1.02, topSpeed: 46, steerMax: 0.56,
    colors: ['#6f7a55', '#8a2f28', '#c9c3b2', '#2f3a4a', '#7a6a4f'],
    roofBox: [0.24, 0.62], class: 'sedan',
  },
  r12: {
    name: 'R12', L: 4.35, W: 1.64, H: 1.44, mass: 950,
    power: 3050, brake: 8100, grip: 0.96, topSpeed: 40, steerMax: 0.60,
    colors: ['#c8a13a', '#b6bcc0', '#3c6b52', '#9a3b2f', '#e0ddd2'],
    roofBox: [0.26, 0.66], class: 'sedan',
  },
  taxi: {
    name: 'Taxi', L: 4.55, W: 1.74, H: 1.46, mass: 1180,
    power: 3850, brake: 10000, grip: 1.00, topSpeed: 43, steerMax: 0.58,
    colors: ['#111111'], roofColor: '#f2c200',
    roofBox: [0.25, 0.63], class: 'sedan', taxi: true,
  },
  bondi: {
    name: 'Bondi 60', L: 11.8, W: 2.55, H: 3.15, mass: 12000,
    power: 14500, brake: 96000, grip: 0.80, topSpeed: 28, steerMax: 0.34,
    colors: ['#c62828'], roofColor: '#1f4b8f',
    roofBox: [0.04, 0.88], class: 'bus',
  },
  pickup: {
    name: 'F100', L: 5.30, W: 1.95, H: 1.82, mass: 1750,
    power: 5100, brake: 14900, grip: 0.94, topSpeed: 42, steerMax: 0.50,
    colors: ['#2a4a6a', '#7d1f1f', '#d9d4c4', '#3f4a3a'],
    roofBox: [0.46, 0.76], class: 'pickup',
  },
  deportivo: {
    name: 'Torino', L: 4.62, W: 1.83, H: 1.32, mass: 1210,
    power: 6500, brake: 10800, grip: 1.16, topSpeed: 58, steerMax: 0.54,
    colors: ['#b21f1f', '#101418', '#e8e2d4', '#1c4f8a'],
    roofBox: [0.27, 0.60], class: 'coupe',
  },
  patrullero: {
    name: 'Patrullero', L: 4.80, W: 1.84, H: 1.48, mass: 1350,
    power: 6100, brake: 11800, grip: 1.14, topSpeed: 52, steerMax: 0.58,
    colors: ['#ffffff'], roofColor: '#1b3a8a',
    roofBox: [0.24, 0.62], class: 'sedan', police: 'federal',
  },
  bonaerense: {
    name: 'Bonaerense', L: 4.95, W: 1.92, H: 1.72, mass: 1620,
    power: 6400, brake: 14000, grip: 1.06, topSpeed: 50, steerMax: 0.52,
    colors: ['#1a1a1a'], roofColor: '#8a1420',
    roofBox: [0.42, 0.74], class: 'pickup', police: 'bonaerense',
  },
};

export const CIVILIAN = ['falcon', 'r12', 'taxi', 'pickup', 'deportivo', 'bondi'];
// El bondi aparece menos: uno cada tantos autos.
export const CIVILIAN_WEIGHTS = [26, 24, 18, 14, 10, 8];

export function pickCivilian(rng) {
  const total = CIVILIAN_WEIGHTS.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < CIVILIAN.length; i++) {
    r -= CIVILIAN_WEIGHTS[i];
    if (r <= 0) return CIVILIAN[i];
  }
  return 'falcon';
}
