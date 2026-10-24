// Pre-entry checks from the guide ("Как читать метрики перед покупкой", "Вампы").
export function checkSafety(token, market, cfg) {
  const s = cfg.safety;
  const h = token.holderStats();
  if (h.holders < s.minHolders) return { ok: false, reason: `holders ${h.holders}<${s.minHolders}` };
  if (h.top10Pct > s.maxTop10Pct) return { ok: false, reason: `top10 ${h.top10Pct.toFixed(0)}%` };
  if (h.devPct > s.maxDevHoldingPct) return { ok: false, reason: `dev ${h.devPct.toFixed(0)}%` };
  if (h.snipersPct > s.maxSnipersPct) return { ok: false, reason: `snipers ${h.snipersPct.toFixed(0)}%` };
  if (s.vampCheck && market.isVamp(token)) return { ok: false, reason: 'vamp' };
  return { ok: true, holders: h };
}
