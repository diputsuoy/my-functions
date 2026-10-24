// Paper execution against a constant-product pool (pump.fun curve or AMM),
// with Axiom-like fees. Nothing here touches a real wallet.

// Pool reserves for a token: SOL side is vSol, token side follows from the price.
function reserves(token) {
  const x = Math.max(token.vSol || 0, 1e-9);
  const y = x / Math.max(token.price, 1e-18);
  return { x, y };
}

export function quoteBuy(token, sol, exec) {
  const fee = sol * exec.platformFeePct / 100;
  const solIn = sol - fee;
  const { x, y } = reserves(token);
  const tokens = y - (x * y) / (x + solIn);
  return { tokens, fee, avgPrice: solIn / tokens, impactPct: (solIn / tokens / token.price - 1) * 100 };
}

export function quoteSell(token, tokens, exec) {
  const { x, y } = reserves(token);
  const gross = x - (x * y) / (y + tokens);
  const fee = gross * exec.platformFeePct / 100;
  return { sol: gross - fee, fee, gross };
}

export function txCost(exec, landed = true) {
  return exec.priorityFeeSol + (landed ? exec.bribeSol : 0);
}

// Fill a buy placed at quotePrice. Fails if the price moved past slippage.
export function fillBuy(token, sol, quotePrice, exec) {
  const q = quoteBuy(token, sol, exec);
  const limit = quotePrice * (1 + exec.slippagePct / 100);
  if (!(q.tokens > 0) || q.avgPrice > limit) {
    return { ok: false, cost: txCost(exec, false), reason: `slippage ${(q.avgPrice / quotePrice * 100 - 100).toFixed(1)}%` };
  }
  return { ok: true, tokens: q.tokens, fee: q.fee, cost: txCost(exec, true), avgPrice: q.avgPrice };
}

// Sells always land in paper mode (Axiom would retry); they simply get the delayed price.
export function fillSell(token, tokens, exec) {
  const q = quoteSell(token, tokens, exec);
  return { ok: true, sol: Math.max(0, q.sol), fee: q.fee, cost: txCost(exec, true) };
}
