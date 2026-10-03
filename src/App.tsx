import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { AlertBanner } from './components/AlertBanner';
import { EventLog } from './components/EventLog';
import { Sparkline, type ChartPoint } from './components/Sparkline';
import { AlarmSound } from './lib/audio';
import { BleLink, SERVICE_PRESETS, isWebBluetoothSupported, type BleStatus } from './lib/bluetooth';
import type { Link } from './lib/link';
import {
  parseLine,
  inferTextAlert,
  SAFE_TEMP_LOW,
  SAFE_TEMP_HIGH,
  type AlertEvent,
  type AlertKind,
  type Telemetry,
} from './lib/protocol';
import { SerialLink, isWebSerialSupported } from './lib/serial';
import { Simulator } from './lib/simulator';
import { DEFAULT_THRESHOLDS, inRange, loadThresholds, saveThresholds, type Thresholds } from './lib/thresholds';

type Source = 'none' | 'bt' | 'serial' | 'demo';

const MAX_POINTS = 90;
const MAX_EVENTS = 150;

function uid(): string {
  const c = crypto as Crypto & { randomUUID?: () => string };
  return c.randomUUID ? c.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function clockOf(ts: number): string {
  return new Date(ts).toLocaleTimeString('es-ES', { hour12: false });
}

export default function App() {
  const [status, setStatus] = useState<BleStatus>('idle');
  const [statusDetail, setStatusDetail] = useState<string | undefined>();
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const [source, setSource] = useState<Source>('none');
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null);
  const [rawLines, setRawLines] = useState<{ ts: number; text: string }[]>([]);
  const [humSeries, setHumSeries] = useState<ChartPoint[]>([]);
  const [tempSeries, setTempSeries] = useState<ChartPoint[]>([]);
  const [events, setEvents] = useState<AlertEvent[]>([]);
  const [activeAlert, setActiveAlert] = useState<AlertEvent | null>(null);
  const [muted, setMuted] = useState(false);
  const [thresholds, setThresholds] = useState<Thresholds>(() => loadThresholds());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [command, setCommand] = useState('');
  const [probeLine, setProbeLine] = useState('');
  const [presets, setPresets] = useState<string[]>(SERVICE_PRESETS.map((p) => p.id));
  const [baudRate, setBaudRate] = useState<number>(() => {
    try {
      return Number(localStorage.getItem('incubator.baud')) || 9600;
    } catch {
      return 115200;
    }
  });

  const updateBaud = useCallback((value: number) => {
    setBaudRate(value);
    try {
      localStorage.setItem('incubator.baud', String(value));
    } catch {
      /* storage disabled */
    }
  }, []);

  const thresholdsRef = useRef(thresholds);
  thresholdsRef.current = thresholds;
  const sourceRef = useRef<Source>(source);
  sourceRef.current = source;
  const activeAlertRef = useRef<AlertEvent | null>(null);
  activeAlertRef.current = activeAlert;
  const ackedRef = useRef<Set<AlertKind>>(new Set());
  const stateAlertRef = useRef<AlertKind | null>(null);
  const telemetryRef = useRef<Telemetry | null>(null);
  const outOfRangeRef = useRef(false);
  const wasConnectedRef = useRef(false);
  const intentionalRef = useRef(false);

  const soundRef = useRef<AlarmSound | null>(null);
  if (soundRef.current === null) soundRef.current = new AlarmSound();
  const simRef = useRef<Simulator | null>(null);
  if (simRef.current === null) simRef.current = new Simulator();

  const bleSupported = useMemo(() => isWebBluetoothSupported(), []);
  const serialSupported = useMemo(() => isWebSerialSupported(), []);
  const anySupported = bleSupported || serialSupported;
  const isMobile = useMemo(
    () => typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true,
    [],
  );

  const raiseAlert = useCallback((kind: AlertKind, message: string, value?: number) => {
    // Ya está visible este tipo de alerta, o el usuario la reconoció: no repetir.
    if (ackedRef.current.has(kind)) return;
    if (activeAlertRef.current?.kind === kind) return;

    const event: AlertEvent = { id: uid(), ts: Date.now(), kind, message, value };
    // Se marca ya mismo (sin esperar al render) para evitar duplicados si
    // llegan varias líneas en el mismo lote.
    activeAlertRef.current = event;
    setEvents((prev) => [event, ...prev].slice(0, MAX_EVENTS));
    setActiveAlert(event);
  }, []);

  /** Cierra el banner (sin borrar el registro) cuando la condición ya no aplica. */
  const dismissAlerts = useCallback((kinds: AlertKind[]) => {
    const current = activeAlertRef.current;
    if (current && kinds.includes(current.kind)) {
      activeAlertRef.current = null;
      setActiveAlert(null);
    }
  }, []);

  const consumeLine = useCallback(
    (line: string) => {
      const parsed = parseLine(line);
      if (!parsed) return;

      setRawLines((prev) => [{ ts: Date.now(), text: line.trim().slice(0, 160) }, ...prev].slice(0, 8));

      if (parsed.telemetry) {
        const incoming = parsed.telemetry;
        const before = telemetryRef.current;
        const t: Telemetry = {
          ts: incoming.ts,
          humidity: incoming.humidity ?? before?.humidity ?? null,
          temperature: incoming.temperature ?? before?.temperature ?? null,
          battery: incoming.battery ?? before?.battery ?? null,
          state: incoming.state ?? before?.state ?? null,
          raw: incoming.raw,
        };
        telemetryRef.current = t;
        setTelemetry(t);

        const freshHumidity = incoming.humidity;
        if (freshHumidity !== null) {
          setHumSeries((prev) => [...prev, { ts: t.ts, v: freshHumidity }].slice(-MAX_POINTS));
        }

        if (t.humidity !== null) {
          const limits = thresholdsRef.current;
          const out = !inRange(t.humidity, limits);
          if (out && !outOfRangeRef.current) {
            const kind: AlertKind = t.humidity > limits.humMax ? 'hum_high' : 'hum_low';
            raiseAlert(
              kind,
              `Humedad ${t.humidity.toFixed(1)}% fuera de rango (${limits.humMin}–${limits.humMax}%)`,
              t.humidity,
            );
          }
          if (!out) {
            outOfRangeRef.current = false;
            ackedRef.current.delete('hum_high');
            ackedRef.current.delete('hum_low');
            dismissAlerts(['hum_high', 'hum_low']);
          } else {
            outOfRangeRef.current = true;
          }
        }

        const freshTemperature = incoming.temperature;
        if (freshTemperature !== null) {
          setTempSeries((prev) => [...prev, { ts: t.ts, v: freshTemperature }].slice(-MAX_POINTS));
          if (freshTemperature >= SAFE_TEMP_LOW && freshTemperature <= SAFE_TEMP_HIGH) {
            ackedRef.current.delete('temp_high');
            ackedRef.current.delete('temp_low');
            dismissAlerts(['temp_high', 'temp_low']);
          }
        }

        if (t.state !== 'HATCH' && t.state !== 'LOCKDOWN') {
          stateAlertRef.current = null;
          ackedRef.current.delete('hatch');
          ackedRef.current.delete('lockdown');
        }
      }

      if (parsed.alert) {
        if (parsed.telemetry && stateAlertRef.current === parsed.alert.kind) return;
        if (parsed.telemetry) stateAlertRef.current = parsed.alert.kind;
        raiseAlert(parsed.alert.kind, parsed.alert.message, parsed.alert.value);
        return;
      }

      if (parsed.text) {
        const inferred = inferTextAlert(parsed.text, telemetryRef.current?.temperature ?? null);
        if (!inferred) return;
        if (inferred.kind === 'hatch' || inferred.kind === 'lockdown') {
          if (stateAlertRef.current === inferred.kind) return;
          stateAlertRef.current = inferred.kind;
        }
        raiseAlert(inferred.kind, inferred.message, inferred.value);
      }
    },
    [dismissAlerts, raiseAlert],
  );

  const handleStatus = useCallback(
    (next: BleStatus, detail?: string) => {
      setStatus(next);
      setStatusDetail(detail);
      if (next === 'connected') {
        wasConnectedRef.current = true;
        intentionalRef.current = false;
        ackedRef.current.delete('disconnected');
        dismissAlerts(['disconnected']);
        setError(null);
      } else if ((next === 'idle' || next === 'error') && wasConnectedRef.current) {
        wasConnectedRef.current = false;
        const live = sourceRef.current === 'bt' || sourceRef.current === 'serial';
        if (live) setSource('none');
        if (!intentionalRef.current && live) {
          raiseAlert(
            'disconnected',
            sourceRef.current === 'serial'
              ? 'Se perdió el puerto serie (HC-05).'
              : 'Se perdió la conexión con el módulo Bluetooth.',
          );
        }
        intentionalRef.current = false;
      }
    },
    [dismissAlerts, raiseAlert],
  );

  const bleRef = useRef<BleLink | null>(null);
  const serialRef = useRef<SerialLink | null>(null);
  const activeLinkRef = useRef<Link | null>(null);
  const handleStatusRef = useRef(handleStatus);
  handleStatusRef.current = handleStatus;
  const consumeLineRef = useRef(consumeLine);
  consumeLineRef.current = consumeLine;

  if (bleRef.current === null) {
    bleRef.current = new BleLink({
      onStatus: (s, d) => handleStatusRef.current(s, d),
      onLine: (l) => consumeLineRef.current(l),
      onDevice: (name) => setDeviceName(name),
    });
  }
  if (serialRef.current === null) {
    serialRef.current = new SerialLink({
      onStatus: (s, d) => handleStatusRef.current(s, d),
      onLine: (l) => consumeLineRef.current(l),
      onDevice: (name) => setDeviceName(name),
    });
  }

  useEffect(() => {
    soundRef.current?.setMuted(muted);
  }, [muted]);

  useEffect(() => {
    const sound = soundRef.current;
    if (!sound) return;
    if (!activeAlert) {
      sound.setLevel('none');
      return;
    }
    sound.setLevel(activeAlert.kind === 'hatch' || activeAlert.kind === 'disconnected' ? 'critical' : 'warning');
  }, [activeAlert]);

  const closeLink = useCallback(() => {
    intentionalRef.current = true;
    const link = activeLinkRef.current;
    activeLinkRef.current = null;
    link?.disconnect();
    wasConnectedRef.current = false;
  }, []);

  useEffect(() => {
    return () => {
      soundRef.current?.dispose();
      simRef.current?.stop();
      bleRef.current?.disconnect(true);
      serialRef.current?.disconnect(true);
    };
  }, []);

  const connectBle = useCallback(async () => {
    const ble = bleRef.current;
    if (!ble || busy) return;
    closeLink();
    simRef.current?.stop();
    setBusy(true);
    setError(null);
    soundRef.current?.unlock();
    try {
      await ble.connect({ presets });
      activeLinkRef.current = ble;
      setSource('bt');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/cancelada|cancel|chooser/i.test(msg)) setError(msg);
    } finally {
      setBusy(false);
    }
  }, [busy, closeLink, presets]);

  const connectSerial = useCallback(async () => {
    const link = serialRef.current;
    if (!link || busy) return;
    closeLink();
    simRef.current?.stop();
    setBusy(true);
    setError(null);
    soundRef.current?.unlock();
    try {
      await link.connect({ baudRate });
      activeLinkRef.current = link;
      setSource('serial');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/cancelada|cancel|chooser/i.test(msg)) setError(msg);
    } finally {
      setBusy(false);
    }
  }, [baudRate, busy, closeLink]);

  const disconnect = useCallback(() => {
    simRef.current?.stop();
    closeLink();
    setSource('none');
  }, [closeLink]);

  const toggleDemo = useCallback(() => {
    const sim = simRef.current;
    if (!sim) return;
    soundRef.current?.unlock();
    if (sourceRef.current === 'demo') {
      sim.stop();
      setSource('none');
      return;
    }
    closeLink();
    setDeviceName('Simulador integrado');
    setSource('demo');
    sim.start(consumeLineRef.current);
  }, [closeLink]);

  const acknowledge = useCallback(() => {
    const current = activeAlertRef.current;
    if (current) ackedRef.current.add(current.kind);
    activeAlertRef.current = null;
    setActiveAlert(null);
  }, []);

  const sendCommand = useCallback(async () => {
    const link = activeLinkRef.current;
    if (!link || !command.trim()) return;
    try {
      await link.send(command.trim());
      setEvents((prev) =>
        [{ id: uid(), ts: Date.now(), kind: 'info' as const, message: `TX → ${command.trim()}` }, ...prev].slice(
          0,
          MAX_EVENTS,
        ),
      );
      setCommand('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [command]);

  const runProbe = useCallback(() => {
    const value = probeLine.trim();
    if (!value) return;
    consumeLine(value);
    setProbeLine('');
  }, [consumeLine, probeLine]);

  /**
   * Cambiar un umbral rearma la alarma de humedad y la evalúa al instante:
   * si la última lectura ya está fuera del nuevo rango, suena de inmediato
   * sin esperar a la siguiente línea del módulo.
   */
  const updateThresholds = useCallback(
    (patch: Partial<Thresholds>) => {
      const next = { ...thresholdsRef.current, ...patch };
      thresholdsRef.current = next;
      saveThresholds(next);
      setThresholds(next);

      ackedRef.current.delete('hum_high');
      ackedRef.current.delete('hum_low');
      outOfRangeRef.current = false;

      const hum = telemetryRef.current?.humidity;
      if (hum === null || hum === undefined) return;

      if (inRange(hum, next)) {
        dismissAlerts(['hum_high', 'hum_low']);
        return;
      }

      outOfRangeRef.current = true;
      const kind: AlertKind = hum > next.humMax ? 'hum_high' : 'hum_low';
      const message = `Humedad ${hum.toFixed(1)}% fuera de rango (${next.humMin}–${next.humMax}%)`;

      // Si el banner ya enseña este mismo tipo de alarma, se actualiza el
      // mensaje con el rango nuevo en lugar de duplicar la entrada en el log.
      const current = activeAlertRef.current;
      if (current?.kind === kind) {
        const updated = { ...current, message, value: hum };
        activeAlertRef.current = updated;
        setActiveAlert(updated);
        return;
      }

      raiseAlert(kind, message, hum);
    },
    [dismissAlerts, raiseAlert],
  );

  const onThresholdInput =
    (key: 'humMin' | 'humMax' | 'hysteresis') =>
    (e: ChangeEvent<HTMLInputElement>): void => {
      const value = Number(e.target.value);
      if (Number.isFinite(value)) updateThresholds({ [key]: value });
    };

  const humCurrent = telemetry?.humidity ?? null;
  const tempCurrent = telemetry?.temperature ?? null;
  const humOut = humCurrent !== null && !inRange(humCurrent, thresholds);
  const statusLabel: Record<BleStatus, string> = {
    idle: 'Desconectado',
    connecting: 'Conectando…',
    connected: 'Conectado',
    disconnecting: 'Desconectando…',
    error: 'Error',
  };

  const linkActive = source === 'bt' || source === 'serial';

  return (
    <div className={`app${activeAlert ? ' app--alarm' : ''}`}>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <div>
            <h1>Incubadora · Alertas BT</h1>
            <p>Fase Lockdown / Hatch</p>
          </div>
        </div>

        <div className="topbar-actions">
          <span className={`pill pill--${status}`}>
            <i />
            {source === 'demo'
              ? 'Modo demo'
              : source === 'bt'
                ? `BLE · ${statusLabel[status]}`
                : source === 'serial'
                  ? `Serie · ${statusLabel[status]}`
                  : statusLabel[status]}
          </span>
          <button type="button" className="btn btn--ghost" onClick={() => setMuted((m) => !m)} aria-pressed={muted}>
            {muted ? '🔇 Silencio' : '🔔 Alarmas'}
          </button>
          <button type="button" className="btn btn--ghost" onClick={toggleDemo}>
            {source === 'demo' ? 'Detener demo' : 'Demo'}
          </button>
          {linkActive ? (
            <button type="button" className="btn btn--ghost" onClick={disconnect}>
              Desconectar
            </button>
          ) : (
            <>
              {bleSupported && (
                <button type="button" className="btn btn--solid" onClick={connectBle} disabled={busy}>
                  {busy ? 'Conectando…' : 'Conectar Bluetooth'}
                </button>
              )}
              {serialSupported && (
                <button type="button" className="btn btn--ghost" onClick={connectSerial} disabled={busy}>
                  {busy ? 'Conectando…' : 'Conectar Serie'}
                </button>
              )}
            </>
          )}
        </div>
      </header>

      {error && (
        <div className="error" role="alert">
          {error}
          <button type="button" onClick={() => setError(null)} aria-label="Cerrar">
            ×
          </button>
        </div>
      )}

      {!anySupported && source !== 'demo' && (
        <div className="warn">
          Este navegador no expone Web Bluetooth ni Web Serial. Ábrelo en Chrome u Opera, o usa el modo Demo para
          probar la interfaz.
        </div>
      )}

      {bleSupported && !serialSupported && !isMobile && source !== 'demo' && (
        <div className="warn">
          Este navegador no expone Web Serial: la conexión por puerto serie (HC-05 + dongle USB) solo funciona en
          Chrome/Opera de escritorio. Desde el móvil usa Bluetooth LE (ESP32 / HM-10).
        </div>
      )}

      {!bleSupported && serialSupported && source !== 'demo' && (
        <div className="warn">
          Web Bluetooth no está disponible aquí. Puedes usar <strong>Conectar Serie</strong> con el HC-05 conectado a
          un dongle USB, o el modo Demo.
        </div>
      )}

      <AlertBanner
        alert={activeAlert}
        muted={muted}
        flash={Boolean(activeAlert) && !muted}
        onAck={acknowledge}
        onToggleMute={() => setMuted((m) => !m)}
      />

      <div className="grid">
        <Sparkline
          label="Humedad relativa"
          unit="%"
          color="#38bdf8"
          points={humSeries}
          band={[thresholds.humMin, thresholds.humMax]}
          current={humCurrent}
        />
        <Sparkline
          label="Temperatura"
          unit="°C"
          color="#f59e0b"
          points={tempSeries}
          minY={30}
          maxY={42}
          current={tempCurrent}
          decimals={2}
        />

        <section className="card">
          <header className="card-head">
            <h2>Estado</h2>
            <span className={`badge badge--${telemetry?.state ? 'on' : 'off'}`}>{telemetry?.state ?? '—'}</span>
          </header>
          <dl className="stats">
            <div>
              <dt>Última lectura</dt>
              <dd>{telemetry ? clockOf(telemetry.ts) : '—'}</dd>
            </div>
            <div>
              <dt>Batería</dt>
              <dd>{telemetry?.battery !== null && telemetry?.battery !== undefined ? `${telemetry.battery}%` : '—'}</dd>
            </div>
            <div>
              <dt>Dispositivo</dt>
              <dd>{deviceName ?? '—'}</dd>
            </div>
            <div>
              <dt>Muestras</dt>
              <dd>{humSeries.length}</dd>
            </div>
          </dl>
          <p className={`hint${humOut ? ' hint--alert' : ''}`}>
            {humCurrent === null
              ? 'Esperando datos del módulo…'
              : humOut
                ? `Fuera de rango: ${humCurrent.toFixed(1)}%`
                : 'Humedad dentro de rango'}
            {statusDetail ? ` · ${statusDetail}` : ''}
          </p>

          <details className="raw">
            <summary>Últimas líneas recibidas ({rawLines.length})</summary>
            {rawLines.length === 0 ? (
              <p className="empty">Sin datos todavía.</p>
            ) : (
              <ul className="raw-list">
                {rawLines.map((r, i) => (
                  <li key={`${r.ts}-${i}`}>
                    <time>{clockOf(r.ts)}</time>
                    <code>{r.text}</code>
                  </li>
                ))}
              </ul>
            )}
          </details>

          <div className="probe">
            <span className="field-note">Pega una línea para probar el parser:</span>
            <div className="cmd">
              <input
                value={probeLine}
                placeholder="Temp: 37.5 C | Humedad: 65.0 %"
                onChange={(e) => setProbeLine(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && runProbe()}
              />
              <button type="button" className="btn btn--ghost btn--sm" onClick={runProbe}>
                Probar
              </button>
            </div>
          </div>
        </section>

        <section className="card">
          <header className="card-head">
            <h2>Ajustes y umbrales</h2>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => updateThresholds(DEFAULT_THRESHOLDS)}>
              Restablecer
            </button>
          </header>
          <div className="field-row">
            <label>
              Mínimo
              <input
                type="number"
                value={thresholds.humMin}
                min={0}
                max={100}
                onChange={onThresholdInput('humMin')}
              />
            </label>
            <label>
              Máximo
              <input
                type="number"
                value={thresholds.humMax}
                min={0}
                max={100}
                onChange={onThresholdInput('humMax')}
              />
            </label>
            <label>
              Histéresis
              <input
                type="number"
                value={thresholds.hysteresis}
                min={0}
                max={20}
                onChange={onThresholdInput('hysteresis')}
              />
            </label>
          </div>

          {bleSupported && (
            <div className="field-row field-row--check">
              {SERVICE_PRESETS.map((p) => (
                <label key={p.id} className="check">
                  <input
                    type="checkbox"
                    checked={presets.includes(p.id)}
                    onChange={(e) =>
                      setPresets((prev) => (e.target.checked ? [...prev, p.id] : prev.filter((x) => x !== p.id)))
                    }
                  />
                  {p.label}
                </label>
              ))}
            </div>
          )}

          {serialSupported && (
            <div className="field-row field-row--single">
              <label>
                Baudios (serie)
                <select value={baudRate} onChange={(e) => updateBaud(Number(e.target.value))}>
                  {[9600, 19200, 38400, 57600, 115200, 230400].map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
                <span className="field-note">HC-05 de fábrica: 9600 8N1</span>
              </label>
            </div>
          )}

          <div className="cmd">
            <input
              value={command}
              placeholder="Comando UART, p. ej. ACK"
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void sendCommand()}
              disabled={!linkActive}
            />
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => void sendCommand()} disabled={!linkActive}>
              Enviar
            </button>
          </div>
        </section>

        <div className="span-2">
          <EventLog events={events} />
        </div>
      </div>

      <footer className="foot">
        Web Bluetooth (ESP32 / HM-10) y Web Serial (HC-05 por USB) requieren Chrome u Opera sobre HTTPS. En Vercel se
        sirve por HTTPS de forma automática.
      </footer>
    </div>
  );
}
