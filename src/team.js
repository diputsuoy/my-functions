// The trading team: bankrolls, entries, exits, hourly reallocation, event log.
import { EventEmitter } from 'node:events';
import { checkSafety } from './safety.js';
import { fillBuy, fillSell, quoteSell } from './paper.js';

const MAX_EVENTS = 300;
const MAX_CLOSED = 500;
const WATCH_TTL_MS = 90_000;

export class Team extends EventEmitter {
  constructor(cfg, agents, market, clock = Date.now) {
    super();
    this.cfg = cfg;
    this.agents = agents;
    this.market = market;
    this.now = clock;
    this.startedAt = this.now();
    this.halted = false;
    this.paused = false;
    this.nextId = 1;
    this.positions = [];   // bid / open
    this.closed = [];      // closed / failed, newest last
    this.watch = new Map(); // `${agent}:${mint}` -> { agent, mint, symbol, reason, ts }
    this.events = [];
    this.allocations = [];
    this.hour = 1;
    this.lastAllocationAt = this.startedAt;
    this.books = Object.fromEntries(agents.map(a => [a.name, this.newBook(cfg.startBankroll)]));
  }

  newBook(cash) {
    return { cash, start: cash, hourStart: cash, entries: [], lastLossAt: 0, wins: 0, losses: 0, fees: 0, realized: 0 };
  }

  log(kind, agent, token, text) {
    const e = { ts: this.now(), kind, agent, token, text };
    this.events.push(e);
    if (this.events.length > MAX_EVENTS) this.events.shift();
    this.emit('event', e);
  }

  // ---- valuation -------------------------------------------------------

  positionValue(p) {
    if (p.state === 'bid') return p.solIn;
    const t = this.market.tokens.get(p.mint);
    if (!t) return p.lastValue ?? 0;
    p.lastValue = quoteSell(t, p.tokens, this.cfg.execution).sol;
    return p.lastValue;
  }

  equity(name) {
    let eq = this.books[name].cash;
    for (const p of this.positions) if (p.agent === name) eq += this.positionValue(p);
    return eq;
  }

  teamEquity() { return this.agents.reduce((s, a) => s + this.equity(a.name), 0); }
  teamStart() { return Object.values(this.books).reduce((s, b) => s + b.start, 0); }

  // ---- main loop -------------------------------------------------------

  tick() {
    const now = this.now();
    this.fillBids(now);
    this.manageExits(now);
    if (!this.paused) this.scan(now);
    this.checkDrawdown();
    if (now - this.lastAllocationAt >= this.cfg.allocation.intervalMin * 60_000) this.reallocate(now);
    for (const [k, w] of this.watch) if (now - w.ts > WATCH_TTL_MS) this.watch.delete(k);
    this.market.prune(now, new Set(this.positions.map(p => p.mint)));
  }

  canEnter(agent, now) {
    const b = this.books[agent.name];
    const r = this.cfg.risk;
    if (this.halted) return false;
    if (this.positions.filter(p => p.agent === agent.name).length >= r.maxOpenPerAgent) return false;
    b.entries = b.entries.filter(ts => now - ts < 3_600_000);
    if (b.entries.length >= r.maxEntriesPerAgentPerHour) return false;
    if (now - b.lastLossAt < r.cooldownAfterLossSec * 1000) return false;
    return this.entrySize(agent) > 0;
  }

  entrySize(agent) {
    const b = this.books[agent.name];
    const ex = this.cfg.execution;
    const reserve = (ex.priorityFeeSol + ex.bribeSol) * 2; // keep enough for the exit tx
    const size = Math.max(ex.minEntrySol, b.cash * this.cfg.risk.positionPct / 100);
    return b.cash - reserve >= size ? size : 0;
  }

  scan(now) {
    for (const agent of this.agents) {
      if (!this.canEnter(agent, now)) continue;
      for (const t of this.market.tokens.values()) {
        if (this.positions.some(p => p.mint === t.mint)) continue; // one team position per token
        const sig = agent.evaluate(t, now, this.market);
        if (!sig) continue;
        const key = `${agent.name}:${t.mint}`;
        if (sig.action === 'watch') {
          if (!this.watch.has(key)) this.log('watch', agent.name, t.symbol, sig.reason);
          this.watch.set(key, { agent: agent.name, mint: t.mint, symbol: t.symbol, reason: sig.reason, ts: now });
          continue;
        }
        const safe = checkSafety(t, this.market, this.cfg);
        if (!safe.ok) {
          if (!this.watch.has(key)) this.log('skip', agent.name, t.symbol, `signal skipped: ${safe.reason}`);
          this.watch.set(key, { agent: agent.name, mint: t.mint, symbol: t.symbol, reason: `skip: ${safe.reason}`, ts: now });
          continue;
        }
        this.watch.delete(key);
        this.placeBid(agent, t, sig.reason, now);
        break; // one entry per agent per tick
      }
    }
  }

  placeBid(agent, t, reason, now) {
    const b = this.books[agent.name];
    const size = this.entrySize(agent);
    b.cash -= size;
    b.entries.push(now);
    const p = {
      id: this.nextId++, agent: agent.name, mint: t.mint, symbol: t.symbol, url: t.axiomUrl(),
      state: 'bid', solIn: size, quotePrice: t.price, placedAt: now, fillAt: now + this.cfg.execution.latencyMs,
      reason, tokens: 0, fees: 0, peakPct: 0,
    };
    this.positions.push(p);
    this.log('bid', agent.name, t.symbol, `${size.toFixed(3)} SOL @ MC $${Math.round(t.mcapSol * this.cfg.solUsd)} — ${reason}`);
  }

  fillBids(now) {
    for (const p of [...this.positions]) {
      if (p.state !== 'bid' || now < p.fillAt) continue;
      const t = this.market.tokens.get(p.mint);
      const b = this.books[p.agent];
      const r = t ? fillBuy(t, p.solIn, p.quotePrice, this.cfg.execution) : { ok: false, cost: this.cfg.execution.priorityFeeSol, reason: 'token gone' };
      if (!r.ok) {
        b.cash += p.solIn - r.cost;
        b.fees += r.cost;
        this.finish(p, 'failed', r.reason, p.solIn - r.cost, now);
        this.log('fail', p.agent, p.symbol, `buy failed (${r.reason}), tx fee ${r.cost.toFixed(4)} SOL`);
        continue;
      }
      b.cash -= r.cost;
      p.fees = r.fee + r.cost;
      b.fees += p.fees;
      p.tokens = r.tokens;
      p.entryPrice = r.avgPrice;
      p.cost = p.solIn + r.cost;
      p.openedAt = now;
      p.state = 'open';
      this.log('fill', p.agent, p.symbol, `filled ${p.solIn.toFixed(3)} SOL, avg MC $${Math.round(r.avgPrice * 1e9 * this.cfg.solUsd)}`);
    }
  }

  manageExits(now) {
    for (const p of [...this.positions]) {
      if (p.state !== 'open') continue;
      const c = this.cfg.agents[p.agent];
      const t = this.market.tokens.get(p.mint);
      if (!t) continue;
      const value = this.positionValue(p);
      const pnlPct = (value / p.cost - 1) * 100;
      p.pnlPct = pnlPct;
      p.peakPct = Math.max(p.peakPct, pnlPct);
      let why = null;
      if (pnlPct >= c.takeProfitPct) why = 'take profit';
      else if (pnlPct <= -c.stopLossPct) why = 'stop';
      else if (p.peakPct >= c.trailActivatePct && pnlPct <= p.peakPct - c.trailPct) why = 'trailing stop';
      else if (now - p.openedAt >= c.maxHoldMin * 60_000) why = 'time exit';
      else if (now - t.lastTradeAt > 120_000) why = 'no activity';
      if (why) this.sell(p, t, why, now);
    }
  }

  sell(p, t, why, now) {
    const b = this.books[p.agent];
    const r = fillSell(t, p.tokens, this.cfg.execution);
    const net = r.sol - r.cost;
    b.cash += net;
    b.fees += r.fee + r.cost;
    p.fees += r.fee + r.cost;
    const pnl = net - p.cost;
    b.realized += pnl;
    if (pnl >= 0) b.wins++; else { b.losses++; b.lastLossAt = now; }
    this.finish(p, 'closed', why, net, now);
    this.log(why === 'take profit' || pnl >= 0 ? 'win' : 'stop', p.agent, p.symbol,
      `${why}: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL (${p.pnlPct >= 0 ? '+' : ''}${(p.pnlPct ?? 0).toFixed(1)}%)`);
  }

  finish(p, state, why, solOut, now) {
    p.state = state;
    p.exitReason = why;
    p.solOut = solOut;
    p.closedAt = now;
    p.pnl = solOut - (p.cost ?? p.solIn);
    this.positions = this.positions.filter(x => x !== p);
    this.closed.push(p);
    if (this.closed.length > MAX_CLOSED) this.closed.shift();
    this.emit('closed', p);
  }

  closeAll(why = 'manual') {
    const now = this.now();
    for (const p of [...this.positions]) {
      const t = this.market.tokens.get(p.mint);
      if (p.state === 'bid') {
        this.books[p.agent].cash += p.solIn;
        this.finish(p, 'failed', 'cancelled', p.solIn, now);
      } else if (t) this.sell(p, t, why, now);
    }
  }

  checkDrawdown() {
    const ddPct = (1 - this.teamEquity() / this.teamStart()) * 100;
    if (!this.halted && ddPct >= this.cfg.risk.teamMaxDrawdownPct) {
      this.halted = true;
      this.log('halt', 'TEAM', '', `drawdown ${ddPct.toFixed(1)}% — new entries stopped`);
    }
  }

  // Worst agent of the hour hands transferPct of its free cash to the best one.
  reallocate(now) {
    const ranked = this.agents
      .map(a => ({ name: a.name, ret: this.hourReturn(a.name) }))
      .sort((a, b) => b.ret - a.ret);
    if (ranked.length >= 2) {
      const best = ranked[0], worst = ranked[ranked.length - 1];
      const amount = this.books[worst.name].cash * this.cfg.allocation.transferPct / 100;
      if (best.ret > worst.ret && amount > 0.0001) {
        this.books[worst.name].cash -= amount;
        this.books[best.name].cash += amount;
        const a = { ts: now, hour: this.hour, from: worst.name, to: best.name, amount };
        this.allocations.push(a);
        this.log('transfer', 'ALLOC', '', `${worst.name} → ${best.name} ${amount.toFixed(4)} SOL / ${this.cfg.allocation.transferPct}% bankroll`);
      }
    }
    this.hour++;
    this.lastAllocationAt = now;
    for (const a of this.agents) this.books[a.name].hourStart = this.equity(a.name);
  }

  hourReturn(name) {
    const b = this.books[name];
    return b.hourStart > 0 ? (this.equity(name) / b.hourStart - 1) * 100 : 0;
  }

  // ---- UI snapshot & persistence --------------------------------------

  snapshot(extra = {}) {
    const now = this.now();
    const teamEq = this.teamEquity();
    const start = this.teamStart();
    const agents = this.agents.map(a => {
      const b = this.books[a.name];
      const eq = this.equity(a.name);
      const pos = this.positions.filter(p => p.agent === a.name);
      const last = pos[pos.length - 1] || [...this.closed].reverse().find(p => p.agent === a.name);
      return {
        name: a.name, style: a.style, cash: b.cash, equity: eq,
        hourReturnPct: this.hourReturn(a.name), totalReturnPct: (eq / b.start - 1) * 100,
        share: teamEq > 0 ? eq / teamEq * 100 : 0,
        wins: b.wins, losses: b.losses, fees: b.fees, open: pos.length,
        current: last ? { symbol: last.symbol, state: last.state, pnlPct: last.state === 'open' ? last.pnlPct ?? 0 : (last.pnl / (last.cost ?? last.solIn)) * 100, exitReason: last.exitReason } : null,
      };
    });
    const row = p => ({
      id: p.id, agent: p.agent, symbol: p.symbol, mint: p.mint, url: p.url, state: p.state,
      solIn: p.solIn, pnl: p.state === 'open' ? this.positionValue(p) - p.cost : p.pnl ?? 0,
      pnlPct: p.state === 'open' ? p.pnlPct ?? 0 : p.pnl != null ? p.pnl / (p.cost ?? p.solIn) * 100 : 0,
      reason: p.exitReason || p.reason, ts: p.closedAt || p.openedAt || p.placedAt,
    });
    const watching = [...this.watch.values()].slice(-12).map(w => ({ agent: w.agent, symbol: w.symbol, mint: w.mint, state: 'watch', reason: w.reason, ts: w.ts }));
    return {
      now, startedAt: this.startedAt, hour: this.hour, paused: this.paused, halted: this.halted,
      nextAllocationAt: this.lastAllocationAt + this.cfg.allocation.intervalMin * 60_000,
      team: { start, equity: teamEq, pnl: teamEq - start, pnlPct: (teamEq / start - 1) * 100 },
      agents,
      open: this.positions.map(row),
      closed: this.closed.slice(-40).reverse().map(row),
      watching,
      allocations: this.allocations.slice(-12).reverse(),
      events: this.events.slice(-80).reverse(),
      ...extra,
    };
  }

  toJSON() {
    return {
      startedAt: this.startedAt, hour: this.hour, lastAllocationAt: this.lastAllocationAt, nextId: this.nextId,
      halted: this.halted, books: this.books, positions: this.positions, closed: this.closed,
      allocations: this.allocations, events: this.events,
    };
  }

  // Restores bankrolls and history. Positions open before a restart are closed
  // at their last known value: the market data they depend on is gone.
  restore(s) {
    Object.assign(this, {
      startedAt: s.startedAt, hour: s.hour, lastAllocationAt: s.lastAllocationAt, nextId: s.nextId,
      halted: s.halted, closed: s.closed || [], allocations: s.allocations || [], events: s.events || [],
    });
    for (const [name, b] of Object.entries(s.books || {})) if (this.books[name]) this.books[name] = { ...this.books[name], ...b };
    const now = this.now();
    for (const p of s.positions || []) {
      const value = p.state === 'bid' ? p.solIn : p.lastValue ?? 0;
      this.books[p.agent] && (this.books[p.agent].cash += value);
      p.state = p.state === 'bid' ? 'failed' : 'closed';
      p.exitReason = 'restart';
      p.solOut = value;
      p.pnl = value - (p.cost ?? p.solIn);
      p.closedAt = now;
      this.closed.push(p);
    }
    this.log('info', 'TEAM', '', 'state restored');
  }
}
