// COLE — momentum: volume and price accelerating right now.
import { Agent } from './base.js';

export class Cole extends Agent {
  evaluate(t, now) {
    const c = this.cfg;
    const mc = this.mcapUsd(t);
    if (t.ageMin(now) > c.maxAgeMin) return this.no('age');
    if (mc < c.minMcapUsd || mc > c.maxMcapUsd) return this.no('mcap');
    const w = t.window(now, c.windowSec);
    if (w.volume < c.minVolumeSol / 2) return this.no('volume');
    const ratio = w.buys / Math.max(1, w.sells);
    const reason = `vol ${w.volume.toFixed(1)} SOL/${c.windowSec}s, ${w.priceChangePct >= 0 ? '+' : ''}${w.priceChangePct.toFixed(0)}%, b/s ${ratio.toFixed(1)}`;
    if (w.volume >= c.minVolumeSol && ratio >= c.minBuySellRatio &&
        w.priceChangePct >= c.minPriceChangePct && w.uniqueBuyers >= c.minBuyers) {
      return { action: 'buy', reason: `volume rising: ${reason}` };
    }
    return { action: 'watch', reason };
  }
}
