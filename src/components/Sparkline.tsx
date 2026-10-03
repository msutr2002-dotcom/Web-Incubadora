export interface ChartPoint {
  ts: number;
  v: number;
}

interface SparklineProps {
  points: ChartPoint[];
  label: string;
  unit: string;
  color: string;
  band?: [number, number];
  current?: number | null;
  decimals?: number;
  minY?: number;
  maxY?: number;
}

const W = 320;
const H = 130;
const PAD = 6;

export function Sparkline({
  points,
  label,
  unit,
  color,
  band,
  current,
  decimals = 1,
  minY,
  maxY,
}: SparklineProps) {
  const values = points.map((p) => p.v);
  if (typeof minY === 'number') values.push(minY);
  if (typeof maxY === 'number') values.push(maxY);
  if (band) values.push(band[0], band[1]);

  let lo = values.length ? Math.min(...values) : 0;
  let hi = values.length ? Math.max(...values) : 1;
  if (hi - lo < 1) {
    hi += 0.5;
    lo -= 0.5;
  }
  const span = hi - lo;
  lo -= span * 0.1;
  hi += span * 0.1;

  const x = (i: number, n: number) => (n <= 1 ? W / 2 : PAD + (i / (n - 1)) * (W - PAD * 2));
  const y = (v: number) => H - PAD - ((v - lo) / (hi - lo)) * (H - PAD * 2);

  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i, points.length).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const area = points.length > 1 ? `${path} L${x(points.length - 1, points.length).toFixed(1)},${H - PAD} L${PAD},${H - PAD} Z` : '';
  const outOfBand = band && typeof current === 'number' && (current < band[0] || current > band[1]);
  const display = typeof current === 'number' ? current.toFixed(decimals) : '—';

  return (
    <section className={`card chart-card${outOfBand ? ' chart-card--alert' : ''}`}>
      <header className="chart-head">
        <span className="chart-label">{label}</span>
        <span className="chart-value" style={{ color }}>
          {display}
          <small>{unit}</small>
        </span>
      </header>
      <svg className="chart-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
        {band && (
          <rect
            x={PAD}
            y={y(band[1])}
            width={W - PAD * 2}
            height={Math.max(1, y(band[0]) - y(band[1]))}
            className="chart-band"
          />
        )}
        {band && (
          <>
            <line x1={PAD} y1={y(band[1])} x2={W - PAD} y2={y(band[1])} className="chart-th" />
            <line x1={PAD} y1={y(band[0])} x2={W - PAD} y2={y(band[0])} className="chart-th" />
          </>
        )}
        {area && <path d={area} fill={color} opacity={0.13} />}
        {path && <path d={path} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />}
        {points.length > 0 && (
          <circle cx={x(points.length - 1, points.length)} cy={y(points[points.length - 1].v)} r={3} fill={color} />
        )}
      </svg>
      <footer className="chart-foot">
        <span>
          mín {lo.toFixed(decimals)}
          {unit}
        </span>
        {band && (
          <span>
            rango {band[0]}–{band[1]}
            {unit}
          </span>
        )}
        <span>
          máx {hi.toFixed(decimals)}
          {unit}
        </span>
      </footer>
    </section>
  );
}
