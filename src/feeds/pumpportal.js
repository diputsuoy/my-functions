// Live pump.fun data from the free PumpPortal websocket (read-only, no wallet).
// Docs: https://pumpportal.fun/data-api/real-time
import { EventEmitter } from 'node:events';
import { appendFileSync } from 'node:fs';

const URL = process.env.PUMPPORTAL_URL || 'wss://pumpportal.fun/api/data';
const CONNECT_TIMEOUT_MS = 15_000;
const STALE_MS = 60_000;       // no messages this long on an open socket -> reconnect
const SUBSCRIBE_CHUNK = 100;
const SAMPLE_LIMIT = 200;

export class PumpPortalFeed extends EventEmitter {
  constructor({ samplePath = null } = {}) {
    super();
    this.status = 'connecting';
    this.subscribed = new Set();
    this.retry = 0;
    this.samplePath = samplePath;
    this.stats = {
      startedAt: Date.now(), connectedAt: null, lastMessageAt: null, messages: 0,
      creates: 0, trades: 0, migrations: 0, unknown: 0, reconnects: 0, lastError: null, lastServerMessage: null,
    };
    this.samples = 0;
    this.decoder = new TextDecoder();
  }

  start() {
    if (typeof WebSocket === 'undefined') {
      this.setStatus('error', 'В этой версии Node.js нет WebSocket. Установите Node.js 22.4+ (лучше 24 LTS) с nodejs.org');
      return;
    }
    this.stopped = false;
    let ws;
    try {
      ws = new WebSocket(URL);
    } catch (e) {
      this.setStatus('error', e.message);
      return this.reconnect();
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.setStatus('connecting');
    clearTimeout(this.connectTimer);
    this.connectTimer = setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        this.stats.lastError = 'таймаут подключения к pumpportal.fun';
        try { ws.close(); } catch {}
        this.reconnect();
      }
    }, CONNECT_TIMEOUT_MS);

    ws.addEventListener('open', () => {
      clearTimeout(this.connectTimer);
      this.retry = 0;
      this.stats.connectedAt = Date.now();
      this.stats.lastMessageAt = Date.now();
      this.send({ method: 'subscribeNewToken' });
      this.send({ method: 'subscribeMigration' });
      const keys = [...this.subscribed];
      for (let i = 0; i < keys.length; i += SUBSCRIBE_CHUNK) {
        this.send({ method: 'subscribeTokenTrade', keys: keys.slice(i, i + SUBSCRIBE_CHUNK) });
      }
      this.setStatus('live');
      this.watchdog();
    });
    ws.addEventListener('message', m => this.onMessage(m.data));
    ws.addEventListener('close', e => {
      if (ws !== this.ws) return;
      if (e.code && e.code !== 1000) this.stats.lastError = `соединение закрыто (код ${e.code}${e.reason ? `: ${e.reason}` : ''})`;
      this.reconnect();
    });
    ws.addEventListener('error', e => {
      this.stats.lastError = e?.message || e?.error?.message || 'ошибка WebSocket (нет доступа к pumpportal.fun?)';
    });
  }

  onMessage(data) {
    const text = typeof data === 'string' ? data : this.decoder.decode(data);
    this.stats.messages++;
    this.stats.lastMessageAt = Date.now();
    if (this.samplePath && this.samples < SAMPLE_LIMIT) {
      this.samples++;
      try { appendFileSync(this.samplePath, text + '\n'); } catch {}
    }
    let d;
    try { d = JSON.parse(text); } catch { this.stats.unknown++; return; }
    if (d.message || d.errors) { this.stats.lastServerMessage = d.message || JSON.stringify(d.errors); return; }
    const ev = normalize(d);
    if (!ev) { this.stats.unknown++; return; }
    if (ev.type === 'create') this.stats.creates++;
    else if (ev.type === 'trade') this.stats.trades++;
    else this.stats.migrations++;
    this.emit('event', ev);
  }

  watchdog() {
    clearInterval(this.watchTimer);
    this.watchTimer = setInterval(() => {
      if (this.status === 'live' && Date.now() - this.stats.lastMessageAt > STALE_MS) {
        this.stats.lastError = 'нет сообщений больше минуты — переподключаемся';
        try { this.ws.close(); } catch {}
        this.reconnect();
      }
    }, 5000);
  }

  setStatus(s, error) {
    this.status = s;
    if (error) this.stats.lastError = error;
    this.emit('status', s);
  }

  reconnect() {
    if (this.stopped || this.reconnectTimer) return;
    clearInterval(this.watchTimer);
    this.ws = null;
    this.stats.reconnects++;
    this.setStatus('reconnecting');
    const delay = Math.min(30_000, 1000 * 2 ** this.retry++);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.start(); }, delay);
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
    for (let i = 0; i < keys.length; i += SUBSCRIBE_CHUNK) {
      this.send({ method: 'unsubscribeTokenTrade', keys: keys.slice(i, i + SUBSCRIBE_CHUNK) });
    }
  }

  stop() {
    this.stopped = true;
    clearInterval(this.watchTimer);
    clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}

const num = v => (v == null || v === '' ? undefined : Number(v));

export function normalize(d) {
  const ts = Date.now();
  if (!d || typeof d !== 'object' || !d.mint) return null;
  if (d.txType === 'create') {
    return {
      type: 'create', ts, mint: d.mint, name: d.name, symbol: d.symbol, creator: d.traderPublicKey,
      bondingCurveKey: d.bondingCurveKey, pool: d.pool, vSol: num(d.vSolInBondingCurve), vTokens: num(d.vTokensInBondingCurve),
      mcapSol: num(d.marketCapSol), initialBuyTokens: num(d.initialBuy), initialBuySol: num(d.solAmount),
    };
  }
  if (d.txType === 'buy' || d.txType === 'sell') {
    return {
      type: 'trade', ts, mint: d.mint, side: d.txType, trader: d.traderPublicKey,
      sol: num(d.solAmount) || 0, tokens: num(d.tokenAmount) || 0,
      vSol: num(d.vSolInBondingCurve), vTokens: num(d.vTokensInBondingCurve), mcapSol: num(d.marketCapSol),
    };
  }
  if (d.txType === 'migrate' || (d.pool && d.signature && !d.txType)) {
    return { type: 'migrate', ts, mint: d.mint, pool: d.pool };
  }
  return null;
}
