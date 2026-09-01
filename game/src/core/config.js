// Parámetros globales del mundo. Todo en metros y segundos.
export const CFG = {
  // --- Trama urbana ---
  // Buenos Aires es una grilla casi perfecta de manzanas de 100x100m.
  // Eso nos permite generar la ciudad *exacta*, no aproximada.
  BLOCK: 100,          // lado de manzana
  STREET: 16,          // calle común (dos manos angostas)
  AVENUE: 32,          // avenida (Corrientes, Santa Fe, Rivadavia...)
  MEGA: 110,           // 9 de Julio: la avenida más ancha del mundo
  COLS: 26,            // manzanas de este a oeste
  ROWS: 26,            // manzanas de norte a sur
  AVENUE_EVERY: 5,     // cada cuántas calles hay una avenida

  // --- Simulación ---
  TRAFFIC_CARS: 70,
  PED_COUNT: 90,
  SIM_RADIUS: 420,     // radio alrededor del jugador donde vive la simulación
  DESPAWN_RADIUS: 620,

  // --- Física ---
  GRAVITY: 9.81,

  // --- Policía ---
  WANTED_MAX: 5,
  HEAT_DECAY: 0.055,   // estrellas por segundo cuando estás escondido
  HIDE_TIME: 6.0,      // segundos fuera de vista para empezar a enfriar

  // --- Economía ---
  // La inflación es el sistema que ningún GTA tiene: tu plata se derrite.
  INFLATION_PER_MIN: 0.055,   // 5.5% de suba de precios por minuto real
  BLUE_BASE: 1200,            // pesos por dólar al empezar
  BLUE_VOL: 0.04,             // volatilidad del blue

  // --- Ciclo de día ---
  DAY_LENGTH: 480,     // segundos reales por día completo
  START_HOUR: 19.5,    // arrancamos al atardecer, que es cuando BA se ve mejor
};

// Barrios. Cada uno cambia altura, color, densidad y textura de fachada.
export const DISTRICTS = {
  microcentro: { h: [34, 78], w: 0.92, hue: '#8b8f96', win: '#cfd6de', dens: 1.00, name: 'Microcentro' },
  maderos:     { h: [55, 130], w: 0.80, hue: '#3f5a6b', win: '#9fd8ff', dens: 0.55, name: 'Puerto Madero' },
  palermo:     { h: [16, 40], w: 0.88, hue: '#b8a894', win: '#ffe3b0', dens: 0.92, name: 'Palermo' },
  sanTelmo:    { h: [8, 16], w: 0.95, hue: '#c2a071', win: '#ffe6bb', dens: 0.98, name: 'San Telmo' },
  boca:        { h: [6, 12], w: 0.95, hue: '#d05a2a', win: '#ffd98a', dens: 0.95, name: 'La Boca' },
  once:        { h: [14, 34], w: 0.96, hue: '#9a8d7d', win: '#ffdca8', dens: 1.00, name: 'Once' },
  barrio:      { h: [6, 14], w: 0.90, hue: '#a8907c', win: '#ffddaa', dens: 0.85, name: 'Barrio' },
};
