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
    this.propiedades = [];      // negocios comprados
    this.rentaAcum = 0;
    this.peakReal = this.realWealth;
  }

  get blue() {
    return CFG.BLUE_BASE * this.priceIndex * (1 + this.blueNoise);
  }
  // Riqueza medida en pesos del día uno. Es el único número que importa.
  get realWealth() { return this.pesos / this.priceIndex + this.usd * CFG.BLUE_BASE; }
  get power() { return this.pesos / this.priceIndex; }

  // Renta total por minuto, en pesos de hoy.
  get rentaReal() { return this.propiedades.reduce((a, p) => a + p.renta, 0); }

  comprar(negocio) {
    if (negocio.dueno) return 'ya es tuyo';
    if (!this.charge(negocio.precio)) return 'sin plata';
    negocio.dueno = true;
    this.propiedades.push({ nombre: negocio.nombre, renta: negocio.renta });
    return 'comprado';
  }

  update(dt) {
    this.priceIndex *= Math.exp(this.rate * dt);
    // La renta también viene indexada: los negocios ajustan precios.
    if (this.propiedades.length) this.pay(this.rentaReal * (dt / 60));
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
  guardar() {
    return { pesos: this.pesos, usd: this.usd, priceIndex: this.priceIndex,
             propiedades: this.propiedades };
  }
  cargar(d) {
    if (!d) return;
    this.pesos = d.pesos ?? this.pesos;
    this.usd = d.usd ?? this.usd;
    this.priceIndex = d.priceIndex ?? this.priceIndex;
    this.propiedades = d.propiedades || [];
  }

  charge(realAmount) {
    const nominal = realAmount * this.priceIndex;
    if (this.pesos < nominal) return false;
    this.pesos -= nominal;
    return true;
  }
}
