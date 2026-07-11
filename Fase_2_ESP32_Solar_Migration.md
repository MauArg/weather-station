# Weather Station IoT - Fase 2: Migración ESP32 + Solar Autónomo

## Metadata del Proyecto

- **Autor**: Mau
- **Fecha Inicio**: Semana 4 (post Fase 1 completada)
- **Duración Estimada**: 3-4 semanas
- **Hardware**: Migración de NodeMCU ESP8266 → FireBeetle ESP32
- **Objetivo**: Transición a alimentación solar 100% autónoma con consumo <50µA en deep sleep
- **Prerequisitos**: Fase 1 completada exitosamente (7 días uptime, consumo documentado)
- **Estado**: Prototipo desplegado en campo (perfboard, no PCB definitivo) — ver `weather-station-station-iot/componentes_y_conexiones.md` → "Estado actual en campo" para el detalle vigente (actualizado 2026-07-11; este documento de fase quedó desactualizado como plan, se conserva como referencia de objetivos originales)

---

## Executive Summary

Fase de producción del proyecto Weather Station. Esta fase implementa la migración de NodeMCU ESP8266 (Fase 1) a FireBeetle ESP32 para reducir consumo energético de ~10mA a <50µA, permitiendo operación solar autónoma. Incluye instalación de panel solar 6W, batería LiPo 2500mAh, housing definitivo IP65, y optimizaciones de software para maximizar autonomía. Objetivo: 30+ días sin mantenimiento en condiciones climáticas adversas.

**Migración ESP8266 → ESP32 justificada por:**
- Consumo deep sleep: 10mA → <50µA (200x mejora)
- Autonomía batería: Imposible → 10+ días
- RAM: 80KB → 520KB (más headroom)
- Sin jumper GPIO16→RST (más simple)

---

## Objetivos de Fase 2

### Objetivos Primarios
1. Migrar código ESP8266 → ESP32 con cambios mínimos (~20% código)
2. Implementar alimentación solar 100% autónoma
3. Reducir consumo deep sleep a <50µA medido
4. Instalar housing definitivo IP65 weatherproof
5. Lograr 30+ días autonomía sin mantenimiento

### Objetivos Secundarios
1. Implementar métricas de batería (voltaje, %, carga) en dashboard
2. Alertas inteligentes batería crítica (<20%)
3. Adaptive sleep modes según nivel de batería
4. Comparación consumo ESP8266 vs ESP32 (documentado)
5. Verificar FireBeetle <50µA con multímetro

### Métricas de Éxito
- Autonomía sin sol: >5 días (batería 2500mAh)
- Consumo sleep: <50µA confirmado
- Código migrado: <1 día trabajo
- Carga solar funcional: 0→100% en 2 días soleados

---

## Cambios vs Fase 1

### Hardware Changes

| Componente | Fase 1 (ESP8266) | Fase 2 (ESP32) | Beneficio |
|------------|------------------|----------------|-----------|
| **Board** | NodeMCU ESP8266 | FireBeetle ESP32 | 200x menos consumo |
| **Deep Sleep** | 8-12mA + jumper GPIO16→RST | <50µA, solo software | Mucho más simple |
| **RAM** | 80KB | 520KB | Sin out-of-memory |
| **WiFi Speed** | 2-3s connect | 1-2s connect | 33% más rápido |
| **Alimentación** | Cable USB 5V | Solar 6W + LiPo 2500mAh | Autónomo |
| **Housing** | Tupper DIY | Radiation shield IP65 | Weatherproof |
| **Precisión temp** | ±3°C | ±1°C | Mejor sensor shield |

### Software Changes

| Aspecto | ESP8266 (Fase 1) | ESP32 (Fase 2) | Esfuerzo |
|---------|------------------|----------------|----------|
| **Includes** | `ESP8266WiFi.h` | `WiFi.h` | Buscar/reemplazar |
| **Deep Sleep** | `ESP.deepSleep()` | `esp_deep_sleep_start()` | Reescribir función |
| **RTC Memory** | `rtcUserMemory` | `RTC_DATA_ATTR` | Más simple |
| **Battery Monitor** | Simulado | ADC GPIO34 real | Nuevo código |
| **Pin Mapping** | D1/D2 | GPIO21/22 | Actualizar #define |
| **Adaptive Sleep** | Fixed 5min | 5-30min según batería | Lógica nueva |

**Estimado:** ~20% del código requiere cambios, mayoría automática.

---

## Arquitectura del Sistema (Fase 2)

```
┌──────────────────────────────────────────────────────┐
│              FireBeetle ESP32 (DFRobot)              │
│                   ESP32-WROOM-32                     │
│                                                      │
│  Hardware:                                           │
│   - BME280 (I2C) - reutilizado de Fase 1            │
│   - Batería LiPo 3.7V 2500mAh (JST)                 │
│   - Panel Solar 6W 6V                                │
│   - TP4056 charge controller (integrado)             │
│   - Voltage divider GPIO34 (medir batería)          │
│                                                      │
│  Consumo:                                            │
│   - Deep sleep: 10-50µA (target <50µA)              │
│   - Active + WiFi: ~160mA × 20s                     │
│   - Promedio: ~250 mAh/día                          │
│   - vs Fase 1: ~2400 mAh/día (ESP8266)              │
│   - Mejora: 10x menos consumo                       │
│                                                      │
│  Battery Monitoring:                                 │
│   - GPIO34: ADC (voltage divider 2:1)               │
│   - GPIO26: CHRG pin (LOW = charging)               │
│   - GPIO25: STDBY pin (LOW = full)                  │
│                                                      │
│  Software Loop (adaptive):                           │
│    1. Wake from deep sleep (timer, no RST)           │
│    2. Read RTC variables (bootCount)                 │
│    3. Read battery voltage (GPIO34)                  │
│    4. IF battery <3.0V → emergency sleep 30min      │
│    5. WiFi connect (~1-2s, vs 2-3s ESP8266)         │
│    6. MQTT connect                                   │
│    7. Check OTA (skip si batería <30%)              │
│    8. Read BME280 + battery metrics                  │
│    9. Publish MQTT (campos adicionales batería)     │
│   10. Calculate adaptive sleep (5-30min)            │
│   11. esp_deep_sleep_start()                        │
└──────────────────┬───────────────────────────────────┘
                   │ WiFi (sin cambios vs Fase 1)
                   │
         ┌─────────▼─────────┐
         │  Raspberry Pi 3   │
         │                   │
         │  + N8N workflows  │
         │    adicionales:   │
         │    - Battery mon  │
         │    - Low battery  │
         │      alerts       │
         └───────────────────┘
```

### Power Budget - FireBeetle ESP32

**Consumo por ciclo (5 min normales):**
```
Component              | Active (20s) | Sleep (280s) | Avg/ciclo
-----------------------|--------------|--------------|----------
ESP32 core             | 80 mA        | 10 µA        | 0.53 mA
WiFi radio             | 120 mA       | 0 µA         | 0.67 mA
BME280                 | 3 µA         | 3 µA         | 3 µA
Voltage divider 10kΩ   | 180 µA       | 180 µA       | 180 µA
FireBeetle overhead    | ~30 µA       | ~30 µA       | 30 µA
-----------------------|--------------|--------------|----------
TOTAL per cycle                                      | 1.4 mA

Daily consumption (288 cycles):
  - Active: 288 × 0.67 mA × (20s/3600s) = 1.07 mAh
  - Sleep: 288 × 1.4 mA × (280s/3600s) = 109 mAh
  - Night sleep (12h × 30µA) = 0.36 mAh
  -------------------------------------------
  TOTAL: ~110-120 mAh/día
```

**Comparación con ESP8266 (Fase 1):**
```
ESP8266 NodeMCU: ~2400 mAh/día (estimado)
ESP32 FireBeetle: ~120 mAh/día
Mejora: 20x menos consumo
```

**Autonomía sin sol:**
```
Batería: 2500 mAh × 70% DoD = 1750 mAh utilizables
Consumo: 120 mAh/día
Autonomía: 1750 / 120 = 14.5 días ≈ 2 semanas
```

**Carga solar:**
```
Panel 6W @ 6V: 1A max
Horas sol (invierno): 4h/día
Energía generada: 1A × 4h × 70% eficiencia = 2.8 Ah/día
Consumo: 120 mAh/día
Neto: +2680 mAh/día → sobra ampliamente
```

---

## Bill of Materials (BOM) - Fase 2

### Hardware a Adquirir

| Item | Descripción | Cant | Costo | Proveedor | Prioridad |
|------|-------------|------|-------|-----------|-----------|
| **FireBeetle ESP32** | DFRobot low-power con charger | 1 | USD 10-12 | AliExpress | **CRÍTICO** |
| **Batería LiPo** | 3.7V 2500mAh JST-PH 2.0 | 1 | USD 8-10 | Local / AliExpress | **CRÍTICO** |
| **Panel Solar** | 6V 6W monocrystalline | 1 | USD 10-15 | AliExpress | **CRÍTICO** |
| **Radiation Shield** | Commercial multi-plate IP65 | 1 | USD 30-35 | AliExpress | Alta |
| **Caja IP65** | ABS 150x110x70mm waterproof | 1 | USD 12-15 | Local | Alta |
| **Diodo Schottky** | 1N5819 × 2 | 2 | USD 0.50 | Local | Alta |
| **Cable solar** | AWG18 rojo/negro 2m | 1 | USD 3 | Local | Media |
| **Mounting bracket** | Para panel solar | 1 | USD 5 | Ferretería | Media |
| **Silicona UV** | Outdoor sealant | 1 | USD 5 | Ferretería | Alta |
| **Cable glands** | M12 IP68 × 3 | 3 | USD 6 | Local | Alta |

**TOTAL Fase 2:** ~USD 90-110

### Hardware Reutilizado de Fase 1

- ✅ BME280 sensor (funcional)
- ✅ Cables jumper I2C
- ✅ Raspberry Pi 3 (sin cambios)
- ✅ NAS (sin cambios)
- ✅ Poste/estructura jardín
- ✅ **NodeMCU ESP8266** (backup o segundo sensor)

---

## Migración de Código ESP8266 → ESP32

### Paso 1: Cambios Automáticos (Buscar/Reemplazar)

```cpp
// Buscar:                  Reemplazar con:
#include <ESP8266WiFi.h>    #include <WiFi.h>
#include <ESP8266mDNS.h>    #include <ESPmDNS.h>
ESP.getChipId()             ESP.getEfuseMac()
ESP.getResetReason()        esp_reset_reason()
```

### Paso 2: board_config.h (actualizar)

```cpp
#ifndef BOARD_CONFIG_H
#define BOARD_CONFIG_H

// Board selection - CAMBIAR
// #define BOARD_NODEMCU_ESP8266  // Fase 1
#define BOARD_FIREBEETLE_ESP32    // Fase 2

#ifdef BOARD_FIREBEETLE_ESP32
  // Pin mapping FireBeetle
  #define LED_BUILTIN 2
  #define I2C_SDA 21         // vs D2 en ESP8266
  #define I2C_SCL 22         // vs D1 en ESP8266
  
  // Battery monitoring (NUEVO)
  #define BATTERY_ADC_PIN 34
  #define BATTERY_VOLTAGE_DIVIDER 2.0
  #define CHRG_PIN 26        // Verificar en datasheet
  #define STDBY_PIN 25       // Verificar en datasheet
  
  #define HAS_BATTERY_CHARGER true
  
  // Battery thresholds
  #define BATTERY_CRITICAL_MV 3000
  #define BATTERY_LOW_MV 3400
  #define BATTERY_NORMAL_MV 3800
#endif

#endif
```

### Paso 3: RTC Memory (simplificar)

**Antes (ESP8266):**
```cpp
struct {
  uint32_t bootCount;
  uint32_t crc32;
} rtcData;

// Leer
ESP.rtcUserMemoryRead(0, (uint32_t*) &rtcData, sizeof(rtcData));

// Escribir
ESP.rtcUserMemoryWrite(0, (uint32_t*) &rtcData, sizeof(rtcData));
```

**Después (ESP32):**
```cpp
// Más simple: variables persisten automáticamente
RTC_DATA_ATTR int bootCount = 0;

// Uso directo
bootCount++;  // Persiste entre deep sleeps
```

### Paso 4: Deep Sleep (reescribir)

**Antes (ESP8266):**
```cpp
void deepSleep() {
  mqtt.disconnect();
  WiFi.disconnect(true);
  delay(100);
  
  // Requiere GPIO16 → RST jumper
  ESP.deepSleep(SLEEP_SECONDS * 1000000ULL, WAKE_RF_DEFAULT);
}
```

**Después (ESP32):**
```cpp
void deepSleep() {
  mqtt.disconnect();
  WiFi.disconnect(true);
  
  // Deshabilitar periféricos RTC si no se usan
  esp_sleep_pd_config(ESP_PD_DOMAIN_RTC_PERIPH, ESP_PD_OPTION_OFF);
  
  // Configurar timer wake
  int sleepSeconds = battery.getAdaptiveSleepSeconds();  // 5-30min
  esp_sleep_enable_timer_wakeup(sleepSeconds * 1000000ULL);
  
  // Dormir (sin jumper necesario!)
  esp_deep_sleep_start();
}
```

### Paso 5: Battery Monitoring (NUEVO)

```cpp
// battery.h - implementación completa

#include "board_config.h"

class Battery {
private:
  const float VOLTAGE_CALIBRATION = 1.0;  // Ajustar tras medición
  
  // LiPo voltage curve
  const int voltageTable[11] = {
    3000, 3300, 3500, 3600, 3650,
    3700, 3750, 3850, 3950, 4050, 4200
  };
  
public:
  void init() {
    #if HAS_BATTERY_CHARGER
      pinMode(CHRG_PIN, INPUT);
      pinMode(STDBY_PIN, INPUT);
      analogSetAttenuation(ADC_11db);  // 0-3.6V range
      
      // Warm-up ADC
      for(int i=0; i<10; i++) {
        analogRead(BATTERY_ADC_PIN);
        delay(10);
      }
    #endif
  }
  
  float getVoltage() {
    #if HAS_BATTERY_CHARGER
      // Promediar 10 lecturas
      int samples = 10;
      long sum = 0;
      
      for(int i=0; i<samples; i++) {
        sum += analogRead(BATTERY_ADC_PIN);
        delay(5);
      }
      
      int rawValue = sum / samples;
      
      // ADC 12-bit (0-4095) → voltage
      float voltage = (rawValue / 4095.0) * 3.3 * BATTERY_VOLTAGE_DIVIDER;
      voltage *= VOLTAGE_CALIBRATION;
      
      return voltage;
    #else
      return 3.7;  // Fallback
    #endif
  }
  
  int getVoltageMv() {
    return (int)(getVoltage() * 1000);
  }
  
  int getPercentage() {
    int mv = getVoltageMv();
    
    if (mv <= voltageTable[0]) return 0;
    if (mv >= voltageTable[10]) return 100;
    
    // Interpolación lineal entre puntos
    for(int i=0; i<10; i++) {
      if (mv >= voltageTable[i] && mv < voltageTable[i+1]) {
        int pct_low = i * 10;
        int pct_high = (i+1) * 10;
        int mv_low = voltageTable[i];
        int mv_high = voltageTable[i+1];
        
        return pct_low + ((mv - mv_low) * 10) / (mv_high - mv_low);
      }
    }
    
    return 50;
  }
  
  bool isCharging() {
    #if HAS_BATTERY_CHARGER
      return digitalRead(CHRG_PIN) == LOW;  // TP4056: LOW = charging
    #else
      return false;
    #endif
  }
  
  bool isFullyCharged() {
    #if HAS_BATTERY_CHARGER
      return digitalRead(STDBY_PIN) == LOW;
    #else
      return false;
    #endif
  }
  
  bool isCritical() {
    return getVoltageMv() < BATTERY_CRITICAL_MV;
  }
  
  bool isLow() {
    return getVoltageMv() < BATTERY_LOW_MV;
  }
  
  // Adaptive sleep: 5min normal, hasta 30min si batería baja
  int getAdaptiveSleepSeconds() {
    int mv = getVoltageMv();
    
    if (mv < BATTERY_CRITICAL_MV) {
      return 1800;  // 30 min
    } else if (mv < BATTERY_LOW_MV) {
      return 900;   // 15 min
    } else if (mv > BATTERY_NORMAL_MV) {
      return 300;   // 5 min - normal
    } else {
      return 600;   // 10 min
    }
  }
};
```

### Paso 6: MQTT Payload (agregar campos batería)

```cpp
void publishSensorData() {
  bme.takeForcedMeasurement();
  
  float temp = bme.readTemperature();
  float hum = bme.readHumidity();
  float pres = bme.readPressure() / 100.0F;
  
  // ESP32: más RAM, JSON más grande OK
  StaticJsonDocument<384> doc;  // vs 256 en ESP8266
  
  // Sensor data
  doc["temperature"] = round(temp * 100) / 100.0;
  doc["humidity"] = round(hum * 100) / 100.0;
  doc["pressure"] = round(pres * 100) / 100.0;
  
  // Battery metrics (NUEVO en Fase 2)
  doc["battery_voltage"] = battery.getVoltage();
  doc["battery_mv"] = battery.getVoltageMv();
  doc["battery_percent"] = battery.getPercentage();
  doc["charging"] = battery.isCharging();
  doc["fully_charged"] = battery.isFullyCharged();
  
  // System
  doc["boot_count"] = bootCount;
  doc["rssi"] = WiFi.RSSI();
  doc["sleep_duration"] = battery.getAdaptiveSleepSeconds();
  doc["free_heap"] = ESP.getFreeHeap();  // Ahora >300KB
  
  char buffer[384];
  serializeJson(doc, buffer);
  
  mqtt.publish(MQTT_TOPIC_DATA, buffer, true);
  mqtt.loop();
  delay(100);
}
```

---

## Instalación Física - Fase 2

### Día 1: Testing Indoor FireBeetle

**1. Test básico:**
```
1. Conectar batería LiPo a FireBeetle (JST)
2. Medir voltaje: 3.7-4.2V con multímetro
3. Upload blink sketch
4. Verificar LED onboard funciona
```

**2. Test panel solar:**
```
1. Panel al sol: medir voltaje abierto (6-7V)
2. Medir corriente cortocircuito (~1A)
3. Conectar: Panel → Diodo → TP4056 → Batería
4. LED CHRG rojo = cargando
5. LED STDBY azul/verde = llena
```

**3. Calibración ADC batería:**
```cpp
void loop() {
  int raw = analogRead(34);
  
  // Medir voltaje REAL con multímetro
  float real_voltage = 3.85;  // Ejemplo
  
  float calculated = (raw / 4095.0) * 3.3 * 2.0;
  float calibration = real_voltage / calculated;
  
  Serial.printf("Raw: %d, Calc: %.2fV, Real: %.2fV, Cal: %.3f\n",
                raw, calculated, real_voltage, calibration);
  delay(1000);
}

// Actualizar VOLTAGE_CALIBRATION en battery.h con resultado
```

### Día 2: Migración Código

**1. Preparación:**
```bash
# Backup código ESP8266
cp weather_station_esp8266/ weather_station_esp8266_backup/

# Copiar a nuevo proyecto ESP32
cp -r weather_station_esp8266/ weather_station_esp32/
cd weather_station_esp32/
```

**2. Cambios (30-60 minutos):**
```
☐ Actualizar includes (ESP8266WiFi → WiFi)
☐ Cambiar board_config.h (BOARD_FIREBEETLE_ESP32)
☐ Reemplazar RTC memory (RTC_DATA_ATTR)
☐ Actualizar deepSleep()
☐ Implementar battery.h completo
☐ Agregar campos batería en publishSensorData()
```

**3. Upload y test:**
```
1. Arduino IDE: Board → ESP32 Dev Module
2. Upload Speed: 921600
3. Flash Size: 4MB
4. Upload
5. Monitor serial: verificar no errores
6. Dashboard: ver datos batería fluyendo
```

### Día 3-4: Instalación Outdoor

**1. Housing:**
```
Caja IP65:
  - ESP32 + batería adentro
  - BME280 AFUERA (cable I2C)
  - Cable glands: panel, sensor
  - Silicona UV: todas las juntas
```

**2. Panel solar:**
```
Mounting:
  - Bracket en top poste
  - Orientación: Norte (hemisferio sur)
  - Ángulo: 49° (latitud + 15°)
  - Cable bajando por poste
```

**3. Radiation shield:**
```
Commercial shield:
  - A 1.5m altura
  - BME280 colgando en centro
  - Ventilación pasiva libre
```

### Día 5: Medición Consumo

**Verificar <50µA:**
```
Setup:
  1. Desconectar panel solar
  2. Multímetro en serie con batería (mA/µA mode)
  3. Esperar 1 ciclo completo (5min)

Mediciones esperadas:
  - Active (20s): 150-180mA ✅
  - Transition (2s): 5-10mA
  - Sleep (278s): <50µA ✅ ← CRÍTICO

Si sleep >100µA:
  - Revisar LED onboard apagado
  - Verificar GPIO pull-ups disabled
  - Check código: esp_sleep_pd_config() usado
```

---

## N8N Workflows Nuevos

### Workflow: Battery Health Monitor

```json
{
  "name": "Battery Health - Fase 2",
  "nodes": [
    {
      "name": "MQTT Battery",
      "type": "n8n-nodes-base.mqttTrigger",
      "parameters": {
        "topic": "weather/outdoor/data"
      }
    },
    {
      "name": "Extract Battery",
      "type": "n8n-nodes-base.set",
      "parameters": {
        "values": {
          "number": [
            {"name": "voltage", "value": "={{ $json.battery_voltage }}"},
            {"name": "percent", "value": "={{ $json.battery_percent }}"}
          ],
          "boolean": [
            {"name": "charging", "value": "={{ $json.charging }}"}
          ]
        }
      }
    },
    {
      "name": "IF Battery <20%",
      "type": "n8n-nodes-base.if",
      "parameters": {
        "conditions": {
          "number": [{
            "value1": "={{ $json.percent }}",
            "operation": "smaller",
            "value2": 20
          }]
        }
      }
    },
    {
      "name": "Email URGENT",
      "type": "n8n-nodes-base.emailSend",
      "parameters": {
        "subject": "🔴 Batería Crítica: {{ $json.percent }}%",
        "text": "Weather Station batería al {{ $json.percent }}% ({{ $json.voltage }}V). Revisar panel solar urgente.",
        "toEmail": "tu@email.com"
      }
    },
    {
      "name": "IF Low + Not Charging",
      "type": "n8n-nodes-base.if",
      "parameters": {
        "conditions": {
          "boolean": [{
            "value1": "={{ $json.charging }}",
            "value2": false
          }],
          "number": [{
            "value1": "={{ $json.percent }}",
            "operation": "smaller",
            "value2": 40
          }]
        }
      }
    },
    {
      "name": "Telegram Warning",
      "type": "n8n-nodes-base.telegram",
      "parameters": {
        "text": "⚠️ Batería {{ $json.percent }}% y NO cargando. Panel desconectado?"
      }
    }
  ]
}
```

---

## Grafana Dashboard - Paneles Nuevos

### Panel: Battery Voltage Curve

```flux
// Voltaje + estado carga
from(bucket: "weather")
  |> range(start: -24h)
  |> filter(fn: (r) => r._measurement == "outdoor")
  |> filter(fn: (r) => r._field == "battery_voltage" or r._field == "charging")
```

**Config:**
- Y-axis: 3.0-4.3V
- Thresholds: Red <3.3V, Yellow 3.3-3.6V, Green >3.6V
- Show charging status as overlay

### Panel: Daily Energy Balance

```flux
// Carga neta diaria
from(bucket: "weather")
  |> range(start: -30d)
  |> filter(fn: (r) => r._field == "battery_percent")
  |> aggregateWindow(every: 1d, fn: last)
  |> difference()
```

**Interpretación:**
- Positivo: batería ganó carga (sol OK)
- Negativo: batería perdió carga (días nublados)

### Panel: Sleep Duration (adaptive)

```flux
from(bucket: "weather")
  |> range(start: -7d)
  |> filter(fn: (r) => r._field == "sleep_duration")
```

Muestra cómo el ESP32 adapta sleep según batería:
- 300s = batería >3.8V (normal)
- 600s = batería 3.4-3.8V
- 900s = batería <3.4V
- 1800s = batería <3.0V (emergencia)

---

## Testing y Validación

### Test 1: Autonomía sin Sol

```
Setup:
  1. Batería 100% (4.2V)
  2. Desconectar panel solar
  3. Operar normalmente

Objetivo:
  - >5 días hasta 30% batería
  - 7-10 días hasta 20%

Medir cada 6 horas:
  - Voltaje
  - %
  - Tiempo transcurrido

Si <5 días: revisar consumo sleep
```

### Test 2: Carga Solar

```
Setup:
  1. Batería 50% (3.7V)
  2. Panel conectado
  3. Día soleado

Objetivo:
  - Alcanzar 100% en 1-2 días

Verificar:
  - Panel genera >5V al sol
  - LED CHRG enciende de día
  - LED STDBY enciende cuando llena
```

### Test 3: Comparación ESP8266 vs ESP32

```
Métrica              | ESP8266  | ESP32    | Mejora
---------------------|----------|----------|-------
Sleep current        | ~10 mA   | <50 µA   | 200x
Daily consumption    | ~2.4 Ah  | ~120 mAh | 20x
WiFi connect time    | ~3s      | ~1.5s    | 2x
Free RAM             | ~40 KB   | ~400 KB  | 10x
Battery autonomy     | N/A      | 14 días  | ∞
```

---

## Troubleshooting Fase 2

### Problema: Batería no carga

**Síntomas:** LED CHRG apagado con panel al sol

**Diagnóstico:**
```
1. Voltaje panel (desconectado): >5V?
2. Voltaje TP4056 IN: coincide con panel?
3. Voltaje batería: 3.0-4.2V?
4. LED CHRG: debería encender si batería <4.1V
```

**Soluciones:**
- Panel: verificar orientación/limpieza
- Diodo: si voltaje drop >1V, invertido
- TP4056: LED nunca enciende = dañado
- Batería: <2.5V o >4.5V = dañada

### Problema: Consumo >100µA sleep

**Diagnóstico:**
```cpp
// Antes de deep sleep
void prepareDeepSleep() {
  // Deshabilitar GPIO no usados
  for (int i = 0; i <= 39; i++) {
    if (i != I2C_SDA && i != I2C_SCL && i != BATTERY_ADC_PIN) {
      gpio_reset_pin((gpio_num_t)i);
      gpio_pullup_dis((gpio_num_t)i);
      gpio_pulldown_dis((gpio_num_t)i);
    }
  }
  
  // Deshabilitar periféricos RTC
  esp_sleep_pd_config(ESP_PD_DOMAIN_RTC_PERIPH, ESP_PD_OPTION_OFF);
}
```

---

## Criterios de Éxito Fase 2

### Obligatorios ✅

1. Consumo sleep <50µA medido
2. Autonomía sin sol >5 días
3. Carga solar funcional (0→100% en 2 días sol)
4. Código migrado ESP8266→ESP32 en <1 día
5. Dashboard batería funcionando
6. 30 días operación sin mantenimiento

### Deseables ⭐

- Precisión temperatura <1°C vs referencia
- Alertas batería <20% funcionando
- Housing IP65 sin filtraciones tras lluvia
- Comparación consumo ESP8266 vs ESP32 documentada

---

## Documentación Final

Al completar Fase 2, documentar:

### Métricas Finales

| Métrica | Objetivo | Resultado | ✅/❌ |
|---------|----------|-----------|------|
| Sleep current | <50 µA | ___ µA | |
| Daily consumption | ~120 mAh | ___ mAh | |
| Autonomy no sun | >5 días | ___ días | |
| Solar charge 0→100% | <2 días | ___ días | |
| Migration effort | <1 día | ___ horas | |

### Lecciones Aprendidas

```
ESP8266 → ESP32 Migration:
  - Tiempo real: ___
  - Issues encontrados: ___
  - Recomendaciones: ___

Solar System:
  - Panel performance: ___
  - Battery degradation: ___
  - Optimizaciones posibles: ___

Housing:
  - Weatherproofing: ___
  - Temperature accuracy: ___
  - Mejoras futuras: ___
```

---

## Fase 3 Potencial (Futuro)

**Expansión posible:**
- Segundo sensor (indoor vs outdoor)
- Sensor de lluvia
- Anemómetro (viento)
- Cámara timelapse solar
- Integración Home Assistant

---

## Referencias

### Hardware
- [FireBeetle ESP32 Specs](https://wiki.dfrobot.com/FireBeetle_Board_ESP32_E_SKU_DFR0654)
- [TP4056 Charger](https://dlnmh9ip6v2uc.cloudfront.net/datasheets/Prototyping/TP4056.pdf)
- [LiPo Battery Guide](https://learn.adafruit.com/li-ion-and-lipoly-batteries)

### Software Migration
- [ESP32 Arduino Core](https://github.com/espressif/arduino-esp32)
- [ESP8266 to ESP32 Migration](https://docs.espressif.com/projects/esp-idf/en/latest/esp32/migration-guides/)
- [ESP32 Deep Sleep](https://docs.espressif.com/projects/esp-idf/en/latest/esp32/api-reference/system/sleep_modes.html)

---

## Changelog

| Versión | Fecha | Cambios |
|---------|-------|---------|
| 1.0 | 2024-12-13 | Documento inicial - Migración ESP8266→ESP32 |

---

**Documento preparado por**: Mau  
**Migración**: NodeMCU ESP8266 (Fase 1) → FireBeetle ESP32 (Fase 2)  
**Última actualización**: 2024-12-13  
**Status**: Listo para iniciar tras completar Fase 1
