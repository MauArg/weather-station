# Estado del proyecto

> Actualizar este archivo al final de cada sesión de trabajo relevante. Es el punto de partida para la siguiente conversación — ver política en [`CLAUDE.md`](./CLAUDE.md).

_Última actualización: 2026-08-09_

## ✅ Live mode — implementado y validado en campo (2026-08-08/09)

Primer tier con caso de uso concreto: en un día despejado con la batería llena el charger ya está tirando energía a la basura, así que el nodo **deja de dormir y publica cada 5 s** en vez de cada 60.

**Firmware `1.15.0`** (comando `live`) y **`1.16.0`** (heartbeat de sesión). El `1.15.0` corrió en campo; el `1.16.0` está commiteado y **sin flashear**.

### Decisión de diseño: live NO cuelga de la escalera de tiers

`battery.Tier()` es función pura del voltaje del pack y describe **descartar carga mientras la batería se vacía**. Live es lo contrario: **gastar excedente mientras carga**. Y los dos ejes ya estaban en desacuerdo antes de esta sesión — `energy.Assess` llama `StateFull` al sistema con el panel arriba de 12,5 V, donde el pack mide ~4,084 V de mediana, que `battery.Tier()` reporta como **Tier 2**. Gatear live en "Tier 1" lo habría hecho negarse a entrar exactamente cuando el sistema está más lleno. Son modos ortogonales, no una sola escalera.

### Arquitectura: el backend decide, el firmware tiene pisos propios

La política vive en el backend porque ahí están la escala calibrada de `luminosity` y el histórico de deriva. **Nada de eso está implementado todavía** (ver pendientes) — hoy se arma a mano.

El nodo mantiene cuatro salidas independientes de lo que el backend crea:

| piso | umbral | notas |
|---|---|---|
| Sol | `solar_v < 6,0 V` | igual a `energy.PanelDaylightV` |
| Batería | `system_v < 3,90 V` | igual a `energy.LowBatteryV` |
| Presupuesto | `timeout_min`, acumulado en RTC | absoluto entre re-entradas |
| MQTT | reconexión agotada | sin broker no hay a quién publicar ni cómo recibir el stop |

Los dos primeros exigen **3 lecturas consecutivas**, y un `NaN` no cuenta como strike — un sensor que no contestó no dice nada sobre el panel ni sobre el pack.

**El flag `force`** saltea sólo el piso de sol, para poder probar de noche o en banco. `parseCommand()` capea las sesiones forzadas a **30 min** contra las 8 h normales, y el motivo es aritmético: forzar quita el piso que normalmente termina una sesión que no debería estar corriendo, y llegar al piso de batería desde ~4,05 V con ~70 mA lleva del orden de 6 h porque la curva de la LiPo es plana justo ahí. Una sesión forzada podía quemar un tercio del pack de noche antes de que saltara nada.

### Resultados de campo (2026-08-08)

Dos sesiones reales, `1.15.0`:

| | sesión 1 | sesión 2 |
|---|---|---|
| duración | 902 s | **2802 s** |
| publicaciones | 172 | **535** |
| salida | `timeout` | **`no_sun`** |

- **Cadencia real: 5,24 s por ciclo**, no 5,00. `interval_sec` es el tiempo *entre* publicaciones; el trabajo de leer sensores (~250 ms) se suma. Consistente en las dos sesiones.
- **Pérdida a 5 s: 1 de 535 = 0,19%**, contra 0,3% del ciclo normal a 60 s. **Publicar 12× más seguido no degradó la entrega.** Conteo exacto contra el `seq` del nodo, y el segmento en InfluxDB coincide al segundo con el `elapsed_s` reportado.
- **Costo energético, medido por primera vez: 53,1 mA × 2802 s = 41,3 mAh, o ~53 mAh por hora.** Contra los ~47 mAh/día del ciclo normal, **una hora de live cuesta como 1,1 días de operación normal**. Es el número para decidir cuándo conviene.
- **Los strikes se ganaron su lugar.** Los últimos ciclos antes del corte: `6,12 → 6,21 → 5,96 → 6,02 → 6,09 → 5,42 → 4,35 → 5,17`. Oscilando sobre el piso de 6,0 V. Sin la regla de 3 consecutivos habría cortado varios minutos antes, en el primer 5,96.

### Hallazgo: el piso de sol es un test de "está oscuro", no de "hay excedente"

El Voc de un panel se sostiene alto con poca luz y sólo colapsa cerca de la oscuridad. Durante la sesión 2, con `photo_kohm` ya en 8 kΩ (~35% de luminosidad, atardecer), `solar_v` todavía marcaba 6 V. Mientras tanto el panel entregaba ~55 mW contra los ~212 mW del nodo: **live mode corrió a déficit los últimos minutos**.

Está bien **como piso de seguridad** — cortó, y el pack sólo bajó 0,02 V. Pero confirma que la señal de entrada/salida real tiene que ser luminosidad + `energy.StateFull`, no voltaje de panel. Eso es justamente lo que el paso 2 pone en el backend.

### Bugs encontrados en las pasadas de revisión previas al flasheo

- **Habría hecho que live mode no funcionara nunca**: el callback marcaba la sesión como cancelada ante *cualquier* mensaje en `TOPIC_CMD`, y el comando `live` es retenido — el broker lo reentrega en el instante del `subscribe()`. La sesión habría terminado en la primera pasada del loop, siempre. Ahora sólo cuenta un payload vacío, igual que service mode.
- El presupuesto **sub-contaba**: `elapsed` se leía antes de `publishTelemetry()` y se usaba después.
- El acumulador se **reseteaba aunque el clear del retenido fallara**, regalando presupuesto completo a la re-entrada.
- `LOG_PUBLISH_OK` es nivel 2, así que una captura en nivel 2-3 se llevaba **una entrada por publicación**: 360 de un ring de 768 en 30 min, y siete vueltas completas en 8 h. Ya no se escribe en live mode — `live_seq` contesta lo mismo desde el lado receptor, y las horas no habrían servido igual porque `ms` satura a los 65 s y `boot_count` queda congelado toda la sesión.

### ✅ Pasos 2 y 3 — completos y desplegados (2026-08-09)

**En producción: firmware `1.17.0`, frontend `1.3.0`, backend `1.3.1`.**

**Paso 2 — el backend arma y desarma solo** (`internal/mqttbridge/live.go`). El hallazgo que definió el diseño: **`energy.Assess` no puede ser la señal de armado.** Con el pack lleno el CN3791 cicla, y `Assess` devuelve `StateFull` sólo durante la fase de corte, que es el 22% del tiempo — armar con eso armaría en los huecos y desarmaría durante la carga real. La señal correcta es una ventana: **¿el panel llegó a circuito abierto alguna vez en los últimos 15 min?**

| | condición |
|---|---|
| Entrada | ventana de excedente · luminosidad ≥ 65% · slot retenido libre · cooldown cumplido |
| Salida | luminosidad < 45% |
| Sesión | 5 s, 60 min, renovable |

Entrada y salida usan señales **distintas** a propósito: una vez corriendo, live mode es carga suficiente para frenar el cicleo del charger por sí solo, así que "se fue el excedente" pasa a ser una lectura auto-infligida. La luminosidad se mide independiente de lo que hace el nodo.

**Apagado por defecto** (`LIVE_AUTO_ENABLED=false`, documentado en `.env.example`). Prenderlo significa que el nodo deja de dormir sin que nadie lo pida.

**Paso 3 — panel en la vista de service mode** (`components/service/LivePanel.jsx`). Deriva el estado del nodo, nunca de lo que la vista publicó, con tres fuentes que contestan tres preguntas: `retained.cmd` (qué se le ordenó, cierto apenas se arma), `live_seq` (qué hace de verdad, cierto recién cuando arrancó) y `status` (elapsed/remaining). Un nodo dormido tarda hasta un ciclo en levantar el comando, así que "armado" y "corriendo" son estados separados. `Force` es un botón propio y no un checkbox, porque saltea un piso de seguridad. `Stop` manda `clear`, no un comando propio: un retenido vacío es lo que todos los modos leen como "pará".

### Validación end-to-end en campo (2026-08-09, de noche)

Con `photo_kohm` = 9999 (centinela de oscuridad) y `solar_v` = 3,6 V, muy por debajo del piso de 6,0 V:

- Se armó con **`force`** desde el botón → el firmware salteó el piso de panel. Una sesión normal habría salido con `no_sun` en el `live_seq` 3.
- Corrió a 5 s con `live_seq` 1→6, y se cortó desde el botón **Stop** → `cleared_by_server`, `retained: null`.
- **El backend no armó solo**, correcto: con la luminosidad en el piso la condición de entrada del 65% no se acerca.
- **`live_seq` llega a InfluxDB** — el mapeo de N8N quedó actualizado.

### Bugs encontrados en las pasadas de revisión de los pasos 2 y 3

- **Bloqueo del router MQTT.** `evaluateLiveAuto` publicaba desde adentro de un callback de paho, con el cliente en `OrderMatters` = true (su default): el router despacha de a uno desde una goroutine, así que el `tok.WaitTimeout(5s)` esperaba sobre un router bloqueado en esa misma llamada. Congelaba todo el procesamiento MQTT hasta 5 s por armado. Los publish pasaron a goroutine, con el cooldown seteado **antes** de lanzarla para que no arme dos veces.
- **Bucle de re-armado cada 5 min.** Los dos lados juzgan con sensores distintos; con el panel sombreado y el LDR viendo cielo claro, el nodo salía por `no_sun` a los 15 s y el backend re-armaba a los 5 min, todo el día. Ahora `onStatus` lee el `reason`: si el nodo salió por uno de sus propios pisos, el cooldown pasa a 60 min.
- **La automatización pisaba al operador.** El cooldown sólo corría cuando el backend terminaba la sesión, así que pararla a mano la re-armaba enseguida. Ahora arranca con cualquier comando que abandone el slot — lo que además evita saltar a live justo después de un OTA, cuando el ciclo normal es lo que se quiere mirar.
- **`remaining_s` vs `remaining_sec`** — el heartbeat del `1.16.0` usaba el nombre corto, que el backend no parsea. El campo se descartaba en silencio, anulando el motivo entero del heartbeat.
- **Tooltip mudo** — el botón Force tenía `data-tip` sin la clase `svc-tip`. Verificado renderizado en Chrome tras el fix.
- **El panel decía "running" hasta un minuto de más** — `live_seq` sigue en la última telemetría hasta que llega la siguiente, un ciclo de sueño después.
- **Faltaba la antigüedad** en "última sesión terminó porque…", que sobrevive hasta el próximo status. Es el mismo problema que el dashboard ya había resuelto con `formatAge`.

### Pendientes

- **Auto-armado sin estrenar**: `LIVE_AUTO_ENABLED` sigue en `false`. La lógica nunca corrió contra un día real con excedente.
- **Los umbrales de luminosidad (65%/45%) son de primera pasada**, con los anclajes medidos escritos al lado en `models/service.go` para afinarlos con datos.

## ⚠️ El mapeo de campos de N8N descarta en silencio lo que no conoce (2026-08-09)

Al intentar medir la pérdida de live mode se descubrió que **`live` y `live_seq` no llegaban a InfluxDB**. No es cosa de live mode: `log_active` y `log_count` tampoco estaban, y existen desde el `1.3.0` del 28 de julio.

El workflow de N8N arma Line Protocol desde un `fieldMap` explícito, así que **cualquier campo que el firmware agregue es invisible en InfluxDB hasta que se edite ese script a mano**. No está versionado en ningún repo (ver "Deuda conocida"). Al subsistema de viento le va a pasar lo mismo.

**Corregido el 2026-08-09**: Mau agregó los cuatro campos. Notas del código revisado:

- El script escribe **todos los booleanos como `0i`/`1i`**, que es correcto. El `type conflict: bool != int` que rompe cualquier query agregada sobre `dht11_ok` en el histórico viene de **datos viejos**, no de este script.
- `solar_mW` y `system_mW` se escriben como enteros (`${p.solar_mW}i`) y funciona **por casualidad**: el `Adafruit_INA219` con la calibración 32V/2A tiene `powerMultiplier = 2`, así que la potencia siempre sale múltiplo entero. Si esa calibración cambia, `${256.4}i` sería Line Protocol inválido.
- **No se manda timestamp**, así que InfluxDB usa hora de ingesta. Por eso a 5 s se ven intervalos de 2-4 s que el firmware no generó. `live_seq` es exacto igual; los deltas de tiempo no sirven para medir cadencia.

## ✅ Validación del `DHT_WARMUP_MS` 2000 → 1300 (2026-08-09)

**Sin evidencia de problema.** Cero fallos de `dht11_ok`, y el corrimiento aparente del delta contra el DS18B20 resultó ser **confundidor horario**, no el warmup:

| firmware | franja 19:40-20:20 UTC | n | mediana | % negativo |
|---|---|---|---|---|
| `1.13.2` (warmup 2000) | misma franja | 78 | −0,30 | **95%** |
| `1.13.2` (warmup 2000) | resto del día | 2781 | 0,00 | 44% |
| **`1.14.0` (warmup 1300)** | misma franja | 36 | −0,40 | 100% |

El firmware **sin cambiar** ya daba −0,30 y 95% negativo en esa misma franja: el enfriamiento de la tarde hace que el DHT22 —masa térmica chica— siga la caída más rápido que el DS18B20, y la ventana de `1.14.0` cayó entera adentro de ese transitorio. El residuo de ~0,1 °C está en la resolución del propio sensor.

**Método que vale reusar**: comparar distribuciones entre firmwares sin controlar la hora del día lleva a conclusiones falsas en cualquier magnitud con ciclo diurno. La validación sigue corriendo sola porque `1.15.0` y `1.16.0` llevan el mismo warmup.

## 🔎 El charger cicla, y el backend está aliasando ese cicleo (2026-08-09)

Analizado a pedido de Mau, que notaba "carga un ratito, corta, y después picos de generación". **Son ciclos cortos de carga/corte** — no el panel alimentando el módulo.

Un día despejado (2026-08-07, 9 h): **14 rachas de carga y 15 de corte**.

| fase | % del tiempo | `solar_mA` | `solar_v` | `system_v` |
|---|---|---|---|---|
| Cargando | 78% | 197 mA | 12,28 V | **4,192 V** |
| Cortado | 22% | 6,5 mA | ~14,1 V | **3,97 V** |

La firma está en las transiciones: al cortar, el panel **sube** a ~14,2 V (circuito abierto) y la corriente se desploma; al arrancar, **baja** a ~11,5 V (Vmp bajo carga) y salta a ~200 mA. Es terminación por CV más auto-recarga con histéresis, el comportamiento normal de un CN3791 con el pack lleno. Las rachas largas (hasta 3,7 h) son la carga real de la mañana; el cicleo corto aparece recién cuando ya está lleno.

### La consecuencia: tres valores del dashboard oscilan con el charger

| valor | lógica | en carga | en corte |
|---|---|---|---|
| SoC | `socCurve` sobre `system_v` | ~99% | **~75%** |
| `Charging` | `solar_mA >= 20` | true | **false** |
| `energyState` | `solar_v >= 12,5 → StateFull` | charging | **full** |

Ninguno está mal muestra a muestra: muestrean cada 60 s un proceso que cicla cada 1-10 min y reportan la fase instantánea.

**El más engañoso es el SoC.** En fase de corte el pack está **lleno** —acaba de terminar la carga en 4,2 V— y sin embargo lee 3,97 V, que la curva traduce a **~75%**. Son ~25 puntos de error sistemático, y aparecen justo cuando el sistema está en su mejor momento. `battery.go` ya advierte que es una curva en reposo y que `system_v` se mide con WiFi arriba; esto lo agrava.

Dato que confirma lo hundido de la lectura: hay muestras de `system_v` en **4,268 y 4,276 V**, por encima del 4,20 con que arranca `socCurve`. Es el pack durante carga activa. La curva las clampea a 100%, así que no rompe nada, pero el rango real desborda la tabla por los dos lados.

**Propuesta, no implementada**: derivar esos tres valores de una ventana y no de la última muestra. `energy` ya tiene la filosofía correcta —usa `DriftVPerH` sobre horas porque la batería es lo único que integra energía—; el SoC y el flag de carga quedaron instantáneos y desalineados con eso. Un máximo móvil de `system_v` sobre ~15 min daría el voltaje de la fase de carga, mucho más cercano al estado real del pack.

## ✅ Limpieza Spanglish → inglés — terminada, los 3 repos (2026-08-02)

Sesión dedicada exclusivamente a dejar el código de los 3 repos 100% en inglés (identificadores, comentarios, strings, texto de UI), como base para una futura sesión que implemente un sistema de i18n (selector EN/ES en la UI, hoy hardcodeado). Es el mismo pendiente ya anotado en "Pendientes de UI, revisados y anotados para atacar más adelante" (2026-07-29), más abajo en este archivo.

**Alcance acordado con Mau:**
- Sólo código + UI. La documentación narrativa (este archivo, los `CLAUDE.md`, `README.md`, `componentes_y_conexiones.md`, `aprendizajes_y_roadmap.md`, `backend_api_specs.md`, `datos_backend.md`, `logging_system_design.md`) queda en español a propósito.
- Los archivos de hardware (`.fzz` de Fritzing, exports de PCB, el esquemático PNG) quedan **excluidos** de esta pasada — no son código editable como texto y `CLAUDE.md` pide investigar antes de tocar cualquier cosa de hardware.
- Orden: **frontend → backend → IoT**.
- Commits: varios por módulo dentro de cada repo, no uno solo gigante, para que sea revisable.

**Hallazgo clave, vale para las tres pasadas:** los identificadores ya estaban en inglés en todos lados — nombres de función/variable/struct, `json:"..."` tags del backend, tópicos MQTT (`station/<id>/telemetry|status|cmd|log/req|log/data`), keys de `localStorage` (`pressureMode`). Esto convierte la tarea en **traducir comentarios y strings literales**, no en renombrar símbolos que rompan el contrato entre repos o dejen huérfanos datos históricos en InfluxDB. Si en el backend o el IoT aparece algún identificador realmente en español (variable, campo, tópico), parar y confirmar con Mau antes de renombrarlo — ninguno apareció en el frontend, pero no está garantizado en los otros dos repos.

**Regla aplicada para no romper comportamiento real:** valores que afectan el formato/idioma que ve el usuario final —`'es-AR'` pasado a `toLocaleString`/`toLocaleTimeString`, `America/Argentina/Buenos_Aires`, el reemplazo de `.` por `,` en `CalendarView.formatTemp`— **se dejaron intactos**. No son "código en español": son configuración de runtime, y ya estaban anotados en este mismo archivo (sección "Pendientes de UI") como parte deliberada del trabajo de i18n que viene, no de esta limpieza.

**Hallazgo no obvio para la sesión de i18n que viene:** no todo el texto de UI vive en el frontend. `internal/battery/battery.go` (backend) arma strings como los de `TierLabel`/`RiskNote` que el backend le manda al frontend y éste sólo muestra tal cual. La extracción a i18n va a necesitar tocar ese archivo también, no sólo `components/`.

### ✅ Frontend — terminado (2026-08-02)

Los 22 archivos de `src/` más `eslint.config.js` y `vite.config.js`. 7 commits, todos pusheados:
`ad1e058` utils/services · `601830b` app shell + dashboard/calendario · `46a49c9` service mode entry + componentes chicos · `76ea941` BatteryPanel + NodeHealthPanel · `4cdeaba` OtaWizard + PayloadViewer · `7ece61e` LogPanel.jsx (692 líneas, el archivo más grande) · `867f7df` eslint.config.js + vite.config.js.

Verificado `npm run lint` y `npm run build` limpios después de cada tanda. Barrido final por caracteres acentuados y palabras sueltas comunes (esta/esto/solo/aquí/etc.) sobre todo `src/` — cero coincidencias.

`datos_backend.md`, `backend_api_specs.md` y `README.md` quedaron en español (documentación, fuera de alcance).

### ✅ Backend — terminado (2026-08-02)

Los 12 archivos `.go` con contenido en español, más `.env.example` y `.gitignore`. 7 commits, todos pusheados:
`d70a06d` battery+config+luminosity · `15544e6` logdict+logdecode (incluye tests) · `96479b0` models/logs.go+service.go (+ arregla un resto sin tilde en battery.go) · `f4f70c7` api/routes+api/handlers/logs.go · `4ba5fb9` mqttbridge/bridge.go+logs.go (808+453 líneas, el paquete más grande) · `bce4be7` .env.example · `c9d85b7` .gitignore.

**Encontrado durante esta pasada, no antes:** el grep de tildes/ñ del arranque de sesión no alcanza — se coló "tabla de componentes" en un comentario de `battery.go` (sin tilde) que sólo apareció al pasar un segundo grep con palabras sueltas comunes sin acentuar (de/la/el/con/nodo/campo/etc.). Se corrigió y desde ahí se usó ese grep más amplio en cada archivo, no sólo el de acentos. **Si se retoma texto ya "terminado" de este proyecto, conviene repasarlo con ese grep amplio antes de darlo por bueno.**

**Confirmado el hallazgo de la sección de arriba:** `CommandResponse.Note` (bridge.go), `LogState.CantWhy` (logs.go) y las labels de `sensorCatalog` (bridge.go) son texto que el backend arma y el frontend muestra tal cual — ya traducidos, pero son la lista concreta de dónde va a tener que tocar la sesión de i18n además de `battery.go`.

Verificado `go build ./...`, `go vet ./...` y `go test ./...` limpios después de cada tanda (incluye actualizar un test de `logdecode` que buscaba el substring en español `"reinicio del nodo"` dentro de una nota ya traducida — pasa a buscar `"node restart"`).

`CLAUDE.md` quedó en español (documentación, fuera de alcance).

### ✅ IoT firmware — terminado (2026-08-02)

`src/` (command, logging, sensors, service_mode, config/board_config, main.cpp), `platformio.ini`, `infra/` (docker-compose.yml, mosquitto.conf, env.example), `secrets.ini.example`, `.gitignore`, y las dos herramientas de diagnóstico en `tools/` (`brokerprobe/` en Go+Python+PowerShell, `wifi-sniffer/` en C++/PlatformIO+Python). 9 commits, todos pusheados:
`30d23a3` command · `2bb4bec` logging.h/.cpp (incluye el diccionario `LOG_CODES` que renderiza texto de producción, no sólo comentarios) · `dd22689` sensors · `7dc6046` service_mode · `0c72566`+`d78ac7b` config.h+board_config.h (+ arregla un resto "I2C para BMP180" que el primer grep no vio) · `654687d` main.cpp · `c1cdd87` platformio.ini + infra/ + secrets.ini.example · `8997104` tools/brokerprobe (6 archivos) · `4657688` tools/wifi-sniffer (3 archivos) · `500225b` .gitignore.

**Repetido el hallazgo del backend, una vez más:** un grep con glob (`{archivo1,archivo2,...}`) devolvió falsos negativos — dijo que `platformio.ini` no tenía español cuando sí tenía. Se abandonó el filtrado por glob para el chequeo de completitud; el método que funciona es correr el grep (acentos **y** palabras sueltas) sin ningún filtro sobre la raíz del repo entero, y recién ahí triar archivo por archivo en docs/hardware/código. **Vale como regla general para las próximas veces que se retome esta limpieza en otro repo:** no confiar en un grep scoped por glob para declarar un repo "terminado".

Verificado con `pio run` (environments `production`, `development` del firmware principal, y el default `s3_uart` de `tools/wifi-sniffer`) — los tres compilan limpio. También `go build ./...` y `go vet ./...` sobre `tools/brokerprobe`, limpio.

**Nota de seguridad, sin resolver, no es parte de esta limpieza:** `tools/brokerprobe/main.go` tiene un default hardcodeado para el flag `--pass` (`aXdC7nE2gLEe`) que parece una contraseña MQTT real, commiteada en un repo de GitHub. No se tocó porque no es texto en español y cambiarlo no estaba pedido — queda anotado acá para que Mau decida si hay que rotarla y sacarla del default.

`aprendizajes_y_roadmap.md`, `componentes_y_conexiones.md`, `Readme.md`, `PCB/README.md`, `tools/brokerprobe/README.md`, `logging_system_design.md` y `CLAUDE.md` quedaron en español (documentación, fuera de alcance). Los archivos de hardware (`.fzz`, exports de `PCB/`, los `.svg`/`.html` de esquemático) no se tocaron.

### ✅ Verificación de "sin cambios funcionales" + bump de versión, los 3 repos (2026-08-02)

Mau pidió confirmar explícitamente que la limpieza no tocó comportamiento antes de flashear/deployar, con foco en el firmware por ser lo más costoso de arreglar si algo sale mal.

**Método**: tomar el diff completo de cada repo desde el commit anterior a la limpieza, "vaciar" el contenido de todos los strings y comentarios (dejar sólo el esqueleto de código real) y comparar viejo vs. nuevo. Cualquier línea donde el esqueleto cambiara —algo *fuera* de un string o comentario— quedó marcada para revisión manual, línea por línea. Sobre 26 archivos de IoT + 14 de backend + 18 de frontend, **cero cambios de código real**: todo lo marcado fue reflow de comentarios multilínea (el español y el inglés envuelven distinto), texto de UI/logs traducido, o placeholders de ejemplo (`CAMBIA_ESTO`→`CHANGE_THIS`). Un solo caso de identificadores renombrados (`tools/brokerprobe/linkstate.py`: `fotos`→`snapshots`, `grupos`→`groups`, `conectados`→`connected`), verificado sin referencias sueltas y compilando limpio.

Chequeo aparte y específico para el firmware: la tabla `LOG_CODES` (el diccionario que decodifica el backend) mantiene los mismos 14 códigos, mismo número de argumentos y misma secuencia `%a`/`%b` por entrada — sólo cambió el texto humano.

**Dos consecuencias de comportamiento, no roturas, que motivaron el bump:**
1. `_dictFingerprint()` en `logging.cpp` hashea el texto de las plantillas de `LOG_CODES`, así que cambió. Al primer boot con este firmware dispara el mecanismo ya existente para "cambió el diccionario" (resetea nivel y ring de logs en RTC) — mismo camino que cualquier firmware que agregue/reordene códigos, no es nuevo. Si hay una captura corriendo en el nodo de campo al momento de flashear, se pierde — comportamiento esperado, no un bug.
2. El caché de diccionario del backend (`internal/logdict`) está indexado por `FIRMWARE_VERSION`. Sin bump, el backend seguía sirviendo el diccionario viejo (español) cacheado para "1.13.1" y el texto traducido no se hubiera visto reflejado en el LogPanel.

**Bump aplicado** (sin cambios funcionales, PATCH, para que la build sea distinguible de la anterior):
- IoT: `1.13.1` → `1.13.2` (`platformio.ini`, envs `production` y `development`) — commit `4c0d262`.
- Backend: `1.2.0` → `1.2.1` (`internal/version/version.go`) — commit `a566cb4`.
- Frontend: `1.2.0` → `1.2.1` (`package.json`) — commit `b4145b7`.

Los tres repushados. Verificado que compilan/buildean limpio después del bump: `pio run -e production` (IoT), `go build ./... && go vet ./...` (backend), `npm run lint && npm run build` (frontend).

## ✅ Versión 1.2.0 — desplegada y verificada (2026-08-02)

> Desplegada por Mau (las dos imágenes) y verificada contra la Pi: `GET /api/v1/version` responde `1.2.0`, `/weather/current` trae `pressureQnh`, `batteryVolts`, `luminosity` y `energyState`.
>
> **Nota para no confundirse tras cualquier redeploy**: el `energyState` arranca en `unknown` ("Midiendo…") con la deriva vacía, porque el ring de batería del bridge vive en memoria y se vacía al reiniciar el backend. Se resuelve solo alrededor de una hora después. No es una falla.

Backend y frontend en **1.2.0**. Cuatro bloques de trabajo, en orden cronológico.

### 1. Sistema de versionado (no existía)

Ni constante, ni tags de git (cero en los tres repos), ni tags de versión en las imágenes. El `package.json` del front tenía `"version": "0.0.0"` del scaffold. Sólo el firmware estaba versionado.

- **Backend**: `internal/version/version.go`, una `var` (no `const`, para que un pipeline pueda estamparla con `-ldflags`). Se expone en `GET /api/v1/version`, que **no toca InfluxDB ni el broker** a propósito: sigue contestando cuando todo lo demás está caído, que es cuando alguien mira.
- **Frontend**: el campo `version` de `package.json`, leído en build por `vite.config.js` e inyectado como `__APP_VERSION__`.
- **UI**: leyenda `ui 1.2.0 · api 1.2.0` en la esquina inferior derecha. El backend degrada a `—` si no contesta — un hueco ocupado hace que "no contestó" se lea distinto de "misma versión".

> ⚠️ **Las imágenes usan tag mutable**, así que nada obliga a que el número suba cuando cambia la imagen. **Bumpear es el último paso antes de rebuildear.** Ya se pasó por alto una vez y lo tuvo que preguntar Mau. Anotado en el `CLAUDE.md` de los dos repos.

### 2. Presión: QNH por defecto

El nodo publica `pressure_qnh` desde siempre (`readSealevelPressure(ALTITUDE_M)`, 780 m) pero **ninguna query lo seleccionaba** — había sólo un comentario en `influx.go`. La card mostraba los ~923 hPa de presión de estación, que sólo se interpretan sabiendo la altura del sensor, en vez de los ~1013 que es como se cita una lectura barométrica.

Va como `*float64` con `omitempty`: el firmware **omite** el campo cuando la lectura falla (`main.cpp:414`), y colapsar eso en 0 mostraría una presión a nivel del mar de cero. Sin el campo, la card queda como antes, sin switch.

Toggle discreto (chevron + leyenda, ambos clickeables) que persiste en `localStorage`. Separador de miles apagado: `1.012,53` se confunde con el decimal de un vistazo.

### 3. El gráfico de lag térmico ahora grafica luz, no potencia del panel

Leía la irradiancia del INA219 del panel, que mide **la corriente que el cargador pide**, no la luz que llega. Con la batería llena el cargador corta y el valor se desploma con sol pleno. Medido el 31/07, día despejado:

| hora | `photo_kohm` | `solar_mW` | `solar_v` |
|---|---|---|---|
| 14:20 | 0,88 | **2393** | 12,02 |
| 15:20 | 0,94 | **79** | 13,33 |

La luz no se movió y la potencia cayó **30×**. El delator es `solar_v` **subiendo**: el panel yéndose a circuito abierto. Y arrancaba **~3 h tarde** al amanecer.

`internal/luminosity` es el hogar de la calibración (patrón de `internal/battery`). **Lo que costó fueron los dos refs**: anclar `dark_ref` en la oscuridad real da un gráfico que casi no se mueve, porque el crepúsculo se lleva **1,92 de las 3,29 décadas** de rango — 58,5% de la escala para media hora por día. Anclando en el crepúsculo (**50 kΩ**, con `sunny_ref` 0,5) la separación entre nublado y muy despejado pasa de 21 a **34 puntos**.

Tres correcciones sobre la query de Grafana equivalente, por si se lleva allá:
1. **El centinela 9999 se mapea a 0%, NO se filtra.** Es el 54% de las muestras (cubre todas las noches); descartarlo deja un hueco de 13 h que el gráfico interpola en silencio.
2. **Guard contra `≤ 0`** — hay un 0,0 registrado en el bucket y `math.log(0)` es `-Inf`, que clampea a 100%.
3. **Convertir por muestra y después promediar**, o las ventanas de amanecer y atardecer promedian el centinela con lecturas reales.

### 4. El medidor central pasa a ser un estado, no una resta

**El hallazgo más grande de la tanda.** El balance restaba `solar_mW - system_mW`, y esos dos **no están en las mismas unidades**: el del panel es continuo, el del sistema se mide durante el **3,6%** de cada ciclo en que el nodo está despierto. Es un pico, no un promedio.

- **56%** de las muestras diurnas con buena luz reportaban déficit.
- De esas **1099, ninguna** sobrevive prorratear el consumo (210 mW × 0,036 = 7,6 mW).
- La batería coincidía: deriva diaria `0,000 / −0,036 / −0,020 / +0,112 / 0,000 V`. Plana.

El caso reportado por Mau (batería llena, MPPT corta) es real pero es **18% del día**; el grueso son 1595 muestras (81%) donde el 45% decía déficit **mientras cargaba a 266 mW**.

Prorratear por ciclo de trabajo **se evaluó y se descartó**: el ciclo no viaja en la telemetría y el deep sleep está sin medir. Un piso disfrazado de promedio.

`internal/energy` clasifica cinco estados con las señales que sí pueden contestar. **Dos decisiones de diseño que no conviene re-derivar:**

- **La tensión del panel es la señal primaria de "hay luz", no la fotorresistencia.** Separa día de noche con **0% de error** sobre 4972 muestras (máx. noche 4,16 V, mín. día 7,88 V; umbral 6,0 en el medio del hueco). Y evita un modo de falla: `sensors.cpp` emite el centinela 9999 tanto para "oscuridad total" como para **"sensor desconectado"**, así que una LDR despegada haría anunciar que no hay sol al mediodía. La LDR queda de respaldo para cuando el INA solar no reporta.
- **"Lleno" se detecta por el panel en circuito abierto (≥12,5 V), no por tensión de batería.** El CN3791 sólo suelta el panel cuando la batería dejó de aceptar carga. Con el panel sobre 12,5 V el pack medía 4,084 V — bastante debajo de los 4,2 que un umbral ingenuo exigiría, porque `system_v` saguea bajo carga.

La deriva sale del ring en memoria del bridge (sin queries nuevas) y se estima por **mediana de tercios**, no restando punta contra punta: medido en noche profunda, restar puntas da una dispersión p10-p90 de **0,048 V/h** y medianas de tercios la baja a **0,0030**. El umbral de 0,010 queda afuera de la banda de ruido con el segundo estimador y adentro con el primero.

Validado sobre **5509 muestras**: 19-07h descargando, 09-15h y 16-17h cargando/llena, cero déficit en cinco días equilibrados.

### Lo que salió de acá y no es de esta tanda

- **El consumo de reposo pesa más que la ventana activa** — ver `weather-station-station-iot/componentes_y_conexiones.md`. Estimado desde la caída nocturna de la batería: **5,10 mA** totales, de los cuales la ventana activa explica 1,86 mA. Quedan **~3,2 mA (63%)** sin explicar. En mAh/día: activo 44,7 · resto 77,7 · **total 122,4**. Los LEDs están todos descartados (Mau confirmó DS18B20 y ESP32 desoldados); el sospechoso es el **reposo del step-up boost**. **Pendiente: medirlo con multímetro** — no hay firmware que lo resuelva, el INA219 se apaga al dormir.
- **Promediar el consumo en el firmware** — acordado que es conceptualmente correcto: es *adquisición*, no derivación, porque la dinámica sub-segundo del burst de WiFi **no existe en la telemetría** y ningún backend puede recuperarla. No es análogo al punto de rocío, que sí es función pura de datos publicados.

  📄 **El diseño completo vive en [`weather-station-station-iot/aprendizajes_y_roadmap.md`](./weather-station-station-iot/aprendizajes_y_roadmap.md) → "Medir la energía de la ventana activa"** — ahí está el detalle de implementación (qué campos publicar y por qué la integral y no el promedio, la codificación de bits del ADC del INA219, los tres obstáculos conocidos con la librería Adafruit y con el WiFi ocupando la ventana). Se documentó ahí y no acá porque el trabajo de firmware pasa por ese repo, y su `CLAUDE.md` manda el roadmap a ese archivo.

  **Orden acordado**: medir primero el reposo con multímetro. Esto instrumenta 44,7 mAh/día; el reposo son 77,7 mAh/día sin explicar.

## ✅ Tendencia de batería: el gráfico se duplicaba con cada reflash (2026-07-31)

Mau reportó "dos lecturas solapadas" en el gráfico de tendencia de energía de service mode, sospechando que aparecían al deployar firmware nuevo. **La sospecha era correcta, y la causa es exactamente esa.**

Los puntos de `telemetry` llevan un tag **`firmware`** (los tags del measurement son `firmware` y `station_id`). Entonces `from()` devuelve **una tabla por versión que el nodo corrió dentro del rango** — diez en las últimas 72 h, de `1.2.0` a `1.12.0`. `aggregateWindow` y `keep` trabajan por tabla, y `keep(columns:["_time","_value"])` saca la *columna* del tag pero **no fusiona las tablas**: la group key sigue ahí. El `for result.Next()` de Go aplanaba esas diez tablas en un solo slice, concatenadas en el orden en que Flux emite las group keys, que es **lexicográfico por valor del tag** — o sea `1.10.0, 1.11.0, 1.12.0, 1.2.0, 1.3.0, …`.

Resultado: una serie cuyo eje de tiempo avanza, salta para atrás y vuelve a avanzar. Con `XAxis type="number"` cada segmento se dibuja sobre todo el ancho, y eso es lo que se veía como dos trazos superpuestos más una recta larga cruzando el gráfico (la línea que une el salto).

**Arreglo** (`internal/database/influx_battery.go`): `|> group() |> sort(columns: ["_time"])` antes de `aggregateWindow`. Además de arreglar el orden es la aritmética correcta — es una sola batería física, y una ventana que cruza un reflash debe promediar todas sus muestras y no emitir un punto por versión. El `sort()` no es decorativo: `group()` concatena las tablas tal cual y `aggregateWindow` espera la entrada ordenada por tiempo.

**Segundo efecto que arrastraba, en `HandleGetBatteryTrend`.** El cutoff para pegar el ring en memoria al final de la serie sale de `points[len(points)-1].Time`. Con las tablas desordenadas ese último elemento era la cola de la versión que ordenaba última **por nombre**, no la muestra más nueva: quedaba horas en el pasado y `BatteryLiveAfter` volvía a apilar puntos vivos encima de historia que la serie ya traía. Se corrige solo al ordenar la serie; quedó anotado el acoplamiento en el comentario, porque no es evidente que esa línea dependa del orden del query.

**Verificado contra el InfluxDB de producción**, con el backend corriendo local (`MQTT_CLIENT_ID=weather-station-backend-dev`) y el front por `VITE_API_PROXY`: 72 h pasan de **464 puntos con 9 saltos hacia atrás** a **155 estrictamente crecientes y sin timestamps repetidos**. Los tres rangos de la UI (24h/72h/7d) quedan monótonos, y el gráfico se ve como una sola curva continua. `go build`, `go vet` y `go test` limpios.

> ✅ **Desplegado y verificado en campo el 2026-07-31.** Ver [el cierre del bloque](#-desplegado-todo-verificado-contra-la-pi-2026-07-31) al final de esta sección.

### ✅ El mismo bug estaba en las otras cuatro queries — también corregido (2026-07-31)

Mau pidió cerrarlo completo, así que se barrieron **todas** las queries Flux del backend. Las cinco que leen telemetría estaban afectadas (la sexta, el healthcheck, no mira datos). Commit `e4f5a74`.

**El caso más grave, y que nadie había reportado: `/weather/current` servía datos viejos.** `GetCurrentTelemetry` hace `last()`, que con el tag `firmware` contesta **una vez por versión**; el lector Go toma el primer record y Flux emite las group keys en orden lexicográfico. Medido en producción: el dashboard mostraba `2026-07-30T19:12:44Z` con **14,65 °C y balance 46 mW** mientras el nodo publicaba `1.12.0` — **20 h de atraso**, datos de la noche anterior en pleno día de sol (26,2 °C, +2466 mW, SoC 99,6%). Y no se destrababa solo: quedaba clavado hasta que esa versión saliera de la ventana de 24 h, y ahí pasaba a la siguiente **por orden alfabético, no por fecha**.

**El calendario anual mostraba extremos falsos.** `GetYearlyTemperature` corría `aggregateWindow(1d)` por versión, así que un día con reflasheo volvía como varias filas con la misma fecha, cada una con los extremos de *su* pedazo del día. `GetYearlyTable` indexa un map por día, o sea que **ganaba la última escrita** — la versión que ordenara última por nombre. Medido: **127 filas para 109 días**, y el 2026-07-29 informaba 14,86/14,77 °C cuando el día real fue **22,99/5,31**.

| día | antes (roto) | ahora |
|---|---|---|
| 2026-07-29 | 14,86 / 14,77 | **22,99 / 5,31** |
| 2026-07-30 | 11,94 / 11,91 | **15,65 / 11,91** |
| 2026-07-31 | 10,86 / 9,30 | **15,65 / 9,30** |

**`GetDailyRaw` es el único que no corrompía nada**, y conviene que quede escrito para no volver a investigarlo: `GetDailyStats` sólo saca max/min sobre todo el slice, que es independiente del orden, así que leía bien los extremos de una serie desordenada. Se corrigió igual para que no sea una trampa para el próximo que asuma orden temporal. Verificado: la respuesta es byte a byte idéntica antes y después.

**El detalle que no es obvio y cuesta media hora si se re-deriva: no se puede hacer `group()` a secas en las queries multi-campo.** Una columna de Flux tiene un solo tipo y estos campos son mixtos — `solar_mW` y `system_mW` son `long`, el resto `double` —, así que colapsar todo en una tabla deja `_value` ambiguo y la query **falla** con `schema collision detected: column "_value" is both of type float and int`. Hay que agrupar **por `_field`** (`group(columns: ["_field"])`), que fusiona las versiones y deja una tabla por campo, con su `_value` homogéneo. `influx_battery.go` y `GetYearlyTemperature` sí pueden usar `group()` pelado porque leen un solo campo.

Verificado endpoint por endpoint contra el InfluxDB de producción: `/weather/history/recent` (6h/24h/72h) y `/weather/history/day` quedan monótonos, el calendario baja a 109 filas para 109 días sin duplicados, y `/weather/current` devuelve una lectura de hace segundos. `go build`, `go vet` y `go test` limpios.

### ✅ El calendario corrido un día — arreglado, junto con el corte de día en hora local (2026-07-31)

Mau lo confirmó mirando y pidió arreglarlo para que entre todo en el mismo deploy. Decidió además que **los días se corten en hora local (ART, UTC−3)** y que la UI lo diga en algún lado. Backend `2238ec4`, frontend `707b555`.

Eran **dos causas independientes** que se sumaban:

1. **`timeSrc` por defecto.** `aggregateWindow` rotula cada ventana con su borde de **cierre**, así que la ventana diaria quedaba estampada en la medianoche que la termina. Corregido con `timeSrc: "_start"`.
2. **Ventanas cortadas en medianoche UTC**, o sea 21:00 local. Los extremos diarios se comían tres horas de la noche anterior. Corregido con `option location = timezone.location(name: "America/Argentina/Buenos_Aires")`, que además hace que `today()` resuelva en medianoche local. Alcanza a `GetYearlyTemperature`, `GetDailyRaw` y `GetDayHistory` — este último recibía del front una fecha armada con `getDate()` **local** y la leía como día UTC, así que estaba desalineado desde el vamos.

**Los instantes siguen viajando en UTC**, y esto es lo que más importa no re-derivar: el contrato con el front es que **el browser localiza**. `ApiService.getDailyStats` le **agrega una `Z`** al clock string antes de convertir, así que mover la zona en la respuesta hace que reste tres horas **dos veces**. Se intentó y se revirtió — el bug sólo se ve en la UI renderizada, no en la API, que es donde casi se pasa por alto. Lo único que se movió a local son los **bordes de día**, que deciden qué filas existen y eso el browser no lo puede rehacer.

Dos detalles de implementación que no son obvios: la zona va **nombrada y no como offset fijo de −3 h** (el offset es correcto para todo lo que hay en el bucket, pero el nombre sigue siéndolo si el país vuelve a mover los relojes, como hizo hasta 2009); y `time/tzdata` va **embebido en el binario** porque la imagen de runtime es `alpine` pelada sin zoneinfo — ahí `LoadLocation` no falla, **devuelve UTC en silencio**, que es exactamente el bug que esto arregla.

| jul | antes | ahora |
|---|---|---|
| 26 | 10,05 / 7,75 | **21,59 / 4,21** |
| 27 | 12,66 / 11,85 | **30,98 / 6,66** |
| 28 | 30,98 / 6,66 | **22,99 / 5,31** |
| 31 | 10,86 / 9,30 | **27,86 / 15,20** |

Verificado **en la UI renderizada** además de en la API: los 30,98 °C pasan del 28 al 27, la celda de hoy coincide exacto con los extremos del día (28,4 / 15,2 — cosa que antes no podía pasar, porque cada uno usaba un día distinto), y el mínimo del día pasa a marcar `12:00 a. m.` en vez de tomar la noche anterior. Aparece un día más en el año (110 vs 109).

**Indicador de zona en la UI**: badge `ART (UTC−3)` en la navbar, con tooltip que explica que los cortes de día también son locales. Va en la navbar y no en una vista porque aplica a las tres. Nuevo `src/utils/timezone.js` como semilla de la i18n ya anotada más abajo; los call sites existentes siguen hardcodeados a propósito, se migran en esa pasada.

**Queda deliberadamente sin cambiar**: los buckets **horarios** de `GetRecentHistory` y `GetDayHistory` siguen rotulados por su cierre. Cambiarlo correría los gráficos una hora y esa convención ya estaba establecida.

### ✅ Desplegado, todo verificado contra la Pi (2026-07-31)

Mau rebuildeó y pusheó **las dos imágenes** (`backend` y `frontend` — el badge de zona horaria vive en el frontend) y corrió `docker compose pull && up -d`. **Tema cerrado.**

Medido contra `http://192.168.18.250` después del deploy, no reportado de oídas:

| qué | antes | después del deploy |
|---|---|---|
| `/weather/current` | congelado 20 h en el pasado | **4 s de antigüedad** |
| calendario 27/7 | 12,66 / 11,85 | **30,98 / 6,66** (corrimiento corregido) |
| `date` del calendario | `...T00:00:00Z` | **`2026-07-27T00:00:00-03:00`** |
| celda de hoy vs extremos del día | usaban días distintos | **coinciden exacto** (29,42 / 15,20) |
| mínimo del día | tomaba la noche anterior | **`03:00:35Z` = 00:00 local** |
| `battery-trend` 72 h | 464 puntos, 9 saltos atrás | **155 puntos, 0 saltos** |

El `time` de los extremos sigue viajando en **UTC** (`17:34:30Z` para un máximo de las 14:34 local), que es el contrato correcto: el browser localiza. Confirmado que no hay doble conversión.

Este deploy se llevó **cuatro bloques de trabajo acumulados**: el contador de tiempo de captura (2026-07-29), la tendencia de batería, las cinco queries partidas por el tag `firmware`, y los cortes de día en hora local + el badge.

### Nota histórica: cómo se veía el bug antes de arreglarlo

**No tiene relación con el tag `firmware` y no lo introdujo este arreglo** — es anterior y sigue ahí. `aggregateWindow` rotula cada ventana con su borde de **cierre** (`timeSrc: "_stop"` es el default), así que la ventana del día N queda estampada a medianoche del día N+1. Medido:

| celda del calendario | contiene en realidad | max |
|---|---|---|
| 28/7 | datos del **27/7** | 30,98 |
| 29/7 | datos del **28/7** | 22,99 |
| 30/7 | datos del **29/7** | 15,65 |

Hay una segunda dimensión encima: las ventanas son **días UTC**, pero la estación está en Argentina (UTC−3) y el front formatea en `America/Argentina/Buenos_Aires`. Aun corrigiendo el rótulo, un "día" seguiría yendo de 21:00 a 21:00 hora local. **Queda pendiente de decisión de Mau**, porque arreglarlo mueve todas las fechas del calendario y además hay que elegir si el día es UTC o local.

## Vista de service mode — cuatro correcciones, y una necesita redeploy del backend (2026-07-29)

Lista de minor bugs/mejoras que trajo Mau sobre la vista de service mode. Las cuatro están implementadas y **verificadas en el browser** contra un backend mockeado servido por IP de LAN (ver más abajo por qué eso importa). `npm run lint` y `npm run build` limpios; `go build`, `go vet` y `go test` limpios.

> ✅ **Desplegado el 2026-07-31**, junto con los arreglos de las queries de Influx. El contador de tiempo de captura necesitaba dos campos nuevos en el snapshot de estado; ya están en campo.

**1. Los botones de copiar no funcionaban en campo — `navigator.clipboard` no existe sin HTTPS.** Afectaba al copiado de payloads y al del comando de PlatformIO. La API sólo está definida en *secure contexts* (HTTPS o localhost), y el dashboard se sirve por nginx en HTTP plano sobre la LAN, así que `navigator.clipboard.writeText(...)` tiraba un `TypeError` antes de intentar nada. El `catch` pelado se lo comía: de ahí que no apareciera nada en consola.

  **Por qué nunca se detectó**: `npm run dev` sirve desde localhost, que *sí* califica como contexto seguro. Toda la verificación previa de esta vista se hizo ahí. Cualquier cosa que dependa de una API restringida a secure context va a pasar en desarrollo y fallar en la Pi — conviene probar por IP de LAN cuando se toque algo así.

  Corregido con `src/utils/clipboard.js`, que hace fallback a `document.execCommand('copy')` sobre un textarea temporal. Está deprecado pero es lo único que funciona sin TLS. Detalles que no conviene re-derivar: el textarea va `readOnly` y no `disabled` (un `disabled` no se puede seleccionar, y sin selección no se copia nada), y fuera de la vista con `position:fixed` pero participando del layout (`display:none` lo dejaría sin selección posible). El guard por `window.isSecureContext` antes del feature detection no es redundante: hace que en campo se corte sin ningún `await` de por medio, y eso importa porque `execCommand` exige estar dentro del gesto del usuario. La alternativa de fondo sería poner el dashboard detrás de HTTPS, que para una LAN doméstica es un certificado y un dominio para arreglar un botón.

**2. Los niveles de captura ahora dicen el número.** `Anomalías (N1) · ~19.5 h`, `Resumen (N2) · ~8.0 h`, `Verboso (N3) · ~2.7 h`, y el tooltip abre con "Nivel N.". Se unificó en un helper `levelName()` que devuelve `nivel 2 (Resumen)` y se usa en todos los lugares donde antes se nombraba uno solo de los dos — chip de estado, aviso de cambio de nivel, diálogo de confirmación y toasts. El nivel es lo que viaja en el comando y en los payloads; el nombre es lo único que se entiende de un vistazo. Nombrar uno solo obligaba a traducir mentalmente entre la pantalla y el `level` del JSON.

**3. Comenzar/Detener captura ahora muestran que están esperando al nodo.** El síntoma era "clickeo y no pasa nada": el `POST` vuelve en milisegundos, pero el comando queda **retenido** hasta que el nodo despierte, lo lea y lo aplique — hasta un ciclo entero. La UI no cambiaba en nada, y el toast decía "Captura iniciada", que era falso. Ahora el toast dice "Comando publicado", el botón queda deshabilitado con `Comenzando captura…` / `Deteniendo captura…`, y un aviso explica en qué fase está la espera (esperando el wake, con el estimado de `nextWakeInSec`; o "el nodo levantó el comando, falta la telemetría que lo confirme").

  La confirmación exige tres cosas a la vez, y las tres hacen falta: que el nodo reporte el estado pedido, que lo reporte en una telemetría **posterior** al click, y que algo haya cambiado de verdad. Sin la tercera, volver a arrancar una captura en el mismo nivel que ya corría se daría por hecha con la primera telemetría que llegue, aunque el nodo todavía no hubiera leído el comando. Esa tercera condición mira tres señales porque ninguna sola alcanza: el nodo limpia el retenido al consumirlo (pero ese publish puede perderse como el 42% de los otros), el nivel cambia (pero no si se re-arranca en el mismo), y el contador retrocede — `logging_configure()` vacía el ring, y el contador nunca baja solo porque satura en la capacidad cuando empieza a pisar lo viejo. Timeout de 4 min (tres ciclos y monedas) que suelta la UI sin deshacer nada: el comando sigue retenido y el nodo lo va a aplicar cuando pueda.

  **Hallazgo del firmware que salió de acá, y que cambió el diseño**: un `log_on` publicado **mientras el nodo está en service mode se pierde en silencio**. El loop de `service_mode.cpp` sólo reacciona al topic de comandos cuando llega **vacío** —ese es el "salí de service mode"— y descarta cualquier otro payload; después, al cerrar la sesión, `serviceMode_exit()` limpia el topic y se lleva puesto el `log_on` que estaba esperando. Y como el topic retenido guarda un mensaje solo, publicarlo **pisa el `maintenance` que sostiene la sesión de OTA**. Era fácil caer ahí, porque el propio panel empuja a activar service mode para el paso de transferir. Así que los botones de captura ahora se deshabilitan con el nodo en service mode (o con un `maintenance` retenido esperando), explicando que el comando no se demoraría sino que se perdería. Transferir sigue habilitado: las dos mitades del panel tienen disponibilidad opuesta a propósito.

**4. Contador de tiempo de la captura activa.** Va en el chip de estado —`Capturando · nivel 2 (Resumen) · 544/768 · 3 h 7 min`—, así que se contesta "¿ya pasaron las 2 h que quería capturar?" sin abrir el panel, que era el pedido. Desplegado también en el cuerpo con la hora absoluta.

  El nodo no puede darlo: no tiene reloj, y su única marca de arranque es la entry `LOG_CAPTURE_START`, que recién se ve **después de transferir** — o sea justo la operación cara que esto tiene que evitar. Así que lo deriva el backend (`trackLogCapture`) observando las transiciones de `log_active`/`log_count` en la telemetría, y lo expone en `LogState.ActiveSince`. Precisión: un ciclo (~64 s), y peor si justo se perdió el payload del ciclo donde arrancó.

  Dos decisiones que importan. **Se reinicia cuando el nodo vacía el ring**, no sólo cuando arranca una captura de cero: cambiar de nivel y transferir con `keep:true` también dejan la memoria vacía, y en los dos casos la ventana que el nodo tiene guardada vuelve a empezar — que es lo que la pregunta realmente quiere saber. Y **`ActiveSinceExact` distingue haber visto arrancar la captura de haberla encontrado ya corriendo** (backend reiniciado). En el segundo caso el número es un piso y no un dato, y se muestra como `≥ 3 h 7 min` con "Corriendo desde *antes* de las 15:11": decir "hace 3 min" sobre una captura de seis horas sería peor que no mostrar nada, porque se leería como que arrancó recién.

**Dos menores corregidos de paso, en el mismo panel:**

- El label del botón de transferir miraba `busy`, que comparten todas las acciones del panel, así que arrancar una captura lo ponía en `Transfiriendo…` sin que nadie transfiriera. Ahora tiene su propio flag.
- El botón de "Activar service mode" del panel de logs se apagaba con `session.armed`, que el backend prende con **cualquier** comando retenido — incluido el `log_on` que acabábamos de publicar nosotros. Ahora chequea que el comando retenido sea efectivamente `maintenance`.

**Cómo se verificó**: mock del backend sirviendo el build por `http://192.168.18.27:8099`, o sea por IP de LAN y no localhost, para que el browser **no** considere la página un contexto seguro — la condición exacta que rompía el punto 1. Confirmado `isSecureContext: false` y `navigator.clipboard: undefined` antes de empezar. El copiado se probó end-to-end: copiar un payload y pegarlo con Ctrl+V en el input de JSON crudo, verificando que el texto pegado fuera el del renglón clickeado (`boot_count 4621`). El mock scriptea el timing real del comando retenido —lo retiene, lo consume a los 6 s, confirma por telemetría a los 9 s— así que las tres fases del punto 3 se vieron pasar. Los puntos 2 y 4 se verificaron en las dos ramas, exacta e inexacta, más el bloqueo por service mode.

## Pendientes de UI, revisados y anotados para atacar más adelante (2026-07-29)

Salieron de una pasada de revisión del frontend. **Ninguno está tocado** — se acordó enfocar la sesión en service mode.

- **El idioma está partido en dos.** Dashboard y calendario están enteros en inglés ("Live Data", "Max Temp", "Loading Weather Station..."); toda la vista de service mode está en español. Se nota fuerte al cambiar de vista. La idea es un **sistema de i18n con inglés/español switcheable**. Para React/Vite el camino estándar es `react-i18next` con un JSON de recursos por idioma, el idioma elegido persistido en `localStorage` y un selector en la navbar. Dos cosas a tener en cuenta cuando se encare: (1) hoy hay `es-AR` y `America/Argentina/Buenos_Aires` hardcodeados en varios `toLocaleTimeString`/`toLocaleString` —dashboard, calendario, `ServiceApi.js`, `BatteryPanel`—, así que el locale de formato tiene que pasar a salir de la capa de i18n o va a quedar desincronizado del idioma de los textos; y (2) el costo real no es el cableado sino el volumen: la vista de service mode es deliberadamente explicativa y tiene párrafos largos y decenas de tooltips con prosa técnica en español. Extraerlos es mecánico, traducirlos bien no.
- **Cambiar el rango de tiempo del dashboard borra la vista entera.** `Dashboard.jsx` hace `setIsLoading(true)` dentro del efecto que depende de `timeRange`, y el `if (isLoading)` devuelve el spinner a pantalla completa. O sea que un click en "6h" tira abajo las stat cards y el balance energético, que no dependen del rango. Debería recargar sólo la serie histórica.
- **`stats.maxTemp.value` sin guard** (`Dashboard.jsx`, bloque de extremos del día). El `if` de arriba chequea `!stats` pero no que traiga `maxTemp`/`minTemp`, así que un `/weather/stats/daily` sin esas claves revienta el render.
- **El dashboard pollea `/weather/current` cada 3 s** y el nodo publica cada ~64 s: son ~20 requests por cada dato nuevo. No es un bug, pero el intervalo no tiene relación con el ritmo real de la fuente.

## Deploy completo — backend, frontend y firmware `1.3.1` en producción (2026-07-28)

Todo el sistema de logs está desplegado y corriendo. **El nodo en campo corre `1.3.1`**, flasheado por Mau por fuera de la sesión de trabajo. Ya no queda ninguna acción manual pendiente de este bloque.

Lo que se hizo, en orden:

**1. Rebuild y push de las DOS imágenes.** `maulpdocker/weather-station:backend` y `:frontend` en Docker Hub eran anteriores a todo el sistema de logs; sin esto el `docker compose pull` bajaba lo viejo.

**2. `git pull`** en el clon de `weather-station` (repo main) de la Pi, para levantar el `docker-compose.yml` nuevo. Agrega un volumen `backend-data` montado en `/data` para el cache del diccionario de logs. Importa porque el diccionario código → texto sólo se puede pedir al nodo, y el nodo sólo conoce el de la versión que corre **ahora**: sin el volumen, cada redeploy lo borra y deja ilegible cualquier export de una versión vieja. No hizo falta tocar el `.env` — el compose define `LOG_DICT_PATH` en `environment`, que gana sobre `env_file`.

**3. `docker compose pull && docker compose up -d`**.

**4. Reflash a `1.3.1`.** Bumpeado desde `1.3.0` por la corrección de `LOG_PUBLISH_FAIL` (distinguir buffer de conexión caída). Cambió el diccionario de códigos, así que al flashear la huella dejó de coincidir y cualquier captura en curso sobre `1.3.0` se descartó — comportamiento correcto y esperado.

**Nota para probar en local**: si levantás el backend en la máquina de desarrollo, pisá el client ID o va a pelearse con el de la Pi por el mismo (`MQTT_CLIENT_ID=weather-station-backend-dev go run ./cmd/server/main.go`). Para probar sólo cambios de UI contra el backend ya desplegado alcanza con `VITE_API_PROXY=http://192.168.18.250 npm run dev`.

## No hay sesión entre front y backend — pero la historia se veía como si fuera actual (2026-07-28)

Volver al dashboard después de una noche mostraba payloads y anomalías de horas atrás, lo que se leía como una sesión que quedaba abierta. **No la hay**: el backend es el cliente MQTT, corre siempre con o sin browser —eso es lo que hace que el banner de comando retenido y el watchdog de sesión funcionen sin nadie mirando— y ceba cada conexión nueva con su ring buffer a propósito, para que el visor no abra vacío.

Lo que sí estaba mal es que esa historia no se distinguía de lo actual: `formatClock()` imprime `HH:MM:SS` y nada más, así que un evento de anoche se ve idéntico a uno de hace un minuto. Medido contra el backend desplegado, abrir el dashboard entrega **57 payloads que abarcan 1,3 h**, y el cliente pide hasta 100 (~1,8 h tras una noche).

Corregido con antigüedad relativa (`formatAge()`, que devuelve null por debajo de 2 min para no ensuciar lo que sí es en vivo), un separador entre el backlog y lo que llega después, y el mismo tratamiento en las discontinuidades de `boot_count` — ahí es donde más confundía, porque la lista guarda las últimas 20 sin tope de tiempo. El visor pasó a llamarse "Payloads del broker".

De paso se revisó el camino de limpieza del SSE por si había un leak de suscriptores, que era la otra lectura posible del síntoma: `HandleStream` cierra con `defer Unsubscribe` y sale por `r.Context().Done()`, y `broadcast()` es no bloqueante. **No había nada que arreglar ahí.**

## ✅ RESUELTO: forzar 802.11b lleva la pérdida de 39% a 0% (2026-07-30)

**`1.12.0` con `esp_wifi_set_protocol(WIFI_IF_STA, WIFI_PROTOCOL_11B)`.**

**Confirmado sobre 18 h de InfluxDB (2026-07-31), un único dataset homogéneo que abarca los dos firmwares:**

| firmware | ventana | ciclos | perdidos |
|---|---|---|---|
| `1.11.0` (tasas OFDM, el default) | 1,85 h | 107 | **37 = 34,6%** |
| `1.12.0` (forzado a 11b) | **16,05 h** | **922** | **3 = 0,3%** |

`z = 17,4`, `p = 1,9 × 10⁻⁶⁷`. **Una reducción de 106×**, y ya no sobre una ventana elegida: 922 ciclos cubriendo una noche entera. Queda **una pérdida cada 307 ciclos, o sea una cada 5,4 h.**

Las tres pérdidas fueron a las **23:11**, **06:09** y **06:10** local — las dos últimas consecutivas, probablemente un mismo evento de dos ciclos. No hay patrón horario ni agrupamiento que sugiera una causa sistemática remanente.

Esto además **cierra el problema del confundidor ambiental** que arrastraba toda la investigación: al venir los dos brazos del mismo dump y cubrir el `1.12.0` un ciclo día/noche completo, ya no hay forma de que la mejora sea un artefacto de la hora en que se midió.

_(Medición anterior, más chica, que ya apuntaba a lo mismo: 22/57 = 39% contra 0/40 = 0%, `p = 7,9 × 10⁻⁶`.)_

**Por qué funciona.** A 1-11 Mbps (DSSS) la sensibilidad requerida es 5-10 dB menor que en OFDM. El enlace del nodo estaba justo en el margen —lo dice todo lo medido antes: 16% de reintentos hasta en los ciclos sanos, rachas de 10+ reintentos agotando el límite— y bajar la tasa compra exactamente los dB que faltaban. El costo es tiempo de aire: una trama de 660 B tarda 0,5 ms a 11 Mbps contra 0,1 ms a 54, irrelevante en un nodo que transmite un puñado de tramas por minuto.

### ⚠️ Se llegó por un razonamiento equivocado, y conviene que quede escrito

La hipótesis que llevó a probar 11b fue: *"el sniffer captura las tramas de gestión del nodo (1 Mbps) y ninguna de datos (OFDM), a la misma distancia y en el mismo instante — luego las de tasa alta están al límite"*. **Esa observación era un artefacto.**

Entre las dos capturas que se compararon, el ESP32 sniffer había cambiado de posición: está sobre un escritorio regulable que se movió de 78 cm a 101 cm. **A 2,4 GHz eso son casi dos longitudes de onda** (λ ≈ 12,5 cm), suficiente para pasar de un máximo a un nulo de multitrayecto.

Verificado en vivo con un experimento controlado (marca a las 18:51:39, escritorio subido a las 18:52):

| escritorio | tramas del nodo | RSSI del nodo | RSSI del AP |
|---|---|---|---|
| abajo | **0** | inaudible | **-14 dBm** |
| arriba | **47** | -74 dBm | **-20 dBm** |

El control es que **el AP quedó 6 dB peor** mientras el nodo pasaba de inaudible a audible: no fue una mejora general del receptor, fue multitrayecto específico de ese trayecto. Y confirmado por partida doble: la captura de las 11:13 —sin 11b y con el escritorio arriba— **sí tenía** tramas de datos del nodo (`data: 40`, `qos-data: 27`).

**La lección de método**: el sniffer es un instrumento y su posición es parte de la calibración. Para comparar capturas entre sí hay que dejarlo fijo y anotado. Es el mismo error que ya habíamos identificado con el horario, cometido en otra dimensión.

La intervención resultó correcta igual, porque el mecanismo físico que la justifica —tasas bajas necesitan menos margen— era cierto por su cuenta y estaba sostenido por el resto de la evidencia.

### Limpieza de cierre (2026-07-31)

- **`1.13.0` saca los campos `pv_*` y el código de las balizas.** Los `pv_*` contestaron su pregunta y el detector de huecos de `boot_count` ya da la tasa de pérdida gratis; salen 55 B del payload (581 → ~526 B de 741), margen que va a querer el subsistema de viento. Las balizas nunca se flashearon en campo, así que era código muerto. Ambos vuelven con un revert si hacen falta.
- **El instrumental se versionó en [`weather-station-station-iot/tools/brokerprobe/`](./weather-station-station-iot/tools/brokerprobe/)**, con README. Antes vivía en el scratchpad de la sesión, que es temporal — y `STATUS.md` lo referenciaba desde ahí. Es lo que bajó el costo de medir la pérdida de una noche a 35 minutos.
- **Bug de InfluxDB corregido de paso** (backend): los puntos llevan un tag `firmware`, así que `from()` devolvía una serie por versión y `last()` contestaba una vez por cada una — el dashboard mostraba la que ordenara primero alfabéticamente, con dato "en vivo" congelado 8 h en el pasado. Lo destapó esta sesión sin querer, al dejar ~7 versiones dentro de la ventana de 24 h.

### Pendientes que deja

- **Confirmar en una ventana larga** (varias horas, distintos momentos del día) que el 0% se sostiene. 40 ciclos son concluyentes contra el 39%, pero no dicen nada sobre el comportamiento nocturno o con lluvia.
- **Evaluar `WIFI_PROTOCOL_11B|WIFI_PROTOCOL_11G` como término medio** si alguna vez molesta el tiempo de aire. Hoy no molesta.
- **La confirmación de entrega en banda queda sin urgencia**, pero sigue siendo la única defensa real contra una pérdida silenciosa. Vale como red de seguridad si el enlace vuelve a degradarse.
- **El margen sigue siendo escaso**: que 23 cm cambien tanto lo demuestra. La altura y orientación del nodo dentro de la caja estanca es una palanca gratis que nunca se tocó.

## 🎯 Causa raíz (análisis previo, superado por lo de arriba): el enlace al límite (2026-07-30)

**Encontrada con el sniffer 802.11.** No es el AP echando al nodo, no es steering, no es el driver colgado. **El nodo transmite y el AP no lo escucha.**

Las tres mediciones del aire, con el sniffer al lado del AP (o sea, oyendo aproximadamente lo que oye el AP):

| | mediana | rango | n |
|---|---|---|---|
| tramas **del nodo** | **-74 dBm** | -76 a -72 | 100 |
| tramas **del AP** | **-16 dBm** | -24 a -13 | 229 |

- **El 34% de las tramas del nodo salen con el bit RETRY.** Un enlace sano está en un dígito.
- **Ninguna trama de deauth/disassoc proviene del AP.** Las 25 que aparecieron en una ráfaga son del **nodo hacia el AP**, con `reason=8` ("la estación se está yendo del BSS"): es el `WiFi.disconnect(true)` de `goToDeepSleep()`. El nodo se despide, lo retransmite **25 veces** —24 con RETRY— y el AP no se lo reconoce ni una sola vez.

### Por qué esto invalida el análisis anterior, y no un poco

**Todo el descarte de "no correlaciona con el RSSI" usaba el RSSI equivocado.** `WiFi.RSSI()` mide lo que el nodo **recibe** del AP: -62/-64 dBm, saludable. La dirección que falla es la otra, y el nodo no tiene forma de medirla. Son **12 dB de asimetría** entre los dos sentidos del mismo enlace.

Y hay un agravante documentado que ahora se lee al revés: en su momento se subió el router **al máximo de potencia** porque "en medium el nodo no conectaba". Eso mejoró el downlink —el único que se estaba mirando— y **no hizo absolutamente nada por el uplink**, que es el que falla. Enmascaró el síntoma.

Con esto, todo lo medido antes encaja sin hipótesis extra:

- El enlace "se muere en los dos sentidos" porque el uplink agota los reintentos: el AP sí le llega al nodo, pero los ACK del nodo no vuelven, así que el AP también deja de insistir.
- El `LOG_PUBLISH_OK` engañoso: el nodo entrega los bytes a lwIP y nunca sabe que el frame no fue reconocido.
- Los ciclos perdidos que cierran con `WL_CONNECTED`: nadie lo desasoció, simplemente no lo oyen.
- El `DISCONNECT` que nunca llegaba al broker, y con él la sesión colgada que provocaba el takeover por client-ID duplicado en Mosquitto. Era este mismo fenómeno una capa más arriba.
- La no correlación con el RSSI **del nodo**, y la no correlación con el tamaño de frame (un management frame de 30 B falla igual que un PUBLISH de 503 B — no es tamaño, es margen).

### Confirmación con una hora de sniffer + broker en paralelo (2026-07-30)

59 ciclos sobre `1.10.0` (power save ya restaurado), con el sniffer y el `brokerprobe` corriendo juntos y cruzados por reloj de pared. **16 perdidos = 27%.**

| grupo | n | RSSI del nodo en el AP | % de tramas con RETRY | tramas | duración |
|---|---|---|---|---|---|
| ciclos que llegaron | 42 | **-74 dBm** | **16%** | 26 | 2421 ms |
| ciclos perdidos | 15 | **-74 dBm** | 37% | 36 | 5427 ms |

**El RSSI es idéntico entre los dos grupos.** La diferencia de reintentos NO sirve para explicar nada: es casi tautológica, porque un ciclo perdido es por definición uno cuyas tramas no fueron reconocidas, y cada no-reconocimiento genera un reintento. El dato que sí importa y no es circular es otro:

> **Hasta los ciclos SANOS tienen 16% de reintentos.** Un enlace sano está en 1-5%.

Y la tasa global se mueve muchísimo con el ambiente — medida en tercios de esa misma hora: **29% → 54% → 41%**.

**Cómo se decide entonces cuál ciclo se pierde.** Mirando las rachas de reintentos consecutivos aparece una distribución bimodal: 133 rachas cortas (1-3 reintentos, la trama termina pasando) y **20 rachas de 10 o más**, que es el límite de reintentos agotándose y la trama descartada. Esas 20 se corresponden bien con los 15 ciclos perdidos.

O sea: **el margen malo explica el régimen (por qué se pierde ~1 de cada 4), pero no cuál ciclo cae — eso lo decide que una racha de fallos consecutivos agote el límite.** Es una buena noticia para el plan: cada dB que se gane baja la probabilidad de fallo por trama, y como las rachas son potencias de esa probabilidad, la tasa de pérdida debería bajar **más que proporcionalmente**.

### ⚠️ Corrección de método: las comparaciones entre ventanas tienen un confundidor ambiental

La no-estacionariedad medida arriba (29% → 54% de reintentos **dentro de una misma hora**) obliga a bajarle el precio a todas las comparaciones entre ventanas tomadas en momentos distintos:

- **Power save ON vs OFF**: 4/32 = 12% (anoche 22:20) contra 16/59 = 27% (hoy 11:13). `z = -1,61`, `p = 0,11` — **no significativo**, y encima cambió la hora del día junto con el setting. No se puede atribuir.
- **El 41% → 12% atribuido al stack de cambios del router** también queda más débil de lo que parecía. El `p = 0,009` sigue siendo el número correcto, pero suponía que las dos ventanas eran comparables salvo por los cambios — y ahora sabemos que el ambiente solo mueve la tasa en ese orden.

Para cualquier A/B futuro que importe: **medir los dos brazos alternados en la misma franja horaria**, o aceptar que sólo se pueden detectar efectos grandes.

### Qué hacer, por costo creciente

1. **`WiFi.setTxPower()` al máximo** y verificar con `getTxPower()` qué está usando hoy. Es una línea y puede que ya esté al máximo, pero hay que mirarlo antes de suponerlo.
2. **Antena y orientación del nodo dentro de la caja estanca.** Es donde más margen hay para ganar dB gratis: una antena de PCB cerca de la batería, del cableado o de la propia PCB pierde muchísimo. Vale medir con el sniffer antes y después de mover la placa dentro de la caja.
3. **Acercar un AP al nodo.** Hoy los dos AX3000 están a **2 m uno del otro**, con lo cual el segundo no aporta cobertura. Reubicarlo cambiaría el problema de raíz — la limitación es que sostiene por cable a las RPi y la tele.
4. **Bajar el ruido del canal.** El canal 1 solapa con `Stitch` (canal 3, 82% de señal, **25% de uso de canal**). A -74 dBm de señal útil, el ruido del vecino pesa. El canal 11 se veía más limpio.

**El fix de la re-asociación al fallar `mqtt.connect()` sigue teniendo sentido** —recupera ciclos cuando el enlace se recompone— pero ahora se entiende como paliativo, no como solución: si el AP no oye al nodo, reasociarse tampoco lo va a oír.

## ⚠️ Pérdida de telemetría — DÓNDE RETOMAR (fin de la sesión del 2026-07-29)

Estado al cerrar: la pérdida bajó de **41% a 12%** (significativo, `p = 0,009`) y el modo de falla quedó acotado a una sola clase. Lo que hay que hacer, en orden:

1. **Implementar la re-asociación al fallar `mqtt.connect()`** — es el arreglo que corresponde al 12% que queda, y está justificado abajo. **No estaba empezado al cerrar la sesión.**
2. **Terminar la captura con el sniffer**, que quedó a mitad de camino por un problema de puerto serie, no del sniffer (detalle más abajo). Es opcional: contesta *por qué* se muere el enlace, no hace falta para arreglarlo.
3. **Volver `WIFI_POWER_SAVE` a 1** y remedir. Está en 0 sólo para no mover dos variables mientras se probaba el router; ya se demostró que no compra nada, y cuesta ~22 mAh/día.

Lo que corre en campo al cerrar: **`1.9.0`**, con la SSID `Ire y Mau IoT`, `WIFI_POWER_SAVE 0` y los campos `pv_*` de diagnóstico. Router: 2,4 GHz en canal 1, sin `ax`, los dos AP.

**Herramientas nuevas, que hacen barato repetir cualquier medición** (antes esto costaba una captura de logs y una sesión de service mode; ahora son 35 min desde la LAN):

- `brokerprobe` (Go, en el scratchpad de la sesión) — suscriptor propio que además lee los contadores `$SYS` del broker. Da la tasa de pérdida y si el PUBLISH entró al broker.
- `linkstate.py` / `analyze.py` — cruzan los `pv_*` y la aritmética de bytes.
- `pingstorm.ps1` — sondeo ICMP que acota cuándo muere el enlace dentro del ciclo.
- `tools/wifi-sniffer/` (versionado, en el repo del firmware) — captura 802.11 en modo promiscuo sobre una ESP32-S3 de banco.

### El sniffer quedó listo pero sin capturar todavía

No es un problema del sniffer: la placa arrancaba en **modo descarga** (`rst:0x15, boot:0x23 (DOWNLOAD(USB/UART0))`, "waiting for download"), esperando un flasheo que nunca llegaba, y por eso no imprimía nada. Lo causó tocar RTS a mano para "resetearla" — en el USB-Serial-JTAG del S3, DTR y RTS gobiernan IO0 y EN con lógica propia del periférico, así que cualquier toque se interpreta como secuencia de arranque. El monitor de PlatformIO probablemente hacía lo mismo al abrir el puerto.

**Para retomar**: el `platformio.ini` del sniffer ahora tiene dos entornos y el default es `s3_uart`, que saca el `Serial` por UART0 — hay que **enchufar el cable en el conector rotulado `UART`**, no en el `USB`. Ese es un puente USB-serie común, sin re-enumeración en cada reset ni rarezas de strapping. Se agregó además un latido cada 15 s, porque el nodo transmite 2,3 s cada 63 y sin eso no hay forma de distinguir "vivo y esperando" de "colgado".

Qué buscar en la captura, que son tres ramas mutuamente excluyentes: el nodo **sigue transmitiendo** con `Retry=1` y sin ACK (el AP lo dio de baja), el nodo **deja de transmitir** (se colgó su driver), o aparece un **deauth/disassoc** con su reason code.

## ⚠️ Pérdida de telemetría: se muere la ASOCIACIÓN WIFI a mitad del ciclo (2026-07-29, sesión dedicada)

**Localizado, y una capa entera más abajo de donde se lo venía buscando.** No es el broker, no es la entrega a los suscriptores, no es MQTT, no es TCP y no es el margen de RF. **El nodo se asocia bien, y unos cientos de milisegundos o unos segundos después deja de estar en la red — en los dos sentidos.** Todo lo demás que se venía midiendo son consecuencias de en qué punto del ciclo cae ese corte.

La prueba: sondeando el nodo con ICMP cada 150 ms (contesta ping, tiene IP estática) mientras se medían las llegadas al broker, **la ventana en que el nodo responde predice exactamente hasta dónde llega el ciclo**:

| ventana alcanzable por ICMP | hasta dónde llega el ciclo |
|---|---|
| 0–180 ms | ni siquiera conecta al broker |
| 470–1100 ms | conecta al broker, no llega a publicar |
| 2150–2700 ms | publica y cierra limpio |

El publish de telemetría sale a los ~2290 ms, así que sólo los ciclos del tercer grupo lo logran. Como el nodo no se puede enterar —en QoS 0 no hay ack y `PubSubClient::publish()` sólo informa que lwIP aceptó los bytes—, publica contra un enlace muerto y registra `LOG_PUBLISH_OK`. De ahí salía el dato engañoso que sostuvo todas las hipótesis anteriores.

**Esto reinterpreta un descarte que estaba documentado como firme**: *"no es WiFi — asoció al primer intento las 30 veces, cero `WIFI_FAIL`"*. Es cierto y es irrelevante: la asociación **siempre** funciona, se muere después, y `connectWiFi()` no vuelve a mirar `WiFi.status()` en todo el resto del ciclo.

**Descartado que sea un reset o un panic**: el nodo volvería a conectarse ~350 ms más tarde y aparecerían dos renglones en el log del broker en el mismo ciclo. No aparecen, y los wakes siguen clavados en la grilla de 62-63 s.

**Descartado el tamaño de frame**, que era la otra lectura posible de "el CONNECT de 67 B pasa y el PUBLISH de 503 B no": pings alternados de 32 B y 470 B *dentro* de la ventana despierta dan 88,3% y 91,7% de éxito. El grande no falla más que el chico.

### Dos hipótesis probadas y descartadas (2026-07-29, noche)

Se flashearon las dos juntas —SSID nueva + `WIFI_POWER_SAVE 0`— y se midieron 33 ciclos de `1.8.0`. **Ninguna resolvió el problema.**

**Resultado: 9 perdidos de 33 = 27%**, contra el 41% del baseline. Parece mejora pero **no lo es estadísticamente**: dos proporciones, z = 1,13, p ≈ 0,26. Con estos tamaños de muestra no se puede distinguir de 41%. Y la firma es idéntica — `publish/messages/received` = 24 = las 24 entregadas, y los ciclos perdidos entregan al broker sólo el CONNECT (~62-70 B) o CONNECT+SUBSCRIBE (~152 B).

**El modem sleep queda descartado, y esta vez con la verificación hecha.** Era fácil que `WiFi.setSleep(false)` no tomara efecto (el modo se aplica sobre el driver ya inicializado y `WiFi.begin()` puede pisarlo), así que se comprobó por fuera del firmware, midiendo el RTT de ICMP:

| | mediana | mínimo |
|---|---|---|
| `1.5.0`, power save por default | 42 ms | — |
| `1.8.0`, `WIFI_POWER_SAVE 0` | **7 ms** | 3 ms |

La línea funcionó —el AP dejó de bufferizar hasta el DTIM— y **aun así la asociación se sigue muriendo**. O sea que dormir la radio no era la causa.

**El band steering queda muy debilitado**: `Ire y Mau IoT` tiene un solo BSSID, en una sola banda y en un solo AP, así que no hay nada hacia donde stearlo, y el fenómeno persiste igual.

**Dato nuevo que sí quedó**: incluso con power save apagado, 5 de 57 respuestas ICMP tardan **108-494 ms** en una LAN. Eso es reintento a nivel MAC, y apunta a contienda de aire o al comportamiento del AP, no a margen de RF (el RSSI sigue clavado en -64 dBm y es idéntico en los ciclos que llegan y en los que no).

### Topología de red, que resultó ser parte del problema (2026-07-29)

No es una red doméstica estándar y conviene tenerlo escrito:

- **ONT/router del ISP** (Huawei EchoLife EG8041V5), `192.168.18.1` — hace de **servidor DHCP** de toda la casa. El ISP no lo pone en bridge. Su WiFi no se usa.
- **AX3000 "principal"** — colgado del ONT por ethernet gigabit, hace de AP. Acá se asocia el nodo.
- **Segundo AX3000 idéntico**, a 2 m del primero, unido por **WiFi**, y detrás de él por ethernet: la RPi del broker/N8N/backend, el NAS con InfluxDB y el smart TV. Se hizo así porque no se puede tirar cable hasta ese rack.

Consecuencia que importa: **el broker está detrás de un salto inalámbrico**, y los dos AX3000 son una **mesh**, no un puente tonto. El escaneo lo confirma — `Ire y Mau` tiene **cuatro BSSIDs** (dos por AP, uno por banda), y **las dos radios de 2,4 GHz están en el mismo canal 11**, a dos metros una de la otra.

Detalle que no es síntoma aunque lo parezca: **el nodo no aparece en la lista de dispositivos del ONT**, y es esperable por dos motivos independientes — tiene IP estática, así que nunca pide un lease DHCP; y su tráfico va sólo al broker, dentro de la LAN, así que los frames nunca tocan el ONT. Los logs de `service quality of ipv4 DNS on wan1` del ONT también son ruido: son del monitoreo WAN, y el nodo no hace una sola consulta DNS (el broker está por IP).

### Resultado con el stack completo: 41% → 12%, y el modo de falla se angostó (2026-07-29, noche)

Medidos 32 ciclos de `1.9.0` con **todos** los cambios aplicados (SSID de IoT, `WIFI_POWER_SAVE 0`, los dos AP fuera de `ax`, canal 1): **4 perdidos = 12%**, contra el 41% del baseline. `z = 2,61`, **`p = 0,009`** — la mejora acumulada es real.

**Pero no se puede atribuir a una perilla concreta.** Las ventanas intermedias no alcanzan: con SSID + power save y todavía `ax` en canal 11 daba 27% (p ≈ 0,26 contra el baseline, no significativo), y el salto a 12% coincide con "los dos AP sin `ax` + canal 1", pero 27% vs 12% por sí solo da p ≈ 0,14. Para separar cuál fue haría falta desandar de a una y medir ~100 ciclos por brazo. Anotado como deuda, no como conclusión.

**El veredicto de los campos `pv_*`, que era el objetivo de la ventana:**

| | n | `WiFi.status()` | `mqtt.state()` | despierto |
|---|---|---|---|---|
| ciclos que llegaron | 23 | `WL_CONNECTED` ×23 | conectado ×23 | 2292 ms (rango 2292-2294) |
| ciclos perdidos | 4 | **`WL_CONNECTED` ×4** | **timeout ×4** | **5322 ms** (rango 5295-5344) |

**El nodo nunca se entera.** En los cuatro ciclos perdidos cerró creyéndose asociado y con un RSSI normal (-62 a -64 dBm). O sea que **re-chequear `WiFi.status()` antes de publicar no sirve de nada** — siempre va a decir que sí. Eso descarta el arreglo barato que parecía posible.

**El modo de falla se angostó, y eso cambia cuál es el arreglo correcto.** Los cuatro perdidos son la misma clase: `mqtt.connect()` que agota el socket timeout (`-4`). **No hay un solo ciclo de la otra clase** —conectar bien y perder el publish en silencio—, que era la dominante con 41%. En esta configuración la pérdida ocurre entera al principio del ciclo.

**Y sale un costo energético que no estaba en ninguna cuenta**: un ciclo perdido queda despierto **5322 ms contra 2292 ms** de uno sano, porque paga entero el `setSocketTimeout(5)`. Al 41% de pérdida eso era ~50% más consumo de la ventana activa del presupuestado; al 12% es ~+16%.

### El arreglo que corresponde al modo de falla que quedó

`connectMQTT()` falla → hoy `main.cpp` se va directo a `goToDeepSleep()`. El pendiente que estaba anotado como "reintentar `mqtt.connect()` en el ciclo normal" **no alcanzaría**, y ahora se sabe por qué: el enlace está muerto, así que un segundo intento sobre el mismo socket volvería a agotar el timeout. Lo que hace falta es **forzar una re-asociación de WiFi** (`WiFi.disconnect()` + `WiFi.begin()`, porque `WiFi.status()` miente) y recién ahí reintentar MQTT.

Se paga sólo en el ~12% de ciclos que fallan, que además ya están quemando 5,3 s. Si funciona, la pérdida debería irse a ~0 y esos ciclos pasarían a costar ~7 s.

La **confirmación de entrega en banda** (eco del propio topic + republish) queda en reserva: es el arreglo para la otra clase de falla, la que hoy no aparece pero dominaba con la config vieja.

### Lo que sigue: 802.11ax en 2,4 GHz

**Hipótesis actual.** Las dos radios de 2,4 GHz se anuncian como **`802.11ax`** —incluida la SSID de IoT— y el ESP32-C3 es b/g/n. El mecanismo candidato no es una incompatibilidad genérica sino algo concreto: un AP WiFi 6 anuncia parámetros que un cliente legacy tiene que interpretar (**MU-EDCA**, sesiones de block-ack de **OFDMA**), y un cliente que los procesa mal **deja de transmitir sin perder la asociación**. Esa es exactamente la firma medida, y encaja con que apagar el power save no cambiara nada, porque no tiene relación con dormir la radio.

Orden propuesto, de a una perilla por vez y midiendo 35 min cada una:

1. Banda de 2,4 GHz: de `802.11b/g/n/ax mixed` a **`802.11b/g/n mixed`**.
2. Si no alcanza o no existe esa opción: **apagar OFDMA**.
3. Independiente del resultado, es sano igual: **separar los canales de los dos AX3000** (hoy los dos en el 11, a 2 m). Del escaneo de vecinos, el canal 1 está bastante libre.

**Pendiente de método**: `WIFI_POWER_SAVE` se deja en 0 **a propósito** mientras se prueba el router, para no mover dos variables. Cuando el router quede resuelto hay que volver a ponerlo en 1 y remedir — son ~22 mAh/día sobre un presupuesto activo de ~47, y ya está probado que no compra nada.

**Sigue sin descartar**: que la alimentación se caiga en los picos de transmisión. El `brokerprobe` guardaba sólo cuatro campos y `system_v` se perdía, así que no se pudo cruzar; ya está corregido para que guarde el payload entero.

> Se conserva más abajo lo que sigue siendo válido de las hipótesis anteriores, incluida la del keepalive/takeover — que **no** explica la pérdida, pero cuyo `1.6.0` se mantiene por ser correcto por sí mismo.

### Instrumento nuevo: medir la pérdida desde la LAN, en 30 minutos y sin tocar el nodo

Hasta ahora medir la pérdida costaba una captura de logs, una sesión de service mode y una transferencia paginada — o sea una noche y una operación cara. **Ya no.** `brokerprobe` (Go, en el scratchpad de la sesión) se suscribe al broker desde la máquina de desarrollo y lee los contadores `$SYS/broker/#` que publica el propio Mosquitto:

- `$SYS/broker/publish/messages/received` y `.../bytes/received` se incrementan en `handle__publish`, **antes de rutear**. O sea que dicen si el broker *ingresó* el mensaje, con independencia de a quién se lo entregue.
- Mosquitto publica cada valor de `$SYS` **sólo cuando cambia**, así que la secuencia de mensajes es la secuencia de transiciones con su timestamp.

Eso contesta algo que un tercer suscriptor **no puede** contestar, y por eso el pendiente anotado antes ("un `mosquitto_sub` en la Pi separa 'no llegó al broker' de 'el broker no lo entregó'") estaba mal planteado: si el broker descarta en el ingreso, *todos* los suscriptores pierden igual, y un consumidor más habría visto exactamente lo mismo que el backend y que InfluxDB.

**Medido el 2026-07-29, 32 ciclos de `1.5.0` (boot 200..231), 19 entregados y 13 perdidos = 41%:**

| | ingreso al broker alrededor del wake |
|---|---|
| 19 ciclos entregados | 505–662 B (mediana **660 B**) |
| 13 ciclos perdidos | 64–152 B (mediana **156 B**) |

Y `publish/messages/received` subió **+1 en cada uno de los 19 entregados y 0 en los 13 perdidos**, sin una sola excepción.

### La aritmética de bytes, que es de donde sale la conclusión

Los paquetes del nodo tienen tamaño conocido y fijo:

```
CONNECT      67 B  = 2 + (2+4 "MQTT") + 1 nivel + 1 flags + 2 keepalive
                       + (2+18 client id) + (2+19 user) + (2+12 pass)
SUBSCRIBE    21 B  = 2 + 2 packet id + (2+14 "station/01/cmd") + 1 qos
PUBLISH     503 B  = 3 + (2+20 "station/01/telemetry") + 478 de payload
DISCONNECT    2 B
             ─────
ciclo sano  593 B     (medido: 595-600 B en las muestras limpias ✓)
```

El ruido de fondo son los PINGREQ de los otros clientes (2 B c/u) y el healthcheck del contenedor, que conecta y sale cada 30 s (~75 B). Por eso algunas muestras dan ~660 en vez de ~596.

En los ciclos perdidos el ingreso es **~90 B = CONNECT + SUBSCRIBE**, y nada más. Un caso (boot 225) dio 64 B, o sea **sólo el CONNECT**: ahí el uplink murió aún antes, entre el CONNECT y el SUBSCRIBE, que están separados por milisegundos.

**Lo que eso obliga a concluir**, porque TCP entrega en orden y el broker no puede procesar lo posterior sin lo anterior:

1. El CONNECT llegó y el CONNACK volvió (coherente con el `LOG_MQTT_OK` de ~46 ms que el nodo registra en los ciclos perdidos). La conexión estaba viva y era **bidireccional**.
2. Después, todo lo que el nodo escribe en ese socket se pierde: el PUBLISH y también el DISCONNECT.
3. El punto de muerte **varía** entre ciclos — a veces inmediatamente después del CONNECT, casi siempre después del SUBSCRIBE y antes del publish.

O sea: **la ventana de muerte es el hueco de ~1,9 s que va del handshake (~330 ms) al publish (~2290 ms)**, y en ese hueco el nodo no manda nada. Es exactamente el tramo en que espera el retenido y lee sensores.

### Por qué la cadena del takeover no cierra

La hipótesis decía: un ciclo publica bien → su `DISCONNECT` se pierde → el broker mantiene la sesión 90 s → el ciclo siguiente hace takeover → **ese** publish se cae → alterna.

- **En los ciclos que llegan, el `DISCONNECT` sí llega**: los 593 B medidos lo incluyen. Entonces esos ciclos cierran limpio y no dejan sesión colgada, así que no hay takeover que provocar en el ciclo siguiente. (Salvedad honesta: son 2 B sobre 593, dentro del ruido — lo que lo prueba de verdad es el log del broker, ver los pendientes.)
- La sesión colgada aparece después de los ciclos **perdidos**, que son los que no mandan `DISCONNECT`. Pero los datos de alternancia dicen que tras una pérdida el ciclo siguiente **acierta el 72% de las veces** — o sea que el takeover, cuando ocurre, no es lo que rompe.
- El apoyo histórico (17% con keepalive 15 s vs 42% con 60 s) es débil: esta misma sección ya documenta que **el 17% estaba subestimado 2,5×**, así que probablemente siempre fue ~40% y el keepalive nunca movió la aguja.

### Cambios de firmware de esta sesión

**`1.6.0` — keepalive 30 s en el ciclo normal, 60 s sólo en service mode.** Se mantiene aunque la hipótesis se haya debilitado, porque es correcto por sí mismo: tras cada ciclo perdido queda una sesión viva 90 s y el wake siguiente arrastra un takeover por client-ID duplicado que no tiene por qué existir. Con 30 s el broker la expira a los 45 s, por debajo de los 57 s del peor caso del ciclo. En el ciclo normal el nodo vive 2,2 s, así que su propio PINGREQ nunca se dispara y bajarlo no cuesta nada. Service mode necesita lo contrario (sesiones de minutos, `ArduinoOTA.handle()` bloquea decenas de segundos sin mandar nada) y como el valor que gobierna al broker es el que viaja en el CONNECT, `serviceMode_run()` **reconecta** para renegociarlo — después de publicar el `service_mode_active` y de levantar OTA, para no arriesgar la verificación del flasheo, y con un solo intento porque el loop ya sabe reconectar.

**`1.7.0` — balizas de uplink (`UPLINK_BEACON` en `config.h`, se apagan poniéndolo en 0).** Dos publishes de ~42 B en `station/01/dbg`, con el `boot_count` adentro para poder cruzarlos contra la telemetría faltante: `pre_sensors` al terminar la espera del retenido (~1170 ms) y `pre_publish` inmediatamente antes del payload grande (~2280 ms). Parten el hueco de 1,9 s en tres tramos distinguibles:

| qué llega en un ciclo perdido | conclusión |
|---|---|
| ninguna baliza | murió durante la espera del retenido |
| sólo `pre_sensors` | murió durante la lectura de sensores |
| las dos | el enlace estaba vivo 10 ms antes → **el problema es el frame de 503 B, no el enlace** |
| llega hasta la telemetría | el tráfico extra lo arregló → el problema es el hueco sin tráfico |

**Lo medido (segunda captura, `1.3.1`, 68 ciclos, nivel 3):**

- **67 ciclos registraron `LOG_PUBLISH_OK` y sólo 39 llegaron. 28 perdidos = 42%.**
- Verificado cruzando **dos consumidores independientes**: el backend Go (MQTT directo) e InfluxDB (vía N8N). Coinciden exactamente en qué llegó y qué no. Dos caminos separados que pierden los mismos mensajes ⇒ nunca llegaron al broker.
- **`LOG_PUBLISH_OK` no prueba entrega.** `PubSubClient::publish()` devuelve `true` cuando la escritura al socket tuvo éxito; en QoS 0 no hay ack posible. El nodo cierra el socket en el mismo milisegundo (`mqtt.disconnect()`) y apaga la radio 200 ms después, así que si el segmento TCP necesita retransmisión —RTO del orden de 1-3 s— muere sin que nadie se entere.
- **No correlaciona con la señal.** Ciclos que llegaron vs. perdidos: RSSI idéntico, tiempo de `mqtt.connect()` idéntico, tamaño de payload idéntico, tiempo despierto idéntico.

**Confirmado y reforzado por una tercera captura (`1.5.0`, 119 ciclos, 2026-07-29):**

- **La pérdida se mantiene en 38%** — dentro del ruido respecto del 42%, como se esperaba: el `1.4.0` y el `1.5.0` se hicieron cuidando de no tocar el camino de red.
- **La hipótesis de radiofrecuencia queda muy debilitada.** Esa noche el RSSI barrió **10 dB** (-71 a -61) contra los 4 dB de la captura anterior, y la correlación sigue siendo exactamente **cero**: mediana -67 dBm tanto en los llegados como en los perdidos. La salvedad de la banda angosta queda contestada.
- **La pérdida NO es independiente — alterna.** Esto **corrige** la conclusión de la captura anterior ("pérdida independiente y sin memoria"), que salió de comparar rachas contra una geométrica sobre sólo 67 muestras. Con 112 pares consecutivos:

  ```
  P(perdido | el anterior se perdió) = 0.279
  P(perdido | el anterior llegó)     = 0.470
          si fuera independiente:      0.384
          chi² = 3.96 (1 gl) → p < 0.05
  ```

  Un ciclo tiene casi el doble de probabilidad de perderse si el anterior llegó bien. Se ve a ojo en la secuencia (`X.X.X.X.XXX`, con tramos limpios de hasta 12 seguidos entre medio). Hay además no-estacionariedad: ventanas móviles de 10 ciclos van de 0 a 7 pérdidas.

La alternancia sigue siendo un dato válido, pero **ya no apoya la cadena del takeover** — ver arriba por qué no cierra. Lo que hoy tiene que explicar cualquier mecanismo candidato es más específico: por qué el uplink muere en un punto variable del hueco de 1,9 s, y por qué eso pasa más seguido justo después de un ciclo exitoso.

### Lo que falta para cerrarlo

**1. El log del broker — es lo único que separa las dos sub-hipótesis que quedan.** Los bytes del PUBLISH pueden no haber llegado nunca (pérdida en el aire, y el nodo muere antes de que lwIP retransmita: el RTO es de 1-3 s y la radio se apaga 300 ms después del publish), **o** pueden haber llegado a la Pi con el socket ya cerrado por el broker, en cuyo caso el kernel los descarta con un RST y el contador `$SYS` tampoco se mueve. Los dos casos son indistinguibles desde afuera, pero el log del broker los separa:

```
docker exec mosquitto sh -c 'ls -la /mosquitto/log/; head -3 /mosquitto/log/mosquitto.log'
docker exec mosquitto grep -icE "already connected|closing old" /mosquitto/log/mosquitto.log
docker exec mosquitto grep -ic "exceeded timeout" /mosquitto/log/mosquitto.log
docker exec mosquitto grep -ic "Socket error on client weather-station-01" /mosquitto/log/mosquitto.log
docker exec mosquitto sh -c 'grep weather-station-01 /mosquitto/log/mosquitto.log | tail -30'
```

- Si el broker **cerró** el socket, hay una línea de cierre en el instante de la pérdida.
- Si los bytes **nunca llegaron**, el broker no ve el `DISCONNECT` y da de baja la sesión ~90 s después por keepalive → aparecen `exceeded timeout` en ~40% de los ciclos, y `already connected` en el ciclo siguiente.
- `log_type` ya tiene `error`, `warning` y `notice`, que alcanzan para las tres líneas. El primer comando da el tramo temporal que cubren los conteos (los timestamps de Mosquitto son epoch). Descomentar `log_type information` en `weather-station-station-iot/infra/mosquitto/config/mosquitto.conf` y reiniciar el contenedor agrega una línea por conexión con el **puerto de origen y el keepalive negociado**.

> El intento anterior no sirvió y conviene no repetirlo: `docker logs mosquitto` está vacío **por diseño**, porque `mosquitto.conf` tiene `log_dest file`. Hay que entrar con `docker exec`.

**2. Flashear `1.7.0` y leer las balizas** — parte el hueco de 1,9 s en tres tramos (tabla arriba). Con `brokerprobe` corriendo, el resultado se lee en 30 minutos.

**3. Modem sleep, que es el sospechoso natural del hueco.** El `WiFi.setSleep()` del ESP32 está en el default (`WIFI_PS_MIN_MODEM`), y hay evidencia directa: los pings al nodo vuelven en **53-63 ms** dentro de una LAN, que es el AP guardando el paquete hasta el DTIM. El hueco de 1,9 s sin tráfico es precisamente donde la radio entra en modem sleep. Un `WiFi.setSleep(false)` en el ciclo normal lo prueba en una línea, pero **no es gratis**: son ~+22 mAh/día sobre un presupuesto activo de ~47, así que sirve como experimento y habría que pensarlo dos veces como fix permanente.

### El fix que funciona sin saber la causa

**Confirmación de entrega en banda, aprovechando que TCP entrega en orden.** Hoy el nodo publica a ciegas: QoS 0 no da ack y `PubSubClient` no puede publicar en QoS 1. Pero si el nodo **se suscribe al propio topic de telemetría**, el broker le devuelve su propio payload, y recibir ese eco es prueba de que el PUBLISH entró. Con eso el nodo puede reconectar y republicar en el mismo ciclo, y de paso registrar `confirmado`/`sin confirmar` en el log — convirtiendo el 41% ciego en un dato observable.

Costo: ~40 ms de espera en el caso bueno (RTT de LAN) y ~480 B de RX por ciclo, contra recuperar el 41% de los datos. Vale la pena decidirlo con Mau antes de implementarlo, porque cambia el contrato del ciclo normal.

**Nota de método**: el `1.4.0` y el `1.5.0` se hicieron cuidando de **no perturbar el camino de red**, para que el baseline siguiera siendo comparable. El `1.6.0` y el `1.7.0` **sí lo tocan a propósito**, que es el punto — y el baseline contra el que se comparan ya no es una captura de logs de una noche sino los 32 ciclos medidos con `brokerprobe`, que se reproducen en 35 minutos cuando se quiera.

### Qué sí quedó establecido (primera captura, `1.3.0`)

177 eventos, 30 ciclos, nivel verboso, 0 pisados. **Análisis completo en [`weather-station-station-iot/aprendizajes_y_roadmap.md`](./weather-station-station-iot/aprendizajes_y_roadmap.md) → "Primera captura de logs en campo".** Sigue siendo válido, pero explica el 1,5% de fallos de conexión, no el 42% de pérdida:

- **No es WiFi.** Asoció en el primer intento las 30 veces, con señal buena y mala. Cero `WIFI_FAIL`, cero `WIFI_GIVEUP`.
- **Es TCP/MQTT, y correlaciona con el RSSI.** A **-73 dBm fallaron 3 de 5 ciclos (60%)**; a -63/-66 dBm, **0 de 21**. El handshake MQTT pasa de ~40 ms a 2400–3200 ms y a veces cruza el socket timeout de 5 s. `state -4` = `MQTT_CONNECTION_TIMEOUT`.
- **El enlace oscila ~9 dB solo por movimiento de personas o puertas**, sin ningún cambio de configuración. El router ya está al máximo de potencia, y eso fue un parche necesario: en "medium" el nodo no conectaba. La condición marginal es el régimen normal.
- **El tiempo despierto es 3,3 s, no ~10 s** — la cifra que circulaba por los documentos estaba mal por 3×. La red está lista a los 314 ms y el nodo se queda 3 s más con el WiFi asociado esperando el retenido y el warmup del DHT22. Eso reordena dos pendientes conocidos: **los 800 ms del retenido son el 24% del despierto, no el 8%**, y el **warmup del DHT22 es el 61%**.

**Corregido ya**: `LOG_PUBLISH_FAIL` decía "¿buffer corto?" con 505 B contra 741 disponibles — era una conexión caída. Ahora el firmware distingue las dos causas.

**Diferido a la sesión dedicada de MQTT**: reintento de `mqtt.connect()` en el ciclo normal. Hoy hay un único intento; si da timeout, `main.cpp` va directo a `goToDeepSleep()`. Con WiFi ya arriba —la parte cara, y que nunca falla— un segundo intento cuesta a lo sumo otro socket timeout. ~~Y **revisar el presupuesto de reintentos de WiFi**~~ — **resuelto el 2026-07-31 en `1.13.1`.** Decía que el peor caso de `WIFI_MAX_RETRIES` 3 × `WIFI_TIMEOUT_MS` 15 s = 45 s nunca había ocurrido, y pedía capturar una ventana con peor señal antes de recortar. Esa captura llegó (nivel 1, ~830 ciclos) y **el peor caso ocurrió dos veces** — boots 668 y 1074, con `WIFI_GIVEUP` a los 45,9 s despierto. `WIFI_TIMEOUT_MS` bajó a 5 s; los detalles y por qué no menos están en `src/config.h`.

**Ya hecho**: mover el rail-on del DHT22 al inicio de `setup()` — entró en el `1.5.0`, ver la sección de power management.

## Power management — dos fixes en campo (2026-07-29)

Retomado tras estar en pausa desde el 2026-07-26. La medición de campo reordenó las prioridades respecto de lo que se suponía.

**El dato que faltaba: `system_mA` = 51,2 mA de mediana** en la ventana despierta (59 muestras de InfluxDB). La cifra que se venía estimando era ~100 mA — **estaba 2× alta**. Presupuesto real:

| Consumidor | mAh/día | Origen |
|---|---|---|
| Ventana despierta (51,2 mA × 3,3 s × 1440) | ~68 | medido |
| INA219 en conversión continua 24/7 | 32–45 | datasheet, sin medir |

Con eso, los dos INA219 resultaron estar en el mismo orden de magnitud que **toda** la ventana activa, cosa que no estaba en ninguna lista de pendientes.

**`1.4.0` — los INA219 duermen en power-down entre ciclos.** Cuelgan del bus 3V3, que el regulador del ESP32 sigue alimentando durante el deep sleep, así que venían convirtiendo los ~57 s por ciclo en que nadie los lee: ~0,7-1 mA c/u contra ~6 µA en power-down. Ahorro estimado **32–45 mAh/día**. Detalles que no conviene re-derivar:

- `Adafruit_INA219::powerSave()` usa `i2c_dev` **sin chequear null**, y el camino de fallo de red entra a deep sleep sin pasar por `sensors_init()`. De ahí el guard por `_solar_ok`/`_system_ok` — sin él, el nodo crashearía justo en los ciclos que fallan la conexión.
- No hace falta despertarlos: `begin()` → `init()` → `setCalibration_32V_2A()` reescribe el registro de config completo, incluido `MODE_SANDBVOLT_CONTINUOUS`.
- `serviceMode_exit()` llama a `esp_deep_sleep()` directo, sin pasar por `goToDeepSleep()`, así que apaga los monitores por su cuenta. Las cinco salidas de service mode pasan todas por ahí.
- **El power-down no afecta la carga solar**: apaga el ADC del chip, pero el shunt de 0,1 Ω sigue físicamente en serie en el camino del panel.
- La llamada quedó **al final del teardown, con la radio ya apagada**, y no entre el publish y el `disconnect()`. Con el bus I2C trabado serían hasta 4 × 50 ms de timeout de `TwoWire` inyectados justo en el tramo bajo investigación por el 42% de pérdida — habría arruinado la comparabilidad del baseline.

**`1.5.0` — el warmup del DHT22 corre en paralelo con la red.** El rail-on salió de `sensors_init()` (que corre después de WiFi, MQTT y la espera del retenido) y pasó al arranque del ciclo normal. Los ~2 s de estabilización del DHT22 dejaron de pagarse en serie al final del ciclo.

**Medido en campo (2026-07-29, 116 ciclos sanos sobre `1.5.0`):**

| Tramo | `1.3.1` | `1.5.0` |
|---|---|---|
| boot → WiFi ok | 277 ms | 275 ms |
| red lista (absoluto) | 322 ms | 324 ms |
| `mqtt.connect()` | 42 ms | 46 ms |
| **red lista → publish** | **3047 ms** | **1968 ms** |
| **despierto (`LOG_SLEEP`, cuantizado a 100 ms)** | **3300 ms** | **2200 ms** |
| publish absoluto | 3365 ms | 2292 ms |

**−1073 ms, −33%, ≈ −22 mAh/día** con los 51,7 mA medidos. Los demás tramos quedaron dentro de milisegundos del baseline, que era el objetivo de método: el camino de red no se movió, así que la medición del 42%/38% de pérdida sigue siendo comparable.

**Balance de los dos fixes juntos**: el consumo conocido pasa de ~100–113 mAh/día a **~47 mAh/día** de ventana activa (más el deep sleep, que sigue sin medir). Aproximadamente la mitad.

- `sensors_railsOn()` es **idempotente** y `sensors_init()` la vuelve a llamar, así que el init sigue siendo correcto por si algún camino futuro llega ahí sin pasar por `setup()`.
- Va **después** del early-return de service mode a propósito: ese camino no toca los rails, y una sesión puede durar 60 min — encenderlos ahí dejaría al sensor de lluvia con tensión continua sobre los electrodos toda la sesión.
- **El tiempo total de rails energizados no cambia**: el ciclo se acorta en la misma medida en que el encendido se adelanta (~2540 ms antes, ~2545 ms después). La exposición del sensor de lluvia queda igual.
- El DHT22 sigue recibiendo `DHT_WARMUP_MS` completos desde la energización; lo único que cambia es cuánto de eso se superpone con trabajo útil.

**Efecto de composición que invalida un pendiente anotado.** Desde el `1.5.0` el despierto es `max(camino de red ≈ 1270 ms, DHT_WARMUP_MS = 2000 ms) + lecturas ≈ 240 ms`, o sea que **el warmup pasa a ser el término que manda**. Consecuencia: **acortar `MQTT_RETAINED_WAIT_MS` ya no ahorra nada** — lo que se recorte ahí lo absorbe el warmup y el total queda igual. El pendiente que figuraba como "los 800 ms del retenido son el 24% del despierto" dejó de aplicar. La palanca que queda viva es `DHT_WARMUP_MS`, hoy en 2× el mínimo del datasheet del AM2302, pero bajarlo requiere validación contra lecturas reales — un warmup corto ya fue sospechoso de lecturas erráticas en julio. Documentado en `src/config.h`.

**Verificado en hardware**: los módulos INA219 **no tienen LED de alimentación** (confirmado por Mau, 2026-07-29). Era la duda que quedaba, porque un LED a 1-3 mA por módulo habría superado a todo lo demás junto y `powerSave()` no lo apaga.

**Sigue pendiente de power management**: `src/battery.h` continúa vacío y el sistema de tiers sin implementar. Ojo con la premisa: los tiers **no ahorran en deep sleep** — GPIO7/GPIO8 no son RTC GPIOs en el ESP32-C3, así que al dormir quedan sin drive y el pull-down de 9,9 kΩ corta ambos rails solo. El ahorro real de los tiers está en T3/T4, que cambian el *intervalo* de sleep, no en los rails.

## Sistema de logs del nodo — completo en los tres repos y validado en campo (2026-07-28)

Diseño completo en [`weather-station-station-iot/logging_system_design.md`](./weather-station-station-iot/logging_system_design.md), que es el contrato para los tres repos. **Firmware, backend y frontend implementados; el flujo entero se probó end-to-end contra el nodo real** — armar captura, dejarla correr, entrar a service mode, transferir 177 eventos en 4 páginas y borrar con confirmación. **Desplegado y en producción** (ver arriba).

**El problema**: el nodo en campo no tiene observabilidad. `LOG_V`/`LOG_E` son `Serial.printf` y con `LOG_LEVEL=0` compilan a no-op, así que la única forma de ver algo es abrir la caja estanca y enchufar USB. El disparador concreto fue la pérdida de ciclos sin telemetría —que se creía del ~17% y resultó ser del 42%, ver arriba—, donde no se podía saber si fallaba WiFi o MQTT. La herramienta cumplió: descartó WiFi, cuantificó el fallo de MQTT y, cruzada contra InfluxDB, destapó que `LOG_PUBLISH_OK` no prueba entrega.

**El modelo**: como el logging de un router comercial —acumula hasta un límite, pisa lo viejo, se consulta— pero **activable a demanda**, porque el nodo cuida cada mA. El operador sabe cuándo lo necesita, igual que sabe cuándo conviene flashear según el SoC.

Decisiones que vale la pena no re-derivar:

- **Capturar es gratis.** Una entry son 8 bytes en RTC memory y escribirla es un `memcpy`. El único costo real es el dump, que es operador-iniciado. Esto invalidó la guarda de batería que se había propuesto en la conversación: partía de suponer que capturar costaba energía.
- **La captura se mide en horas, no en días.** El ESP32-C3 tiene 8176 B de RTC memory en total y el deep sleep borra todo lo demás. Con 768 entries: ~18 h en nivel 1, ~7,5 h en nivel 2, ~2,5 h en nivel 3. Alcanza de sobra para el caso de uso — a 17% de fallos son ~10 ciclos fallidos por hora. **Medido sobre el ELF**: las secciones RTC terminan en `0x50001850`, o sea 6224 B usados y 1952 B libres.
- **El nodo es la autoridad del diccionario** código → texto, y manda también las plantillas con `%a`/`%b`, así que define cómo interpretar los argumentos. Un X-macro genera enum, niveles y textos desde una sola definición. El backend cachea por versión de firmware, que ya viaja en todos los payloads. El export a disco tiene que llevar el diccionario adentro, si no un archivo viejo queda ilegible.
- **No hay timestamps en el nodo** — no tiene reloj y `millis()` se reinicia en cada ciclo. Cada entry lleva `boot_count` + `ms` y el backend reconstruye la hora de pared anclándose en los ciclos que sí publicaron e interpolando los huecos. Precisión honesta: el timer de deep sleep tiene ±5%, así que interpolar 7 ciclos perdidos acumula ~±21 s.
- **El dump es pull y paginado**, sobre topics propios sin retain (`log/req`, `log/data`), atendido en service mode. Pull porque reintentar una página es el mismo mensaje de siempre, y porque el ack cae solo: el backend tiene todas las páginas → recién ahí manda el clear. **Borrado en dos fases** para que una transferencia incompleta no cueste horas de captura; `keep:true` trae un snapshot sin desactivar.
- **`esp_reset_reason()` en el evento de boot** distingue brownout de panic de wake normal. Es gratis y hoy no hay forma de saberlo en campo.

### Revisión previa al flasheo (2026-07-28) — un hallazgo importante

**La captura no sobrevivía a un reinicio del nodo, y eso era silencioso.** Todo el estado del logging usaba `RTC_DATA_ATTR`, que según `esp_attr.h` conserva el valor *"during a deep sleep / wake cycle"* — no después de un restart. Un panic, un watchdog, una brownout o un comando `reboot` borraban la captura entera **y ponían el nivel en 0**, así que la captura se desarmaba sola y la UI mostraba "Captura detenida" sin explicación. Con una ironía: el `esp_reset_reason()` del evento de boot existe para distinguir brownout de panic, pero esa entry nunca se escribía porque cuando `setup()` la intentaba el nivel ya era 0.

Ahora el estado vive en **`.rtc_noinit`**, validado por `logging_begin()` contra una palabra mágica, la geometría del ring y los invariantes de `head`/`count`/capacidad — `NOINIT` arranca con basura en un power-on, y un `head` con basura escribiría fuera del array, que en RTC memory pisa las variables de al lado. Efecto secundario bienvenido: `.rtc_noinit` es `NOBITS`, así que los 6 KB del ring dejaron de ocupar lugar en la imagen de flash.

Eso creó una frontera nueva que el backend tuvo que aprender: el ring sobrevive pero `rtc_bootCount` no, así que una captura puede traer ciclos de **dos series distintas del contador**. El evento de boot ya lleva el motivo del reset, así que la frontera es detectable (cualquier valor ≠ 8 = `ESP_RST_DEEPSLEEP`); se ancla sólo desde ahí en adelante y lo anterior se entrega sin hora, con una nota. Sin esto darían horas inventadas, que es peor que no tener hora.

Menores corregidos: `LOG_CMD_RX` ahora documenta sus códigos en la plantilla como ya hacía `LOG_SERVICE_EXIT`, y se agregó `LOG_CAPTURE_START` como primera entry de toda captura — sin ella no había forma de saber a qué nivel se capturó mirando el archivo. Aceptado y documentado: **`ms` satura a los 65 s**, lo que afecta a una sola entry por sesión de service mode (la de salida); dar más rango costaría la resolución de milisegundos dentro del ciclo, que es lo que hace útil el diagnóstico de conexión.

**Backend implementado (2026-07-28)** — `go build`, `go vet` y `go test` limpios:

- `internal/mqttbridge/logs.go` — driver de descarga pull, single-flight, borrado en dos fases. Las respuestas tardías a un pedido ya reintentado se descartan en vez de mezclarse con la página en curso.
- `internal/logdict/` — cache persistente del diccionario por versión de firmware, escritura por temporal + rename. **Necesita el volumen del compose** (ver el pendiente de deploy arriba).
- `internal/logdecode/` — des-truncado del `boot_count` de 16 bits por diferencia con signo, y reconstrucción de hora de pared. **La interpolación usa el tiempo despierto real**, que está en el propio log, en vez de un período fijo: un ciclo que agota los reintentos de WiFi queda despierto 45 s contra ~9 s de uno sano, y asumir un período fijo erraría por mucho justo en las rachas de fallos que se investigan. Cada entry declara si su hora es anclada o interpolada. Con tests.
- Anclas temporales en el bridge, descartadas enteras si `boot_count` retrocede — un reflash reinicia el contador y mezclar dos vidas del mismo número daría horas sin sentido.
- Endpoints `POST /api/v1/logs/fetch`, `GET /api/v1/logs/capture` y `capture.ndjson`. La activación no tiene endpoint propio: va por `/service/command` con `cmd=log_on`, porque es un comando más sobre el topic retenido.

**Frontend implementado (2026-07-28)** — `npm run lint` y `npm run build` limpios. `components/service/LogPanel.jsx`, a todo el ancho de la grilla (clase `svc-span-2`, nueva).

**Plegable y cerrado por defecto**, porque debuggear el nodo es ocasional. Pero el chip de estado de la captura queda visible en el encabezado plegado: el firmware gasta bytes del payload publicando `log_active` justo para que una captura olvidada no pase desapercibida, y esconderla detrás de un click anularía eso.

Contenido: selector de nivel que **muestra la ventana estimada de cada uno** (~19.5 h / ~8 h / ~2.7 h) porque el tradeoff detalle-vs-horas es la decisión real al iniciar una captura, ocupación de la memoria del nodo, transferencia con checkbox de "mantener captura activa", filtros por código y por texto, exports JSON/NDJSON, aviso destacado cuando se perdieron los eventos más viejos, y marca `≈` en las horas interpoladas.

**Confirmación antes de las dos acciones destructivas.** Detener la captura vacía la memoria del nodo, así que un click por error se lleva eventos que quizás no se transfirieron. Se aplica también a *Comenzar captura* cuando ya hay una corriendo, porque `logging_configure()` limpia el ring en los dos casos — guardar sólo uno dejaría el otro camino abierto y, peor, haría creer que ese otro es inofensivo. El diálogo dice cuántos eventos están en juego y aclara que el número puede estar hasta un ciclo atrasado, así que es un piso. `ConfirmDialog` usa el `<dialog>` nativo y no `window.confirm()`: `confirm()` bloquea el event loop y congelaría el stream SSE que alimenta el resto de la vista mientras esté arriba.

**Vocabulario deliberado** (revisado con Mau, 2026-07-28): "memoria de captura" en vez de "ring", "Faltan los eventos más viejos" en vez de "captura truncada" —se descartó "incompleta" porque se lee como "la transferencia falló", que es otro problema con otra solución—, "Comenzar/Detener captura" y "Transferir logs desde el nodo". Las notas que devuelve el backend en el comando `log_on` se alinearon con estos términos, porque se muestran tal cual en un toast del dashboard.

Incluye un guard para cuando el backend todavía no expone el campo `logs` — frontend y backend son dos imágenes distintas y hay una ventana de deploy donde una está actualizada y la otra no.

**Dos cosas que aplican a toda la vista de service mode, no sólo a este panel**: el ícono de `.svc-alert` estaba desalineado (con `align-items: flex-start` el SVG se pega al tope de la caja mientras el texto arranca más abajo por su `line-height`; 3px de margen lo centran contra el primer renglón), y ahora los tooltips funcionan sobre `<button>` con la clase `svc-tip` + `data-tip` directo, sin necesitar el wrapper del componente `Tip`.

Verificado primero en el browser contra un backend mockeado, y después **end-to-end contra el nodo real**: armar captura, dejarla correr, entrar a service mode, transferir 177 eventos en 4 páginas y borrar con confirmación.

**Desplegado en producción** el 2026-07-28 junto con el firmware `1.3.1` — ver la sección de arriba.

## Vista de service mode en la UI (2026-07-26)

El flujo de OTA ya no requiere SSH a la Pi. Antes era: `mosquitto_pub` del comando `maintenance` por SSH → una ventana de `cmd` haciendo ping para adivinar cuándo despertaba el nodo → `pio run -t upload` → otro `mosquitto_pub` con payload vacío para desarmar. Ahora hay una vista dedicada en el dashboard.

**Hallazgo que simplificó el diseño**: el ping era innecesario desde siempre. El firmware ya publica en `station/01/status` un `service_mode_active` al entrar (con ArduinoOTA ya levantado) y un `service_mode_alive` cada 30 s con `remaining_sec`. Y como `_publishStatus` incluye `firmware`, el status que el nodo publica al re-entrar tras el reinicio del OTA trae la **versión nueva** — o sea la UI verifica el flash sola, sin esperar al próximo ciclo de telemetría.

**Arquitectura**: el backend Go es el único cliente MQTT (`internal/mqttbridge/`), mantiene el estado en memoria y lo empuja al browser por SSE. Se descartó conectar el browser directo a Mosquitto por WebSockets porque obligaría a poner las credenciales MQTT en el bundle del cliente. Endpoints nuevos bajo `/api/v1/service/`: `state`, `stream` (SSE), `command`, `battery-trend`.

**Qué tiene la vista**: wizard de OTA cuyo paso se *deriva* del estado real del nodo (no un stepper manual, así no puede desincronizarse), banner global de comando retenido — el chequeo "¿me olvidé el nodo armado?" —, visor de payloads en vivo con filtro por topic y export NDJSON, chips por sensor, medidor de bytes del payload contra el buffer, badge de alerta si corre un build `-dev`, detector de huecos en `boot_count`, consola de comandos y panel de batería.

**Batería**: el semáforo de riesgo de flasheo (🟢 ≥4.00 V · 🟡 3.85–4.00 V · 🔴 <3.85 V) es más estricto que los tiers de `componentes_y_conexiones.md` a propósito — service mode mantiene el nodo despierto sin deep sleep que permita recuperar tensión, y el boost tira más corriente de entrada a medida que baja Vin. El modo de falla que se evita es el brownout a mitad de escritura, no quedarse sin capacidad (15 min a ~100 mA son ~25 mAh de 1500). Incluye sparkline de 24 h/72 h/7 d, porque "varios días nublados" es un problema de tendencia invisible en el valor instantáneo.

**Cambios de firmware — versión `1.2.0` / `1.2.0-dev`.** Bump menor: agrega una feature compatible hacia atrás más un bug fix. El string mide lo mismo que `1.1.0`, así que no mueve el tamaño del payload.

> **Flasheado y corriendo (2026-07-27).** El OTA salió sin problemas y el nodo quedó en `1.2.0` — reportado por Mau, que hizo el flasheo por fuera de una sesión de trabajo. Fue además el estreno en serio de la vista de service mode. Todo lo de abajo está **en campo**, ya no pendiente.

Contenido del `1.2.0`:
- `sensors_initSystemMonitor()` / `sensors_readSystemVoltage()` en `sensors.{h,cpp}` — inicializan y leen solo el INA219 de sistema (0x40), sin encender Rail A ni Rail B. Verificado en la tabla de pines que los INA219 cuelgan del bus I2C siempre alimentado.
- `service_mode.cpp` publica `system_v` en cada heartbeat. Sin esto la UI quedaba ciega a la batería justo durante la sesión, que es cuando el nodo está drenando — `sensors_init()` no corre en service mode.
- **Bug corregido en `main.cpp`: el comando `reboot` dejaba el nodo en loop de reinicio.** Reiniciaba sin limpiar el topic retenido, así que al despertar leía el mismo `{"cmd":"reboot"}` y volvía a reiniciar, indefinidamente, hasta agotar la batería. `PING` sí limpiaba y `MAINTENANCE` limpia al salir de service mode; `REBOOT` no tenía salida. Ahora limpia antes de `ESP.restart()`. El backend además limpia el retenido apenas ve el `{"state":"rebooting"}`, como segunda línea de defensa. Nunca se disparó en campo porque el comando `reboot` no se usó nunca por fuera de pruebas.

### Bug grave encontrado probando: el timeout de service mode no acotaba nada

**Detectado 2026-07-26** en una prueba de Mau con `timeout_min: 1`, todavía sobre el firmware `1.1.0`. El log de status mostró tres `service_mode_active` sin ningún `service_mode_ended` entre medio: el nodo no completaba las sesiones, las reiniciaba.

La cadena, en `service_mode.cpp`:

1. Se cae MQTT en medio de la sesión (WiFi flojo — ver la sección de abajo).
2. El loop hacía `break` sin reintentar, pese a que el log decía "reintentando".
3. Caía en `serviceMode_exit(..., "mqtt_disconnected")`, que limpia el flag de RTC pero tiene el clear del retenido y el publish del `ended` detrás de un `if (mqtt.connected())` — con el broker caído no hace ninguna de las dos, **en silencio**.
4. Deep sleep 60 s → despierta → el flag de RTC está en false → flujo normal → lee el `maintenance` que **seguía retenido** → sesión nueva con el timeout entero.

O sea `timeout_min` no acotaba la sesión sino el tiempo entre caídas. Con un enlace que se cae cada 15-45 s el nodo puede quedar en ciclo indefinidamente, despierto a 50-140 mA. En la prueba pasó 3 veces en 4 minutos; con el default de 15 min cada sesión que sobreviva son 15 minutos despierto. Y era invisible: el `remaining_sec` es por sesión, así que la UI mostraba "en service mode" sin que nada se viera raro.

Arreglado en tres capas:

- **Firmware — reconectar en vez de abandonar** (`SERVICE_MODE_MQTT_RETRIES` 5 × 2 s). Al reconectar hay que re-suscribir a `TOPIC_CMD` y reinstalar el callback, si no `cmdCleared` deja de funcionar y el botón de desactivar queda mudo. El callback se sacó a nivel de archivo para poder reinstalarlo.
- **Firmware — timeout absoluto entre reinicios**. `rtc_serviceStartEpoch` estaba declarado pero nunca se usaba (`_remainingSeconds()` era código muerto, se eliminó); se reemplazó por `rtc_serviceElapsedSec`, que acumula lo consumido. Una re-entrada retoma el saldo en vez de estrenar presupuesto, y el acumulador se pone en cero solo cuando se logró limpiar el retenido, o sea cuando no puede haber re-entrada.
- **Backend — deadline absoluto de pared** (`runSessionWatchdog`). Limpia el retenido a los `timeout_min` + 2 de gracia contados desde el `issued_at`, sin importar cuántas veces reinicie el nodo. La gracia cubre que el nodo puede tardar hasta un ciclo de sleep en levantar el comando. Se deriva del payload retenido y no de memoria del proceso, así que **sobrevive a un reinicio del backend** — y funciona contra el firmware que hay hoy en campo, sin flashear.
- **UI** — cuenta los `service_mode_active` por sesión y avisa si son más de uno, más el horario del corte del backend.

Verificado con una instancia de backend apuntada a `station/99` para no tocar el nodo: un comando con `issued_at` viejo se limpió a los 10 s con el motivo logueado, y como control negativo una sesión vigente sobrevivió 50 s sin que el watchdog la cortara. El nodo real siguió publicando normal durante toda la prueba.

**Bugs de backend corregidos de paso**: `BatteryType` estaba hardcodeado en `"18650 Li-ion"` cuando la batería real es una LiPo 1500 mAh, y el SoC era lineal 3.2–4.2 V. La curva Li-ion es muy plana entre 3.7 y 4.0 V, así que el cálculo lineal sobreestimaba justo en la zona de decisión (a 3.70 V daba 50% contra un ~33% real). Ahora hay una curva por tramos en `internal/battery/`, compartida entre el dashboard y la vista de service mode.

### Dos pasadas de revisión antes de mandar el OTA

Repaso completo del firmware antes de flashear, en dos tandas (`968bb55` y `d84edf9`). Todo esto entró en el `1.2.0` que hoy corre en campo:

- **Keepalive de MQTT 15 s → 60 s.** El default de `PubSubClient` es 15 s: un solo PINGREQ/PINGRESP perdido tumba la conexión, y en el enlace marginal de campo eso pasa seguido. Es el gatillo más probable de las caídas que cortaban y reiniciaban el service mode. Se lo dio por gratis en el ciclo normal, donde el nodo está despierto 3,3 s y el keepalive nunca llega a dispararse.

  > ⚠️ **Revisar en la sesión de MQTT (2026-07-29): "gratis" puede ser falso.** El keepalive no sólo gobierna el PING del cliente — también define cuánto tarda el broker en dar por muerta una sesión (1,5 ×). A 60 s son 90 s, más que el ciclo de ~63 s del nodo, así que cada reconexión encuentra la sesión anterior viva y fuerza un takeover por client-ID duplicado. Es la hipótesis principal del 42% de pérdida. Ver la sección del principio.
- **Socket timeout 15 s → 5 s.** También se pagaba entero cada vez que la conexión fallaba: en el ~17% de ciclos que no publican eran 15 s extra despierto a 50-140 mA por nada. De paso acota `_reconnectMqtt`: peor caso de 5×(15+2)=85 s a 5×(5+2)=35 s.
- **`timeout_min` negativo rompía el presupuesto por overflow.** `parseCommand` aplicaba techo pero no piso, y el operador `|` de ArduinoJson solo usa el default si la clave falta o es de otro tipo — no si es ≤ 0. Con `{"timeout_min":-5}`, el `(uint32_t)timeoutMin * 60` de `serviceMode_run()` daba una sesión de ~136 años, exactamente lo contrario de lo que el timeout tiene que garantizar. Alcanzable desde la consola de JSON crudo de la UI. Ahora se clampea a `[1, SERVICE_MODE_MAX_TIMEOUT_MIN]`.
- **El acumulador de tiempo sobrevivía al flasheo.** El reinicio del OTA pasa dentro de `ArduinoOTA.handle()` y nunca pasa por `serviceMode_exit()`, así que `rtc_serviceElapsedSec` conservaba lo consumido antes del flash: si la sesión venía de arrastre, la post-flash nacía sin presupuesto y el nodo se dormía antes de publicar el `service_mode_active` con la versión nueva — que es de donde la UI saca la verificación del OTA. Ahora `onEnd` lo pone en cero.
- **`CONFIG`, `CALIBRATE` y el caso `default` no limpiaban el retenido** — la misma clase de bug que tenía `REBOOT`. Son stubs, pero alcanzables desde la consola de JSON crudo. Se extrajo `clearRetainedCommand()` y los tres caminos lo usan.
- **Se eliminó `esp_ota_mark_app_valid_cancel_rollback()` de `ArduinoOTA.onEnd()`** — no hacía lo que decía el comentario. Ver la sección de rollback más abajo.

### Flaggeado en la revisión de firmware, para otra sesión (no bloquea el flasheo)

- **`waitForRetainedCommand()` paga 800 ms fijos en casi todos los ciclos.** El loop espera hasta `MQTT_RETAINED_WAIT_MS` a que llegue un retenido, y sale antes solo si efectivamente hay uno — o sea que la mayoría de los ciclos, que no tienen comando, esperan los 800 ms completos despiertos a 50-140 mA. Sobre un tiempo despierto de ~10 s es ~8%, del orden de 30 mAh/día sobre un pack de 1500. **Corregido 2026-07-28: el despierto real son 3,3 s, así que eran el 24%.** **Y desde el `1.5.0` (2026-07-29) esto dejó de ser una palanca**: con el rail-on adelantado, el warmup del DHT22 pasó a ser el término que fija el piso del despierto, así que lo que se recorte acá lo absorbe el warmup y el total no baja — ver "Power management" arriba. **No tocado a propósito** también por otro motivo: acortarlo es un tradeoff, no una mejora gratis. El broker manda los retenidos apenas responde el SUBACK y `PubSubClient::subscribe()` no espera confirmación, así que un margen demasiado corto haría que el nodo se **pierda** comandos de mantenimiento — que es bastante peor que el costo energético. Medir el tiempo real hasta el primer retenido antes de bajarlo.
- **`system_mW` no es consumo real** y el `delay(2000)` de `LOG_LEVEL>0` — ya documentados más arriba y en `componentes_y_conexiones.md`.
- **Rollback de OTA — evaluado el 2026-07-27, decisión: no se implementa por ahora.** Análisis completo en `weather-station-station-iot/aprendizajes_y_roadmap.md`. Dos correcciones a lo que se había anotado antes: la palanca es `verifyRollbackLater()` y no `verifyOta()` (que corre antes de `setup()` y no puede juzgar si el firmware funciona), y diferir la validación **no** te deja sin poder re-flashear, porque el `Update` de Arduino esquiva el `esp_ota_begin()` que tiene ese guard. Se descarta por costo/beneficio: de los bugs reales que aparecieron en este firmware, el rollback no habría atrapado ninguno. Se reconsidera si el firmware se vuelve más riesgoso de flashear.

### Pendiente que destapó la herramienta: ~17% de ciclos sin telemetría

> **Superado el 2026-07-29** — el número real es 42% y la causa es otra. Ver la sección "Pérdida de telemetría" al principio del documento. Esto se conserva porque documenta cómo se detectó y descarta hipótesis que ya no hace falta volver a probar.

El detector de huecos de `boot_count` mostró, apenas se encendió, que el nodo **pierde alrededor del 17% de los payloads**. Verificado de forma independiente contra InfluxDB (que se alimenta por N8N, otro camino): en una ventana de 45 min, 7 de 42 boots no dejaron telemetría — mismos `boot_count`, mismos timestamps que los que detectó el bridge nuevo. No es un artefacto del código nuevo.

`boot_count` incrementa al principio de `setup()`, antes de la red, así que un hueco significa que el nodo despertó pero salió por `if (!connectWiFi())` o `if (!connectMQTT())` sin publicar. Descartado que sea overflow del buffer MQTT: los payloads miden 485–490 B contra 741 útiles. RSSI ronda -67/-68 dBm.

Importa por energía, no solo por datos: un ciclo que falla la conexión puede quemar hasta 45 s despierto (`WIFI_MAX_RETRIES` 3 × `WIFI_TIMEOUT_MS` 15 s) a 50-140 mA, contra los ~10 s de un ciclo exitoso. **Medido 2026-07-28: nada de esto ocurre así — los fallidos cuestan 5,7–6,2 s y fallan en MQTT, no en WiFi; los sanos duran 3,3 s.** Con `LOG_LEVEL=0` en campo no se puede distinguir si falla WiFi o MQTT.

**Hipótesis de Mau (2026-07-26): es señal WiFi marginal en la ubicación de campo.** Ya lo había notado antes de que la herramienta lo cuantificara. En banco no pasa — el router está cerca —, pero en el fondo la señal llega justa. Consistente con el RSSI de -65/-68 dBm medido. **Tema diferido a otra sesión**, no está en curso.

## Arquitectura

- **`weather-station-station-iot/`** — firmware ESP32 (PlatformIO) de la estación. Publica lecturas por MQTT a un broker Mosquitto corriendo en una Raspberry Pi (`infra/docker-compose.yml`). Incluye también **todo** el diseño de hardware: esquemáticos, PCB en Fritzing `.fzz`, y exports de fabricación (gerbers/etch/silk en PDF) en `PCB/`.
- **`weather-station-backend-service/`** — servicio en Go, expone API y persiste datos.
- **`weather-station-frontend-dashboard/`** — dashboard en React/Vite, consume la API del backend.
- **Deploy backend+frontend**: `docker-compose.yml` de este repo (main), imágenes publicadas en Docker Hub (`maulpdocker/weather-station:backend` / `:frontend`).

## Fase actual

Objetivo original según `Fase_2_ESP32_Solar_Migration.md`: migración NodeMCU ESP8266 → FireBeetle ESP32 + alimentación solar autónoma, deep sleep <50µA, 30+ días de autonomía. **Estado real (2026-07-11)**: prototipo v1 (dos perfboards, con cold solder joints) desplegado y funcionando al aire libre en la ubicación de campo — ver `weather-station-station-iot/componentes_y_conexiones.md` → "Estado actual en campo". El documento de Fase 2 quedó desactualizado como plan; se conserva como referencia de objetivos.

**Actualizado 2026-07-31 — la PCB v2 está en campo, barnizada y es lo que corre hoy.** FR4 casera (transferencia de tóner + cloruro férrico, main + aux), armada, **con doble capa de barniz aislante aplicada** sobre la cara de pistas/soldaduras, y desplegada. **El prototipo de dos perfboards con cold solder joints ya no está en servicio.** Ver `weather-station-station-iot/componentes_y_conexiones.md`.

Dos problemas de armado encontrados y resueltos en esta sesión:

- **Transistores BC337 (Q1 RAIL1, Q2 RAIL2) invertidos** — el footprint TO92 de Fritzing tiene la D de la serigrafía inconsistente con el orden C-B-E de los pads, así que un BC337 real insertado según la panza queda con colector y emisor cruzados. El cobre y el esquemático de Fritzing eran correctos (verificado por continuidad e inter-board contra la aux); el error era solo del silkscreen. Resuelto desoldando y rotando ambos transistores. Regla de armado y notas de diagnóstico en `componentes_y_conexiones.md` → "Orientación física — footprint de Fritzing con serigrafía inconsistente".
- **Conectores JST montados 180° invertidos** respecto del prototipo perfboard v1. Se dieron vuelta todos, quedó correcto.

## Herramienta de diseño de PCB — KiCad en evaluación (decisión diferida)

**2026-07-23** — Se evaluó migrar de Fritzing a KiCad, a raíz del bug de footprint del BC337. El disparador concreto: en Fritzing el swap colector/emisor está acoplado entre esquemático y PCB, así que cambiar el tipo del transistor a "NPN (EBC)" para corregir la serigrafía intenta invertir las pistas del PCB — no hay forma de corregir solo el silkscreen desde el dropdown.

**Decisión: por ahora no se migra.** La v2 ya está armada y funcionando; KiCad pagaría recién a partir de una v3. Queda documentado como candidato para la próxima placa.

Si se retoma, tener en cuenta:

- No hay import limpio de `.fzz` a KiCad — en la práctica es redibujar. Mitigante: el netlist ya está escrito en prosa en `componentes_y_conexiones.md` y en los mapas de pines de `pcb_placa_principal.html` / `pcb_placa_auxiliar.html`, así que es transcripción y no rediseño.
- Lo que resolvería: mapeo pin-de-símbolo ↔ pad-de-footprint explícito y verificable con cross-probe, visor 3D para confirmar orientación real del TO-92 sobre el pad, y export para toner transfer con control de espejado explícito por capa.
- Lo que **no** desaparece: el TO-92 tiene varios footprints en la librería de KiCad con distinto orden de pin 1 y distinta convención de panza. Hay que elegir el que corresponda al BC337 real (C-B-E con plano de frente) y verificar pad→net antes de rutear.

## Issue de fallas I2C intermitentes — CERRADO (2026-07-31)

**La causa real eran cold solder joints en las dos perfboards del prototipo** (no el AS5600, que nunca se conectó — ver `i2c-bus-lockup-investigation.md` para la corrección de la hipótesis original). Los dos intermitentes remanentes eran el **INA219 solar** y el **DS18B20** (temp_sistema).

Al reemplazar las perfboards por la PCB v2 el nodo arrancó a la primera y viene **totalmente estable**, incluidos esos dos sensores. **El barniz protector ya está aplicado (doble capa)** y la placa lleva desde entonces corriendo en campo, con los cuatro `*_ok` de la telemetría en `true` de forma sostenida. El prototipo con las juntas frías no está en servicio. Issue cerrado.

### Humedad dentro de la caja — anotado el 2026-07-31, sin acción de firmware

En el primer payload del `1.13.1` la caja apareció **mucho más húmeda que el exterior**, invirtiendo la línea base:

| | exterior (SHT31) | caja (DHT22) |
|---|---|---|
| 2026-07-25 (referencia) | 87-88% HR | **62,7%** — la caja más seca |
| 2026-07-31 | 28,6 °C / 40,9% HR → 11,5 g/m³ | 32,9 °C / 88,6% HR → **31,3 g/m³** |

La caja tiene **2,7× la humedad absoluta** del exterior, y no es efecto de temperatura: está más caliente, lo que debería bajarle la HR. El punto de rocío interior queda en 30,8 °C, apenas 2 °C por debajo de la temperatura de la caja.

**Explicación probable y tranquilizadora**: los días previos fueron muy húmedos, con llovizna y 96% de HR exterior. Es humedad que entró en ese período y que ahora, con la caja caliente al sol, se evapora y se lee alta. **No es una alarma de falla eléctrica**: la placa es la PCB v2 con doble capa de barniz, no la perfboard que daba problemas.

**Cómo distinguir transitorio de filtración, sin abrir nada**: si en 48-72 h la brecha vuelve a la referencia (caja más seca que el exterior), fue el arrastre del temporal. Si la caja se mantiene por encima del exterior con tiempo seco, entró agua y no se está yendo. El dato se registra en cada ciclo, así que la respuesta llega sola.

Mau va a mirar la condensación físicamente cuando pueda. Esto es exactamente para lo que quedó el DHT22 como monitor de sellado.

**Anterior (2026-07-11)**: resoldar varias juntas del prototipo mejoró mucho el problema pero no lo eliminó.

## Deuda conocida, revisada y aceptada por ahora (no es un olvido)

- **Credenciales hardcodeadas en `weather-station-station-iot` — resuelto para `main` el 2026-07-29, con dos residuos anotados.** Estaban en texto plano en `src/config.h` y `platformio.ini` (WiFi, MQTT y OTA), versionadas y pusheadas. Se levantó la deuda al cambiar de SSID, para que la credencial nueva no entrara nunca al repo. Ahora salen de **`secrets.ini`**, gitignoreado, que PlatformIO carga por `extra_configs` y del que salen tanto los `-D` del firmware como el `--auth` del upload por OTA — de paso la password de OTA dejó de estar duplicada en dos archivos. La plantilla versionada es `secrets.ini.example`. Falla ruidoso si falta: PlatformIO corta con `No section: 'secrets'` antes de compilar, y `config.h` tiene además un `#error` por si están algunas claves y otras no.

  Dos cosas que **no** resuelve, y conviene tenerlas presentes en vez de creer que el tema está cerrado: (1) el firmware compilado sigue llevando las credenciales en texto plano, así que protege contra la filtración del repo y **no** contra el acceso físico al nodo — para eso haría falta provisioning por NVS o flash encryption; y (2) **los valores viejos siguen en el historial de git**, así que sacarlos de circulación es rotarlos, no reescribir commits. La de WiFi se rota sola al mudar el nodo a la SSID nueva; las de MQTT y OTA siguen pendientes.

  Queda además `src_diagnostic/config_diagnostic.h` en la branch `pcb_test`, que repite la password de WiFi vieja y no se tocó.
- **Branch `pcb_test`** (con `claude/reverent-wright` mergeada adentro): agrega un ambiente de PlatformIO `env:diagnostic` aislado en `src_diagnostic/` (firmware de diagnóstico de hardware + calibración de rain sensor y DHT11, abril 2026). Mergea limpio contra `main` (probado, sin conflictos) pero se decidió (2026-07-11) dejarla afuera de `main` por ahora. Sigue disponible en GitHub (`origin/pcb_test`, `origin/claude/reverent-wright`) para cuando se quiera retomar.
- **Config del lado del NAS (InfluxDB v2 + Grafana, 192.168.18.251)** no está versionada en ningún repo de este proyecto todavía — vive solo en el NAS. Ver `weather-station-station-iot/Readme.md` → "Pipeline completo de datos".

## Sensores — pendientes conocidos (migrado del proyecto legacy, 2026-07-11)

- **DHT11 → DHT22 — reemplazo físico y firmware completados (2026-07-25).** El DHT11 murió (falla crónica, venía fallando ya en proyectos anteriores — no fue un problema del circuito/Rail B). Mau desoldó el DHT11 del módulo Sunfounder y soldó en su lugar el DHT22 pelado que había comprado, reutilizando el PCB del módulo: mismo pull-up y filtro ya incluidos ahí, mismo orden de pines VDD-DATA-NC-GND y mismo paso de 2.54mm que el DHT11 (confirmado por datasheet antes de tocarlo), mismo conector JST y pin GPIO0 de la placa principal — **sin cambios de cableado ni de PCB**. Documentado con fotos antes/después del desoldado.

  **Validado en banco (2026-07-25).** Flasheado con `1.0.5-dev` y verificado por MQTT: `dht11_ok:true`, humedad 58.8–60.2% contra **59% de una estación comercial de referencia** (dentro del ±2% RH de spec del DHT22), y temperatura 19.4–19.7 °C contra 19.5 °C del DS18B20 — dos sensores independientes coincidiendo en 0.2 °C. `boot_count` incrementando monótonamente (2→3→4→5): deep sleep sano, sin resets ni brownouts.

  **Validado en campo (2026-07-25), issue cerrado.** Varias horas corriendo con todo conectado y la caja cerrada. Telemetría completa y consistente: SHT31 10.4 °C / 88% (exterior), DHT22 9.8 °C / 62.7% (caja), DS18B20 9.5 °C, BMP085 9.0 °C y 923 hPa → 1013.7 QNH (coherente con los 780 m). 6/6 payloads JSON válido, `boot_count` consecutivo sin huecos. El DHT22 da 0.1 °C de resolución contra los 0.5 °C del DS18B20 configurado a 9 bits, así que pasa a ser la lectura de temperatura más fina de la caja.

  **Efecto secundario útil: el DHT22 quedó como monitor de integridad del sellado.** Con la caja cerrada, la humedad exterior subía (87.2 → 88.1%) mientras la interior se mantenía estable o bajaba (62.8 → 62.7%). Esa brecha de ~25 puntos sostenida es evidencia directa de que el sellado aguanta. Si en el futuro la humedad interior empieza a seguir a la exterior, hay filtración — y se detecta antes de que se manifieste como falla eléctrica.

  Firmware reactivado y adaptado en `weather-station-station-iot/` (compila limpio en `production` y `development`):
  - `src/sensors.cpp` — driver activo: `DHT _dht(PIN_DHT22, DHT22);`, `_dht.begin()`, warmup y bloque de lectura descomentados.
  - `src/config.h` — `PIN_DHT22` = GPIO0 (sin cambios de pin). Se **eliminaron** las constantes de calibración de humedad (`DHT_HUM_RAW_LO/HI`, `DHT_HUM_REAL_LO/HI`): corregían el sesgo del DHT11 defectuoso y volverían a sesgar al DHT22, que viene calibrado de fábrica (±2% RH, ±0.5 °C). Nueva `DHT_RETRY_INTERVAL_MS` = 2000 (período mínimo de muestreo del DHT22 por datasheet).
  - **Decisión: los campos MQTT siguen llamándose `dht11_temp_c`/`dht11_hum_pct`/`dht11_ok`** aunque el sensor sea un DHT22. Renombrarlos partiría la serie histórica en el InfluxDB del NAS (que no está versionado en ningún repo, así que no se puede verificar qué dashboards dependen del nombre). El backend Go no consume estos campos — verificado, no hay ninguna referencia a `dht` en `.go`/`.ts`/`.json`/`.yml`. Documentado en `src/sensors.h`.

  **Dos bugs latentes encontrados y corregidos en el camino** (preexistentes, no introducidos por el DHT22):
  - **El warmup del DHT nunca se ejecutaba.** Se medía con `millis()` desde el boot, pero Rail B recién se energiza dentro de `sensors_init()`, que corre *después* de WiFi+MQTT (`main.cpp`) — con `millis()` ya en 2-5s, el `delay` quedaba en cero y el sensor se leía apenas energizado. Ahora se ancla a `rail_on_ms`, tomado justo después de poner Rail B en HIGH. Puede haber contribuido a las lecturas erráticas que se le atribuían al DHT11.
  - **El payload de telemetría excedía el buffer MQTT.** `mqtt.setBufferSize(512)` daba 485 bytes útiles (buffer − header 5 − 2 − topic 20); el payload llega a ~546 bytes con los 3 campos del DHT22 y temperaturas bajo cero (más dígitos). `PubSubClient::publish()` descarta el mensaje **entero** y en silencio si no entra, y el retorno no se chequeaba. Sin los campos DHT ya estaba en ~488 bytes — es decir, el firmware en campo probablemente venía perdiendo telemetría en las madrugadas bajo cero. Buffer subido a 768 (deja margen para el subsistema de viento pendiente) y ahora se loguea el fallo. Medido en campo con el sistema completo: los payloads reales miden **479–481 B** contra los 485 B útiles del buffer viejo — entre 4 y 6 bytes de margen a 10 °C. Con cuatro campos de temperatura bajo cero (un `-` extra cada uno) se llega justo a 485, y cualquier dígito adicional de presión lo pasa. El fix entró justo antes de la temporada fría.
- **Deploy pendiente: el nodo está corriendo el build de debug (2026-07-25).** La telemetría reportaba `firmware: "1.0.5-dev"`, o sea `LOG_LEVEL=2`. Causa: el único `env:ota_upload` de `platformio.ini` extendía `env:development`, así que **todo deploy por OTA mandaba el build de debug** sin que se notara. Cuesta caro en energía: con `LOG_LEVEL=2` el `setup()` de `main.cpp` quema 2 s fijos en `delay(2000)` en cada wake, encima de los 2 s del warmup del DHT22 — en un ciclo de 60 s es una porción grande del tiempo despierto, a 50–140 mA, sin ningún beneficio en campo.
  **Ya corregido en `platformio.ini`**: ahora hay dos entornos explícitos, `env:ota_production` (extiende `production`, `LOG_LEVEL=0`) y `env:ota_development` (extiende `development`, `LOG_LEVEL=2`). Verificado que la herencia resuelve bien y que `ota_production` compila. También se bumpeó la versión a **1.1.0** / `1.1.0-dev` — quedarse en 1.0.0 habría hecho que el campo `firmware` no distinga si el DHT22 está desplegado.
  **Deploy hecho y confirmado (2026-07-25).** El nodo corre `firmware: "1.1.0"` (`LOG_LEVEL=0`), verificado por MQTT. 3/3 payloads JSON válido, todos los sensores en OK. `boot_count` reiniciado en 2 — firma esperada de un reflash (se borra la RTC memory), no una falla; un reset **espontáneo** a 1 sí sería watchdog o brownout. Los payloads de producción miden **470–475 B** (4–6 B menos que en dev, por el string de versión más corto) contra los 741 B útiles del buffer actual.
- **Dirección de viento (AS5600 vs. óptico)**: AS5600 vuelve a ser candidato fuerte — el módulo vino con un imán chico no notado antes, lo que corrige la conclusión previa de "imanes disponibles incompatibles". En validación de banco con un Arduino Mega (2026-07-25): primero rotando el imán a mano sin la veleta, después una prueba de concepto con la veleta montada. Todavía no se conectó nada en JST5 (eso es el nodo real; el banco es aparte). Detalle en `weather-station-station-iot/aprendizajes_y_roadmap.md`.
- **Anemómetro/veleta (Windicator V1)**: diseño y calibración listos en papel, armado mecánico y prueba en campo todavía no empezaron.

**Banco de pruebas veleta/anemómetro (2026-07-25)**: para no desarmar el nodo, las pruebas de electrónica (AS5600 y reed switch del anemómetro) se arman en una carpeta throwaway `bench-veleta-anemometro/` en la raíz de este repo (main), ignorada vía `.gitignore` — el target es un Arduino Mega 2560, hardware distinto al ESP32 del nodo, así que no ameritaba una branch de `station-iot` (ver precedente de `pcb_test`/`env:diagnostic`, que sí compartía target). Se descarta al terminar de validar; cualquier aprendizaje reusable (pines, resultado del imán, umbrales) queda en prosa en `aprendizajes_y_roadmap.md`, no como código versionado.

## Configuración de este repo (hecho en sesión 2026-07-10/11)

- Identidad de git personal (`Mauricio <maulp_gnt@hotmail.com>`) aplicada automáticamente a todo bajo `D:/trabajo/my_projects/` vía `includeIf` en `~/.gitconfig` — no requiere configuración manual por repo.
- Topología definida: este repo es **main** (docs transversales, deploy), `weather-station-backend-service/` `weather-station-frontend-dashboard/` `weather-station-station-iot/` son **secondary** independientes (ignorados por `.gitignore` acá, no son submodules).
- Política de auto-commit + auto-push activada (ver `CLAUDE.md`) — sin necesidad de confirmación manual, dado que es un proyecto personal de bajo riesgo.
- Los 4 repos están pusheados a GitHub (cuenta personal `MauArg`, privados): `weather-station`, `weather-station-backend-service`, `weather-station-frontend-dashboard`, `weather-station-station-iot`, conectados vía el alias SSH `github-personal`.
- Se commiteó el trabajo pendiente de `weather-station-station-iot` (PCB Aux v1.2.2 actualizado, nuevas iteraciones Main PCB v1.3/v1.4, `componentes_y_conexiones.md`).
- `PCB/` de la raíz se consolidó dentro de `weather-station-station-iot/PCB/` — ya no hay diseño de hardware duplicado entre repos; `weather-station-station-iot/` es ahora la única fuente para todo lo de hardware.
- Se arregló un `env_file` roto en el `docker-compose.yml` raíz (seguía apuntando a `./backend-service/.env` tras el renombrado de carpeta).
- Limpieza de branches ya mergeadas a la rama principal, local y remoto: `weather-station-frontend-dashboard` (`dockerization`, `integration`, `bugfix`), `weather-station-backend-service` (`dockerization`; falta `core-logic`, ver pendiente manual), `weather-station-station-iot` (`DHT11-fix`, `add-rssi-value`, `nuevos_sensores`, `rain-pulsed-signal`, `rain-value`, `claude/friendly-euler`). También se podó un worktree de git huérfano en `weather-station-station-iot` (metadata vieja de antes del renombre de carpeta, sin datos reales).
