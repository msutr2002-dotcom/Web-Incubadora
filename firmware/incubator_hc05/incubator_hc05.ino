/*
 * Incubadora · Alertas Bluetooth (Arduino + HC-05)
 * ------------------------------------------------
 * Adaptado de tu sketch original: control del foco por relé, DHT11 y aviso de
 * humedad baja. Cambia solo el formato de salida para que la app React lo
 * entienda de forma fiable.
 *
 * Cableado (igual que el tuyo):
 *   SoftwareSerial BT(2, 3);   // D2 <- TX del HC-05, D3 -> RX del HC-05
 *   DHT11 en D4
 *   Relé (foco) en D7
 *
 * Baudios: 9600 (por defecto del HC-05). En la app elige 9600.
 *
 * Lineas que envía por Bluetooth (UTF-8, terminadas en \n):
 *
 *   HUM:65.0,TEMP:37.5,STATE:LOCKDOWN          <- telemetria cada 2 s
 *   ALERT:HUM_LOW,VALUE:64.0                   <- humedad por debajo del mínimo
 *   ALERT:TEMP_HIGH,VALUE:38.9                 <- fuera de rango seguro
 *   ALERT:TEMP_LOW,VALUE:35.5
 *
 * Por el Monitor Serie (USB) imprime el mensaje en español, para depurar.
 *
 * Comandos entrantes (campo "Comando" de la app, o Monitor Serie):
 *   HATCH | LOCKDOWN | IDLE (o ACK) | PING | RATE:2000
 */

#include <SoftwareSerial.h>
#include <DHT.h>

// --- Pines y módulo Bluetooth -------------------------------------------
SoftwareSerial BT(2, 3);        // D2 <- TX del HC-05, D3 -> RX del HC-05
#define BT_BAUD 9600

// --- Sensor ----------------------------------------------------------------
#define DHTPIN 4
#define DHTTYPE DHT11            // DHT11 (azul). Usa DHT22 si tu sensor es negro.
DHT dht(DHTPIN, DHTTYPE);

// --- Relé del foco ---------------------------------------------------------
#define RELAY_FOCO 7

// --- Umbrales ---------------------------------------------------------------
const float TEMP_OBJETIVO = 37.5;
const float HISTESIS = 0.3;        // rango 37.2 °C .. 37.8 °C
const float TEMP_SEGURA_MIN = 36.0;
const float TEMP_SEGURA_MAX = 38.5;
const float HUMEDAD_MINIMA = 65.0; // alarma si la humedad baja de 65 %

unsigned long ultimoEnvio = 0;
unsigned long periodoEnvio = 2000; // ms entre lineas de telemetria

// Fase de la incubadora: IDLE / LOCKDOWN / HATCH
String fase = "LOCKDOWN";

void setup() {
  Serial.begin(9600);
  BT.begin(BT_BAUD);

  pinMode(RELAY_FOCO, OUTPUT);
  digitalWrite(RELAY_FOCO, LOW);   // foco apagado al arrancar

  dht.begin();

  Serial.println(F("Incubadora iniciada con Bluetooth."));
  // Aviso de fase: la app lo reconoce y muestra el aviso de Lockdown.
  BT.println(F("Incubadora en Modo Lockdown Iniciada."));
}

// --- Utilidades ------------------------------------------------------------

String n(float v, uint8_t dec) {
  // Siempre con punto decimal: la app separa los campos por comas.
  return String(v, dec);
}

void enviarLinea(const String& linea) {
  BT.println(linea);
  Serial.println(linea);
}

void enviarAlerta(const char* codigo, float valor) {
  enviarLinea(String("ALERT:") + codigo + ",VALUE:" + n(valor, 1));
}

void enviarTelemetria(float temp, float hum) {
  enviarLinea("HUM:" + n(hum, 1) + ",TEMP:" + n(temp, 1) + ",STATE:" + fase);
}

void manejarComando(String raw) {
  raw.trim();
  raw.toUpperCase();
  if (!raw.length()) return;

  Serial.print(F("[RX] "));
  Serial.println(raw);

  if (raw == "HATCH") {
    fase = "HATCH";
    enviarLinea("OK:HATCH");
  } else if (raw == "LOCKDOWN") {
    fase = "LOCKDOWN";
    enviarLinea("OK:LOCKDOWN");
  } else if (raw == "IDLE" || raw == "ACK") {
    fase = "IDLE";
    enviarLinea("OK:ACK");
  } else if (raw.startsWith("RATE:")) {
    long v = raw.substring(5).toInt();
    if (v >= 500 && v <= 60000) {
      periodoEnvio = v;
      enviarLinea("OK:RATE," + String(periodoEnvio));
    }
  } else if (raw == "PING") {
    enviarLinea("OK:PONG");
  } else {
    enviarLinea("ERR:CMD");
  }
}

// --- Programa principal ------------------------------------------------------

void loop() {
  float temp = dht.readTemperature();
  float hum = dht.readHumidity();

  if (!isnan(temp) && !isnan(hum)) {

    // --- 1. CONTROL DEL FOCO ---
    if (temp < (TEMP_OBJETIVO - HISTESIS)) {
      digitalWrite(RELAY_FOCO, HIGH);   // enciende el foco
    } else if (temp > (TEMP_OBJETIVO + HISTESIS)) {
      digitalWrite(RELAY_FOCO, LOW);    // apaga el foco
    }

    // --- 2. ENVÍO DE DATOS Y ALERTAS (cada 2 s) ---
    if (millis() - ultimoEnvio > periodoEnvio) {

      // Telemetria en formato de la app
      enviarTelemetria(temp, hum);

      // El mismo mensaje en español, solo para el Monitor Serie
      Serial.println("Temp: " + n(temp, 1) + " C | Humedad: " + n(hum, 1) + " %");

      if (hum < HUMEDAD_MINIMA) {
        enviarAlerta("HUM_LOW", hum);
        Serial.println(F("¡ALERTA! Humedad baja. Agrega agua urgente."));
      }

      if (temp > TEMP_SEGURA_MAX) {
        enviarAlerta("TEMP_HIGH", temp);
        Serial.println(F("¡ALERTA! Temperatura alta."));
      } else if (temp < TEMP_SEGURA_MIN) {
        enviarAlerta("TEMP_LOW", temp);
        Serial.println(F("¡ALERTA! Temperatura baja."));
      }

      ultimoEnvio = millis();
    }

  } else {
    Serial.println(F("Error de lectura en el sensor DHT."));
  }

  // --- 3. COMANDOS DESDE LA APP O EL MONITOR SERIE ---
  while (BT.available()) {
    manejarComando(BT.readStringUntil('\n'));
  }
  while (Serial.available()) {
    manejarComando(Serial.readStringUntil('\n'));
  }

  delay(200);
}
