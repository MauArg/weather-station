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

- En GitHub, el repo `weather-station-frontend-dashboard` todavía tiene `bugfix` como default branch (heredado del primer push). Hay que cambiarlo a `master` en Settings → Branches para poder borrar `origin/bugfix` (ya está mergeado a `master`, no se pierde nada).

## Configuración de este repo (hecho en sesión 2026-07-10/11)

- Identidad de git personal (`Mauricio <maulp_gnt@hotmail.com>`) aplicada automáticamente a todo bajo `D:/trabajo/my_projects/` vía `includeIf` en `~/.gitconfig` — no requiere configuración manual por repo.
- Topología definida: este repo es **main** (docs transversales, deploy), `weather-station-backend-service/` `weather-station-frontend-dashboard/` `weather-station-station-iot/` son **secondary** independientes (ignorados por `.gitignore` acá, no son submodules).
- Política de auto-commit + auto-push activada (ver `CLAUDE.md`) — sin necesidad de confirmación manual, dado que es un proyecto personal de bajo riesgo.
- Los 4 repos están pusheados a GitHub (cuenta personal `MauArg`, privados): `weather-station`, `weather-station-backend-service`, `weather-station-frontend-dashboard`, `weather-station-station-iot`, conectados vía el alias SSH `github-personal`.
- `weather-station-frontend-dashboard`: ramas redundantes `dockerization`/`integration`/`bugfix` mergeadas a `master` y borradas (local + remoto, salvo `bugfix` — ver pendiente manual arriba).
- Se commiteó el trabajo pendiente de `weather-station-station-iot` (PCB Aux v1.2.2 actualizado, nuevas iteraciones Main PCB v1.3/v1.4, `componentes_y_conexiones.md`).
- `PCB/` de la raíz se consolidó dentro de `weather-station-station-iot/PCB/` — ya no hay diseño de hardware duplicado entre repos; `weather-station-station-iot/` es ahora la única fuente para todo lo de hardware.
