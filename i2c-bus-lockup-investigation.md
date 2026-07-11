# Investigación: Bus I2C bloqueado después de agregar nuevos sensores

**Fecha:** Abril 2026  
**Firmware afectado:** 1.1.x-dev  
**Branch:** `nuevos_sensores`

---

## Contexto

En el commit de integración de nuevos sensores (PCB auxiliar) se agregaron:
- Rail A (GPIO7 → NPN BC337) controlando GND de SHT31 + BMP085
- Rail B (GPIO8 → NPN BC337) controlando GND de DHT11, rain sensor, fotorresistencia, AS5600 (veleta, deferida)
- Sensores always-on: DS18B20 (GPIO10), anemómetro (GPIO2), pluviómetro (GPIO1)

El firmware anterior (sin rails) funcionaba correctamente con SHT31, BMP085 e INA219×2.

---

## Síntoma

**Todos los sensores I2C fallan simultáneamente; los no-I2C funcionan correctamente.**

```json
{
  "sht31_ok": false,
  "bmp_ok": false,
  "solar_ok": false,
  "system_ok": false,
  "ds18b20_ok": true,
  "dht11_ok": true,
  "photo_ok": true,
  "rain_ok": true
}
```

Sensores I2C afectados: SHT31 (0x44), BMP085 (0x77), INA219 solar (0x41), INA219 sistema (0x40).  
Los INA219 están en la PCB principal con GND directo (no pasan por ningún rail), lo que indica que **el bus I2C completo está bloqueado**, no solo los sensores del rail.

---

## Hipótesis firmware (descartada)

### Intento 1 — `delay(50)` después de activar rails (v1.1.0-dev)

**Razonamiento:** Los sensores en Rail A no tenían tiempo de completar su power-on reset antes de que `sensors_init()` intentara comunicarse.

**Resultado:** Sin cambio. El fallo persiste desde el primer ciclo.

---

### Intento 2 — Rails activados al inicio de `setup()` (v1.1.0-dev)

**Razonamiento:** Mover `digitalWrite(PIN_RAIL_A/B, HIGH)` antes de `connectWiFi()` para que los sensores tengan 1–3 s de warmup durante la conexión WiFi.

**Resultado:** Sin cambio.

---

### Intento 3 — `gpio_hold_en` + recuperación I2C (v1.1.1-dev)

**Razonamiento:** Durante `esp_deep_sleep()`, GPIO7/8 vuelven a INPUT. El pulldown del NPN apaga los transistores → Rail A/B GND se desconecta → sensores pierden GND mientras duermen. Al despertar, el SHT31/BMP085 puede volver con SDA en estado indefinido, colgando el bus entero (incluye INA219).

**Fix implementado:**
- `gpio_hold_en(PIN_RAIL_A/B)` + `gpio_deep_sleep_hold_en()` antes de `esp_deep_sleep()` → rails permanecen HIGH durante el sueño.
- `gpio_hold_dis(PIN_RAIL_A/B)` al inicio de `setup()` para liberar el hold antes de reconfigurar.
- `_recover_i2c_bus()`: 9 pulsos de SCL + STOP condition + `Wire.begin()` antes de inicializar sensores I2C.

**Resultado:** Sin cambio. El fallo aparece incluso en el **primer boot** post-flash (boot_count=2 o 3), antes de que haya habido un ciclo de deep sleep. Esto descarta que la causa sea exclusivamente el power cycling durante el sueño.

---

## Conclusión preliminar: problema de hardware

El hecho de que el fallo ocurra en el primer ciclo (sin deep sleep previo) y afecte **todos** los sensores I2C — incluidos los INA219 que tienen GND directo e independiente — apunta a que **algún dispositivo está manteniendo SDA en bajo** y bloqueando el bus completo.

---

## Próximos pasos de diagnóstico

### 1. Medir SDA con multímetro (nodo corriendo)
- GPIO6 (SDA) debería estar en **~3.3 V en reposo**.
- Si mide 0 V o un valor intermedio, un dispositivo tiene SDA colgado.

### 2. Desconectar conectores JST del aux PCB de a uno
Desconectar mientras el nodo está activo y observar si los I2C vuelven:
- **JST1** — SHT31 + BMP085 (Rail A, I2C)
- **JST5** — AS5600 veleta (Rail B, I2C) ← **candidato principal**

### 3. AS5600 como principal sospechoso
El AS5600 (veleta, 0x36) está **físicamente conectado** en JST5 pero **no inicializado en el firmware**. Al recibir GND por Rail B, el chip despierta en el bus I2C. Si hay un problema de conexión (pin suelto, corto) o el chip recibió un daño estático, puede estar tirando SDA a bajo permanentemente.

**Verificación:** desconectar JST5. Si el bus I2C se recupera → AS5600 o su conexión es el problema.

---

## Estado del firmware al momento de esta investigación

| Archivo | Cambio relevante |
|---|---|
| `main.cpp` | `gpio_hold_en` en `goToDeepSleep()`, `gpio_hold_dis` al inicio de `setup()`, rails activados antes de WiFi |
| `sensors.cpp` | `_recover_i2c_bus()` (9 pulsos SCL + STOP + Wire reinit) antes de `sht31.begin()` |
| `config.h` | `PIN_RAIL_A=7`, `PIN_RAIL_B=8`, pines y calibración de nuevos sensores |
| `platformio.ini` | Librerías OneWire, DallasTemperature, DHT agregadas a `env:base` |

**Nota:** `serviceMode_exit()` en `service_mode.cpp` llama `esp_deep_sleep()` directamente sin pasar por `goToDeepSleep()`, por lo que no ejecuta `gpio_hold_en()`. Menor inconsistencia a resolver cuando se cierre este bug.
