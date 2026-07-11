# Estado del proyecto

> Actualizar este archivo al final de cada sesión de trabajo relevante. Es el punto de partida para la siguiente conversación — ver política en [`CLAUDE.md`](./CLAUDE.md).

_Última actualización: 2026-07-11_

## Arquitectura

- **`weather-station-station-iot/`** — firmware ESP32 (PlatformIO) de la estación. Publica lecturas por MQTT a un broker Mosquitto corriendo en una Raspberry Pi (`infra/docker-compose.yml`). Incluye también **todo** el diseño de hardware: esquemáticos, PCB en Fritzing `.fzz`, y exports de fabricación (gerbers/etch/silk en PDF) en `PCB/`.
- **`weather-station-backend-service/`** — servicio en Go, expone API y persiste datos.
- **`weather-station-frontend-dashboard/`** — dashboard en React/Vite, consume la API del backend.
- **Deploy backend+frontend**: `docker-compose.yml` de este repo (main), imágenes publicadas en Docker Hub (`maulpdocker/weather-station:backend` / `:frontend`).

## Fase actual

Según `Fase_2_ESP32_Solar_Migration.md`: migración NodeMCU ESP8266 → FireBeetle ESP32 + alimentación solar autónoma. Estado documentado: **Diseño**. Objetivo: deep sleep <50µA, 30+ días de autonomía sin mantenimiento.

## Issue abierto: bus I2C bloqueado (sin resolver)

Ver `i2c-bus-lockup-investigation.md`. Todos los sensores I2C (SHT31, BMP085, ambos INA219) fallan simultáneamente desde el primer boot, incluso sin ciclo de deep sleep previo — descarta causa puramente de firmware. Hipótesis principal: el **AS5600** (veleta, conectado en JST5, no inicializado aún en firmware) puede estar tirando SDA a bajo por un problema físico de conexión o daño estático. Próximo paso de diagnóstico: desconectar JST5 con el nodo activo y ver si el bus I2C se recupera.

## Pendiente manual (no lo puedo hacer yo)

- En GitHub, el repo `weather-station-backend-service` todavía tiene `core-logic` como default branch (heredado del primer push). Hay que cambiarlo a `master` en Settings → Branches para poder borrar `origin/core-logic` (ya está mergeado a `master`, no se pierde nada).

## Deuda conocida, revisada y aceptada por ahora (no es un olvido)

- **Credenciales hardcodeadas en `weather-station-station-iot`**: `src/config.h` (branch `main`) y `platformio.ini` tienen en texto plano la password de WiFi doméstica, la password de MQTT y la password OTA del dispositivo; `src_diagnostic/config_diagnostic.h` (branch `pcb_test`) repite la password de WiFi. Todo esto ya está pusheado a GitHub (repo privado). Decisión explícita (2026-07-11): dejarlo como está por ahora, dado que el repo es privado — no rotar ni sacar del código todavía. Si en algún momento el repo pasa a público, o se comparte acceso, esto hay que resolverlo antes.
- **Branch `pcb_test`** (con `claude/reverent-wright` mergeada adentro): agrega un ambiente de PlatformIO `env:diagnostic` aislado en `src_diagnostic/` (firmware de diagnóstico de hardware + calibración de rain sensor y DHT11, abril 2026). Mergea limpio contra `main` (probado, sin conflictos) pero se decidió (2026-07-11) dejarla afuera de `main` por ahora. Sigue disponible en GitHub (`origin/pcb_test`, `origin/claude/reverent-wright`) para cuando se quiera retomar.

## Configuración de este repo (hecho en sesión 2026-07-10/11)

- Identidad de git personal (`Mauricio <maulp_gnt@hotmail.com>`) aplicada automáticamente a todo bajo `D:/trabajo/my_projects/` vía `includeIf` en `~/.gitconfig` — no requiere configuración manual por repo.
- Topología definida: este repo es **main** (docs transversales, deploy), `weather-station-backend-service/` `weather-station-frontend-dashboard/` `weather-station-station-iot/` son **secondary** independientes (ignorados por `.gitignore` acá, no son submodules).
- Política de auto-commit + auto-push activada (ver `CLAUDE.md`) — sin necesidad de confirmación manual, dado que es un proyecto personal de bajo riesgo.
- Los 4 repos están pusheados a GitHub (cuenta personal `MauArg`, privados): `weather-station`, `weather-station-backend-service`, `weather-station-frontend-dashboard`, `weather-station-station-iot`, conectados vía el alias SSH `github-personal`.
- Se commiteó el trabajo pendiente de `weather-station-station-iot` (PCB Aux v1.2.2 actualizado, nuevas iteraciones Main PCB v1.3/v1.4, `componentes_y_conexiones.md`).
- `PCB/` de la raíz se consolidó dentro de `weather-station-station-iot/PCB/` — ya no hay diseño de hardware duplicado entre repos; `weather-station-station-iot/` es ahora la única fuente para todo lo de hardware.
- Se arregló un `env_file` roto en el `docker-compose.yml` raíz (seguía apuntando a `./backend-service/.env` tras el renombrado de carpeta).
- Limpieza de branches ya mergeadas a la rama principal, local y remoto: `weather-station-frontend-dashboard` (`dockerization`, `integration`, `bugfix`), `weather-station-backend-service` (`dockerization`; falta `core-logic`, ver pendiente manual), `weather-station-station-iot` (`DHT11-fix`, `add-rssi-value`, `nuevos_sensores`, `rain-pulsed-signal`, `rain-value`, `claude/friendly-euler`). También se podó un worktree de git huérfano en `weather-station-station-iot` (metadata vieja de antes del renombre de carpeta, sin datos reales).
