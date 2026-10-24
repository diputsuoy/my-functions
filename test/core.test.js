import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { Market, Token, TOTAL_SUPPLY } from '../src/market.js';
import { Team } from '../src/team.js';
import { createAgents } from '../src/agents/index.js';
import { quoteBuy, quoteSell, fillBuy } from '../src/paper.js';
import { SimulatorFeed } from '../src/feeds/simulator.js';

const cfg = loadConfig();
const T0 = 1_700_000_000_000;
const create = (mint, extra = {}) => ({ type: 'create', ts: T0, mint, symbol: 'TEST', name: 'Test', creator: 'dev', vSol: 30, vTokens: 1_073_000_000, ...extra });

test('round trip costs the platform fee on both sides', () => {
  const t = new Token(create('m1'), cfg);
  const exec = { ...cfg.execution };
  const b = quoteBuy(t, 0.1, exec);
  // Move the pool by our own buy, then sell back: only the two fees are lost.
  const vSol = t.vSol + 0.1 * 0.99, vTokens = t.vTokens - b.tokens;
  t.applyTrade({ ts: T0 + 1, side: 'buy', trader: 'me', sol: 0.1, tokens: b.tokens, vSol, vTokens });
  const s = quoteSell(t, b.tokens, exec);
  assert.ok(Math.abs(s.sol - 0.1 * 0.99 * 0.99) < 1e-6, `got ${s.sol}`);
});

test('buy fails when the price ran past slippage', () => {
  const t = new Token(create('m2'), cfg);
  const quote = t.price;
  t.applyTrade({ ts: T0 + 1000, side: 'buy', trader: 'w', sol: 10, tokens: 1e8, vSol: 40, vTokens: 805_000_000 });
  const r = fillBuy(t, 0.1, quote, cfg.execution);
  assert.equal(r.ok, false);
  assert.equal(r.cost, cfg.execution.priorityFeeSol);
});

test('holder stats, dev share and curve progress', () => {
  const t = new Token(create('m3', { initialBuyTokens: 50_000_000, initialBuySol: 1.5 }), cfg);
  t.applyTrade({ ts: T0 + 5000, side: 'buy', trader: 'sniper', sol: 1, tokens: 30_000_000, vSol: 32.5, vTokens: 990_000_000 });
  t.applyTrade({ ts: T0 + 60000, side: 'buy', trader: 'late', sol: 1, tokens: 20_000_000, vSol: 33.5, vTokens: 960_000_000 });
  const h = t.holderStats();
  assert.equal(h.holders, 3);
  assert.equal(h.devPct, 5);
  assert.equal(h.snipersPct, 3);
  assert.equal(h.top10Pct, 10);
  assert.ok(t.curvePct > 14 && t.curvePct < 15);
  assert.ok(Math.abs(t.mcapSol - 33.5 / 960_000_000 * TOTAL_SUPPLY) < 1e-9);
});

test('smaller token with the same ticker is a vamp', () => {
  const m = new Market(cfg);
  m.handle(create('main'));
  m.handle(create('copy'));
  m.handle({ type: 'trade', ts: T0 + 1, mint: 'main', side: 'buy', trader: 'w', sol: 5, tokens: 1e8, vSol: 35, vTokens: 920_000_000 });
  assert.equal(m.isVamp(m.tokens.get('copy')), true);
  assert.equal(m.isVamp(m.tokens.get('main')), false);
});

test('hourly reallocation moves half of the worst cash to the best agent', () => {
  let now = T0;
  const m = new Market(cfg);
  const team = new Team(cfg, createAgents(cfg), m, () => now);
  team.books.COLE.cash = 0.5;  // best
  team.books.OWEN.cash = 0.1;  // worst
  now += 60 * 60_000;
  team.reallocate(now);
  assert.equal(team.allocations.length, 1);
  assert.equal(team.allocations[0].from, 'OWEN');
  assert.equal(team.allocations[0].to, 'COLE');
  assert.ok(Math.abs(team.books.OWEN.cash - 0.05) < 1e-12);
  assert.ok(Math.abs(team.books.COLE.cash - 0.55) < 1e-12);
  assert.equal(team.hour, 2);
});

test('demo market: team trades and books stay consistent', () => {
  let now = T0;
  const clock = () => now;
  const m = new Market(cfg);
  const team = new Team(cfg, createAgents(cfg), m, clock);
  const sim = new SimulatorFeed({ seed: 7, clock });
  sim.on('event', e => m.handle(e));
  for (let s = 0; s < 40 * 60 * 4; s++) { now += 250; sim.step(0.25); if (s % 4 === 0) team.tick(); }
  const snap = team.snapshot();
  assert.ok(team.closed.length > 0, 'expected some closed trades');
  assert.ok(Number.isFinite(snap.team.equity) && snap.team.equity > 0);
  for (const b of Object.values(team.books)) assert.ok(b.cash >= -1e-9, 'cash went negative');
  const realized = Object.values(team.books).reduce((s, b) => s + b.realized, 0);
  const failedCost = team.closed.filter(p => p.state === 'failed').reduce((s, p) => s + p.pnl, 0);
  const openPnl = team.positions.reduce((s, p) => s + team.positionValue(p) - (p.cost ?? p.solIn), 0);
  assert.ok(Math.abs(snap.team.pnl - (realized + failedCost + openPnl)) < 1e-9, 'P&L does not reconcile');
});
