// Default settings. Override any of them in config.local.json (same structure).
// Thresholds marked "usd" are converted to SOL with solUsd.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const defaults = {
  port: 3777,
  openBrowser: true,
  solUsd: 180,

  // Start capital per agent, SOL (video: 1 SOL for the whole team).
  startBankroll: 0.25,

  // Paper execution: mimics Axiom costs (see guide, "Комиссии и настройки").
  execution: {
    platformFeePct: 1.0,     // 1% buy + 1% sell
    priorityFeeSol: 0.001,
    bribeSol: 0.001,         // Jito tip
    slippagePct: 15,         // max tolerated move vs. quote, 10-20% on fresh tokens
    latencyMs: 1500,         // time between decision and fill
    minEntrySol: 0.05,       // guide: min 0.05-0.1 SOL per entry
  },

  // Team-wide risk.
  risk: {
    positionPct: 30,             // % of agent cash per entry
    maxOpenPerAgent: 2,
    maxEntriesPerAgentPerHour: 6, // guide: 5-8 trades per session on a small balance
    teamMaxDrawdownPct: 40,      // stop all new entries below this
    cooldownAfterLossSec: 60,    // "не мсти рынку"
  },

  // Hourly capital reallocation from the worst agent to the best one.
  allocation: {
    intervalMin: 60,
    transferPct: 50,
  },

  // Safety filters every agent applies before entering ("Как читать метрики").
  safety: {
    maxTop10Pct: 25,
    maxDevHoldingPct: 10,
    maxSnipersPct: 15,
    minHolders: 15,
    minUniqueBuyers: 10,
    sniperWindowSec: 15,
    vampCheck: true,
  },

  // Token tracking.
  market: {
    maxWatched: 400,
    dropAfterIdleSec: 240,     // stop following tokens with no trades
    dropBelowMcapUsd: 3000,    // ...or that died after the first minutes
    dropCheckAfterSec: 300,
  },

  agents: {
    COLE: {
      enabled: true, style: 'momentum',
      maxAgeMin: 20, minMcapUsd: 6000, maxMcapUsd: 60000,
      windowSec: 60, minVolumeSol: 4, minBuySellRatio: 1.5, minPriceChangePct: 15, minBuyers: 8,
      takeProfitPct: 40, stopLossPct: 15, trailActivatePct: 20, trailPct: 12, maxHoldMin: 10,
    },
    RINA: {
      enabled: true, style: 'pullbacks',
      maxAgeMin: 45, minMcapUsd: 8000, maxMcapUsd: 120000,
      minRunPct: 80, pullbackMinPct: 25, pullbackMaxPct: 45, windowSec: 30, minVolumeSol: 1.5,
      takeProfitPct: 35, stopLossPct: 18, trailActivatePct: 20, trailPct: 12, maxHoldMin: 15,
    },
    VINCE: {
      enabled: true, style: 'liquidity',
      minCurvePct: 40, maxCurvePct: 92, minGlobalFeesSol: 0.5, liquidityWindowSec: 120,
      minLiquidityGrowthPct: 15, minHolders: 40,
      takeProfitPct: 50, stopLossPct: 20, trailActivatePct: 25, trailPct: 15, maxHoldMin: 20,
    },
    OWEN: {
      enabled: true, style: 'survivor',
      minAgeMin: 20, minMcapUsd: 15000, maxTop10Pct: 20, maxSnipersPct: 5,
      trendWindowMin: 10, minTrendPct: 10, maxDrawdownFromHighPct: 40, minVolumeSol5m: 3,
      takeProfitPct: 60, stopLossPct: 25, trailActivatePct: 30, trailPct: 20, maxHoldMin: 60,
    },
  },
};

function merge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = base && typeof base[k] === 'object' && !Array.isArray(base[k]) ? merge(base[k], v) : v;
  }
  return out;
}

export function loadConfig(overrides = {}) {
  const localPath = path.join(ROOT, 'config.local.json');
  const local = existsSync(localPath) ? JSON.parse(readFileSync(localPath, 'utf8')) : {};
  return merge(merge(defaults, local), overrides);
}
