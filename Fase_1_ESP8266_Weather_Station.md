# Weather Station IoT - Fase 1: Validación de Stack con Cable (ESP8266)

## Metadata del Proyecto

- **Autor**: Mau
- **Fecha Inicio**: Diciembre 2024
- **Duración Estimada**: 3 semanas
- **Hardware Principal**: NodeMCU ESP8266
- **Objetivo**: Validar stack completo de telemetría (ESP8266 → MQTT → N8N → InfluxDB → Grafana) con alimentación por cable
- **Nota Importante**: Migración a FireBeetle ESP32 en Fase 2 para optimización energética
- **Estado**: Diseño

---

## Executive Summary

Fase inicial de proyecto de estación meteorológica IoT de 2 meses. Esta fase utiliza el hardware existente (NodeMCU ESP8266 + BME280 ya testeado) para validar la arquitectura de software y flujo de datos con alimentación por cable USB. El objetivo es tener datos fluyendo continuamente durante 1 semana sin gaps antes de migrar a ESP32 + solar en Fase 2.

**Hardware Choice Rationale**: Se usa NodeMCU ESP8266 en Fase 1 porque ya está disponible y funcional con el BME280. En Fase 2 se migrará a FireBeetle ESP32 para reducir consumo de ~10mA (ESP8266) a <50µA (ESP32 optimizado), necesario para operación solar.

---

## Objetivos de Fase 1

### Objetivos Primarios
1. Establecer stack de telemetría end-to-end funcional
2. Configurar y probar deep sleep del ESP8266 (simulando caso solar)
3. Implementar OTA updates funcional
4. Validar precisión de sensores con housing temporal
5. Configurar workflows N8N para procesamiento y alertas

### Objetivos Secundarios
1. Familiarización con N8N para workflows IoT
2. Establecer baseline de consumo energético para comparación en Fase 2
3. Documentar diferencias ESP8266 vs ESP32 para migración
4. Probar resistencia del housing DIY

### Non-Goals (explícitamente fuera de scope)
- Optimización de consumo energético < 1mA (imposible con NodeMCU)
- Housing definitivo weatherproof IP65
- Panel solar y batería LiPo
- Segundo sensor o expansión de red

---

## Diferencias Clave: ESP8266 vs ESP32

**¿Por qué NodeMCU ESP8266 en Fase 1 y FireBeetle ESP32 en Fase 2?**

| Aspecto | ESP8266 (Fase 1) | ESP32 (Fase 2) | Impacto |
|---------|------------------|----------------|---------|
| **Procesador** | 1 core @ 80 MHz | 2 cores @ 240 MHz | ESP32 más rápido |
| **RAM** | 80 KB | 520 KB | ESP32 más headroom |
| **Deep Sleep** | ~20µA (chip) | ~10µA (chip) | Similar teórico |
| **DevKit Sleep** | 8-12mA (NodeMCU) | <50µA (FireBeetle) | **ESP32 100x mejor** |
| **WiFi Connect** | 2-3 segundos | 1-2 segundos | ESP32 más eficiente |
| **Deep Sleep Setup** | **Requiere GPIO16→RST jumper** | Solo por software | ESP32 más simple |
| **Bluetooth** | ✗ No | ✓ Sí | No necesario |
| **Precio** | ~USD 4 | ~USD 10-12 | Similar |

**CRÍTICO - ESP8266 Deep Sleep**: Requiere conexión física GPIO16 (D0) → RST con cable jumper. Sin esto, el chip nunca despierta del deep sleep.

**Conclusión**: ESP8266 funciona para Fase 1 (cable, no importa consumo). Fase 2 requiere ESP32 optimizado para solar.

---

## Arquitectura del Sistema

### Diagrama de Arquitectura

```
┌─────────────────────────────────────────────────────┐
│              NodeMCU ESP8266 DevKit                 │
│            (ESP8266-12E o 12F)                      │
│                                                     │
│  Hardware:                                          │
│    - BME280 (I2C: Temp, Humidity, Pressure)        │
│    - Alimentación: Cable USB 5V desde interior     │
│    - ⚠️ GPIO16 (D0) conectado a RST (jumper wire) │
│                                                     │
│  Software Loop (cada 5 min):                        │
│    1. Wake from deep sleep (via RST pulse)          │
│    2. Read RTC memory (boot count)                  │
│    3. WiFi connect (~2-3 segundos)                  │
│    4. MQTT connect                                  │
│    5. Check OTA flag (topic: esp8266/ota/enable)   │
│    6. Read BME280                                   │
│    7. Publish JSON → MQTT                           │
│    8. ESP.deepSleep(300s) → GPIO16 pulse RST       │
│                                                     │
│  Topics MQTT:                                       │
│    - weather/outdoor/data (sensor readings)         │
│    - weather/outdoor/status (heartbeat)             │
│    - esp8266/ota/enable (OTA trigger)              │
└──────────────────┬──────────────────────────────────┘
                   │ WiFi (MQTT over TCP)
                   │
         ┌─────────▼─────────┐
         │  Raspberry Pi 3   │
         │   (192.168.x.x)   │
         │                   │
         │  Services:        │
         │   - Mosquitto     │ MQTT Broker :1883
         │   - N8N           │ Workflow Engine
         │   - InfluxDB 2.x  │ Time Series DB
         │   - Grafana       │ Dashboards
         └─────────┬─────────┘
                   │ rsync/cron (diario, 02:00 AM)
                   │
         ┌─────────▼─────────┐
         │   NAS (4TB)       │
         │  /backup/weather  │ Backup histórico
         └───────────────────┘
```

### Flujo de Datos Detallado

**1. ESP8266 → MQTT**
```json
Topic: weather/outdoor/data
Payload: {
  "temperature": 23.45,
  "humidity": 65.20,
  "pressure": 1013.25,
  "battery_voltage": 3.70,  // Simulado en Fase 1
  "boot_count": 142,
  "rssi": -67,
  "free_heap": 32000  // Importante en ESP8266 (RAM limitada)
}
```

**2. MQTT → N8N → InfluxDB → Grafana** (sin cambios vs ESP32)

---

## Bill of Materials (BOM)

### Hardware Existente (Ya Disponible)

| Item | Descripción | Cantidad | Notas |
|------|-------------|----------|-------|
| **NodeMCU ESP8266** | ESP8266-12E/12F DevKit | 1 | **Ya testeado con BME280** |
| **BME280** | Sensor I2C temp/hum/pressure | 1 | Dirección 0x76 confirmada |
| Raspberry Pi 3 | Server principal | 1 | Ya configurado con N8N |
| NAS | Almacenamiento 4TB | 1 | Ya funcional |
| Cables jumper | M-F para I2C | 4 | Para BME280 |
| Cable USB | Micro USB 5V, largo >3m | 1 | Desde interior a exterior |
| **Jumper wire** | Para GPIO16→RST | 1 | **CRÍTICO para deep sleep** |

### Hardware a Adquirir (Fase 1)

| Item | Descripción | Costo Est. | Proveedor | Prioridad | Notas |
|------|-------------|------------|-----------|-----------|-------|
| **FireBeetle ESP32** | Para Fase 2 - **COMPRAR AHORA** | USD 10-12 | AliExpress | **CRÍTICO** | Tarda 2-3 semanas en llegar |
| Radiation Shield | Multi-plate passive (Stevenson screen) | USD 25-35 | AliExpress | Alta | Usar DIY temporalmente |
| Caja hermética | ABS 100x68x50mm IP65 | USD 8 | Local | Media | - |
| Silicona | Sellador UV | USD 3 | Ferretería | Media | - |

**Alternativa DIY radiation shield** (usar mientras llega comercial):
- 3x platos hondos plásticos blancos: USD 3
- Tuercas/arandelas separadores: USD 2
- **Total**: USD 5

**IMPORTANTE**: Ordenar FireBeetle ESP32 en esta fase para que llegue cuando comience Fase 2 (semana 4).

---

## Pin Mapping - NodeMCU ESP8266

```
NodeMCU Pin Label → GPIO Number → Función

D0  → GPIO16 → ⚠️ DEBE CONECTARSE A RST (deep sleep wake)
D1  → GPIO5  → I2C SCL (BME280)
D2  → GPIO4  → I2C SDA (BME280)
D3  → GPIO0  → (reservado boot mode)
D4  → GPIO2  → LED_BUILTIN (on-board LED)
D5  → GPIO14 → (libre)
D6  → GPIO12 → (libre)
D7  → GPIO13 → (libre)
D8  → GPIO15 → (reservado boot mode)
A0  → ADC    → Analog input (1V max)

VIN → 5V input (desde USB)
3V3 → 3.3V output (para BME280)
GND → Ground
RST → Reset pin (conectar a D0 para deep sleep)
```

**Conexión CRÍTICA para Deep Sleep:**
```
    D0 (GPIO16) ─────────┬──── RST
                         │
                    [Resistencia 470Ω opcional]
```

**Sin esta conexión física, el ESP8266 nunca despierta del deep sleep.**

---

## Implementación Técnica

### 1. Configuración Raspberry Pi

(Idéntico al documento anterior - Mosquitto, InfluxDB, Grafana, N8N)

```bash
# Mosquitto
sudo apt install mosquitto mosquitto-clients -y
sudo systemctl enable mosquitto
sudo systemctl start mosquitto

# InfluxDB 2.x
wget -q https://repos.influxdata.com/influxdata-archive_compat.key
echo '393e8779c89ac8d958f81f942f9ad7fb82a25e133faddaf92e15b16e6ac9ce4c influxdata-archive_compat.key' | sha256sum -c && cat influxdata-archive_compat.key | gpg --dearmor | sudo tee /etc/apt/trusted.gpg.d/influxdata-archive_compat.gpg > /dev/null
echo 'deb [signed-by=/etc/apt/trusted.gpg.d/influxdata-archive_compat.gpg] https://repos.influxdata.com/debian stable main' | sudo tee /etc/apt/sources.list.d/influxdata.list
sudo apt update && sudo apt install influxdb2 -y
sudo systemctl enable influxdb
sudo systemctl start influxdb

# Grafana
sudo apt install -y adduser libfontconfig1
wget https://dl.grafana.com/oss/release/grafana_10.2.3_arm64.deb
sudo dpkg -i grafana_10.2.3_arm64.deb
sudo systemctl enable grafana-server
sudo systemctl start grafana-server

# Verificar
sudo systemctl status mosquitto influxdb grafana-server
docker ps  # Verificar N8N
```

### 2. Código ESP8266

**Estructura de archivos:**
```
weather_station_esp8266/
├── weather_station_esp8266.ino
├── config.h
├── board_config.h
├── battery.h
└── README.md
```

**config.h:**
```cpp
#ifndef CONFIG_H
#define CONFIG_H

// WiFi Configuration
#define WIFI_SSID "TuSSID"
#define WIFI_PASSWORD "TuPassword"

// MQTT Configuration  
#define MQTT_SERVER "192.168.1.XXX"  // IP de tu RPi
#define MQTT_PORT 1883
#define MQTT_CLIENT_ID "esp8266_weather_01"
#define MQTT_USER ""  
#define MQTT_PASSWORD ""

// MQTT Topics
#define MQTT_TOPIC_DATA "weather/outdoor/data"
#define MQTT_TOPIC_STATUS "weather/outdoor/status"
#define MQTT_TOPIC_OTA "esp8266/ota/enable"

// Timing
#define SLEEP_SECONDS 300  // 5 minutos
#define WIFI_TIMEOUT_MS 20000  // 20 segundos
#define MQTT_TIMEOUT_MS 10000
#define OTA_WAIT_MS 120000

// Sensor Configuration
#define BME280_I2C_ADDR 0x76  // Ya confirmado que funciona

// OTA Configuration
#define OTA_PASSWORD "tu_password_seguro"  // CAMBIAR!
#define OTA_HOSTNAME "esp8266-weather"

#endif
```

**board_config.h:**
```cpp
#ifndef BOARD_CONFIG_H
#define BOARD_CONFIG_H

// Board selection
#define BOARD_NODEMCU_ESP8266

#ifdef BOARD_NODEMCU_ESP8266
  // Pin mapping NodeMCU
  #define LED_BUILTIN 2       // D4 - LED onboard (inverted logic)
  #define I2C_SDA D2          // GPIO4
  #define I2C_SCL D1          // GPIO5
  
  // Deep sleep - REQUIERE GPIO16 conectado a RST físicamente
  #define DEEP_SLEEP_PIN 16   // D0
  
  // Battery (simulado en Fase 1)
  #define BATTERY_ADC_PIN A0
  #define HAS_BATTERY_CHARGER false
#endif

#endif
```

**battery.h:**
```cpp
#ifndef BATTERY_H
#define BATTERY_H

#include "board_config.h"

class Battery {
public:
  void init() {
    // Nada en Fase 1
  }
  
  float getVoltage() {
    // Fase 1: valor simulado (cable USB = siempre 5V)
    return 3.70;
  }
  
  int getPercentage() {
    return 100;  // Siempre conectado
  }
  
  bool isCharging() {
    return false;
  }
  
  bool isFullyCharged() {
    return true;
  }
};

#endif
```

**weather_station_esp8266.ino:**
```cpp
// ===== INCLUDES ESP8266 =====
#include <ESP8266WiFi.h>
#include <PubSubClient.h>
#include <ESP8266mDNS.h>
#include <WiFiUdp.h>
#include <ArduinoOTA.h>
#include <Adafruit_BME280.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include "config.h"
#include "board_config.h"
#include "battery.h"

// Clients
WiFiClient espClient;
PubSubClient mqtt(espClient);
Adafruit_BME280 bme;
Battery battery;

// RTC Memory para persistir entre deep sleeps
// ESP8266: usa rtcUserMemory
struct {
  uint32_t bootCount;
  uint32_t crc32;  // Para validar datos
} rtcData;

// Forward declarations
void connectWiFi();
bool initBME280();
void connectMQTT();
void mqttCallback(char* topic, byte* payload, unsigned int length);
bool checkOTAMode();
void handleOTA();
void publishSensorData();
void publishStatus();
void deepSleep();
uint32_t calculateCRC32(const uint8_t *data, size_t length);

// ===== SETUP =====
void setup() {
  Serial.begin(115200);
  delay(100);
  
  Serial.println("\n\n=== ESP8266 Weather Station ===");
  
  // Leer RTC memory
  ESP.rtcUserMemoryRead(0, (uint32_t*) &rtcData, sizeof(rtcData));
  
  // Validar CRC y inicializar si es primera vez
  uint32_t crcOfData = calculateCRC32((uint8_t*) &rtcData.bootCount, sizeof(rtcData.bootCount));
  
  if (rtcData.crc32 != crcOfData) {
    Serial.println("RTC memory invalid - initializing");
    rtcData.bootCount = 0;
  }
  
  rtcData.bootCount++;
  rtcData.crc32 = calculateCRC32((uint8_t*) &rtcData.bootCount, sizeof(rtcData.bootCount));
  
  // Guardar en RTC
  ESP.rtcUserMemoryWrite(0, (uint32_t*) &rtcData, sizeof(rtcData));
  
  Serial.printf("Boot #%d\n", rtcData.bootCount);
  Serial.printf("Reset reason: %s\n", ESP.getResetReason().c_str());
  Serial.printf("Free heap: %d bytes\n", ESP.getFreeHeap());
  
  // Advertencia GPIO16→RST
  if (rtcData.bootCount == 1) {
    Serial.println("\n⚠️  IMPORTANTE: Verificar que GPIO16 (D0) está conectado a RST");
    Serial.println("    Sin esta conexión, deep sleep no funcionará!\n");
  }
  
  battery.init();
  
  // Conectar WiFi
  connectWiFi();
  
  // Inicializar BME280
  if (!initBME280()) {
    Serial.println("ERROR: BME280 init failed - sleeping");
    deepSleep();
  }
  
  // Conectar MQTT
  mqtt.setServer(MQTT_SERVER, MQTT_PORT);
  mqtt.setCallback(mqttCallback);
  connectMQTT();
  
  // OTA check
  if (checkOTAMode()) {
    handleOTA();
  }
  
  // Publicar datos
  publishSensorData();
  publishStatus();
  
  // Deep sleep
  Serial.printf("Sleeping %d seconds...\n", SLEEP_SECONDS);
  Serial.println("Goodbye!\n");
  deepSleep();
}

void loop() {
  // Nunca se ejecuta con deep sleep
}

// ===== FUNCIONES =====

void connectWiFi() {
  Serial.print("WiFi connecting to ");
  Serial.println(WIFI_SSID);
  
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 40) {
    delay(500);
    Serial.print(".");
    attempts++;
    
    // Watchdog yield para ESP8266
    yield();
  }
  
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\nWiFi OK: %s\n", WiFi.localIP().toString().c_str());
    Serial.printf("RSSI: %d dBm\n", WiFi.RSSI());
  } else {
    Serial.println("\nWiFi FAILED - sleeping");
    deepSleep();
  }
}

bool initBME280() {
  Wire.begin(I2C_SDA, I2C_SCL);
  
  Serial.print("BME280 init...");
  
  if (!bme.begin(BME280_I2C_ADDR, &Wire)) {
    Serial.println("FAILED");
    return false;
  }
  
  Serial.println("OK");
  
  // Configuración low-power
  bme.setSampling(Adafruit_BME280::MODE_FORCED,
                  Adafruit_BME280::SAMPLING_X1,
                  Adafruit_BME280::SAMPLING_X1,
                  Adafruit_BME280::SAMPLING_X1,
                  Adafruit_BME280::FILTER_OFF);
  
  return true;
}

void connectMQTT() {
  int attempts = 0;
  
  while (!mqtt.connected() && attempts < 5) {
    Serial.print("MQTT connecting...");
    
    if (mqtt.connect(MQTT_CLIENT_ID)) {
      Serial.println("OK");
      mqtt.subscribe(MQTT_TOPIC_OTA);
      return;
    }
    
    Serial.printf("FAILED (rc=%d), retry...\n", mqtt.state());
    delay(2000);
    attempts++;
    yield();
  }
  
  if (!mqtt.connected()) {
    Serial.println("MQTT failed - sleeping");
    deepSleep();
  }
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  Serial.printf("MQTT msg received: %s\n", topic);
  // Implementar lógica OTA trigger
}

bool checkOTAMode() {
  // Esperar 3s por mensaje OTA
  unsigned long start = millis();
  while (millis() - start < 3000) {
    mqtt.loop();
    yield();
  }
  
  // Por ahora siempre false
  // Implementar: leer flag desde MQTT
  return false;
}

void handleOTA() {
  Serial.println("\n=== OTA MODE ACTIVE - 2 min ===");
  
  ArduinoOTA.setHostname(OTA_HOSTNAME);
  ArduinoOTA.setPassword(OTA_PASSWORD);
  
  ArduinoOTA.onStart([]() {
    Serial.println("OTA Start");
  });
  
  ArduinoOTA.onEnd([]() {
    Serial.println("\nOTA Complete");
  });
  
  ArduinoOTA.onProgress([](unsigned int progress, unsigned int total) {
    Serial.printf("Progress: %u%%\r", (progress / (total / 100)));
  });
  
  ArduinoOTA.onError([](ota_error_t error) {
    Serial.printf("OTA Error[%u]: ", error);
    if (error == OTA_AUTH_ERROR) Serial.println("Auth Failed");
    else if (error == OTA_BEGIN_ERROR) Serial.println("Begin Failed");
    else if (error == OTA_CONNECT_ERROR) Serial.println("Connect Failed");
    else if (error == OTA_RECEIVE_ERROR) Serial.println("Receive Failed");
    else if (error == OTA_END_ERROR) Serial.println("End Failed");
  });
  
  ArduinoOTA.begin();
  
  // Esperar 2 minutos
  unsigned long otaStart = millis();
  while (millis() - otaStart < OTA_WAIT_MS) {
    ArduinoOTA.handle();
    mqtt.loop();
    yield();
    delay(10);
  }
  
  Serial.println("OTA timeout - continuing");
}

void publishSensorData() {
  bme.takeForcedMeasurement();
  delay(50);  // Esperar medición
  
  float temp = bme.readTemperature();
  float hum = bme.readHumidity();
  float pres = bme.readPressure() / 100.0F;  // hPa
  
  // Validación
  if (isnan(temp) || isnan(hum) || isnan(pres)) {
    Serial.println("ERROR: Invalid sensor readings");
    Serial.printf("T: %.2f, H: %.2f, P: %.2f\n", temp, hum, pres);
    return;
  }
  
  Serial.printf("Sensor readings - T: %.2f°C, H: %.2f%%, P: %.2fhPa\n", 
                temp, hum, pres);
  
  // JSON payload - IMPORTANTE: ESP8266 tiene poca RAM
  StaticJsonDocument<256> doc;
  
  doc["temperature"] = round(temp * 100) / 100.0;
  doc["humidity"] = round(hum * 100) / 100.0;
  doc["pressure"] = round(pres * 100) / 100.0;
  doc["battery_voltage"] = battery.getVoltage();
  doc["boot_count"] = rtcData.bootCount;
  doc["rssi"] = WiFi.RSSI();
  doc["free_heap"] = ESP.getFreeHeap();  // Monitorear RAM
  
  char buffer[256];
  size_t len = serializeJson(doc, buffer);
  
  Serial.printf("Publishing (%d bytes): %s\n", len, buffer);
  
  // Publicar con QoS 1 (garantizar entrega)
  if (mqtt.publish(MQTT_TOPIC_DATA, buffer, true)) {
    Serial.println("MQTT publish OK");
  } else {
    Serial.println("MQTT publish FAILED");
  }
  
  mqtt.loop();
  delay(100);
}

void publishStatus() {
  char status[128];
  snprintf(status, 128, "Boot %d, Heap: %d, RSSI: %d dBm", 
           rtcData.bootCount, ESP.getFreeHeap(), WiFi.RSSI());
  
  mqtt.publish(MQTT_TOPIC_STATUS, status);
  mqtt.loop();
  delay(50);
}

void deepSleep() {
  Serial.println("Entering deep sleep...");
  
  // Desconectar todo
  mqtt.disconnect();
  WiFi.disconnect(true);
  delay(100);
  
  // ESP8266 deep sleep
  // CRÍTICO: Requiere GPIO16 (D0) conectado a RST
  // Al finalizar sleep, GPIO16 envía pulso LOW a RST → reinicia ESP
  ESP.deepSleep(SLEEP_SECONDS * 1000000ULL, WAKE_RF_DEFAULT);
  
  // Después de este comando, ESP8266 duerme
  // Wake up es por RESET, por eso setup() se ejecuta de nuevo
}

// CRC32 para validar RTC memory
uint32_t calculateCRC32(const uint8_t *data, size_t length) {
  uint32_t crc = 0xffffffff;
  while (length--) {
    uint8_t c = *data++;
    for (uint32_t i = 0x80; i > 0; i >>= 1) {
      bool bit = crc & 0x80000000;
      if (c & i) {
        bit = !bit;
      }
      crc <<= 1;
      if (bit) {
        crc ^= 0x04c11db7;
      }
    }
  }
  return crc;
}
```

**Librerías necesarias (Arduino IDE):**
```
- ESP8266WiFi (built-in)
- PubSubClient (by Nick O'Leary)
- ESP8266mDNS (built-in)
- ArduinoOTA (built-in)
- Adafruit BME280 Library
- Adafruit Unified Sensor
- ArduinoJson (by Benoit Blanchon) v6.x
- Wire (built-in)
```

**Board Manager:**
```
File → Preferences → Additional Board Manager URLs:
http://arduino.esp8266.com/stable/package_esp8266com_index.json

Tools → Board → ESP8266 Boards → NodeMCU 1.0 (ESP-12E Module)
Tools → CPU Frequency → 80 MHz
Tools → Flash Size → 4MB (FS:2MB OTA:~1019KB)
Tools → Upload Speed → 115200
```

---

## Instalación Física - Fase 1

### Paso 1: Conexión GPIO16 → RST (CRÍTICO)

**Método A: Jumper Wire (recomendado para testing)**
```
1. Cable dupont M-M
2. D0 (GPIO16) → RST
3. Longitud: 3-5cm
4. Asegurar con cinta adhesiva para que no se desconecte
```

**Método B: Soldar (para instalación permanente)**
```
1. Cable AWG26 delgado
2. Soldar: GPIO16 pad → RST pad en PCB
3. Opcional: resistencia 470Ω en serie (protección)
```

**Verificación:**
```cpp
// Upload este sketch de test
void setup() {
  Serial.begin(115200);
  Serial.println("Testing deep sleep...");
  delay(2000);
  
  Serial.println("Sleeping 10 seconds");
  ESP.deepSleep(10e6);  // 10 segundos
}

void loop() {}

// Si funciona: verás "Testing deep sleep" cada 10s
// Si NO funciona: verás una sola vez y se queda dormido
```

### Paso 2: Conexión BME280

```
NodeMCU   →   BME280
---------------------------
3.3V      →   VCC (o VIN)
GND       →   GND
D2 (GPIO4) →  SDA
D1 (GPIO5) →  SCL
```

### Paso 3: Housing Temporal (DIY)

**Materiales:**
- 3x Platos plásticos blancos hondos (Ø 20cm)
- 1x Plato plano (techo)
- Tuercas M4 + arandelas (separadores 2cm)
- 1x Tupper transparente 15x10cm
- Taladro mecha 5mm

**Construcción:**
```
1. Tupper: 4 agujeros laterales (ventilación) + 1 para cable USB
2. ESP8266 + BME280 dentro del tupper
3. BME280 sensor FUERA (cable I2C 10-15cm), entre platos
4. Apilar platos con 2cm separación
5. Plato superior: techo anti-radiación
6. Sellar cable USB con silicona
```

**Limitaciones:**
- Error esperado: +2 a +3°C vs temperatura real en días soleados
- Condensación interna posible
- Aceptable para Fase 1, reemplazar en Fase 2

---

## N8N Workflows

(Idénticos al documento anterior - sin cambios)

---

## Grafana Dashboard

(Idéntico - agregar panel "Free Heap" para monitorear RAM del ESP8266)

**Panel adicional para ESP8266:**

```flux
// Free Heap (RAM disponible)
from(bucket: "weather")
  |> range(start: -24h)
  |> filter(fn: (r) => r._measurement == "outdoor")
  |> filter(fn: (r) => r._field == "free_heap")
```

**Threshold alerts:**
- Red: <10KB (crítico - puede crashear)
- Yellow: 10-20KB (bajo)
- Green: >20KB (normal)

---

## Cronograma de Implementación

### Semana 1: Setup y Testing

**Día 1-2: Hardware**
- [ ] Soldar/conectar GPIO16 → RST
- [ ] Test deep sleep (10s cycles)
- [ ] Conectar BME280
- [ ] Test lecturas sensor

**Día 3-4: Software**
- [ ] Upload código ESP8266
- [ ] Verificar WiFi + MQTT
- [ ] Test deep sleep 5min cycles
- [ ] Monitorear free_heap

**Día 5-7: Raspberry Pi**
- [ ] Instalar Mosquitto, InfluxDB, Grafana
- [ ] Configurar N8N workflow
- [ ] Dashboard básico
- [ ] Test 24h indoor

### Semana 2: Housing y Outdoor Testing

**Día 8-10: Housing**
- [ ] Construir radiation shield DIY
- [ ] Instalar poste jardín (2m)
- [ ] Cable USB routing
- [ ] Weatherproofing básico

**Día 11-12: OTA**
- [ ] Implementar OTA workflow
- [ ] Test update remoto
- [ ] Documentar proceso

**Día 13-14: Outdoor Testing**
- [ ] Instalar en jardín
- [ ] Comparar vs app meteorológica
- [ ] Ajustar ubicación

### Semana 3: Estabilización

**Día 15-17: N8N Features**
- [ ] Alertas Telegram
- [ ] Reportes email
- [ ] Backup automático

**Día 18-19: Dashboard Pro**
- [ ] Paneles avanzados
- [ ] Alarmas Grafana
- [ ] Mobile layout

**Día 20-21: Testing 7 Días**
- [ ] Operación continua sin intervención
- [ ] Log analysis
- [ ] **Documentar consumo energético para Fase 2**
- [ ] **Preparar migración a ESP32**

---

## Criterios de Éxito Fase 1

### Obligatorios

1. **Uptime**: 7 días sin gaps >10 minutos ✅
2. **Precisión**: Temperatura ±3°C vs referencia ✅
3. **Deep Sleep**: Funcional (GPIO16→RST) ✅
4. **OTA**: Update remoto exitoso ✅
5. **Backup**: Funcionando automáticamente ✅

### Deseables

- Dashboard mobile-friendly ⭐
- Alertas Telegram funcionales ⭐
- **Consumo medido y documentado** ⭐ (crítico para Fase 2)
- Housing DIY resistiendo 1 semana ⭐

---

## Preparación para Migración a ESP32 (Fase 2)

### Durante Fase 1: Documentar

1. **Consumo Energético**
   ```
   - Medir con multímetro:
     * Active mode: ~XXX mA
     * Sleep mode: ~XXX mA (esperado 8-12mA)
   - Calcular: mAh/día total
   - Esto es baseline para comparar con ESP32
   ```

2. **Issues Encontrados**
   ```
   - Problemas WiFi reconnect?
   - Out of memory warnings?
   - MQTT disconnects?
   - Documentar para evitar en ESP32
   ```

3. **Código a Migrar**
   ```
   - Listar funciones que cambiarán:
     * ESP8266WiFi → WiFi (ESP32)
     * ESP.deepSleep() → esp_deep_sleep_start()
     * rtcUserMemory → RTC_DATA_ATTR
   - ~20% del código necesita ajustes
   ```

### Al Final de Fase 1

**Checklist para Fase 2:**
- [ ] FireBeetle ESP32 ha llegado
- [ ] Batería LiPo 2500mAh adquirida
- [ ] Panel solar 6W adquirido
- [ ] Radiation shield comercial adquirido
- [ ] Código migración ESP32 planificado
- [ ] Consumo ESP8266 documentado (baseline)

---

## Troubleshooting Específico ESP8266

### Problema: ESP8266 no despierta de deep sleep

**Síntomas:**
- Bootea una vez
- Serial log: "Sleeping..."
- Silencio total (no despierta más)

**Causa #1: GPIO16 no conectado a RST**
```
Solución: Verificar jumper D0 → RST físicamente presente
Test: Quitar jumper → presionar RST manual → debería bootear
```

**Causa #2: Jumper mal soldado/flojo**
```
Solución: Resoldar o usar cable dupont firme
Test: Medir continuidad con multímetro
```

---

### Problema: Out of Memory / Crash

**Síntomas:**
- ESP8266 se resetea espontáneamente
- Serial: "Fatal exception" o "Out of memory"
- free_heap <5KB

**Diagnóstico:**
```cpp
Serial.printf("Free heap: %d\n", ESP.getFreeHeap());

// Si <10KB: problema
```

**Soluciones:**
1. Reducir tamaño JSON:
   ```cpp
   StaticJsonDocument<192> doc;  // Era 256
   // Eliminar campos no esenciales
   ```

2. No usar String, usar char[]:
   ```cpp
   // MAL:
   String topic = "weather/" + String(ID);
   
   // BIEN:
   char topic[32];
   snprintf(topic, 32, "weather/%d", ID);
   ```

3. Evitar print largo:
   ```cpp
   // MAL:
   Serial.println("Very long debug message with lots of text...");
   
   // BIEN:
   Serial.println("Debug OK");
   ```

---

### Problema: WiFi no conecta o muy lento

**Síntomas:**
- WiFi timeout (>20 segundos)
- RSSI muy bajo (<-80 dBm)

**Soluciones:**
```cpp
// 1. Forzar WiFi a channel específico (más rápido)
WiFi.begin(SSID, PASSWORD, CHANNEL);  // Ej: CHANNEL = 6

// 2. Reducir power (si está muy cerca del router)
WiFi.setOutputPower(15);  // default 20.5 dBm

// 3. Static IP (evita DHCP delay)
IPAddress local_IP(192, 168, 1, 50);
IPAddress gateway(192, 168, 1, 1);
IPAddress subnet(255, 255, 255, 0);
WiFi.config(local_IP, gateway, subnet);
```

---

## Métricas Clave ESP8266 vs ESP32

**Documentar al final de Fase 1:**

| Métrica | ESP8266 (medido) | ESP32 Target (Fase 2) | Mejora Esperada |
|---------|------------------|------------------------|-----------------|
| Deep sleep current | ___ mA | <0.05 mA | ~100-200x |
| WiFi connect time | ___ s | ~1-2s | ~2x |
| Active time/cycle | ___ s | ~15-20s | ~1.5x |
| Daily consumption | ___ mAh | ~250 mAh | ~4-5x |
| Free RAM available | ~40-60 KB | ~300-400 KB | ~6x |
| Autonomía batería 2500mAh | N/A | ~10 días | - |

---

## Anexo: Diferencias de Código ESP8266 vs ESP32

**Para facilitar migración en Fase 2:**

| Función | ESP8266 | ESP32 | Notas |
|---------|---------|-------|-------|
| **Include WiFi** | `<ESP8266WiFi.h>` | `<WiFi.h>` | - |
| **Include mDNS** | `<ESP8266mDNS.h>` | `<ESPmDNS.h>` | - |
| **Deep Sleep** | `ESP.deepSleep(us)` | `esp_deep_sleep_start()` + `esp_sleep_enable_timer_wakeup(us)` | ESP32 más verboso |
| **RTC Memory** | `ESP.rtcUserMemoryRead/Write()` | `RTC_DATA_ATTR` variable | ESP32 más simple |
| **Free Heap** | `ESP.getFreeHeap()` | `ESP.getFreeHeap()` | Idéntico ✅ |
| **Chip ID** | `ESP.getChipId()` | `ESP.getEfuseMac()` | Diferente formato |
| **Reset Reason** | `ESP.getResetReason()` | `esp_reset_reason()` | Return type diferente |
| **Watchdog** | `yield()` obligatorio | Opcional (dual core) | - |
| **Deep Sleep Wake** | GPIO16 → RST (hardware) | Solo software | ESP32 más simple ✅ |

---

## Apéndice: Compra FireBeetle ESP32

**COMPRAR AHORA (semana 1 de Fase 1) para que llegue a tiempo en Fase 2:**

**Producto**: DFRobot FireBeetle ESP32

**Especificaciones clave:**
- ESP32-WROOM-32 (mismo chip)
- Consumo deep sleep: 10-50µA (vs 8-12mA NodeMCU)
- Cargador LiPo integrado (TP4056)
- JST connector para batería
- Interruptor power
- USB-C (algunos modelos)

**Dónde comprar:**

1. **AliExpress** (~USD 10-12, envío 2-3 semanas)
   - Buscar: "DFRobot FireBeetle ESP32"
   - Seller recomendado: "DFRobot Official Store"

2. **Amazon.com** (~USD 18-20, 1 semana)
   - Más caro pero llega rápido

**Verificar al comprar:**
- ✅ JST connector para batería
- ✅ LED indicador carga
- ✅ Interruptor on/off
- ✅ Pines compatibles con breadboard

---

## Referencias

### Documentación Técnica ESP8266
- [ESP8266 Arduino Core](https://github.com/esp8266/Arduino)
- [ESP8266 Deep Sleep](https://github.com/esp8266/Arduino/blob/master/libraries/esp8266/examples/DeepSleep/)
- [NodeMCU Pinout](https://github.com/nodemcu/nodemcu-devkit-v1.0)

### Librerías
- [Adafruit BME280](https://github.com/adafruit/Adafruit_BME280_Library)
- [PubSubClient MQTT](https://pubsubclient.knolleary.net/)
- [ArduinoJson v6](https://arduinojson.org/)

### Migración ESP8266 → ESP32
- [ESP8266 vs ESP32 Comparison](https://randomnerdtutorials.com/esp32-vs-esp8266-differences/)
- [Porting Guide ESP8266 to ESP32](https://docs.espressif.com/projects/esp-idf/en/latest/esp32/migration-guides/index.html)

---

## Changelog

| Versión | Fecha | Cambios |
|---------|-------|---------|
| 1.0 | 2024-12-13 | Documento inicial - ESP8266 específico |

---

**Documento preparado por**: Mau  
**Hardware**: NodeMCU ESP8266 (Fase 1) → FireBeetle ESP32 (Fase 2)  
**Última actualización**: 2024-12-13  
**Próxima revisión**: Al completar Fase 1
