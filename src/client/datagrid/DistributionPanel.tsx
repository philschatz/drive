/**
 * Panel showing distribution statistics and histogram below the formula bar.
 */
import type { DistributionStats } from './distributions';
import { formatNum } from './distributions';

export function DistributionPanel({ stats, isSource }: { stats: DistributionStats; isSource: boolean }) {
  return (
    <div className="dist-panel">
      <div className="dist-histogram">
        {stats.histogram.map((h, i) => (
          <div key={i} className="dist-bar" style={{ height: `${h * 100}%` }} />
        ))}
      </div>
      <div className="dist-stats">
        <span title="Mean">{isSource ? 'Source' : 'Derived'}: μ={formatNum(stats.mean)}</span>
        <span title="Standard deviation">σ={formatNum(stats.stdev)}</span>
        <span title="5th percentile">P5={formatNum(stats.p5)}</span>
        <span title="Median">P50={formatNum(stats.p50)}</span>
        <span title="95th percentile">P95={formatNum(stats.p95)}</span>
      </div>
    </div>
  );
}
