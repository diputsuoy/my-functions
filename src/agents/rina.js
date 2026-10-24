// RINA — pullbacks: buy a dip after a strong run once selling dries up.
import { Agent } from './base.js';

export class Rina extends Agent {
  evaluate(t, now) {
    const c = this.cfg;
    const mc = this.mcapUsd(t);
    if (t.ageMin(now) > c.maxAgeMin || mc < c.minMcapUsd || mc > c.maxMcapUsd) return null;
    if (now - t.highAt > 10 * 60_000) return null;
    const runPct = (t.high / t.low - 1) * 100;
    if (runPct < c.minRunPct) return null;
    const pullback = (1 - t.price / t.high) * 100;
    if (pullback < c.pullbackMinPct || pullback > c.pullbackMaxPct) return null;
    const w = t.window(now, c.windowSec);
    const reason = `run +${runPct.toFixed(0)}%, pullback -${pullback.toFixed(0)}%`;
    if (w.buys >= w.sells && w.volume >= c.minVolumeSol && w.priceChangePct >= 0) {
      return { action: 'buy', reason: `pullback bid: ${reason}` };
    }
    return { action: 'watch', reason: `${reason}, waiting for buyers` };
  }
}
