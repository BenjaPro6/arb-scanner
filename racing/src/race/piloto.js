import { clamp, angDelta } from '../core/utils.js';

// ⚠ INCOMPLETO — NO ESTÁ ENCHUFADO AL JUEGO.
//
// Piloto automático por persecución pura, pensado como rival y como conductor
// de pruebas. Sigue la traza y calcula la frenada por radio y agarre, pero HOY
// NO COMPLETA UNA VUELTA: se va de pista en las curvas encadenadas y no sabe
// recuperarse cuando queda cruzado o andando para atrás.
//
// Lo que falta, sabido:
//   - Traza optimizada (entrada ancha, vértice, salida) en vez del eje de pista
//   - Máquina de estados con recuperación: detectar trompo y reencarar
//   - Ajustar la frenada midiendo contra vueltas reales, no contra la teoría
//
// Se deja en el repo porque el andamiaje sirve, no porque funcione.
export class Piloto {
  constructor(circuito, opciones = {}) {
    this.c = circuito;
    this.agresividad = opciones.agresividad ?? 0.86;   // 1 = al límite teórico
    this.horizonte = opciones.horizonte ?? 320;        // metros que mira adelante para frenar
    this.s = 0;
  }

  // Velocidad máxima a la que se puede pasar por una curvatura dada.
  vMax(curv, mu) {
    const k = Math.abs(curv);
    if (k < 1e-5) return 999;
    return Math.sqrt(mu * 9.81 / k) * this.agresividad;
  }

  conducir(auto, sActual, lateral = 0, mu = 1.35) {
    this.s = sActual;
    const v = auto.velocidad;
    const L = auto.s.a + auto.s.b;

    // Persecución pura: se calcula la CURVATURA necesaria para llegar al punto
    // de mira y de ahí el ángulo de rueda, en vez de multiplicar un error
    // angular por una ganancia. La diferencia importa: una ganancia fija pide
    // ángulos imposibles a alta velocidad y el auto hace trompo.
    const Ld = clamp(11 + v * 0.72, 14, 75);
    const obj = this.c.linea.en(sActual + Ld);
    const dx = obj.x - auto.x, dz = obj.z - auto.z;
    const dist = Math.max(6, Math.hypot(dx, dz));
    const alfa = angDelta(auto.yaw, Math.atan2(dx, dz));
    let delta = Math.atan(2 * L * Math.sin(alfa) / dist);

    // Corrección de desvío. Volante positivo gira a la izquierda y la normal
    // de la traza apunta a la derecha, así que el signo va en más.
    delta += clamp(lateral * 0.016, -0.09, 0.09);
    const volante = clamp(delta / auto.s.volanteMax, -1, 1);

    let acelerador = 1, freno = 0;
    const desac = mu * 7.2;
    for (let d = 6; d < this.horizonte; d += 6) {
      const m = this.c.linea.en(sActual + d);
      const vc = this.vMax(m.curv, mu);
      if (vc >= v) continue;
      const necesaria = (v * v - vc * vc) / (2 * desac);
      const margen = 14;
      if (necesaria > d - margen) { freno = clamp((necesaria - d + margen) / 18, 0, 1); acelerador = 0; break; }
    }
    const aqui = this.vMax(this.c.linea.en(sActual + 6).curv, mu);
    if (v > aqui * 1.04) { acelerador = 0; freno = Math.max(freno, 0.3); }
    else if (freno === 0) acelerador = clamp(1 - Math.abs(volante) * 0.5, 0.3, 1);

    // Elipse de fricción: el agarre es UNO SOLO. Frenar a fondo mientras
    // doblás pide más de lo que hay y el auto se va de trompa o hace trompo.
    // El freno cede ante la dirección, que es lo que hace un piloto de verdad.
    const giro = Math.abs(volante);
    freno *= clamp(1 - giro * 1.25, 0.12, 1);
    acelerador *= clamp(1 - giro * 0.75, 0.22, 1);

    auto.mandos.volante = volante;
    auto.mandos.acelerador = acelerador;
    auto.mandos.freno = freno;
    auto.mandos.mano = false;
    return { volante, acelerador, freno };
  }
}
