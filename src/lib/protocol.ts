export type AlertKind =
  | 'hatch'
  | 'lockdown'
  | 'hum_high'
  | 'hum_low'
  | 'temp_high'
  | 'temp_low'
  | 'disconnected'
  | 'info';

export interface Telemetry {
  ts: number;
  humidity: number | null;
  temperature: number | null;
  battery: number | null;
  state: string | null;
  raw: Record<string, string | number>;
}

export interface AlertEvent {
  id: string;
  ts: number;
  kind: AlertKind;
  message: string;
  value?: number;
}

const STATE_KEYS = ['STATE', 'MODE', 'FASE', 'PHASE', 'ESTADO'];
const NUM_KEYS: Record<string, 'humidity' | 'temperature' | 'battery'> = {
  HUM: 'humidity',
  HUMEDAD: 'humidity',
  HUMIDITY: 'humidity',
  RH: 'humidity',
  HR: 'humidity',
  TEMP: 'temperature',
  TEMP_C: 'temperature',
  TEMPERATURA: 'temperature',
  TEMPERATURA_C: 'temperature',
  T: 'temperature',
  BAT: 'battery',
  BATT: 'battery',
  BATTERY: 'battery',
};

export const SAFE_TEMP_LOW = 36;
export const SAFE_TEMP_HIGH = 38.5;

function toNumber(value: string): number | null {
  const n = Number.parseFloat(value.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function emptyTelemetry(ts = Date.now()): Telemetry {
  return { ts, humidity: null, temperature: null, battery: null, state: null, raw: {} };
}

/**
 * Acepta los tres formatos habituales:
 *   HUM:64.2,TEMP:37.5                     (canónico, separado por comas)
 *   Temp: 37.5 C | Humedad: 65.0 %         (texto libre con unidades)
 *   {"hum":64.2,"temp":37.5}               (JSON, se resuelve antes)
 */
const PAIR_RE =
  /([A-Za-zÁÉÍÓÚáéíóúñÑ_]{2,})\s*[:=]\s*([^,;|]+?(?=\s*[,;|]|\s+[A-Za-zÁÉÍÓÚáéíóúñÑ_]{2,}\s*[:=]|$))/g;

function readPairs(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of line.matchAll(PAIR_RE)) {
    const key = match[1].trim().toUpperCase();
    const value = match[2].replace(/[|%]+$/, '').trim();
    if (key && value) out[key] = value;
  }
  return out;
}

function fromPairs(pairs: Record<string, string>, ts = Date.now()): Telemetry {
  const t = emptyTelemetry(ts);
  for (const [key, value] of Object.entries(pairs)) {
    t.raw[key] = value;
    const target = NUM_KEYS[key];
    if (target) {
      const n = toNumber(value);
      if (n !== null) t[target] = n;
    } else if (STATE_KEYS.includes(key)) {
      t.state = value.toUpperCase();
    }
  }
  return t;
}

export const ALERT_ALIASES: Record<string, AlertKind> = {
  HATCH: 'hatch',
  ECOLOSION: 'hatch',
  ECLOSION: 'hatch',
  LOCKDOWN: 'lockdown',
  BLOQUEO: 'lockdown',
  HUM_HIGH: 'hum_high',
  HUMEDAD_ALTA: 'hum_high',
  HUM_LOW: 'hum_low',
  HUMEDAD_BAJA: 'hum_low',
  TEMP_HIGH: 'temp_high',
  TEMP_ALTA: 'temp_high',
  TEMPERATURA_ALTA: 'temp_high',
  TEMP_LOW: 'temp_low',
  TEMP_BAJA: 'temp_low',
  TEMPERATURA_BAJA: 'temp_low',
};

export const ALERT_LABELS: Record<AlertKind, string> = {
  hatch: 'HATCH · Eclosión',
  lockdown: 'LOCKDOWN · Bloqueo',
  hum_high: 'Humedad alta',
  hum_low: 'Humedad baja',
  temp_high: 'Temperatura alta',
  temp_low: 'Temperatura baja',
  disconnected: 'Conexión perdida',
  info: 'Aviso',
};

export const ALERT_SEVERITY: Record<AlertKind, 'critical' | 'warning' | 'info'> = {
  hatch: 'critical',
  lockdown: 'warning',
  hum_high: 'warning',
  hum_low: 'warning',
  temp_high: 'critical',
  temp_low: 'critical',
  disconnected: 'critical',
  info: 'info',
};

const ALERT_TEXT = /alerta|alarma|fuera de rango|urgente|emergency/i;

/**
 * Traduce frases libres del firmware (p. ej. "¡ALERTA! Humedad baja…")
 * a un tipo de alerta conocido. `lastTemperature` permite deducir si la
 * temperatura se salió por arriba o por abajo cuando el mensaje no lo dice.
 */
export function inferTextAlert(
  text: string,
  lastTemperature?: number | null,
): { kind: AlertKind; message: string; value?: number } | null {
  const t = text.trim();
  const lower = t.toLowerCase();

  if (ALERT_TEXT.test(t)) {
    if (/humedad|humidity|\bhr\b/.test(lower)) {
      if (/\bbaja\b|bajo|menor|falta|low/.test(lower)) return { kind: 'hum_low', message: t };
      if (/\balta\b|alto|mayor|exces|high/.test(lower)) return { kind: 'hum_high', message: t };
      return { kind: 'info', message: t };
    }
    if (/temperatura|temperature|\btemp\b/.test(lower)) {
      if (typeof lastTemperature === 'number') {
        if (lastTemperature > SAFE_TEMP_HIGH) return { kind: 'temp_high', message: t, value: lastTemperature };
        if (lastTemperature < SAFE_TEMP_LOW) return { kind: 'temp_low', message: t, value: lastTemperature };
        return { kind: lastTemperature >= 37.5 ? 'temp_high' : 'temp_low', message: t, value: lastTemperature };
      }
      return { kind: 'info', message: t };
    }
    return { kind: 'info', message: t };
  }

  if (/\blockdown\b|bloqueo/i.test(t)) return { kind: 'lockdown', message: t };
  if (/\bhatch\b|eclosi/i.test(t)) return { kind: 'hatch', message: t };
  return null;
}

export interface ParseResult {
  telemetry?: Telemetry;
  alert?: { kind: AlertKind; message: string; value?: number };
  text?: string;
}

function parseAlert(kind: AlertKind, message: string, value?: number): ParseResult {
  return { alert: { kind, message, value } };
}

function withStateCheck(t: Telemetry): ParseResult {
  const kind = t.state ? ALERT_ALIASES[t.state] : undefined;
  if (kind === 'hatch' || kind === 'lockdown') {
    return { telemetry: t, alert: { kind, message: ALERT_LABELS[kind] } };
  }
  return { telemetry: t };
}

/** Si la línea no aporta ningún dato conocido, se trata como texto libre. */
function finish(t: Telemetry, line: string): ParseResult {
  const hasData =
    t.humidity !== null || t.temperature !== null || t.battery !== null || t.state !== null;
  if (!hasData) return { text: line };
  return withStateCheck(t);
}

export function parseLine(rawLine: string): ParseResult | null {
  const line = rawLine.replace(/\r/g, '').trim();
  if (!line) return null;

  if (line.startsWith('{')) {
    try {
      const json = JSON.parse(line) as Record<string, unknown>;
      const pairs: Record<string, string> = {};
      for (const [k, v] of Object.entries(json)) {
        if (v !== null && v !== undefined) pairs[k.toUpperCase()] = String(v);
      }
      if (pairs.ALERT !== undefined) {
        const kind = ALERT_ALIASES[pairs.ALERT.toUpperCase()] ?? 'info';
        return parseAlert(kind, pairs.MSG ?? pairs.MESSAGE ?? ALERT_LABELS[kind]);
      }
      return finish(fromPairs(pairs), line);
    } catch {
      return { text: line };
    }
  }

  const pairs = readPairs(line);

  if (pairs.ALERT !== undefined) {
    const code = pairs.ALERT.toUpperCase();
    const kind = ALERT_ALIASES[code] ?? 'info';
    const value = pairs.VALUE !== undefined ? (toNumber(pairs.VALUE) ?? undefined) : undefined;
    const message = pairs.MSG ?? pairs.MESSAGE ?? ALERT_LABELS[kind];
    return parseAlert(kind, message, value);
  }

  if (Object.keys(pairs).length === 0) return { text: line };

  return finish(fromPairs(pairs), line);
}
