import type { WeekStat } from './occurrences';

// Colorblind-safe pair (validated: CVD ΔE 25.8, contrast ≥3:1 on light surface).
const MET_COLOR = '#2563eb';
const MISSED_COLOR = '#e11d48';

const W = 560;
const H = 120;
const PAD_BOTTOM = 16;
const GAP = 2; // surface gap between adjacent bars and stacked segments

/** Stacked weekly bars of met vs missed occurrences, oldest week first. */
export function MetMissedChart({ stats }: { stats: WeekStat[] }) {
  const max = Math.max(1, ...stats.map(s => s.met + s.missed));
  const plotH = H - PAD_BOTTOM;
  const slot = W / stats.length;
  const barW = Math.max(4, slot - 8);
  const total = stats.reduce((n, s) => n + s.met + s.missed, 0);

  return (
    <div className="mb-4">
      <div className="flex items-center gap-4 mb-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <span style={{ background: MET_COLOR, width: 10, height: 10, borderRadius: 2, display: 'inline-block' }} />
          Met
        </span>
        <span className="flex items-center gap-1">
          <span style={{ background: MISSED_COLOR, width: 10, height: 10, borderRadius: 2, display: 'inline-block' }} />
          Missed
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxWidth: W }} role="img" aria-label="Met vs missed occurrences per week">
        {total === 0 && (
          <text x={W / 2} y={plotH / 2} textAnchor="middle" className="fill-muted-foreground" fontSize="12">
            No history yet — completed and missed occurrences will show up here.
          </text>
        )}
        {stats.map((s, i) => {
          const x = i * slot + (slot - barW) / 2;
          const metH = (s.met / max) * plotH;
          const missedH = (s.missed / max) * plotH;
          const label = s.weekStart.substring(5); // MM-DD
          return (
            <g key={s.weekStart}>
              <title>{`Week of ${s.weekStart}: ${s.met} met, ${s.missed} missed`}</title>
              {s.met > 0 && (
                <rect x={x} y={plotH - metH} width={barW} height={Math.max(1, metH - (s.missed > 0 ? GAP : 0))} rx={2} fill={MET_COLOR} />
              )}
              {s.missed > 0 && (
                <rect x={x} y={plotH - metH - missedH} width={barW} height={Math.max(1, missedH - GAP)} rx={2} fill={MISSED_COLOR} />
              )}
              <text x={x + barW / 2} y={H - 4} textAnchor="middle" className="fill-muted-foreground" fontSize="9">
                {label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
