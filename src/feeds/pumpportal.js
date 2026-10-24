// Live pump.fun data from the free PumpPortal websocket (read-only, no wallet).
// Docs: https://pumpportal.fun/data-api/real-time
import { EventEmitter } from 'node:events';

const URL = 'wss://pumpportal.fun/api/data';

export class PumpPortalFeed extends EventEmitter {
  constructor() {
    super();
    this.status = 'connecting';
    this.subscribed = new Set();
    this.retry = 0;
  }

  start() {
    const ws = new WebSocket(URL);
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.status = 'live';
      this.retry = 0;
      this.send({ method: 'subscribeNewToken' });
      this.send({ method: 'subscribeMigration' });
      if (this.subscribed.size) this.send({ method: 'subscribeTokenTrade', keys: [...this.subscribed] });
      this.emit('status', this.status);
    });
    ws.addEventListener('message', m => {
      let d;
      try { d = JSON.parse(m.data); } catch { return; }
      const ev = normalize(d);
      if (ev) this.emit('event', ev);
    });
    ws.addEventListener('close', () => this.reconnect());
    ws.addEventListener('error', () => {});
  }

  reconnect() {
    this.status = 'reconnecting';
    this.emit('status', this.status);
    const delay = Math.min(30_000, 1000 * 2 ** this.retry++);
    setTimeout(() => this.start(), delay);
  }

  send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  follow(mint) {
    if (this.subscribed.has(mint)) return;
    this.subscribed.add(mint);
    this.send({ method: 'subscribeTokenTrade', keys: [mint] });
  }

  unfollow(mints) {
    const keys = mints.filter(m => this.subscribed.delete(m));
    if (keys.length) this.send({ method: 'unsubscribeTokenTrade', keys });
  }

  stop() { this.ws?.close(); }
}

export function normalize(d) {
  const ts = Date.now();
  if (d.txType === 'create') {
    return {
      type: 'create', ts, mint: d.mint, name: d.name, symbol: d.symbol, creator: d.traderPublicKey,
      bondingCurveKey: d.bondingCurveKey, pool: d.pool, vSol: d.vSolInBondingCurve, vTokens: d.vTokensInBondingCurve,
      mcapSol: d.marketCapSol, initialBuyTokens: d.initialBuy, initialBuySol: d.solAmount,
    };
  }
  if (d.txType === 'buy' || d.txType === 'sell') {
    return {
      type: 'trade', ts, mint: d.mint, side: d.txType, trader: d.traderPublicKey,
      sol: Number(d.solAmount) || 0, tokens: Number(d.tokenAmount) || 0,
      vSol: d.vSolInBondingCurve, vTokens: d.vTokensInBondingCurve, mcapSol: d.marketCapSol,
    };
  }
  if (d.txType === 'migrate' || (d.mint && d.pool && d.signature && !d.txType)) {
    return { type: 'migrate', ts, mint: d.mint, pool: d.pool };
  }
  return null;
}
