# Trazada

Simulador de circuito jugable en el navegador, pensado para volante (Logitech
G29 y similares) con teclado como respaldo. Motor propio sobre Three.js, sin
ningún asset externo: el circuito, las texturas y el auto se generan por código.

## Correlo

```bash
npm install     # sólo la primera vez
npm start       # http://127.0.0.1:8124
```

`dist/trazada.html` es el juego entero en un solo archivo de 54 KB: se abre con
doble clic y trae Three.js de un CDN. Cambiá de circuito con `?pista=21` en la
URL: cada número da un trazado distinto y determinista.

## Controles

| Control | Qué hace |
|---|---|
| `W` / `S` | acelerar y frenar |
| `A` / `D` | doblar |
| `Espacio` | freno de mano |
| `R` | volver a pista (invalida la vuelta) |
| `C` | calibrar el volante |

## La física

Lo que decide si un juego de volante se siente bien es el modelo de neumático,
y este usa **fórmula mágica de Pacejka**: la fuerza crece con el ángulo de
deriva hasta un pico a 7,5° y después **cae**. Ese pico y esa caída son
exactamente lo que sentís en las manos cuando el auto se te va. Un modelo
lineal —el que alcanza para un GTA— no lo tiene, y con volante se nota al toque.

Encima de eso:

- **Elipse de fricción**: el agarre es uno solo y se reparte entre doblar y
  traccionar. Frenar a fondo mientras doblás pide más de lo que hay.
- **Suspensión de cuatro ruedas** con hundimiento, cabeceo y balanceo como
  estados dinámicos. La transferencia de peso no es una fórmula instantánea:
  sale de resortes y amortiguadores, así que el auto **tarda** en apoyarse al
  entrar a una curva.
- **Barras estabilizadoras** que reparten el balanceo entre ejes y definen si
  el auto avisa antes de irse o se va de cola.
- **Velocidad angular de cada rueda** integrada aparte, con la inercia del motor
  reflejada por la relación al cuadrado: eso da patinada en salida y bloqueo en
  frenada.
- **Paso fijo de 400 Hz**, desacoplado del dibujo. A 60 Hz el volante se siente
  gomoso y el neumático pierde el pico.
- **Par de autoalineación** de las ruedas delanteras calculado y expuesto: es la
  señal que necesita el force feedback.

Números que da el modelo, verificados por pruebas: 0 a 100 en 5,8 s, 100 a 0 en
38 m, 231 km/h de máxima y 1,38 g de agarre lateral.

## El circuito

Curva cerrada Catmull-Rom remuestreada **por longitud de arco**, no por
parámetro. Eso es lo que hace que después funcionen los tiempos por vuelta, los
parciales, la detección de pista y el cálculo de a qué velocidad se pasa cada
curva. El trazado se suaviza sólo lo necesario: demasiado suave da un óvalo sin
frenadas, demasiado crudo da quiebres imposibles. El objetivo es un radio mínimo
de horquilla de verdad, entre 28 y 45 metros.

Asfalto, pianitos, escapatoria de pasto y guardrails, todos con su propio
coeficiente de agarre: irte al pasto se paga.

## El volante

**Aviso honesto: esto se escribió sin un G29 a mano para probarlo.**

Leer el volante es la parte fácil y usa la Gamepad API estándar. El mapeo por
defecto es el habitual en Chrome, pero varía según sistema operativo y según si
los pedales están en modo combinado. Por eso hay calibración con `C`: se aprende
qué eje mueve cada pedal y su recorrido real, y se guarda en el navegador.

**El force feedback todavía no está.** La API estándar de gamepads sólo expone
vibración de joystick, no fuerza constante ni resorte, que es lo que un volante
necesita. La salida es WebHID mandando reportes crudos con el protocolo de
Logitech, o un ejecutable de escritorio donde el FFB está garantizado. El motor
ya calcula y expone la señal (`vehicle.ffb`, el par de autoalineación de las
delanteras); falta el canal para mandarla.

## Pruebas

```bash
npm test
```

Corren la simulación sin navegador y verifican comportamiento, no líneas de
código. Encontraron cuatro bugs reales durante el desarrollo:

- El corte de vueltas no cortaba nunca, porque el régimen se recortaba **antes**
  de consultar el limitador, y el motor entregaba par sin techo.
- Faltaba la inercia del tren motriz, así que las ruedas se disparaban a
  velocidades absurdas al patinar.
- La búsqueda por longitud de arco interpolaba mal y devolvía la muestra
  anterior, con hasta 9 metros de error.
- **La transferencia de peso lateral estaba invertida**: el auto cargaba la
  rueda de adentro de la curva. Con volante eso se siente inmediatamente mal.
  La prueba original no lo detectaba porque estaba escrita con la misma
  suposición equivocada; se reescribió para medir hacia dónde curva la
  trayectoria y deducir de ahí cuál es la rueda de afuera.

## Lo que falta

- **Force feedback** (ver arriba): es lo único que separa esto de un simulador.
- **Rivales.** `src/race/piloto.js` tiene el andamiaje de un piloto automático
  por persecución pura, pero **no completa una vuelta**: se va en las curvas
  encadenadas y no sabe recuperarse cuando queda cruzado. Está en el repo
  marcado como incompleto, y no está enchufado al juego.
- Traza optimizada, desgaste de gomas, combustible, daño, y más de un auto.

## Licencia

Proyecto propio. Three.js va vendorizado en `vendor/` bajo licencia MIT.
