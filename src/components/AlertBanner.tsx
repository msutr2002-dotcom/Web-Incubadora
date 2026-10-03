import type { AlertEvent } from '../lib/protocol';
import { ALERT_LABELS, ALERT_SEVERITY } from '../lib/protocol';

interface Props {
  alert: AlertEvent | null;
  muted: boolean;
  flash: boolean;
  onAck: () => void;
  onToggleMute: () => void;
}

function timeOf(ts: number): string {
  return new Date(ts).toLocaleTimeString('es-ES', { hour12: false });
}

export function AlertBanner({ alert, muted, flash, onAck, onToggleMute }: Props) {
  if (!alert) {
    return (
      <div className="alert alert--ok" role="status">
        <span className="alert-dot" />
        <div>
          <strong>Sin alertas activas</strong>
          <p>Monitoreo en curso. Umbrales vigilados en tiempo real.</p>
        </div>
      </div>
    );
  }

  const severity = ALERT_SEVERITY[alert.kind];
  const unit = alert.kind.startsWith('temp') ? '°C' : '% HR';
  const reading = typeof alert.value === 'number' ? ` · ${alert.value}${unit}` : '';

  return (
    <div className={`alert alert--${severity}${flash ? ' alert--flash' : ''}`} role="alert">
      <span className="alert-dot" />
      <div className="alert-body">
        <strong>{ALERT_LABELS[alert.kind]}</strong>
        <p>
          {alert.message}
          {reading} · {timeOf(alert.ts)}
        </p>
      </div>
      <div className="alert-actions">
        <button type="button" className="btn btn--ghost" onClick={onToggleMute} aria-pressed={muted}>
          {muted ? '🔇 Silenciado' : '🔔 Sonando'}
        </button>
        <button type="button" className="btn btn--solid" onClick={onAck}>
          Reconocer
        </button>
      </div>
    </div>
  );
}
