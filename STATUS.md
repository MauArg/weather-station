# Estado del proyecto

> Actualizar este archivo al final de cada sesión de trabajo relevante. Es el punto de partida para la siguiente conversación — ver política en [`CLAUDE.md`](./CLAUDE.md).

_Última actualización: 2026-07-10_

## Arquitectura

- **`station-iot/`** — firmware ESP32 (PlatformIO) de la estación. Publica lecturas por MQTT a un broker Mosquitto corriendo en una Raspberry Pi (`station-iot/infra/docker-compose.yml`). Incluye también los assets de diseño de hardware (esquemáticos, PCB en Fritzing `.fzz`).
- **`backend-service/`** — servicio en Go, expone API y persiste datos.
- **`frontend-dashboard/`** — dashboard en React/Vite, consume la API del backend.
- **Deploy backend+frontend**: `docker-compose.yml` de este repo (main), imágenes publicadas en Docker Hub (`maulpdocker/weather-station:backend` / `:frontend`).
- **`PCB/`** (este repo) — archivos de diseño/fabricación del PCB (gerbers/etch/silk en PDF).

## Fase actual

Según `Fase_2_ESP32_Solar_Migration.md`: migración NodeMCU ESP8266 → FireBeetle ESP32 + alimentación solar autónoma. Estado documentado: **Diseño**. Objetivo: deep sleep <50µA, 30+ días de autonomía sin mantenimiento.

## Issue abierto: bus I2C bloqueado (sin resolver)

Ver `i2c-bus-lockup-investigation.md`. Todos los sensores I2C (SHT31, BMP085, ambos INA219) fallan simultáneamente desde el primer boot, incluso sin ciclo de deep sleep previo — descarta causa puramente de firmware. Hipótesis principal: el **AS5600** (veleta, conectado en JST5, no inicializado aún en firmware) puede estar tirando SDA a bajo por un problema físico de conexión o daño estático. Próximo paso de diagnóstico: desconectar JST5 con el nodo activo y ver si el bus I2C se recupera.

## Deuda de organización (pendiente de esta reorganización)

- `PCB/` (raíz) duplica contenido que también existe dentro de `station-iot/` (esquemáticos, `.fzz`, exports HTML). Falta decidir cuál es la fuente canónica y limpiar el duplicado.
- `station-iot/` tenía cambios sin commitear de antes de esta sesión (PCB Aux modificado, nuevos PCB Main v1.3/v1.4, `componentes_y_conexiones.md`) — quedan pendientes de revisión antes de commitear.
- Ningún repo (main ni los 3 secondary) tiene remote configurado todavía. Falta crear los repos en GitHub (cuenta personal) y conectar los remotes (usar el alias SSH `github-personal` ya configurado).

## Configuración de este repo (hecho en esta sesión, 2026-07-10)

- Identidad de git personal (`Mauricio <maulp_gnt@hotmail.com>`) aplicada automáticamente a todo bajo `D:/trabajo/my_projects/` vía `includeIf` en `~/.gitconfig` — no requiere configuración manual por repo.
- Topología definida: este repo es **main** (docs transversales, hardware, deploy), `backend-service/` `frontend-dashboard/` `station-iot/` son **secondary** independientes (ignorados por `.gitignore` acá, no son submodules).
- Política de auto-commit + auto-push activada (ver `CLAUDE.md`) — sin necesidad de confirmación manual, dado que es un proyecto personal de bajo riesgo.
