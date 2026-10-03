/*
 * Incubadora · Alertas Bluetooth (ESP32 + Web Bluetooth)
 * -------------------------------------------------------
 * Publica un servicio UART tipo Nordic (NUS) para que la app React
 * reciba lineas de texto como:
 *
 *   HUM:64.2,TEMP:37.50,BAT:92,STATE:LOCKDOWN
 *   ALERT:HATCH,VALUE:70.1
 *
 * Servicio : 6e400001-b5a3-f393-e0a9-e50e24dcca9e
 *  RX (app -> placa) : 6e400002-...   (escribir comandos)
 *  TX (placa -> app) : 6e400003-...   (notificar telemetria)
 *
 * Comandos UART entrantes (por BLE RX o por Monitor Serie):
 *   HATCH        -> emite ALERT:HATCH
 *   LOCKDOWN     -> emite ALERT:LOCKDOWN
 *   ACK          -> confirma y reactiva alarmas locales
 *   RATE:1000    -> intervalo de telemetria en ms
 *   HUM:55-75    -> umbrales de humedad (tambien con HMIN / HMAX)
 */

#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

// Pon a 0 si no tienes DHT22: se usan valores simulados para probar el BLE.
#define USE_DHT 1
#if USE_DHT
#include <DHT.h>
#define DHT_PIN 4
#define DHT_TYPE DHT22
DHT dht(DHT_PIN, DHT_TYPE);
#endif

#define BATTERY_PIN 34   // divisor 100k/100k a VBAT; -1 si no existe
#define STATUS_LED 2

static const char* SERVICE_UUID     = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
static const char* CHAR_RX_UUID     = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
static const char* CHAR_TX_UUID     = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";

BLEServer*         server        = nullptr;
BLECharacteristic* txCharacteristic = nullptr;
BLECharacteristic* rxCharacteristic = nullptr;

volatile bool deviceConnected    = false;
volatile bool oldDeviceConnected = false;

unsigned long lastSample   = 0;
unsigned long samplePeriod = 1500;   // ms entre lineas de telemetria

float humidity    = 65.0;
float temperature = 37.5;
float humMin      = 55.0;
float humMax      = 75.0;
const float HUM_HYSTERESIS = 2.0;

bool humOutOfRange   = false;
bool hatchLatched    = false;
bool lockdownLatched = false;

// ------------------------------------------------------------------ utilidades

String two(float v, uint8_t decimals) {
  // Siempre con punto decimal: la app separa los campos por comas.
  return String(v, decimals);
}

float readHumidity() {
#if USE_DHT
  float h = dht.readHumidity();
  if (!isnan(h)) return h;
#endif
  // Sin sensor: deriva lenta para poder validar el enlace BLE.
  return 64.0f + 6.0f * sin(millis() / 12000.0f);
}

float readTemperature() {
#if USE_DHT
  float t = dht.readTemperature();
  if (!isnan(t)) return t;
#endif
  return 37.5f + 0.6f * sin(millis() / 9000.0f);
}

int readBatteryPercent() {
  if (BATTERY_PIN < 0) return -1;
  int raw = analogRead(BATTERY_PIN);
  float voltage = (raw / 4095.0f) * 3.3f * 2.0f;   // divisor 1:1
  int pct = (int)constrain((voltage - 3.3f) / (4.2f - 3.3f) * 100.0f, 0, 100);
  return pct;
}

const char* currentState() {
  if (hatchLatched) return "HATCH";
  if (lockdownLatched) return "LOCKDOWN";
  return "IDLE";
}

// --------------------------------------------------------------- transmision

void notifyLine(const String& line) {
  if (!deviceConnected || txCharacteristic == nullptr) return;

  // Respeta el MTU negociado: envia la linea en trozos de 100 bytes.
  const size_t CHUNK = 100;
  for (size_t i = 0; i < line.length(); i += CHUNK) {
    String part = line.substring(i, i + CHUNK);
    txCharacteristic->setValue(part.c_str());
    txCharacteristic->notify();
    delay(18);
  }
}

void sendTelemetry() {
  humidity    = readHumidity();
  temperature = readTemperature();
  int bat     = readBatteryPercent();

  String line = "HUM:" + two(humidity, 1) +
                ",TEMP:" + two(temperature, 2);
  if (bat >= 0) line += ",BAT:" + String(bat);
  line += ",STATE:" + String(currentState());
  notifyLine(line);

  if (humidity > humMax + HUM_HYSTERESIS) {
    if (!humOutOfRange) {
      humOutOfRange = true;
      notifyLine("ALERT:HUM_HIGH,VALUE:" + two(humidity, 1));
    }
  } else if (humidity < humMin - HUM_HYSTERESIS) {
    if (!humOutOfRange) {
      humOutOfRange = true;
      notifyLine("ALERT:HUM_LOW,VALUE:" + two(humidity, 1));
    }
  } else if (humidity > humMin && humidity < humMax) {
    humOutOfRange = false;
  }

  digitalWrite(STATUS_LED, humOutOfRange ? HIGH : LOW);
}

void sendAlert(const char* code, const String& extra = "") {
  notifyLine(String("ALERT:") + code + (extra.length() ? "," + extra : ""));
}

// ------------------------------------------------------------- comandos RX

void handleCommand(String raw) {
  raw.trim();
  raw.toUpperCase();
  if (!raw.length()) return;

  Serial.print("[RX] ");
  Serial.println(raw);

  if (raw == "HATCH") {
    hatchLatched = true;
    lockdownLatched = false;
    sendAlert("HATCH", "VALUE:" + two(humidity, 1));
  } else if (raw == "LOCKDOWN") {
    lockdownLatched = true;
    hatchLatched = false;
    sendAlert("LOCKDOWN");
  } else if (raw == "IDLE" || raw == "ACK") {
    hatchLatched = false;
    lockdownLatched = false;
    humOutOfRange = false;
    notifyLine("OK:ACK");
  } else if (raw.startsWith("RATE:")) {
    long v = raw.substring(5).toInt();
    if (v >= 250 && v <= 60000) {
      samplePeriod = v;
      notifyLine("OK:RATE," + String(samplePeriod));
    }
  } else if (raw.startsWith("HMIN:")) {
    humMin = raw.substring(5).toFloat();
    notifyLine("OK:HMIN," + two(humMin, 1));
  } else if (raw.startsWith("HMAX:")) {
    humMax = raw.substring(5).toFloat();
    notifyLine("OK:HMAX," + two(humMax, 1));
  } else if (raw.startsWith("HUM:")) {
    // HUM:55-75
    int dash = raw.indexOf('-', 4);
    if (dash > 4) {
      humMin = raw.substring(4, dash).toFloat();
      humMax = raw.substring(dash + 1).toFloat();
      notifyLine("OK:HUM," + two(humMin, 1) + "-" + two(humMax, 1));
    }
  } else if (raw == "PING") {
    notifyLine("OK:PONG");
  } else {
    notifyLine("ERR:CMD");
  }
}

// ------------------------------------------------------------------ callbacks

class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer*) override {
    deviceConnected = true;
    Serial.println("[BLE] Cliente conectado");
  }
  void onDisconnect(BLEServer*) override {
    deviceConnected = false;
    Serial.println("[BLE] Cliente desconectado");
  }
};

class RxCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* characteristic) override {
    String value = characteristic->getValue().c_str();
    handleCommand(value);
  }
};

// ---------------------------------------------------------------------- setup

void setup() {
  Serial.begin(115200);
  pinMode(STATUS_LED, OUTPUT);
  digitalWrite(STATUS_LED, LOW);
#if USE_DHT
  dht.begin();
#endif
  if (BATTERY_PIN >= 0) analogReadResolution(12);

  BLEDevice::init("Incubadora-HC");
  BLEDevice::setMTU(247);

  server = BLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());

  BLEService* service = server->createService(SERVICE_UUID);

  txCharacteristic = service->createCharacteristic(
      CHAR_TX_UUID,
      BLECharacteristic::PROPERTY_NOTIFY);
  txCharacteristic->addDescriptor(new BLE2902());

  rxCharacteristic = service->createCharacteristic(
      CHAR_RX_UUID,
      BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_WRITE |
          BLECharacteristic::PROPERTY_WRITE_NR);
  rxCharacteristic->setCallbacks(new RxCallbacks());

  service->start();

  BLEAdvertising* advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(SERVICE_UUID);
  advertising->setScanResponse(true);
  advertising->setMinPreferred(0x06);
  advertising->setMinPreferred(0x12);
  BLEDevice::startAdvertising();

  Serial.println("[BLE] Esperando conexion en Incubadora-HC ...");
}

// ----------------------------------------------------------------------- loop

void loop() {
  if (deviceConnected && millis() - lastSample >= samplePeriod) {
    lastSample = millis();
    sendTelemetry();
  }

  if (!deviceConnected && oldDeviceConnected) {
    delay(400);
    server->startAdvertising();
    Serial.println("[BLE] Reanudando publicidad");
    oldDeviceConnected = deviceConnected;
  }
  if (deviceConnected && !oldDeviceConnected) {
    oldDeviceConnected = deviceConnected;
  }

  while (Serial.available()) {
    handleCommand(Serial.readStringUntil('\n'));
  }
}
