// VINCE — liquidity: final-stretch tokens whose curve liquidity keeps expanding.
import { Agent } from './base.js';

export class Vince extends Agent {
  evaluate(t, now) {
    const c = this.cfg;
    if (t.migrated) return this.no('migrated');
    const curve = t.curvePct;
    if (curve < c.minCurvePct || curve > c.maxCurvePct) return this.no('curve');
    if (t.globalFeesSol < c.minGlobalFeesSol) return this.no('fees');
    if (t.holderStats().holders < c.minHolders) return this.no('holders');
    const w = t.window(now, c.liquidityWindowSec);
    const reason = `curve ${curve.toFixed(0)}%, liq ${w.liquidityChangePct >= 0 ? '+' : ''}${w.liquidityChangePct.toFixed(0)}%/${c.liquidityWindowSec}s, fees ${t.globalFeesSol.toFixed(2)}`;
    if (w.liquidityChangePct >= c.minLiquidityGrowthPct && w.priceChangePct > 0) {
      return { action: 'buy', reason: `liquidity expanding: ${reason}` };
    }
    return { action: 'watch', reason };
  }
}
