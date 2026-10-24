// Token state built from the trade stream: price, volume, holders, curve progress.
import { EventEmitter } from 'node:events';

export const TOTAL_SUPPLY = 1_000_000_000;
// pump.fun bonding curve constants (virtual reserves, UI units).
export const CURVE_START_VTOKENS = 1_073_000_000;
export const CURVE_SELLABLE_TOKENS = 793_100_000;
export const CURVE_START_VSOL = 30;

const KEEP_TRADES_MS = 30 * 60_000;
const MAX_TRADES = 4000;

export class Token {
  constructor(ev, cfg) {
    this.mint = ev.mint;
    this.name = ev.name || '';
    this.symbol = ev.symbol || ev.mint.slice(0, 5);
    this.creator = ev.creator || null;
    this.bondingCurveKey = ev.bondingCurveKey || null;
    this.pool = ev.pool || 'pump';
    this.createdAt = ev.ts;
    this.lastTradeAt = ev.ts;
    this.migrated = false;
    this.vSol = ev.vSol ?? CURVE_START_VSOL;
    this.vTokens = ev.vTokens ?? CURVE_START_VTOKENS;
    this.mcapSol = ev.mcapSol ?? (this.vSol / this.vTokens) * TOTAL_SUPPLY;
    this.high = this.price;
    this.highAt = ev.ts;
    this.low = this.price;
    this.trades = [];
    this.balances = new Map();
    this.snipers = new Set();
    this.volumeSol = 0;
    this.txCount = 0;
    this.sniperWindowMs = (cfg?.safety?.sniperWindowSec ?? 15) * 1000;
    this.samples = [[ev.ts, this.price, this.vSol]];
    if (ev.initialBuyTokens && this.creator) {
      this.balances.set(this.creator, ev.initialBuyTokens);
      this.volumeSol += ev.initialBuySol || 0;
      this.txCount++;
    }
  }

  get price() { return this.mcapSol / TOTAL_SUPPLY; }

  applyTrade(ev) {
    if (ev.vSol != null) this.vSol = ev.vSol;
    if (ev.vTokens != null) this.vTokens = ev.vTokens;
    if (ev.mcapSol != null) this.mcapSol = ev.mcapSol;
    else if (ev.vSol != null && ev.vTokens) this.mcapSol = (ev.vSol / ev.vTokens) * TOTAL_SUPPLY;
    this.lastTradeAt = ev.ts;
    this.volumeSol += ev.sol;
    this.txCount++;

    const delta = ev.side === 'buy' ? ev.tokens : -ev.tokens;
    const bal = Math.max(0, (this.balances.get(ev.trader) || 0) + delta);
    if (bal > 0) this.balances.set(ev.trader, bal); else this.balances.delete(ev.trader);
    if (ev.side === 'buy' && ev.trader !== this.creator && ev.ts - this.createdAt <= this.sniperWindowMs) {
      this.snipers.add(ev.trader);
    }

    const p = this.price;
    if (p > this.high) { this.high = p; this.highAt = ev.ts; }
    if (p < this.low) this.low = p;
    this.trades.push({ ts: ev.ts, side: ev.side, sol: ev.sol, trader: ev.trader, price: p });
    this.samples.push([ev.ts, p, this.vSol]);
    if (this.trades.length > MAX_TRADES) this.trades.splice(0, this.trades.length - MAX_TRADES);
    const cut = ev.ts - KEEP_TRADES_MS;
    if (this.samples.length > MAX_TRADES || this.samples[0][0] < cut) {
      let i = 0;
      while (i < this.samples.length - 1 && (this.samples[i][0] < cut || this.samples.length - i > MAX_TRADES)) i++;
      this.samples.splice(0, i);
    }
  }

  // Sample (price, vSol) as of time ts; falls back to the oldest one kept.
  sampleAt(ts) {
    let lo = 0, hi = this.samples.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.samples[mid][0] <= ts) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return this.samples[ans];
  }

  window(now, sec) {
    const from = now - sec * 1000;
    let volume = 0, buys = 0, sells = 0, buyVol = 0, sellVol = 0;
    const buyers = new Set();
    for (let i = this.trades.length - 1; i >= 0; i--) {
      const t = this.trades[i];
      if (t.ts < from) break;
      volume += t.sol;
      if (t.side === 'buy') { buys++; buyVol += t.sol; buyers.add(t.trader); } else { sells++; sellVol += t.sol; }
    }
    const past = this.sampleAt(from);
    return {
      volume, buys, sells, buyVol, sellVol,
      uniqueBuyers: buyers.size,
      priceChangePct: past[1] > 0 ? (this.price / past[1] - 1) * 100 : 0,
      liquidityChangePct: past[2] > 0 ? (this.vSol / past[2] - 1) * 100 : 0,
      lowSince: this.lowSince(from),
    };
  }

  lowSince(from) {
    let low = this.price;
    for (let i = this.samples.length - 1; i >= 0 && this.samples[i][0] >= from; i--) low = Math.min(low, this.samples[i][1]);
    return low;
  }

  holderStats() {
    const holders = [...this.balances.entries()].filter(([, b]) => b > 1);
    const sorted = holders.map(([, b]) => b).sort((a, b) => b - a);
    const top10 = sorted.slice(0, 10).reduce((s, b) => s + b, 0);
    let sniperHold = 0;
    for (const w of this.snipers) sniperHold += this.balances.get(w) || 0;
    const devHold = this.creator ? this.balances.get(this.creator) || 0 : 0;
    return {
      holders: holders.length,
      top10Pct: (top10 / TOTAL_SUPPLY) * 100,
      devPct: (devHold / TOTAL_SUPPLY) * 100,
      snipersPct: (sniperHold / TOTAL_SUPPLY) * 100,
    };
  }

  get curvePct() {
    if (this.migrated) return 100;
    return Math.max(0, Math.min(100, ((CURVE_START_VTOKENS - this.vTokens) / CURVE_SELLABLE_TOKENS) * 100));
  }

  // Approximation of Axiom's "Global Fees Paid": 1% platform fee + typical priority fees.
  get globalFeesSol() { return this.volumeSol * 0.01 + this.txCount * 0.0002; }

  ageMin(now) { return (now - this.createdAt) / 60_000; }

  axiomUrl() { return `https://axiom.trade/meme/${this.bondingCurveKey || this.mint}`; }
}

export class Market extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.tokens = new Map();
    this.stats = { created: 0, trades: 0, migrations: 0, dropped: 0 };
  }

  handle(ev) {
    if (ev.type === 'create') {
      if (this.tokens.has(ev.mint)) return;
      const t = new Token(ev, this.cfg);
      this.tokens.set(ev.mint, t);
      this.stats.created++;
      this.emit('token', t);
      if (this.tokens.size > this.cfg.market.maxWatched) this.dropOldest();
    } else if (ev.type === 'trade') {
      const t = this.tokens.get(ev.mint);
      if (!t) return;
      t.applyTrade(ev);
      this.stats.trades++;
      this.emit('trade', t, ev);
    } else if (ev.type === 'migrate') {
      const t = this.tokens.get(ev.mint);
      if (!t) return;
      t.migrated = true;
      if (ev.pool) t.pool = ev.pool;
      this.stats.migrations++;
      this.emit('migrate', t);
    }
  }

  // Not the main coin: another token with the same ticker/name is bigger.
  isVamp(token) {
    const sym = token.symbol.trim().toLowerCase();
    const name = token.name.trim().toLowerCase();
    for (const o of this.tokens.values()) {
      if (o === token) continue;
      const same = o.symbol.trim().toLowerCase() === sym || (name && o.name.trim().toLowerCase() === name);
      if (same && o.mcapSol > token.mcapSol) return true;
    }
    return false;
  }

  // Forget dead tokens; `keep` holds mints with open positions.
  prune(now, keep = new Set()) {
    const { dropAfterIdleSec, dropBelowMcapUsd, dropCheckAfterSec } = this.cfg.market;
    const minMcapSol = dropBelowMcapUsd / this.cfg.solUsd;
    const dropped = [];
    for (const [mint, t] of this.tokens) {
      if (keep.has(mint)) continue;
      const idle = now - t.lastTradeAt > dropAfterIdleSec * 1000;
      const dead = now - t.createdAt > dropCheckAfterSec * 1000 && t.mcapSol < minMcapSol;
      if (idle || dead) { this.tokens.delete(mint); dropped.push(mint); }
    }
    this.stats.dropped += dropped.length;
    if (dropped.length) this.emit('dropped', dropped);
    return dropped;
  }

  dropOldest(keep = new Set()) {
    for (const [mint] of this.tokens) {
      if (keep.has(mint)) continue;
      this.tokens.delete(mint);
      this.stats.dropped++;
      this.emit('dropped', [mint]);
      return;
    }
  }
}
