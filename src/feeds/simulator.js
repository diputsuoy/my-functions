// Synthetic pump.fun-like market for demo mode and offline testing.
// Prices follow the real bonding-curve math, but every token here is fake.
import { EventEmitter } from 'node:events';
import { CURVE_START_VSOL, CURVE_START_VTOKENS, TOTAL_SUPPLY } from '../market.js';

const MIGRATE_AT_VTOKENS = CURVE_START_VTOKENS - 793_100_000;
const WORDS = ['PEPE', 'DOGE', 'CAT', 'MOON', 'GROK', 'TRUMP', 'WIF', 'BONK', 'FROG', 'APE', 'CHAD', 'GIGA', 'NEIRO', 'POPCAT', 'TORCH', 'GLOAM', 'ELON', 'ANSEM', 'DOPE', 'EXFIL', 'KOLSHI', 'WEFT', 'DACITY', 'AXE'];
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function addr(rand) {
  let s = '';
  for (let i = 0; i < 44; i++) s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  return s;
}

// Small deterministic PRNG so tests are repeatable.
export function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class SimulatorFeed extends EventEmitter {
  constructor({ seed = Date.now(), launchEverySec = 4, clock = Date.now } = {}) {
    super();
    this.rand = mulberry32(seed);
    this.launchEverySec = launchEverySec;
    this.now = clock;
    this.status = 'demo';
    this.live = [];
  }

  start(tickMs = 250) {
    this.timer = setInterval(() => this.step(tickMs / 1000), tickMs);
  }

  stop() { clearInterval(this.timer); }
  follow() {}
  unfollow() {}

  pick() {
    const r = this.rand();
    if (r < 0.5) return 'dud';
    if (r < 0.65) return 'rug';
    if (r < 0.9) return 'runner';
    return 'pumpdump';
  }

  launch() {
    const r = this.rand;
    const word = WORDS[Math.floor(r() * WORDS.length)];
    const symbol = r() < 0.7 ? word : word + Math.floor(r() * 99);
    const t = {
      mint: addr(r) + 'pump', symbol, name: symbol.charAt(0) + symbol.slice(1).toLowerCase(),
      creator: addr(r), kind: this.pick(), age: 0, vSol: CURVE_START_VSOL, vTokens: CURVE_START_VTOKENS,
      holders: new Map(), wallets: [], heat: 1 + r() * 2, migrated: false,
      peakAt: 30 + r() * 600, dumpAt: 40 + r() * 200,
    };
    const devSol = r() * 1.5;
    const devTokens = this.curveBuy(t, devSol);
    t.holders.set(t.creator, devTokens);
    this.live.push(t);
    this.emit('event', {
      type: 'create', ts: this.now(), mint: t.mint, name: t.name, symbol: t.symbol, creator: t.creator,
      bondingCurveKey: null, vSol: t.vSol, vTokens: t.vTokens, mcapSol: this.mcap(t),
      initialBuyTokens: devTokens, initialBuySol: devSol,
    });
  }

  mcap(t) { return (t.vSol / t.vTokens) * TOTAL_SUPPLY; }

  curveBuy(t, sol) {
    const k = t.vSol * t.vTokens;
    const out = t.vTokens - k / (t.vSol + sol);
    t.vSol += sol; t.vTokens -= out;
    return out;
  }

  curveSell(t, tokens) {
    const k = t.vSol * t.vTokens;
    const out = t.vSol - k / (t.vTokens + tokens);
    t.vTokens += tokens; t.vSol -= out;
    return out;
  }

  // Buy pressure (0..1) and activity for the token's archetype and age.
  mood(t) {
    const a = t.age;
    switch (t.kind) {
      case 'dud': return { p: 0.47, act: t.heat * Math.exp(-a / 60) };
      case 'rug': return a < t.dumpAt ? { p: 0.62, act: t.heat * 2 } : { p: 0.15, act: 2 * Math.exp(-(a - t.dumpAt) / 30) };
      case 'pumpdump': return a < 50 ? { p: 0.72, act: 4 } : { p: 0.3, act: 2 * Math.exp(-(a - 50) / 120) };
      default: {
        const wave = Math.sin(a / 25) * 0.12;
        const fade = a > t.peakAt ? Math.exp(-(a - t.peakAt) / 300) : 1;
        return { p: 0.54 + wave - (a > t.peakAt ? 0.08 : 0), act: (1.5 + t.heat) * fade };
      }
    }
  }

  step(dt) {
    if (this.rand() < dt / this.launchEverySec) this.launch();
    for (const t of this.live) {
      t.age += dt;
      const { p, act } = this.mood(t);
      let n = 0;
      const lambda = act * dt;
      while (this.rand() < lambda / (n + 1) && n < 8) n++;
      for (let i = 0; i < n; i++) this.trade(t, this.rand() < p);
      if (t.kind === 'rug' && !t.rugged && t.age >= t.dumpAt) this.rug(t);
      if (!t.migrated && t.vTokens <= MIGRATE_AT_VTOKENS) {
        t.migrated = true;
        this.emit('event', { type: 'migrate', ts: this.now(), mint: t.mint, pool: 'pump-amm' });
      }
    }
    this.live = this.live.filter(t => this.mood(t).act > 0.02 && t.age < 3600);
  }

  trade(t, isBuy) {
    const r = this.rand;
    let trader, sol, tokens;
    if (isBuy || t.holders.size <= 1) {
      const repeat = t.wallets.length > 5 && r() < 0.25;
      trader = repeat ? t.wallets[Math.floor(r() * t.wallets.length)] : addr(r);
      if (!repeat) t.wallets.push(trader);
      sol = Math.min(5, 0.03 + -Math.log(1 - r()) * 0.35);
      tokens = this.curveBuy(t, sol);
      t.holders.set(trader, (t.holders.get(trader) || 0) + tokens);
      this.emitTrade(t, 'buy', trader, sol, tokens);
    } else {
      trader = null;
      for (let i = 0; i < 6 && !trader; i++) {
        const w = r() < 0.03 ? t.creator : t.wallets[Math.floor(r() * t.wallets.length)];
        if (w && t.holders.get(w) > 1) trader = w;
      }
      if (!trader) return;
      const bal = t.holders.get(trader);
      tokens = bal * (r() < 0.5 ? 1 : 0.3 + r() * 0.7);
      sol = this.curveSell(t, tokens);
      if (bal - tokens < 1) t.holders.delete(trader); else t.holders.set(trader, bal - tokens);
      this.emitTrade(t, 'sell', trader, sol, tokens);
    }
  }

  rug(t) {
    t.rugged = true;
    const whales = [...t.holders.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    for (const [w, bal] of whales) {
      const sol = this.curveSell(t, bal);
      t.holders.delete(w);
      this.emitTrade(t, 'sell', w, sol, bal);
    }
  }

  emitTrade(t, side, trader, sol, tokens) {
    this.emit('event', {
      type: 'trade', ts: this.now(), mint: t.mint, side, trader, sol, tokens,
      vSol: t.vSol, vTokens: t.vTokens, mcapSol: this.mcap(t),
    });
  }
}
