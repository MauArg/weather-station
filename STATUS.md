# Estado del proyecto

> Actualizar este archivo al final de cada sesión de trabajo relevante. Es el punto de partida para la siguiente conversación — ver política en [`CLAUDE.md`](./CLAUDE.md).

_Última actualización: 2026-07-28_

## ⚠️ Pendiente de acción manual — deploy en la Raspberry Pi 4B

**El firmware `1.3.0` ya está flasheado y validado en campo** (2026-07-28): se armó una captura, se transfirió completa y el `RTC_NOINIT` quedó confirmado — la captura sobrevivió a dos `reboot`. Lo que falta es del lado del server.

**1. Rebuild y push de las DOS imágenes.** `maulpdocker/weather-station:backend` y `:frontend` en Docker Hub son anteriores a todo el sistema de logs. Sin esto, el `docker compose pull` baja lo viejo y no cambia nada.

**2. `git pull`** en el clon de `weather-station` (repo main) de la Pi, para levantar el `docker-compose.yml` nuevo. Agrega un volumen `backend-data` montado en `/data` para el cache del diccionario de logs. Importa porque el diccionario código → texto sólo se puede pedir al nodo, y el nodo sólo conoce el de la versión que corre **ahora**: sin el volumen, cada redeploy lo borra y deja ilegible cualquier export de una versión vieja. No hace falta tocar el `.env` — el compose define `LOG_DICT_PATH` en `environment`, que gana sobre `env_file`.

**3. `docker compose pull && docker compose up -d`**.

**4. Reflash del firmware `1.3.1`.** Bumpeado desde `1.3.0` por la corrección de `LOG_PUBLISH_FAIL` (distinguir buffer de conexión caída). **Ojo que cambia el diccionario de códigos**, así que al flashearlo la huella deja de coincidir y **cualquier captura en curso se descarta** — es el comportamiento correcto, pero conviene transferir antes lo que interese. El nodo hoy corre `1.3.0`.

**Nota para probar en local**: si levantás el backend en la máquina de desarrollo, pisá el client ID o va a pelearse con el de la Pi por el mismo (`MQTT_CLIENT_ID=weather-station-backend-dev go run ./cmd/server/main.go`). Para probar sólo cambios de UI contra el backend ya desplegado alcanza con `VITE_API_PROXY=http://192.168.18.250 npm run dev`.

## No hay sesión entre front y backend — pero la historia se veía como si fuera actual (2026-07-28)

Volver al dashboard después de una noche mostraba payloads y anomalías de horas atrás, lo que se leía como una sesión que quedaba abierta. **No la hay**: el backend es el cliente MQTT, corre siempre con o sin browser —eso es lo que hace que el banner de comando retenido y el watchdog de sesión funcionen sin nadie mirando— y ceba cada conexión nueva con su ring buffer a propósito, para que el visor no abra vacío.

Lo que sí estaba mal es que esa historia no se distinguía de lo actual: `formatClock()` imprime `HH:MM:SS` y nada más, así que un evento de anoche se ve idéntico a uno de hace un minuto. Medido contra el backend desplegado, abrir el dashboard entrega **57 payloads que abarcan 1,3 h**, y el cliente pide hasta 100 (~1,8 h tras una noche).

Corregido con antigüedad relativa (`formatAge()`, que devuelve null por debajo de 2 min para no ensuciar lo que sí es en vivo), un separador entre el backlog y lo que llega después, y el mismo tratamiento en las discontinuidades de `boot_count` — ahí es donde más confundía, porque la lista guarda las últimas 20 sin tope de tiempo. El visor pasó a llamarse "Payloads del broker".

De paso se revisó el camino de limpieza del SSE por si había un leak de suscriptores, que era la otra lectura posible del síntoma: `HandleStream` cierra con `defer Unsubscribe` y sale por `r.Context().Done()`, y `broadcast()` es no bloqueante. **No había nada que arreglar ahí.**

## El ~17% de ciclos perdidos: resuelto (2026-07-28)

Primera captura real del sistema de logs contra el `1.3.0` en campo — 177 eventos, 30 ciclos, nivel verboso, 0 pisados. **Análisis completo en [`weather-station-station-iot/aprendizajes_y_roadmap.md`](./weather-station-station-iot/aprendizajes_y_roadmap.md) → "Primera captura de logs en campo".** Resumen:

- **No es WiFi.** Asoció en el primer intento las 30 veces, con señal buena y mala. Cero `WIFI_FAIL`, cero `WIFI_GIVEUP`.
- **Es TCP/MQTT, y correlaciona con el RSSI.** A **-73 dBm fallaron 3 de 5 ciclos (60%)**; a -63/-66 dBm, **0 de 21**. El handshake MQTT pasa de ~40 ms a 2400–3200 ms y a veces cruza el socket timeout de 5 s. `state -4` = `MQTT_CONNECTION_TIMEOUT`.
- **El enlace oscila ~9 dB solo por movimiento de personas o puertas**, sin ningún cambio de configuración. El router ya está al máximo de potencia, y eso fue un parche necesario: en "medium" el nodo no conectaba. La condición marginal es el régimen normal.
- **El tiempo despierto es 3,3 s, no ~10 s** — la cifra que circulaba por los documentos estaba mal por 3×. La red está lista a los 314 ms y el nodo se queda 3 s más con el WiFi asociado esperando el retenido y el warmup del DHT22. Eso reordena dos pendientes conocidos: **los 800 ms del retenido son el 24% del despierto, no el 8%**, y el **warmup del DHT22 es el 61%**.

**Corregido ya**: `LOG_PUBLISH_FAIL` decía "¿buffer corto?" con 505 B contra 741 disponibles — era una conexión caída. Ahora el firmware distingue las dos causas.

**Diferido a una sesión propia** (documentado con detalle suficiente para implementar sin re-derivar): reintento de `mqtt.connect()` en el ciclo normal —el de mayor impacto, y casi imprescindible dado que el enlace oscila solo—, mover el rail-on del DHT22 al inicio de `setup()` (~34% menos de tiempo despierto), y revisar el presupuesto de reintentos de WiFi, dimensionado para un modo de falla que no es el real.

## Sistema de logs del nodo — completo en los tres repos y validado en campo (2026-07-28)

Diseño completo en [`weather-station-station-iot/logging_system_design.md`](./weather-station-station-iot/logging_system_design.md), que es el contrato para los tres repos. **Firmware, backend y frontend implementados; el flujo entero se probó end-to-end contra el nodo real** — armar captura, dejarla correr, entrar a service mode, transferir 177 eventos en 4 páginas y borrar con confirmación. Sólo queda el deploy (ver arriba).

**El problema**: el nodo en campo no tiene observabilidad. `LOG_V`/`LOG_E` son `Serial.printf` y con `LOG_LEVEL=0` compilan a no-op, así que la única forma de ver algo es abrir la caja estanca y enchufar USB. El disparador concreto sigue siendo el ~17% de ciclos sin telemetría, donde hoy no se puede saber si falla WiFi o MQTT.

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

**Lo que falta**: sólo el deploy — ver la sección de arriba.

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

- **Keepalive de MQTT 15 s → 60 s.** El default de `PubSubClient` es 15 s: un solo PINGREQ/PINGRESP perdido tumba la conexión, y en el enlace marginal de campo eso pasa seguido. Es el gatillo más probable de las caídas que cortaban y reiniciaban el service mode. Gratis en el ciclo normal, donde el nodo está despierto ~10 s y el keepalive nunca llega a dispararse.
- **Socket timeout 15 s → 5 s.** También se pagaba entero cada vez que la conexión fallaba: en el ~17% de ciclos que no publican eran 15 s extra despierto a 50-140 mA por nada. De paso acota `_reconnectMqtt`: peor caso de 5×(15+2)=85 s a 5×(5+2)=35 s.
- **`timeout_min` negativo rompía el presupuesto por overflow.** `parseCommand` aplicaba techo pero no piso, y el operador `|` de ArduinoJson solo usa el default si la clave falta o es de otro tipo — no si es ≤ 0. Con `{"timeout_min":-5}`, el `(uint32_t)timeoutMin * 60` de `serviceMode_run()` daba una sesión de ~136 años, exactamente lo contrario de lo que el timeout tiene que garantizar. Alcanzable desde la consola de JSON crudo de la UI. Ahora se clampea a `[1, SERVICE_MODE_MAX_TIMEOUT_MIN]`.
- **El acumulador de tiempo sobrevivía al flasheo.** El reinicio del OTA pasa dentro de `ArduinoOTA.handle()` y nunca pasa por `serviceMode_exit()`, así que `rtc_serviceElapsedSec` conservaba lo consumido antes del flash: si la sesión venía de arrastre, la post-flash nacía sin presupuesto y el nodo se dormía antes de publicar el `service_mode_active` con la versión nueva — que es de donde la UI saca la verificación del OTA. Ahora `onEnd` lo pone en cero.
- **`CONFIG`, `CALIBRATE` y el caso `default` no limpiaban el retenido** — la misma clase de bug que tenía `REBOOT`. Son stubs, pero alcanzables desde la consola de JSON crudo. Se extrajo `clearRetainedCommand()` y los tres caminos lo usan.
- **Se eliminó `esp_ota_mark_app_valid_cancel_rollback()` de `ArduinoOTA.onEnd()`** — no hacía lo que decía el comentario. Ver la sección de rollback más abajo.

### Flaggeado en la revisión de firmware, para otra sesión (no bloquea el flasheo)

- **`waitForRetainedCommand()` paga 800 ms fijos en casi todos los ciclos.** El loop espera hasta `MQTT_RETAINED_WAIT_MS` a que llegue un retenido, y sale antes solo si efectivamente hay uno — o sea que la mayoría de los ciclos, que no tienen comando, esperan los 800 ms completos despiertos a 50-140 mA. Sobre un tiempo despierto de ~10 s es ~8%, del orden de 30 mAh/día sobre un pack de 1500. **Corregido 2026-07-28: el despierto real son 3,3 s, así que son el 24% — ver la sección del ~17% arriba.** **No tocado a propósito**: acortarlo es un tradeoff, no una mejora gratis. El broker manda los retenidos apenas responde el SUBACK y `PubSubClient::subscribe()` no espera confirmación, así que un margen demasiado corto haría que el nodo se **pierda** comandos de mantenimiento — que es bastante peor que el costo energético. Medir el tiempo real hasta el primer retenido antes de bajarlo.
- **`system_mW` no es consumo real** y el `delay(2000)` de `LOG_LEVEL>0` — ya documentados más arriba y en `componentes_y_conexiones.md`.
- **Rollback de OTA — evaluado el 2026-07-27, decisión: no se implementa por ahora.** Análisis completo en `weather-station-station-iot/aprendizajes_y_roadmap.md`. Dos correcciones a lo que se había anotado antes: la palanca es `verifyRollbackLater()` y no `verifyOta()` (que corre antes de `setup()` y no puede juzgar si el firmware funciona), y diferir la validación **no** te deja sin poder re-flashear, porque el `Update` de Arduino esquiva el `esp_ota_begin()` que tiene ese guard. Se descarta por costo/beneficio: de los bugs reales que aparecieron en este firmware, el rollback no habría atrapado ninguno. Se reconsidera si el firmware se vuelve más riesgoso de flashear.

### Pendiente que destapó la herramienta: ~17% de ciclos sin telemetría

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

**Actualizado 2026-07-23** — PCB v2 (FR4 casera, transferencia de tóner + cloruro férrico, main + aux) **armada y funcionando correctamente**. En prueba de 12h dentro de la caja estanca antes de aplicar el barniz protector sobre la cara de pistas/soldaduras. Ver `weather-station-station-iot/componentes_y_conexiones.md`.

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

## Issue de fallas I2C intermitentes — resuelto por la PCB v2 (confirmación final pendiente)

**Actualizado 2026-07-23** — la causa real eran cold solder joints en las dos perfboards del prototipo (no el AS5600, que nunca se conectó — ver `i2c-bus-lockup-investigation.md` para la corrección de la hipótesis original). Los dos intermitentes remanentes eran el **INA219 solar** y el **DS18B20** (temp_sistema).

Al reemplazar las perfboards por la PCB v2, el nodo arrancó a la primera y viene **totalmente estable**, incluidos esos dos sensores. Como el prototipo con las juntas frías ya no está en servicio, el issue se considera resuelto.

Confirmación final pendiente: prueba de ~19h en la caja estanca (2026-07-23 17:00 → 2026-07-24 mediodía), elegida para cubrir la madrugada con temperaturas bajo cero — el ciclo térmico es lo que expone una junta marginal. Si pasa limpia, el issue queda cerrado y se aplica el barniz protector.

**Anterior (2026-07-11)**: resoldar varias juntas del prototipo mejoró mucho el problema pero no lo eliminó.

## Deuda conocida, revisada y aceptada por ahora (no es un olvido)

- **Credenciales hardcodeadas en `weather-station-station-iot`**: `src/config.h` (branch `main`) y `platformio.ini` tienen en texto plano la password de WiFi doméstica, la password de MQTT y la password OTA del dispositivo; `src_diagnostic/config_diagnostic.h` (branch `pcb_test`) repite la password de WiFi. Todo esto ya está pusheado a GitHub (repo privado). Decisión explícita (2026-07-11): dejarlo como está por ahora, dado que el repo es privado — no rotar ni sacar del código todavía. Si en algún momento el repo pasa a público, o se comparte acceso, esto hay que resolverlo antes.
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
