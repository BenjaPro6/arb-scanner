# pumpscan

Herramienta para **medir si existe una ventaja** en los lanzamientos de pump.fun,
antes de arriesgar plata en una.

No es un bot de trading. Es el paso que va antes: captura el mercado en vivo,
reconstruye qué pasó con cada token, y responde con números si una señal
temprana predice algo — o si lo que parecía una señal era ruido.

---

## Arranque rápido

Necesitás **Python 3.11 o más nuevo** y conexión a internet sin proxy que
bloquee websockets.

```bash
# 1. Traer el código
git clone -b claude/nuevo-proyecto-ebxwg9 https://github.com/BenjaPro6/arb-scanner.git
cd arb-scanner/solana-pump-scanner

# 2. Entorno aislado e instalación
python3 -m venv .venv
source .venv/bin/activate          # en Windows: .venv\Scripts\activate
pip install -r requirements.txt

# 3. ¿Llego al mercado real? (30 segundos)
python -m pumpscan.cli doctor
```

Si el paso 3 imprime lanzamientos con símbolo y market cap, estás listo. Ahora:

```bash
# 4. Capturar datos reales. Dejalo corriendo VARIOS DÍAS.
python -m pumpscan.cli collect

# 5. Con la captura hecha, ver qué pasó y si hay señal
python -m pumpscan.cli label
python -m pumpscan.cli validate

# 6. Entrenar y operar en papel
python -m pumpscan.cli train --out data/model.pkl
python -m pumpscan.cli trade --model data/model.pkl
```

Todos los comandos cortan limpio con Ctrl-C sin perder datos.

Para probar la maquinaria ahora mismo, sin esperar la captura:

```bash
python -m pumpscan.cli simulate --tokens 1200
python -m pumpscan.cli backtest --log-dir data/sim
```

---

## Por qué esto y no un sniper directo

Un bot que compra y vende se escribe en una tarde. El problema es que no tenés
forma de saber si su lógica sirve, y el mercado te cobra la respuesta en plata.
El orden correcto es al revés:

1. **Capturar** todo lo que pasa, sin interpretarlo.
2. **Medir** si algo observable en los primeros segundos predice el resultado.
3. **Operar en papel** contra el mercado real, para ver si lo medido sobrevive
   al contacto con la realidad.
4. **Recién ahí**, plata de verdad.

Este repo cubre los pasos 1, 2 y 3. El 4 no existe todavía, y esa ausencia es
estructural: **no hay wallet, no hay claves, no hay firma de transacciones.**
Un test recorre todo el código verificando que no aparezcan. No es un flag que
se pueda apretar sin querer.

El paso 3 es el que hace la diferencia con lo que tenías antes. Un backtest
puede estar mal de formas que nada adentro del backtest puede detectar: una
feature que se calcula rápido sobre un archivo y es imposible de calcular en
los 200ms que tenés en vivo, un feed que te pierde justo los trades que
necesitabas, una ventana de decisión que en el papel parecía cómoda y en la
práctica no llegás. Correr el loop real contra el mercado real saca todo eso a
la luz, y la factura por enterarte es cero.

---

## La pregunta honesta: ¿sigue existiendo este mercado?

Vos preguntaste si después de dos años todavía vale la pena. Lo que puedo
decirte con honestidad, y lo que no:

**Lo que sé** (hasta mi corte de conocimiento, mayo 2026): pump.fun siguió
operando con volumen alto y lanzamientos continuos. Los pump and dumps no
desaparecieron — son la mecánica dominante del lugar, no una anomalía.

**Lo que cambió, y te afecta directamente:** el lado comprador se
profesionalizó mucho desde 2023. Buena parte de los lanzamientos vienen
"bundleados" desde el bloque cero — el creador y sus billeteras compran todo el
float antes de que vos veas el token. Competís contra bots co-localizados que
reaccionan en decenas de milisegundos, no en segundos. Y la tasa histórica de
tokens que llegan a graduarse siempre estuvo cerca del 1%.

**Lo que no puedo decirte:** si *hoy*, en tu ventana de latencia y con tu
capital, queda margen. Nadie puede desde afuera, y desconfiá de quien te diga
que sí sin datos tuyos. Por eso la herramienta mide en vez de opinar.

**La conclusión operativa:** lo que mató tu intento de hace dos años
probablemente no fue el código. Fue que no tenías forma de distinguir una
ventaja real de una casualidad del backtest. Eso es exactamente lo que esto
resuelve.

---

## Instalación

```bash
cd solana-pump-scanner
pip install -r requirements.txt
```

Python 3.11+.

## Uso

### 0. Comprobar que llegás al mercado real

```bash
python -m pumpscan.cli doctor
```

Se conecta al feed en vivo y te imprime lanzamientos **reales** de Solana a
medida que van apareciendo, con el símbolo, la compra del dev y el market cap.
Treinta segundos y sabés si tu máquina puede hacer el trabajo. Si no puede, te
dice que el problema es de red y no del código.

### 1. Capturar el mercado (corré esto en tu máquina, necesita red)

```bash
python -m pumpscan.cli collect --minutes 120
```

Se conecta al websocket público de PumpPortal (gratis, sin API key), escucha
lanzamientos nuevos y los trades de cada uno, y escribe todo a `data/raw/`.

Ctrl-C corta limpio sin perder nada. **Dejalo corriendo varios días.** Con
menos de unos pocos miles de tokens, cualquier conclusión es anécdota.

### 2. Ver qué pasó realmente

```bash
python -m pumpscan.cli label --decision-age 10
```

Muestra la distribución de resultados: cuánto llegó a subir cada token contra
**cuánto era realizable** con una regla de salida que podrías ejecutar de
verdad. La diferencia entre esas dos columnas es la que arruina a los bots que
entrenan contra el pico.

### 3. Intentar demostrar que el pipeline está mal

```bash
python -m pumpscan.cli validate
```

**Corré esto antes de creerle a cualquier backtest.** Hace tres cosas:

- **Auditoría de fuga temporal**: borra todo lo que tu proceso no había
  recibido al momento de decidir y verifica que las features no cambien. Si
  cambian, alguna está leyendo el futuro.
- **Test de permutación**: baraja qué token tuvo qué resultado y vuelve a
  entrenar. Si el modelo sigue "acertando" con las etiquetas mezcladas, no
  aprendió el mercado — se aprendió la muestra de memoria.
- **Tamaño de muestra**: te avisa si estás sacando conclusiones de veinte filas.

### 4. Backtestear

```bash
python -m pumpscan.cli backtest --detail
```

Compara cuatro estrategias contra dos varas: no comprar nada, y comprar todo.
Una estrategia que no le gana a ambas no justifica su complejidad.

### 5. Entrenar el modelo

```bash
python -m pumpscan.cli train --out data/model.pkl
```

Ajusta el modelo sobre toda la captura y lo guarda **junto con su AUC
walk-forward**, que es la única estimación honesta de cómo se va a portar con
tokens que nunca vio. Si ese número está cerca de 0.5, te lo dice en rojo y te
avisa que no lo operes.

### 6. Operar en papel contra el mercado real

```bash
python -m pumpscan.cli trade --model data/model.pkl
```

Este es el bot completo, corriendo contra pump.fun de verdad: escucha los
lanzamientos reales, espera la ventana de decisión, decide, abre la posición
simulando latencia, comisiones, impacto propio en la curva y transacciones
fallidas, y gestiona la salida contra los trades reales que van llegando.

Vas a ver un panel en vivo con las posiciones abiertas, su multiplicador
actual, y las últimas operaciones cerradas con su motivo de salida. Cada
operación queda guardada en disco.

Y como bonus: **una sesión de papel también es una sesión de captura**, con los
lanzamientos que la estrategia rechazó incluidos — que son la mayor parte de la
información. Cuando termina te dice el comando para validar esa captura.

### Sin conexión

```bash
python -m pumpscan.cli simulate --tokens 1200
python -m pumpscan.cli backtest --log-dir data/sim
```

Genera un mercado sintético con la misma forma de eventos que el feed real.
Sirve para desarrollar y para probar el pipeline. `--signal 0` genera un
mercado sin señal temprana: cualquier ventaja que un backtest reporte ahí es un
bug.

---

## Cómo está armado

```
pumpscan/
├── curve.py          Matemática exacta de la curva de bonding (enteros, como on-chain)
├── models.py         Eventos normalizados: block_time vs recv_time
├── storage.py        Log JSONL append-only (verdad) + índice SQLite (descartable)
├── sources/
│   ├── pumpportal.py Feed en vivo, con reconexión y re-suscripción
│   ├── replay.py     Repetir una captura de forma reproducible
│   └── simulator.py  Mercado sintético con arquetipos conocidos
├── collect.py        Daemon de captura
├── reconstruct.py    Timelines por token + la barrera anti-fuga
├── features.py       30 features, todas calculadas solo con lo observable
├── label.py          Qué pasó después: pico (diagnóstico) vs realizable (objetivo)
├── execution.py      Latencia, impacto propio, comisiones, tx fallidas, salidas
├── backtest/         Portafolio con capital y slots finitos
├── strategy/         Reglas auditables + modelo con validación walk-forward
├── live/
│   ├── portfolio.py  Posiciones abiertas, capital y slots en tiempo real
│   ├── trader.py     El bot en papel contra el mercado real
│   └── display.py    Panel en terminal
├── doctor.py         Verifica que llegás al feed en vivo
├── validation.py     Los tests que intentan refutar todo lo anterior
└── report.py         Métricas, con expectancy como número principal
```

### Las tres decisiones de diseño que importan

**1. `recv_time`, no `block_time`.** Cada evento guarda cuándo ocurrió en
cadena y cuándo *tu proceso lo recibió*. Las features solo pueden mirar lo
segundo. En la ventana de 1 a 10 segundos, el 6.5% de los eventos todavía no te
habían llegado — un backtest que filtre por `block_time` los usa igual y se
inventa una ventaja de la nada.

**2. El objetivo de entrenamiento es lo realizable, no el pico.** Entrenar
contra el máximo alcanzado enseña al modelo a buscar tokens que se disparan
cuatro segundos y vuelven a cero: exactamente el patrón que le paga al que
manipula y te cobra a vos.

**3. Validación walk-forward, nunca split aleatorio.** Un split aleatorio
entrena con el jueves para predecir el miércoles, y como el mismo dev lanza
decenas de tokens, el modelo memoriza billeteras en vez de aprender conductas.
Se ve brillante hasta que encuentra una billetera nueva — que en vivo son
todas.

---

## Qué encontré mientras lo construía

Todo esto salió de correr el pipeline sobre el mercado simulado. **No son
predicciones sobre el mercado real** — son propiedades de la maquinaria, y
varias contradicen lo que yo mismo esperaba.

**Un filtro de "momentum temprano" selecciona lanzamientos manipulados.** Mis
reglas escritas a mano rindieron *peor* que comprar a ciegas: filtraban 21
tokens orgánicos a 6, y dejaban pasar 64 de 78 rugs. La razón es incómoda: la
manipulación se ve idéntica al momentum orgánico. Un dev comprando fuerte al
inicio pasa cualquier filtro de "hay plata entrando".

**El trailing stop no te salva del rug.** Yo asumí que sí; los datos dicen que
no. Cuando el creador vacía su bolsa, el colapso tarda menos de un segundo — el
gatillo salta y tu venta llega tarde igual. Contra un rug atómico no hay
política de salida que funcione, y por eso el filtro de *entrada* y el tamaño
de posición importan más que cualquier regla de salida.

**Y encima el trailing stop te corta la cola derecha.** Este hallazgo apareció
recién al corregir un bug propio: yo valuaba en **cero** las posiciones de
tokens que graduaban, porque `quote_sell` se niega a operar una curva
completada. Graduar es el *mejor* resultado posible del lugar, así que ese cero
borraba a todos los ganadores de cada backtest — y sesgaba cualquier barrido de
parámetros hacia take-profits bajos.

Con la valuación arreglada (las graduaciones valen entre 4.6x y 11.4x), el
resultado se da vuelta: aguantar rinde **159.8 vs 147.6 SOL** contra usar
trailing stop, y toda la diferencia está en los 24 tokens que graduaron. Un
stop te protege del medio de la distribución y lo paga con la cola. En un
mercado donde casi toda la ganancia viene de unos pocos tokens que corren hasta
el final, eso es caro.

**La velocidad solo paga a la baja.** En salidas por caída (stop loss, trailing
stop) reaccionar rápido rinde 15% más. En take-profit es al revés: apurarse
cuesta ~5%, porque el token todavía está subiendo cuando salta el gatillo.

**Las restricciones de portafolio muerden más de lo que parece.** De 400
lanzamientos, 211 se descartaron por no tener slot libre y 113 por liquidez
insuficiente para poder salir. Solo 67 llegaron a ejecutarse. Un backtest
token-por-token esconde eso por completo.

---

## Advertencias

**Los números del simulador no son una promesa.** El mercado sintético lo
diseñé yo para que fuera aprendible, así que un modelo saca AUC 0.93 ahí. Eso
mide que la maquinaria funciona, **no** que vayas a ganar. El mercado real es
adversario, cambia de régimen, y no te debe nada.

**El simulador no es perfectamente nulo.** Con `--signal 0` queda una señal
residual en el arquetipo `bundle` (AUC ~0.68 en vez de 0.50). El test de
permutación no depende de eso y es la garantía real: sobre etiquetas barajadas
el pipeline saca 0.50.

**El feed de PumpPortal no trae tiempo de bloque.** Cada evento se estampa con
la hora de llegada, así que la latencia medida sobre datos reales es cero y el
backtest aplica su propio modelo encima. Si conseguís un RPC con geyser
(Helius), esa fuente sí trae tiempos reales y conviene enchufarla — la interfaz
`EventSource` ya está preparada.

**Los resultados en papel son optimistas de una forma concreta.** Tus compras
nunca movieron la curva de verdad, y nunca competiste con nadie por el mismo
bloque. Tomalos como cota superior, no como pronóstico.

**Nada de esto ejecuta órdenes reales.** No hay claves privadas, no hay firma de
transacciones, no hay conexión a una wallet. A propósito, y hay un test que lo
verifica recorriendo todo el código fuente.

---

## Tests

```bash
python -m pytest tests/ -q
```

69 tests. Los que más importan están en `tests/test_leakage.py` y
`tests/test_validation.py`: si alguno de esos falla, todos los números que
produce el proyecto quedan sin valor.

`tests/test_trader.py` corre sesiones enteras del bot sobre un reloj virtual,
en milisegundos, para verificar que abre y cierra posiciones, respeta capital y
slots, no decide antes de tiempo, y que la contabilidad cierra al centavo.
