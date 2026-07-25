# Estado del proyecto

> Actualizar este archivo al final de cada sesión de trabajo relevante. Es el punto de partida para la siguiente conversación — ver política en [`CLAUDE.md`](./CLAUDE.md).

_Última actualización: 2026-07-25_

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

  **Validado en banco (2026-07-25).** Flasheado con `1.0.5-dev` y verificado por MQTT: `dht11_ok:true`, humedad 58.8–60.2% contra **59% de una estación comercial de referencia** (dentro del ±2% RH de spec del DHT22), y temperatura 19.4–19.7 °C contra 19.5 °C del DS18B20 — dos sensores independientes coincidiendo en 0.2 °C. `boot_count` incrementando monótonamente (2→3→4→5): deep sleep sano, sin resets ni brownouts. Pendiente: instalar con todo el sistema conectado y validar en campo.

  Firmware reactivado y adaptado en `weather-station-station-iot/` (compila limpio en `production` y `development`):
  - `src/sensors.cpp` — driver activo: `DHT _dht(PIN_DHT22, DHT22);`, `_dht.begin()`, warmup y bloque de lectura descomentados.
  - `src/config.h` — `PIN_DHT22` = GPIO0 (sin cambios de pin). Se **eliminaron** las constantes de calibración de humedad (`DHT_HUM_RAW_LO/HI`, `DHT_HUM_REAL_LO/HI`): corregían el sesgo del DHT11 defectuoso y volverían a sesgar al DHT22, que viene calibrado de fábrica (±2% RH, ±0.5 °C). Nueva `DHT_RETRY_INTERVAL_MS` = 2000 (período mínimo de muestreo del DHT22 por datasheet).
  - **Decisión: los campos MQTT siguen llamándose `dht11_temp_c`/`dht11_hum_pct`/`dht11_ok`** aunque el sensor sea un DHT22. Renombrarlos partiría la serie histórica en el InfluxDB del NAS (que no está versionado en ningún repo, así que no se puede verificar qué dashboards dependen del nombre). El backend Go no consume estos campos — verificado, no hay ninguna referencia a `dht` en `.go`/`.ts`/`.json`/`.yml`. Documentado en `src/sensors.h`.

  **Dos bugs latentes encontrados y corregidos en el camino** (preexistentes, no introducidos por el DHT22):
  - **El warmup del DHT nunca se ejecutaba.** Se medía con `millis()` desde el boot, pero Rail B recién se energiza dentro de `sensors_init()`, que corre *después* de WiFi+MQTT (`main.cpp`) — con `millis()` ya en 2-5s, el `delay` quedaba en cero y el sensor se leía apenas energizado. Ahora se ancla a `rail_on_ms`, tomado justo después de poner Rail B en HIGH. Puede haber contribuido a las lecturas erráticas que se le atribuían al DHT11.
  - **El payload de telemetría excedía el buffer MQTT.** `mqtt.setBufferSize(512)` daba 485 bytes útiles (buffer − header 5 − 2 − topic 20); el payload llega a ~546 bytes con los 3 campos del DHT22 y temperaturas bajo cero (más dígitos). `PubSubClient::publish()` descarta el mensaje **entero** y en silencio si no entra, y el retorno no se chequeaba. Sin los campos DHT ya estaba en ~488 bytes — es decir, el firmware en campo probablemente venía perdiendo telemetría en las madrugadas bajo cero. Buffer subido a 768 (deja margen para el subsistema de viento pendiente) y ahora se loguea el fallo. Medido en la prueba de banco: ~376 B con SHT31/BMP085 desconectados, y ~500 B proyectados con todo conectado — o sea, por encima de los 485 B útiles del buffer viejo. El fix recién se nota con el sistema completo.
- **Dirección de viento (AS5600 vs. óptico)**: sin resolver, nunca se conectó nada en JST5. Detalle completo y alternativas en `weather-station-station-iot/aprendizajes_y_roadmap.md`.
- **Anemómetro/veleta (Windicator V1)**: diseño y calibración listos en papel, armado mecánico y prueba en campo todavía no empezaron.

## Configuración de este repo (hecho en sesión 2026-07-10/11)

- Identidad de git personal (`Mauricio <maulp_gnt@hotmail.com>`) aplicada automáticamente a todo bajo `D:/trabajo/my_projects/` vía `includeIf` en `~/.gitconfig` — no requiere configuración manual por repo.
- Topología definida: este repo es **main** (docs transversales, deploy), `weather-station-backend-service/` `weather-station-frontend-dashboard/` `weather-station-station-iot/` son **secondary** independientes (ignorados por `.gitignore` acá, no son submodules).
- Política de auto-commit + auto-push activada (ver `CLAUDE.md`) — sin necesidad de confirmación manual, dado que es un proyecto personal de bajo riesgo.
- Los 4 repos están pusheados a GitHub (cuenta personal `MauArg`, privados): `weather-station`, `weather-station-backend-service`, `weather-station-frontend-dashboard`, `weather-station-station-iot`, conectados vía el alias SSH `github-personal`.
- Se commiteó el trabajo pendiente de `weather-station-station-iot` (PCB Aux v1.2.2 actualizado, nuevas iteraciones Main PCB v1.3/v1.4, `componentes_y_conexiones.md`).
- `PCB/` de la raíz se consolidó dentro de `weather-station-station-iot/PCB/` — ya no hay diseño de hardware duplicado entre repos; `weather-station-station-iot/` es ahora la única fuente para todo lo de hardware.
- Se arregló un `env_file` roto en el `docker-compose.yml` raíz (seguía apuntando a `./backend-service/.env` tras el renombrado de carpeta).
- Limpieza de branches ya mergeadas a la rama principal, local y remoto: `weather-station-frontend-dashboard` (`dockerization`, `integration`, `bugfix`), `weather-station-backend-service` (`dockerization`; falta `core-logic`, ver pendiente manual), `weather-station-station-iot` (`DHT11-fix`, `add-rssi-value`, `nuevos_sensores`, `rain-pulsed-signal`, `rain-value`, `claude/friendly-euler`). También se podó un worktree de git huérfano en `weather-station-station-iot` (metadata vieja de antes del renombre de carpeta, sin datos reales).
