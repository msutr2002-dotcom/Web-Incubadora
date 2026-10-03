import type { AlertEvent } from '../lib/protocol';
import { ALERT_LABELS } from '../lib/protocol';

interface Props {
  events: AlertEvent[];
}

function timeOf(ts: number): string {
  return new Date(ts).toLocaleTimeString('es-ES', { hour12: false });
}

export function EventLog({ events }: Props) {
  return (
    <section className="card">
      <header className="card-head">
        <h2>Registro de eventos</h2>
        <span className="badge">{events.length}</span>
      </header>
      {events.length === 0 ? (
        <p className="empty">Todavía no se registraron eventos.</p>
      ) : (
        <ul className="log">
          {events.map((ev) => (
            <li key={ev.id} className={`log-item log-item--${ev.kind}`}>
              <time>{timeOf(ev.ts)}</time>
              <span className="log-kind">{ALERT_LABELS[ev.kind]}</span>
              <span className="log-msg">{ev.message}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
