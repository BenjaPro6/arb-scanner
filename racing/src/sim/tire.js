// Modelo de neumático tipo Pacejka (fórmula mágica). La diferencia con el
// modelo lineal del GTA es que ESTE TIENE PICO: la fuerza crece con la deriva
// hasta un máximo y después CAE. Ese pico y esa caída son exactamente lo que
// sentís en las manos cuando el auto se te va, y lo que un volante con force
// feedback tiene que transmitir. Sin esto, un juego de volante no existe.
//
//   F = D · sin( C · atan( B·s − E·(B·s − atan(B·s)) ) )
//
// D es el pico (μ·Fz), C la forma, B la rigidez y E la asimetría de la caída.

// B, C y E resueltos para que el pico caiga donde cae en un neumático real.
// Ojo: los coeficientes que se publican suelen estar en GRADOS; acá todo va en
// radianes, y confundirlo deja la curva sin pico (sube y nunca cae).
export const LATERAL = { B: 10.14, C: 1.9, E: 0.6, pico: 0.1309 };    // pico a 7,5° de deriva
export const LONGITUDINAL = { B: 15.96, C: 1.65, E: 0.5, pico: 0.11 }; // pico a 11% de deslizamiento

function magica(s, p) {
  const bs = p.B * s;
  return Math.sin(p.C * Math.atan(bs - p.E * (bs - Math.atan(bs))));
}

// Fuerza lateral pura. alpha en radianes, Fz en newtons.
export function lateral(alpha, Fz, mu) {
  return -mu * Fz * magica(alpha, LATERAL);
}

// Fuerza longitudinal pura. kappa es el deslizamiento (adimensional).
export function longitudinal(kappa, Fz, mu) {
  return mu * Fz * magica(kappa, LONGITUDINAL);
}

// Elipse de fricción: acelerar y doblar comparten el mismo agarre. Si pedís
// las dos cosas al mismo tiempo, las dos bajan. Es lo que hace que frenar y
// girar juntos te mande de trompa afuera.
export function combinado(alpha, kappa, Fz, mu) {
  if (Fz <= 0) return { fx: 0, fy: 0, uso: 0 };
  // Se normaliza cada deslizamiento contra su propio pico y se combinan: el
  // agarre es uno solo y se reparte entre doblar y traccionar.
  const sa = alpha / LATERAL.pico;
  const sk = kappa / LONGITUDINAL.pico;
  const s = Math.hypot(sa, sk);
  if (s < 1e-7) return { fx: 0, fy: 0, uso: 0 };
  const total = mu * Fz * magica(s * LATERAL.pico, LATERAL);
  return {
    fx: (sk / s) * total,
    fy: -(sa / s) * total,
    uso: s,                       // 1 = justo en el límite de agarre
  };
}

// La carga no da agarre lineal: al doblar el peso, el agarre sube menos del
// doble. Por eso transferir peso a una rueda cuesta agarre total, y por eso
// una barra estabilizadora dura de un lado hace que ese eje pierda antes.
export function muEfectivo(muNominal, Fz, FzNominal = 4000) {
  if (Fz <= 0) return 0;
  return muNominal * Math.pow(FzNominal / Math.max(Fz, 200), 0.11);
}
