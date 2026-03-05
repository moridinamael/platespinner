export default function Sparkline({ data, width = 200, height = 32 }) {
  if (!data || data.length < 2) return null;

  // Aggregate costs by day
  const byDay = new Map();
  for (const { timestamp, cost } of data) {
    const day = new Date(timestamp).toISOString().slice(0, 10);
    byDay.set(day, (byDay.get(day) || 0) + cost);
  }
  const points = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b));
  if (points.length < 2) return null;

  const values = points.map(([, v]) => v);
  const maxVal = Math.max(...values);
  const range = maxVal || 1;
  const padding = 2;
  const w = width - padding * 2;
  const h = height - padding * 2;

  const pathPoints = values.map((v, i) => {
    const x = padding + (i / (values.length - 1)) * w;
    const y = padding + h - (v / range) * h;
    return `${x},${y}`;
  });

  const pathD = `M ${pathPoints.join(' L ')}`;

  return (
    <svg className="sparkline" width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <path d={pathD} fill="none" stroke="var(--accent)" strokeWidth="1.5" />
      <circle
        cx={padding + w}
        cy={padding + h - (values[values.length - 1] / range) * h}
        r="2"
        fill="var(--accent)"
      />
    </svg>
  );
}
