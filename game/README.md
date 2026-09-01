# Sudestada

Un mundo abierto 3D ambientado en Buenos Aires, jugable en el navegador.
Motor propio sobre Three.js. **Cero assets externos**: la ciudad, las texturas,
los vehículos, los personajes y hasta el sonido se generan por código.

Esto es la **Fase 0**: el motor y los sistemas completos con arte procedural.
La idea es probar que el juego es divertido en gris, antes de gastar un peso en arte.

## Correlo

```bash
npm install     # sólo la primera vez (Three.js, que después queda en vendor/)
npm start       # sirve en http://127.0.0.1:8123
```

Si ya está `vendor/three.module.js` en el repo, alcanza con servir la carpeta
con cualquier servidor estático. No hay build, no hay bundler, no hay CDN.

### O sin instalar nada

`dist/sudestada.html` es el juego entero en un solo archivo de 114 KB. Se abre
en cualquier navegador y se trae Three.js de un CDN (con un segundo CDN de
respaldo). Se regenera con `npm run bundle`.

## Controles

| Tecla | Qué hace |
|---|---|
| `W A S D` / flechas | manejar o caminar |
| `Espacio` | freno de mano (con esto derrapás) |
| `F` | subir o bajar del auto |
| `Shift` | correr a pie |
| `H` | vender dólares en la cueva |

Los círculos del mapa: **naranja** = laburo, **verde** = cueva, **azul** = taller.

## Qué hay adentro

**Ciudad.** Buenos Aires es una grilla casi perfecta de manzanas de 100×100 m,
así que la trama sale exacta y no aproximada: 676 manzanas sobre 3,2 × 3,1 km,
avenidas cada cinco cuadras, la 9 de Julio de 110 m partiendo el centro, y el
Obelisco donde corresponde. Siete barrios con altura, densidad, paleta y textura
de fachada propias: Microcentro, Puerto Madero, Palermo, San Telmo, La Boca,
Once y barrio. Las manzanas son perimetrales, con el patio de aire en el medio,
y no hay terraza sin tanque de agua.

**Tránsito.** Los autos circulan sobre un grafo de calles con carriles y manos,
respetan semáforos, mantienen distancia, doblan en las esquinas prefiriendo
seguir derecho y por avenida, y frenan detrás de lo que haya parado adelante.
Van cinemáticos mientras nadie los toca; cuando los chocás pasan a física
completa, salen despedidos y, si sobreviven, vuelven solos a la mano.

**Manejo.** Modelo de neumático de dos ejes con ángulo de deriva, círculo de
fricción y transferencia de carga. El tren trasero se suelta, se contradirige, y
el freno de mano derrapa de verdad. Cada auto está calibrado a números creíbles:
el Falcon hace 0 a 100 en 10,8 s y tope 150; el Torino en 5,9 s y 193; el bondi
no llega a 100 nunca.

**Policía.** Cinco estrellas. La Federal persigue prolijo siguiendo el grafo de
calles con A\*; la Bonaerense aparece de tres estrellas para arriba y te embiste.
Si te escondés, la estrella baja sola. El taller es el Pay'n'Spray: chapa,
pintura y se te va la cana.

**Peatones.** Caminan el perímetro de su manzana, doblan en las esquinas, se
asustan de lo que se mueve rápido y salen corriendo con las manos en la cabeza.
Animación cien por ciento procedural: no hay rig ni esqueleto, los miembros
oscilan por seno. A distancia de cámara de GTA se lee perfecto.

**Piquetes.** Cada tanto se corta una avenida. No es decorado: el tramo se marca
como bloqueado en el grafo, así que el tránsito y la policía recalculan solos.

**Y la que ningún GTA tiene: la inflación.**

Los precios suben 5,5% por minuto real, compuesto. Los pagos de las misiones
están indexados, así que nominalmente cobrás cada vez más — pero si dejás los
pesos quietos, tu poder adquisitivo se derrite. Quedarte en pesos cinco minutos
te come casi un cuarto de lo que tenías. La salida es el dólar: corrés a una
cueva de la City o de Once y comprás, pagando el spread. Pero para llegar a la
cueva hay que manejar, y manejar con estrellas encima es otro problema.

Ese es el bucle: laburás, cobrás en pesos, y la plata te quema en la mano.

**Sonido.** Todo sintetizado en vivo con WebAudio: el motor son dos osciladores
desafinados con la frecuencia atada a una caja de cuatro marchas, la sirena son
dos tonos alternados, la goma quemada es ruido filtrado y los golpes son ráfagas
de ruido con la envolvente cayendo. No hay un solo archivo de audio en el repo.

## Pruebas

```bash
npm test            # normales de la geometría + simulación (economía, tránsito, policía)
npm run test:browser  # arranque real en Chromium: errores, draw calls, capturas
```

Las pruebas de simulación corren la lógica real del juego sin navegador. Ya
encontraron tres bugs de verdad durante el desarrollo: las caras de las cajas
invertidas, el winding al revés de las líneas de la calle, y el signo del volante
de la policía, que hacía que los patrulleros nunca te alcanzaran.

## Estructura

```
src/core/      configuración, PRNG determinista, input, audio, utilidades
src/world/     grilla de la ciudad, grafo de calles, texturas y geometría procedural
src/vehicles/  catálogo, modelado, física de manejo, IA de tránsito
src/actors/    humanoide procedural, peatones, jugador y cámara
src/systems/   policía, economía con inflación, puntos del mapa, misiones
src/ui/        HUD y minimapa
scripts/       pruebas, vendorizado de Three.js y empaquetado a archivo único
dist/          el juego en un solo HTML, listo para abrir sin servidor
vitrina.html   página aparte para mirar los modelos aislados
```

La ciudad es determinista: la semilla `1987` genera siempre el mismo Buenos Aires.

## Lo que falta (Fase 1)

El motor está. Lo que sigue es lo que la generativa sí resuelve bien:

- **Radio**: cuatro emisoras — cumbia, rock nacional, tango, electrónica — con DJ
  en porteño. Es el mayor retorno por peso invertido: son quince tracks, no
  trescientos assets, y la radio es la mitad de la identidad de un GTA.
- **Texturas de fachada** fotográficas por barrio. Con treinta o cuarenta ya
  cambia la ciudad entera, porque la geometría la genera el código.
- **Vehículos 3D** de verdad. Un auto no necesita animación, así que salen
  directo de imagen a malla.
- Combate a pie, entrar y salir con animación, y más tipos de misión.

## Mudarlo a su propio repo

Esto vive en `game/` dentro de `arb-scanner` sólo porque el GitHub App de la
sesión donde se escribió no tenía permiso para crear repositorios. No comparte
nada con el escáner de arbitraje y está pensado para irse a un repo propio.
Creás el repo vacío en GitHub y después:

```bash
git clone https://github.com/BenjaPro6/arb-scanner tmp && cd tmp
git checkout claude/complex-video-game-15yn1k
git subtree split --prefix=game -b solo-juego     # historia sólo del juego
cd .. && git clone tmp -b solo-juego sudestada && cd sudestada
git remote set-url origin https://github.com/BenjaPro6/<repo-nuevo>
git push -u origin solo-juego:main
```

`git subtree split` deja los archivos en la raíz y conserva los commits, así
que el repo nuevo arranca limpio y con historia.

## Licencia y nombre

Proyecto propio. No usa nada de Rockstar: ni marcas, ni assets, ni código.
"Sudestada" es el viento de tormenta del Río de la Plata, y es un nombre
provisorio — cambialo cuando se te ocurra uno mejor.

Three.js va vendorizado en `vendor/` bajo licencia MIT; su copia está en
`vendor/THREE.LICENSE`.
