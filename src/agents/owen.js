// OWEN — survivor: older tokens that are still alive, spread out and trending up.
import { Agent } from './base.js';

export class Owen extends Agent {
  evaluate(t, now) {
    const c = this.cfg;
    if (t.ageMin(now) < c.minAgeMin) return this.no('too_young');
    if (this.mcapUsd(t) < c.minMcapUsd) return this.no('mcap');
    const h = t.holderStats();
    if (h.top10Pct > c.maxTop10Pct || h.snipersPct > c.maxSnipersPct) return this.no('concentration');
    const dd = (1 - t.price / t.high) * 100;
    if (dd > c.maxDrawdownFromHighPct) return this.no('drawdown');
    const trend = t.window(now, c.trendWindowMin * 60);
    const recent = t.window(now, 300);
    const reason = `age ${t.ageMin(now).toFixed(0)}m, ${trend.priceChangePct >= 0 ? '+' : ''}${trend.priceChangePct.toFixed(0)}%/${c.trendWindowMin}m, top10 ${h.top10Pct.toFixed(0)}%`;
    if (trend.priceChangePct >= c.minTrendPct && recent.volume >= c.minVolumeSol5m) {
      return { action: 'buy', reason: `survivor trend: ${reason}` };
    }
    return { action: 'watch', reason };
  }
}
