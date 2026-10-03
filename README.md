# Incubadora · Alertas Bluetooth

App React (Vite) que recibe alertas de tu módulo Bluetooth y las muestra con alarmas sonoras,
parpadeo visual, gráficas en vivo y registro de eventos.

Fase de uso: **Lockdown / Hatch**.

Soporta **dos transportes** en la misma app:

| Transport | Módulo | API | Dónde funciona |
| --- | --- | --- | --- |
| **Bluetooth LE** | ESP32, HM-10, JDY-08 | Web Bluetooth | Móvil y escritorio (Chrome/Opera) |
| **Puerto serie** | **HC-05** | Web Serial | Escritorio (USB/COM) y **Android 138+** (Bluetooth emparejado) |

---

## 1. Requisitos de navegador

| Navegador | Web Bluetooth | Web Serial |
| --- | --- | --- |
| Chrome escritorio / Opera | ✅ | ✅ |
| Chrome Android 138+ | ✅ | ✅ (Bluetooth clásico / SPP) |
| Chrome Android < 138 | ✅ | ❌ |
| Safari (iOS/macOS) | ❌ | ❌ |
| Firefox | ❌ | ❌ |

Ambas APIs requieren **HTTPS**. Vercel lo cumple automáticamente.

> **Sobre el HC-05:** usa Bluetooth *Clásico* (SPP), incompatible con Web Bluetooth.
> La app lo cubre con **Web Serial**:
>
> - **Escritorio:** el HC-05 se ve como un **puerto COM** (dongle USB o adaptador CH340/FT232).
> - **Android 138+:** Chrome lista los **dispositivos Bluetooth ya emparejados** y abre el SPP del HC-05
>   directamente desde el navegador (el baudaje se ignora en Bluetooth).
> - **iPhone:** no hay soporte (Safari no expone Web Serial ni Web Bluetooth).

---

## 2. Conectar el HC-05 (modo serie)

Dos montajes válidos:

**A) Inalámbrico (HC-05 ↔ HC-05 USB dongle)**
```
[Arduino + HC-05] ~~Bluetooth clásico~~ [dongle HC-05 USB en el PC] → puerto COM
```

**B) Cableado (HC-05 directo al PC)**
```
HC-05 TX/RX → adaptador USB-TTL (CH340/FT232) → puerto COM
```

Pasos en la app (escritorio):

1. Abre la app en **Chrome/Opera de escritorio**.
2. Pulsa **Conectar Serie**, elige el puerto COM del HC-05.
3. Selecciona **9600 baudios** (valor de fábrica del HC-05). Si lo cambiaste con AT, usa ese.
4. Ya llegan líneas: `HUM:…,TEMP:…,STATE:…`.

> Web Serial recuerda el último baudaje usado (`localStorage`).

---

## 2b. Conectar el HC-05 desde un teléfono (Android)

Funciona con **Chrome 138 o superior** en Android, sin instalar nada:

1. **Empareja** el HC-05 en *Ajustes → Bluetooth* (PIN `1234` o `0000`). Chrome solo lista
   los dispositivos ya emparejados.
2. Abre la URL de la app (HTTPS) en Chrome y pulsa **Conectar Serie**.
3. Elige tu módulo en el selector. En el panel aparece como `Bluetooth · RFCOMM (SPP)`.
4. El baudaje no importa en Bluetooth; déjalo en `9600`.

Notas:

- El HC-05 admite **una sola conexión**: no puede estar emparejado a la vez con el PC y la app.
- Si el enlace cae y el navegador no avisa (en Android no siempre llega el evento `disconnect`),
  la app lo detecta sola: avisa a los **6 s sin datos** y a los **15 s** lanza la alerta
  *Conexión perdida*.
- En iPhone no funciona (Safari no expone Web Serial). Alternativas: ESP32/HM-10 por BLE, o el PC.

---

## 3. Conectar por Bluetooth LE

1. Abre la app en Chrome (Android o escritorio).
2. Pulsa **Conectar Bluetooth** y elige tu dispositivo.
3. Perfiles disponibles: **Nordic UART** (ESP32) y **HM-10/JDY-08**.

---

## 4. Ejecutar en local

```bash
npm install
npm run dev
```

## 5. Desplegar en Vercel

1. Sube la carpeta a un repositorio de GitHub.
2. En Vercel → **Add New → Project** → importa el repo.
3. Vercel detecta Vite solo; deja los valores por defecto:
   - Build Command: `npm run build`
   - Output Directory: `dist`
4. **Deploy**. Abre la URL y pulsa **Conectar Bluetooth** o **Conectar Serie**.

También puedes usar el CLI:

```bash
npm i -g vercel
vercel --prod
```

---

## 6. Protocolo de datos (texto por línea)

El módulo envía líneas UTF-8 terminadas en `\n` (o `\r\n`). Se aceptan **tres formatos**:

```
HUM:64.2,TEMP:37.50,BAT:92,STATE:LOCKDOWN      <- canónico (recomendado)
Temp: 37.5 C | Humedad: 65.0 %                 <- texto libre con unidades
{"hum":64.2,"temp":37.5,"state":"HATCH"}       <- JSON
ALERT:HATCH,VALUE:70.1
¡ALERTA! Humedad baja. Agrega agua urgente.    <- frases libres del firmware
```

| Clave | Significado |
| --- | --- |
| `HUM` / `HUMEDAD` / `RH` / `HR` | Humedad relativa (%) → gráfica + umbrales |
| `TEMP` / `TEMPERATURA` / `TEMP_C` | Temperatura (°C) → gráfica |
| `BAT` / `BATTERY` | Batería (%) |
| `STATE` / `MODE` / `FASE` / `ESTADO` | Estado: `IDLE`, `LOCKDOWN`, `HATCH` |
| `ALERT` | Código de alerta: `HATCH`, `LOCKDOWN`, `HUM_HIGH`, `HUM_LOW`, `TEMP_HIGH`, `TEMP_LOW` |
| `MSG` / `MESSAGE` | Texto libre de la alerta |

Las frases en español ("¡ALERTA! Humedad baja…", "Modo Lockdown Iniciada") se interpretan
solas; para la temperatura se usa la última lectura para saber si se salió por arriba o por abajo.

**Depuración:** la tarjeta *Estado* incluye un desplegable **«Últimas líneas recibidas»** con
los bytes crudos que llegan del módulo, y un campo **«Pega una línea para probar el parser»**
— la primera comprobación si algo no aparece.

### Alertas que dispara la app

| Alerta | Origen | Comportamiento |
| --- | --- | --- |
| **Humedad fuera de rango** | Umbral configurable + histéresis (app y firmware) | Aviso sonoro y visual hasta volver a rango |
| **Temperatura fuera de rango** | `ALERT:TEMP_HIGH/LOW` o frase "¡ALERTA! Temperatura…" | Crítica; se limpia al volver a 36–38.5 °C |
| **LOCKDOWN / HATCH** | Línea `ALERT:...`, `STATE:HATCH` o frase libre | Hasta pulsar **Reconocer** |
| **Conexión perdida** | `gattserverdisconnected`, cierre del puerto serie o **15 s sin líneas** (vigía) | Crítico; se limpia al reconectar |
| **Silencio / Reconocer** | Usuario | `Reconocer` calla la alerta actual sin borrar el registro |

Umbrales por defecto: **65–85 % HR** con histéresis de 2 (ajustables en la tarjeta
*Ajustes y umbrales*). El baudaje y los umbrales se guardan en `localStorage`.
Cambiar un umbral **rearma** la alerta de humedad y la evalúa al instante con la
última lectura, sin esperar a la siguiente línea del módulo.

---

## 7. Comandos (app → módulo)

Campo **Comando** de la app (o Monitor Serie a 115200 en el ESP32):

| Comando | Acción |
| --- | --- |
| `HATCH` | Latchea fase de eclosión y emite `ALERT:HATCH` |
| `LOCKDOWN` | Latchea fase de bloqueo y emite `ALERT:LOCKDOWN` |
| `IDLE` / `ACK` | Limpia estados y reactiva alarmas (`OK:ACK`) |
| `RATE:1000` | Intervalo de telemetria en ms (250–60000) — ESP32 |
| `HUM:55-75` | Umbrales de humedad (`HMIN:` / `HMAX:`) — ESP32 |
| `PING` | Responde `OK:PONG` |

---

## 8. Firmware

**`firmware/incubator_ble/incubator_ble.ino`** — ESP32 + BLE (Nordic UART).

- Pin DHT22: `GPIO 4` (`#define USE_DHT 0` si no hay sensor; genera valores simulados).
- LED de estado: `GPIO 2`.
- Batería (opcional): divisor en `GPIO 34`, pon `#define BATTERY_PIN -1` si no existe.
- Nombre BLE anunciado: `Incubadora-HC`.

**`firmware/incubator_hc05/incubator_hc05.ino`** — Arduino Uno/Nano + HC-05
(basado en tu sketch: relé del foco, DHT11 y aviso de humedad baja).

- `SoftwareSerial BT(2, 3)`: `D2` ← TX del HC-05, `D3` → RX del HC-05.
- DHT11 en `D4` (cambia `DHTTYPE` a `DHT22` si el sensor es negro).
- Relé (foco) en `D7`, control con `TEMP_OBJETIVO 37.5` e histéresis `0.3`.
- Baud del HC-05: **9600** — elige 9600 en la app.
- Envía `HUM:…,TEMP:…,STATE:…` cada 2 s y `ALERT:HUM_LOW/TEMP_HIGH/TEMP_LOW` cuando
  toca; por el Monitor Serie imprime además el mensaje en español.

---

## 9. Estructura

```
src/
  App.tsx                  panel, estado, umbrales, comandos
  components/              Sparkline, AlertBanner, EventLog
  lib/link.ts              interfaz de transporte + ensamblador de líneas
  lib/bluetooth.ts         transporte BLE (NUS / HM-10)
  lib/serial.ts            transporte Web Serial (HC-05 por COM en PC o Bluetooth en Android)
  lib/protocol.ts          parser de líneas y catálogo de alertas
  lib/audio.ts             alarmas sintetizadas con Web Audio API
  lib/thresholds.ts        umbrales con persistencia local
  lib/simulator.ts         modo Demo (sin hardware)
firmware/incubator_ble/    sketch ESP32 (BLE)
firmware/incubator_hc05/   sketch Arduino + HC-05 (serie)
```
