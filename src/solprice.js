// Keeps cfg.solUsd close to the market so USD thresholds (MC filters) stay meaningful.
const SOURCES = [
  ['CoinGecko', 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', d => d?.solana?.usd],
  ['Binance', 'https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT', d => Number(d?.price)],
  ['Coinbase', 'https://api.coinbase.com/v2/prices/SOL-USD/spot', d => Number(d?.data?.amount)],
];

export async function fetchSolUsd() {
  for (const [name, url, pick] of SOURCES) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const price = pick(await res.json());
      if (price > 1 && price < 100_000) return { price, source: name };
    } catch {}
  }
  return null;
}

export function trackSolUsd(cfg, onUpdate, everyMs = 5 * 60_000) {
  const run = async () => {
    const r = await fetchSolUsd();
    if (r) { cfg.solUsd = r.price; onUpdate?.(r); }
  };
  run();
  return setInterval(run, everyMs);
}
