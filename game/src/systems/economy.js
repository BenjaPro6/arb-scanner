import { CFG } from '../core/config.js';

// El sistema que ningún GTA tiene: la guita se derrite mientras la tenés.
//
// priceIndex sube exponencialmente en tiempo real. Los pagos de las misiones
// están indexados, así que nominalmente cobrás cada vez más — pero si dejás
// los pesos quietos en el bolsillo, tu poder adquisitivo cae solo.
// La salida es el dólar: corrés a una cueva y comprás. Pero para llegar a la
// cueva tenés que manejar, y manejar con estrellas encima es otro problema.
export class Economy {
  constructor(rng) {
    this.rng = rng;
    this.pesos = 45000;
    this.usd = 0;
    this.priceIndex = 1;
    this.blueNoise = 0;
    this.rate = Math.log(1 + CFG.INFLATION_PER_MIN) / 60;   // por segundo
    this.history = [];
    this.peakReal = this.realWealth;
  }

  get blue() {
    return CFG.BLUE_BASE * this.priceIndex * (1 + this.blueNoise);
  }
  // Riqueza medida en pesos del día uno. Es el único número que importa.
  get realWealth() { return this.pesos / this.priceIndex + this.usd * CFG.BLUE_BASE; }
  get power() { return this.pesos / this.priceIndex; }

  update(dt) {
    this.priceIndex *= Math.exp(this.rate * dt);
    // Camino aleatorio con reversión a la media para el blue.
    this.blueNoise += (this.rng() - 0.5) * CFG.BLUE_VOL * dt * 2 - this.blueNoise * 0.25 * dt;
    this.blueNoise = Math.max(-0.18, Math.min(0.28, this.blueNoise));
    this.peakReal = Math.max(this.peakReal, this.realWealth);
  }

  // La cueva se queda con la diferencia, como corresponde.
  buyUsd(pesosIn) {
    const rate = this.blue * 1.025;
    const amount = Math.min(pesosIn, this.pesos);
    if (amount < 1) return 0;
    const got = amount / rate;
    this.pesos -= amount; this.usd += got;
    return got;
  }
  sellUsd(usdIn) {
    const rate = this.blue * 0.975;
    const amount = Math.min(usdIn, this.usd);
    if (amount < 0.01) return 0;
    const got = amount * rate;
    this.usd -= amount; this.pesos += got;
    return got;
  }

  // Los pagos vienen indexados: 20.000 "de hoy" valen más nominalmente mañana.
  pay(realAmount) {
    const nominal = realAmount * this.priceIndex;
    this.pesos += nominal;
    return nominal;
  }
  charge(realAmount) {
    const nominal = realAmount * this.priceIndex;
    if (this.pesos < nominal) return false;
    this.pesos -= nominal;
    return true;
  }
}
