// Dashboard: data arrives ~4x/s over SSE; everything visible is interpolated per
// animation frame, so motion stays smooth at any refresh rate (60–240 Hz).
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sgn = (v, d) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(d)}`;
const pad = n => String(Math.floor(n)).padStart(2, '0');
const dur = ms => { const s = Math.max(0, ms / 1000); return `${pad(s / 3600)}:${pad((s % 3600) / 60)}:${pad(s % 60)}`; };
const short = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return s < 60 ? `${s}с` : s < 3600 ? `${Math.floor(s / 60)}м ${pad(s % 60)}с` : `${Math.floor(s / 3600)}ч ${pad((s % 3600) / 60)}м`; };
const clock = ts => new Date(ts).toLocaleTimeString('ru-RU', { hour12: false });
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const AGENTS = {
  COLE: { role: 'Импульс', desc: 'входит, когда объём и цена резко растут' },
  RINA: { role: 'Откаты', desc: 'покупает откат после сильного роста' },
  VINCE: { role: 'Ликвидность', desc: 'токены перед миграцией с растущей ликвидностью' },
  OWEN: { role: 'Выжившие', desc: 'зрелые токены, которые продолжают расти' },
};
const EXIT = {
  'take profit': ['тейк-профит', 'win'], 'trailing stop': ['трейлинг', null], stop: ['стоп-лосс', 'loss'],
  'time exit': ['по времени', null], 'no activity': ['нет активности', null], manual: ['вручную', null],
  reset: ['сброс', null], restart: ['перезапуск', null], cancelled: ['отменено', 'fail'],
};
const REASONS = {
  age: 'слишком старые', too_young: 'слишком молодые', mcap: 'не та капитализация', volume: 'мало объёма',
  stale_high: 'хай был давно', no_run: 'не было роста', no_pullback: 'нет нужного отката', migrated: 'уже мигрировали',
  curve: 'не та стадия кривой', fees: 'мало Global Fees', holders: 'мало холдеров', concentration: 'топ-10/снайперы',
  drawdown: 'большая просадка', held: 'уже в позиции', watch: 'на радаре', buy: 'сигнал на вход',
  unsafe_holders: 'стоп: мало холдеров', unsafe_top10: 'стоп: топ-10', unsafe_dev: 'стоп: доля дева',
  unsafe_snipers: 'стоп: снайперы', unsafe_vamp: 'стоп: вамп',
  paused: 'пауза', halted: 'остановлен (просадка)', max_open: 'макс. позиций', hour_limit: 'лимит входов за час',
  cooldown: 'пауза после убытка', no_cash: 'мало денег на вход',
};

// ---------- animation core ----------------------------------------------

const active = new Set();
const frameHooks = new Set();

class Tween {
  constructor(render, tau = 160) { this.render = render; this.tau = tau; this.cur = null; this.to = null; }
  set(v) {
    if (!Number.isFinite(v)) return;
    if (this.cur === null) { this.cur = this.to = v; this.render(v); return; }
    if (v === this.to) return;
    this.to = v;
    active.add(this);
  }
  step(dt) {
    this.cur += (this.to - this.cur) * (1 - Math.exp(-dt / this.tau));
    if (Math.abs(this.to - this.cur) <= Math.abs(this.to) * 1e-7 + 1e-10) { this.cur = this.to; active.delete(this); }
    this.render(this.cur);
  }
}

// Animated number bound to an element; optional sign colouring and change flash.
class Num extends Tween {
  constructor(el, fmt, { sign = false, flash = false, tau } = {}) {
    super(v => { const t = fmt(v); if (t !== this.txt) { this.txt = t; el.textContent = t; } }, tau);
    this.el = el; this.sign = sign; this.flash = flash; this.lastFlash = 0;
  }
  set(v) {
    if (!Number.isFinite(v)) return;
    if (this.sign) { this.el.classList.toggle('pos', v >= 0); this.el.classList.toggle('neg', v < 0); }
    const now = performance.now();
    if (this.flash && this.to !== null && Math.abs(v - this.to) > 1e-7 && now - this.lastFlash > 600) {
      this.lastFlash = now;
      const c = v > this.to ? css('--green') : css('--red');
      this.el.animate([{ color: c, textShadow: `0 0 16px ${c}` }, {}], { duration: 700, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }
    super.set(v);
  }
}

let lastFrame = performance.now();
function frame(t) {
  const dt = Math.min(100, t - lastFrame);
  lastFrame = t;
  for (const tw of [...active]) tw.step(dt);
  for (const fn of frameHooks) fn(t, dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Text that only touches the DOM when it changes (timers updated every frame).
function setText(el, text) { if (el._t !== text) { el._t = text; el.textContent = text; } }

// Keyed list sync: existing rows are updated in place, new ones animate in.
function syncList(container, items, key, create, update, { animate = true, empty = null, leave = true } = {}) {
  const map = container._map || (container._map = new Map());
  const seen = new Set();
  let prev = null;
  for (const item of items) {
    const k = key(item);
    seen.add(k);
    let el = map.get(k);
    if (!el) {
      el = create(item);
      el.dataset.key = k;
      map.set(k, el);
      if (animate) { el.classList.add('enter'); el.addEventListener('animationend', () => el.classList.remove('enter'), { once: true }); }
    }
    update(el, item);
    const want = prev ? prev.nextSibling : container.firstChild;
    if (want !== el) container.insertBefore(el, want);
    prev = el;
  }
  for (const [k, el] of map) {
    if (seen.has(k)) continue;
    map.delete(k);
    if (leave && el.tagName !== 'TR') { el.classList.add('leave'); el.addEventListener('animationend', () => el.remove(), { once: true }); }
    else el.remove();
  }
  if (empty) {
    let e = container.querySelector(':scope > .empty');
    if (!items.length && !e) { e = document.createElement('div'); e.className = 'empty'; e.textContent = empty; container.appendChild(e); }
    else if (items.length && e) e.remove();
  }
}

const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; };

// ---------- equity chart --------------------------------------------------

class Chart {
  constructor(canvas) {
    this.c = canvas; this.ctx = canvas.getContext('2d');
    this.points = []; this.names = []; this.live = null; this.base = 0;
    this.yMin = new Tween(() => {}, 260); this.yMax = new Tween(() => {}, 260);
    this.hover = null;
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    canvas.addEventListener('pointermove', e => { const r = canvas.getBoundingClientRect(); this.hover = e.clientX - r.left; });
    canvas.addEventListener('pointerleave', () => { this.hover = null; $('tip').style.opacity = 0; });
    this.resize();
  }
  resize() {
    const r = this.c.parentElement.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = r.width; this.h = r.height;
    this.c.width = Math.round(r.width * dpr); this.c.height = Math.round(r.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  update(points, names, base) {
    if (points) { this.points = points; this.names = names; }
    this.base = base;
    const all = this.points.flatMap(p => [p[1]]).concat(base, this.live?.cur ?? base);
    let lo = Math.min(...all), hi = Math.max(...all);
    const padY = Math.max((hi - lo) * 0.18, base * 0.01);
    this.yMin.set(lo - padY); this.yMax.set(hi + padY);
  }
  draw(now) {
    const { ctx, w, h } = this;
    if (!w || !this.points.length) return;
    ctx.clearRect(0, 0, w, h);
    const top = 22, bottom = h - 18;
    const pts = this.points.slice();
    const liveTeam = this.live?.cur;
    if (liveTeam != null) pts.push([now, liveTeam, ...(this.liveAgents || []).map(t => t.cur)]);
    const t0 = pts[0][0], t1 = Math.max(now, t0 + 60_000);
    const yMin = this.yMin.cur ?? 0, yMax = this.yMax.cur ?? 1;
    const X = t => ((t - t0) / (t1 - t0)) * (w - 8);
    const Y = v => bottom - ((v - yMin) / (yMax - yMin || 1)) * (bottom - top);

    // grid + start line
    ctx.strokeStyle = '#1a222c'; ctx.lineWidth = 1;
    for (let i = 0; i <= 3; i++) { const y = top + (bottom - top) * i / 3; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
    ctx.setLineDash([4, 5]); ctx.strokeStyle = '#3a4656';
    ctx.beginPath(); ctx.moveTo(0, Y(this.base)); ctx.lineTo(w, Y(this.base)); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#5d6977'; ctx.font = '10px "JetBrains Mono", monospace';
    ctx.fillText(`старт ${this.base.toFixed(3)}`, 4, Y(this.base) - 5);
    ctx.fillText(yMax.toFixed(3), w - 46, top + 10); ctx.fillText(yMin.toFixed(3), w - 46, bottom - 4);

    // agents (faint), scaled to the team axis by share of team start
    ctx.save(); ctx.beginPath(); ctx.rect(0, top - 4, w, bottom - top + 8); ctx.clip();
    this.names.forEach((n, i) => {
      const scale = this.names.length;
      ctx.strokeStyle = css(`--${n}`) || '#888'; ctx.globalAlpha = 0.28; ctx.lineWidth = 1.2;
      ctx.beginPath();
      pts.forEach((p, j) => { const x = X(p[0]), y = Y(p[i + 2] * scale); j ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.stroke(); ctx.globalAlpha = 1;
    });
    ctx.restore();

    // team line with gradient fill
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, css('--sol-a')); grad.addColorStop(1, css('--sol-b'));
    ctx.beginPath();
    pts.forEach((p, j) => { const x = X(p[0]), y = Y(p[1]); j ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    const lastX = X(pts[pts.length - 1][0]), lastY = Y(pts[pts.length - 1][1]);
    ctx.strokeStyle = grad; ctx.lineWidth = 2.4; ctx.lineJoin = 'round'; ctx.stroke();
    ctx.lineTo(lastX, bottom); ctx.lineTo(X(pts[0][0]), bottom); ctx.closePath();
    const fill = ctx.createLinearGradient(0, top, 0, bottom);
    fill.addColorStop(0, 'rgba(20,241,149,.20)'); fill.addColorStop(1, 'rgba(153,69,255,0)');
    ctx.fillStyle = fill; ctx.fill();

    // pulsing live dot
    const pulse = (Math.sin(now / 260) + 1) / 2;
    ctx.fillStyle = 'rgba(20,241,149,.18)'; ctx.beginPath(); ctx.arc(lastX, lastY, 6 + pulse * 6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = css('--sol-b'); ctx.beginPath(); ctx.arc(lastX, lastY, 3.5, 0, Math.PI * 2); ctx.fill();

    // hover crosshair
    if (this.hover != null) {
      const t = t0 + (this.hover / (w - 8)) * (t1 - t0);
      let best = pts[0];
      for (const p of pts) if (Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p;
      const x = X(best[0]);
      ctx.strokeStyle = '#3a4656'; ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
      ctx.fillStyle = '#e9eef4'; ctx.beginPath(); ctx.arc(x, Y(best[1]), 3.5, 0, Math.PI * 2); ctx.fill();
      const tip = $('tip');
      tip.style.left = `${Math.min(w - 70, Math.max(70, x))}px`; tip.style.opacity = 1;
      setText(tip, `${clock(best[0])} · ${best[1].toFixed(4)} SOL (${sgn((best[1] / this.base - 1) * 100, 1)}%)`);
    }
  }
}

function sparkline(canvas, values, color, base) {
  const r = canvas.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (canvas.width !== Math.round(r.width * dpr)) { canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr); }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, r.width, r.height);
  if (values.length < 2) return;
  const lo = Math.min(base, ...values), hi = Math.max(base, ...values);
  const X = i => (i / (values.length - 1)) * r.width;
  const Y = v => r.height - 3 - ((v - lo) / (hi - lo || 1)) * (r.height - 6);
  ctx.setLineDash([2, 3]); ctx.strokeStyle = '#2a3442'; ctx.beginPath(); ctx.moveTo(0, Y(base)); ctx.lineTo(r.width, Y(base)); ctx.stroke(); ctx.setLineDash([]);
  ctx.beginPath(); values.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
  ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.stroke();
  ctx.lineTo(r.width, r.height); ctx.lineTo(0, r.height); ctx.closePath();
  const g = ctx.createLinearGradient(0, 0, 0, r.height); g.addColorStop(0, color + '33'); g.addColorStop(1, color + '00');
  ctx.fillStyle = g; ctx.fill();
}

// ---------- page state ----------------------------------------------------

const ui = {};
let S = null;
let initial = true;
const rate = []; // [ms, trades] samples for trades/min
const chart = new Chart($('chart'));

function setup() {
  ui.equity = new Num($('equity'), v => v.toFixed(4), { flash: true, tau: 220 });
  $('pnl').innerHTML = '<span id="pnl-sol"></span><span class="chip" id="pnl-pct"></span>';
  ui.pnl = new Num($('pnl-sol'), v => `${sgn(v, 4)} SOL`, { sign: true, tau: 220 });
  ui.pnlPct = new Num($('pnl-pct'), v => `${sgn(v, 2)}%`, { sign: true, tau: 220 });
  $('hero-meta').innerHTML = '<span id="m-start"></span><span id="m-elapsed"></span><span id="m-hour"></span>';
  chart.live = new Tween(() => {}, 220);

  $('stats').innerHTML = [
    ['trades', 'Сделок'], ['winrate', 'Винрейт'], ['best', 'Лучшая'], ['fees', 'Комиссии'],
  ].map(([k, l]) => `<div class="stat"><div class="eyebrow">${l}</div><div class="v" id="st-${k}">—</div></div>`).join('');
  ui.trades = new Num($('st-trades'), v => Math.round(v).toString());
  ui.winrate = new Num($('st-winrate'), v => `${v.toFixed(0)}%`);
  ui.best = new Num($('st-best'), v => sgn(v, 4), { sign: true });
  ui.fees = new Num($('st-fees'), v => v.toFixed(4));

  frameHooks.add(now => {
    chart.draw(Date.now());
    if (!S) return;
    setText($('m-elapsed'), `в работе ${dur(Date.now() - S.startedAt)}`);
    setText($('next-alloc'), `перераспределение через ${dur(S.nextAllocationAt - Date.now())}`);
    for (const el of document.querySelectorAll('[data-since]')) setText(el, short(Date.now() - Number(el.dataset.since)));
  });

  document.querySelectorAll('.tab').forEach(b => b.onclick = () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === b));
    $('tab-log').hidden = b.dataset.tab !== 'log';
    $('tab-diag').hidden = b.dataset.tab !== 'diag';
  });
  const post = async (action, ask) => { if (ask && !confirm(ask)) return; await fetch(`/api/${action}`, { method: 'POST' }); };
  $('pause').onclick = () => post(S?.paused ? 'resume' : 'pause');
  $('close-all').onclick = () => post('close-all', 'Закрыть все бумажные позиции по текущей цене?');
  $('reset').onclick = () => post('reset', 'Начать новую сессию? Балансы и история будут сброшены.');
}

// ---------- render --------------------------------------------------------

function render(s) {
  S = s;
  const f = s.feedStats || {};
  const live = s.mode === 'live';

  setText($('mode'), live ? 'Бумажная · живые данные' : 'Бумажная · демо-рынок');
  setText($('pause'), s.paused ? '▶ Продолжить' : '❚❚ Пауза');

  // trades per minute from a 60 s sliding window
  const t = Date.now();
  rate.push([t, f.trades || 0]);
  while (rate.length > 2 && t - rate[0][0] > 60_000) rate.shift();
  const span = (rate[rate.length - 1][0] - rate[0][0]) / 60_000;
  const perMin = span > 0.05 ? (rate[rate.length - 1][1] - rate[0][1]) / span : 0;
  const fresh = f.lastMessageAt && t - f.lastMessageAt < 15_000;
  const hs = $('health');
  hs.className = `health ${s.feed === 'live' || s.feed === 'demo' ? (fresh ? 'ok' : 'warn') : 'bad'}`;
  setText(hs.lastChild, s.feed === 'live' || s.feed === 'demo'
    ? (fresh ? `данные идут · ${Math.round(perMin)} сделок/мин` : 'подключено, ждём данные…')
    : s.feed === 'error' ? 'ошибка источника' : 'нет подключения');

  const b = banner(s);
  $('banner').hidden = !b;
  if (b) { $('banner').className = `banner ${b[0]}`; $('banner').innerHTML = `<b>${esc(b[1])}</b>${esc(b[2])}`; }

  // hero
  ui.equity.set(s.team.equity);
  ui.pnl.set(s.team.pnl);
  ui.pnlPct.set(s.team.pnlPct);
  chart.live.set(s.team.equity);
  chart.liveAgents = chart.liveAgents || s.agents.map(() => new Tween(() => {}, 220));
  s.agents.forEach((a, i) => chart.liveAgents[i]?.set(a.equity));
  chart.update(s.history?.points, s.history?.agents, s.team.start);
  setText($('m-start'), `старт ${s.team.start.toFixed(3)} SOL · ${new Date(s.startedAt).toLocaleString('ru-RU', { hour12: false })}`);
  setText($('m-hour'), `торговый час №${s.hour}${s.halted ? ' · входы остановлены (просадка)' : s.paused ? ' · пауза' : ''}`);
  if (s.history) {
    $('legend').innerHTML = `<span><i style="background:linear-gradient(90deg,var(--sol-a),var(--sol-b))"></i>команда</span>` +
      s.history.agents.map(n => `<span><i style="background:var(--${n})"></i>${n}</span>`).join('');
  }
  ui.trades.set(s.summary.trades);
  ui.winrate.set(s.summary.winRate);
  ui.best.set(s.summary.best);
  ui.fees.set(s.summary.fees);

  renderAgents(s);
  renderPositions(s);
  renderHistory(s);
  renderCapital(s);
  renderRadar(s);
  renderLog(s);
  renderDiag(s, perMin);
  initial = false;
}

function renderAgents(s) {
  const ranked = [...s.agents].sort((a, b) => b.hourReturnPct - a.hourReturnPct).map(a => a.name);
  const watching = {};
  for (const w of s.watching) watching[w.agent] = (watching[w.agent] || 0) + 1;
  syncList($('agents'), s.agents, a => a.name, a => {
    const el = h(`<article class="card agent" style="--c:var(--${a.name})">
      <div class="agent-top"><div class="avatar">${a.name[0]}</div>
        <div><div class="agent-name">${a.name}</div><div class="agent-role">${AGENTS[a.name]?.role || a.style}</div></div>
        <span class="rank"></span></div>
      <div class="agent-bal"><span class="num"><span class="eq"></span> <small class="muted">SOL</small></span><span class="ret"></span></div>
      <canvas></canvas>
      <div class="agent-grid"><div>за час<b class="hr"></b></div><div>W / L<b class="wl"></b></div><div>доля<b class="sh"></b></div></div>
      <div class="agent-now"><span class="dot"></span><span class="txt"></span><span class="num npnl"></span></div>
      <div class="why" title="${esc(AGENTS[a.name]?.desc)}"></div>
    </article>`);
    el._eq = new Num(el.querySelector('.eq'), v => v.toFixed(4), { flash: true });
    el._ret = new Num(el.querySelector('.ret'), v => `${sgn(v, 2)}%`, { sign: true });
    el._hr = new Num(el.querySelector('.hr'), v => `${sgn(v, 2)}%`, { sign: true });
    el._sh = new Num(el.querySelector('.sh'), v => `${v.toFixed(1)}%`);
    el._np = new Num(el.querySelector('.npnl'), v => `${sgn(v, 1)}%`, { sign: true });
    return el;
  }, (el, a) => {
    const rank = ranked.indexOf(a.name) + 1;
    el.classList.toggle('best', rank === 1 && a.hourReturnPct > 0);
    el.classList.toggle('worst', rank === ranked.length && a.hourReturnPct < 0);
    setText(el.querySelector('.rank'), `#${rank}`);
    el._eq.set(a.equity); el._ret.set(a.totalReturnPct); el._hr.set(a.hourReturnPct); el._sh.set(a.share);
    setText(el.querySelector('.wl'), `${a.wins} / ${a.losses}`);
    const now = el.querySelector('.agent-now');
    const pos = s.open.find(p => p.agent === a.name);
    let cls = 'scan', txt = 'ищет сигналы…';
    if (pos?.state === 'open') { cls = 'hold'; txt = `держит ${pos.symbol}`; el._np.set(pos.pnlPct); }
    else if (pos?.state === 'bid') { cls = 'buy'; txt = `покупает ${pos.symbol}…`; }
    else if (watching[a.name]) txt = `на радаре: ${watching[a.name]}`;
    now.className = `agent-now ${cls}`;
    el.querySelector('.npnl').hidden = cls !== 'hold';
    setText(now.querySelector('.txt'), txt);
    setText(el.querySelector('.why'), funnelText(a));
    if (s.history) {
      const i = s.history.agents.indexOf(a.name);
      sparkline(el.querySelector('canvas'), s.history.points.map(p => p[i + 2]), css(`--${a.name}`), s.team.start / s.agents.length);
    }
  }, { animate: initial });
}

function funnelText(a) {
  if (!a.scanned) return 'пока нет токенов для проверки';
  const top = Object.entries(a.funnel).sort((x, y) => y[1] - x[1]).slice(0, 3);
  return `проверено ${a.scanned}: ` + top.map(([k, v]) => `${REASONS[k] || k} ${v}`).join(' · ');
}

function tokenCell(p) {
  return p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener" title="Открыть в Axiom">${esc(p.symbol)}</a>` : `<span>${esc(p.symbol)}</span>`;
}

function renderPositions(s) {
  setText($('open-count'), s.open.length ? `${s.open.length} откр.` : '');
  syncList($('open'), s.open, p => String(p.id), p => {
    const el = h(`<div class="pos-row">
      <div class="tok">${tokenCell(p)}<small>${p.solIn.toFixed(3)} SOL · <span data-since="${p.openedAt}"></span></small></div>
      <span class="chip-agent" style="--c:var(--${p.agent})"><i></i>${p.agent}</span>
      <div class="rangebox"><div class="range"><span class="zero"></span><span class="mw" style="position:absolute;inset:0;will-change:transform"><span class="mark"></span></span></div>
        <div class="range-labels"><span>−${p.sl}%</span><span class="st"></span><span>+${p.tp}%</span></div></div>
      <div class="pnl"><b class="ps"></b><small class="pp"></small></div>
    </div>`);
    const lo = -(p.sl || 20), hi = p.tp || 40;
    el.querySelector('.zero').style.left = `${(-lo / (hi - lo)) * 100}%`;
    const mw = el.querySelector('.mw');
    el._mark = new Tween(v => { mw.style.transform = `translateX(${Math.max(0, Math.min(100, (v - lo) / (hi - lo) * 100))}%)`; }, 200);
    el._ps = new Num(el.querySelector('.ps'), v => `${sgn(v, 4)} SOL`, { sign: true });
    el._pp = new Num(el.querySelector('.pp'), v => `${sgn(v, 2)}%`, { sign: true });
    return el;
  }, (el, p) => {
    el._mark.set(p.pnlPct); el._ps.set(p.pnl); el._pp.set(p.pnlPct);
    setText(el.querySelector('.st'), p.state === 'bid' ? 'исполняется…' : p.entryReason?.split(':')[0] || '');
  }, { empty: 'Нет открытых позиций — боты ждут сигнала' });
}

function renderHistory(s) {
  const rows = s.closed.slice(0, 40);
  const wins = rows.filter(r => r.state === 'closed' && r.pnl >= 0).length;
  setText($('hist-hint'), rows.length ? `последние ${rows.length} · в плюс ${wins}` : '');
  syncList($('closed'), rows, p => String(p.id), p => {
    const [label, kind] = p.state === 'failed' ? ['не исполнено', 'fail'] : EXIT[p.reason] || [p.reason, null];
    const k = kind || (p.pnl >= 0 ? 'win' : 'loss');
    return h(`<table><tbody><tr>
      <td class="hide-sm muted">${clock(p.ts)}</td><td>${tokenCell(p)}</td>
      <td><span class="chip-agent" style="--c:var(--${p.agent})"><i></i>${p.agent}</span></td>
      <td class="hide-sm"><span class="tag ${k}" title="${esc(p.state === 'failed' ? p.reason : '')}">${esc(label)}</span></td>
      <td class="r ${p.pnl >= 0 ? 'pos' : 'neg'}">${sgn(p.pnl, 4)}</td><td class="r ${p.pnl >= 0 ? 'pos' : 'neg'}">${sgn(p.pnlPct, 1)}%</td>
    </tr></tbody></table>`).querySelector('tr');
  }, () => {}, { animate: !initial });
}

function renderCapital(s) {
  const bar = $('share');
  if (!bar.children.length) bar.innerHTML = s.agents.map(a => `<div style="--c:var(--${a.name})" data-n="${a.name}"></div>`).join('');
  for (const a of s.agents) { const el = bar.querySelector(`[data-n="${a.name}"]`); if (el) el.style.flexGrow = Math.max(0.001, a.share); }
  syncList($('share-legend'), s.agents, a => a.name, a => {
    const el = h(`<div style="--c:var(--${a.name})"><i></i>${a.name}<span class="num"></span></div>`);
    el._v = new Num(el.querySelector('.num'), v => `${v.toFixed(1)}%`);
    return el;
  }, (el, a) => el._v.set(a.share), { animate: false });
  syncList($('allocations'), s.allocations, a => String(a.ts), a => h(`<div class="row-mini">
      <span class="muted mono">час ${a.hour}</span>
      <span class="txt"><b style="color:var(--${a.from})">${a.from}</b>→ <b style="color:var(--${a.to})">${a.to}</b></span>
      <span class="mono">${a.amount.toFixed(4)} SOL</span></div>`), () => {}, { animate: !initial, empty: 'Первое перераспределение — через час после старта' });
}

function renderRadar(s) {
  const items = [...s.watching].sort((a, b) => b.ts - a.ts).slice(0, 10);
  syncList($('radar'), items, w => `${w.agent}:${w.mint}`, w => h(`<div class="row-mini">
      <span class="chip-agent" style="--c:var(--${w.agent})"><i></i>${w.agent}</span>
      <span class="txt"><b>${esc(w.symbol)}</b><span class="rs"></span></span>
      <span class="muted mono" data-since="${w.ts}"></span></div>`),
  (el, w) => setText(el.querySelector('.rs'), w.reason), { empty: 'Пока ничего интересного' });
}

function renderLog(s) {
  const items = s.events.slice(0, 80);
  syncList($('tab-log'), items, e => `${e.ts}|${e.agent}|${e.kind}|${e.text}`, e => h(`<div class="ev k-${e.kind}">
      <span class="t">${clock(e.ts)}</span><span>${esc(e.agent)}</span><span class="tk">${esc(e.token)}</span><span class="x" title="${esc(e.text)}">${esc(e.text)}</span></div>`),
  () => {}, { animate: !initial, leave: false });
}

function renderDiag(s, perMin) {
  const f = s.feedStats || {};
  const ago = ts => (ts ? `${short(Date.now() - ts)} назад` : 'никогда');
  const mins = Math.max(1 / 60, (Date.now() - (f.connectedAt || f.startedAt || Date.now())) / 60_000);
  const rows = [
    ['источник', s.mode === 'demo' ? 'демо-симулятор' : 'pumpportal.fun'], ['статус', s.feed],
    ['последнее сообщение', ago(f.lastMessageAt)], ['сообщений всего', f.messages ?? 0],
    ['новых токенов / мин', ((f.creates ?? 0) / mins).toFixed(1)], ['сделок / мин', Math.round(perMin)],
    ['миграций', f.migrations ?? 0], ['переподключений', f.reconnects ?? 0],
    ['токенов в работе', s.market.watched], ['цена SOL', `$${(s.solUsd ?? 0).toFixed(2)}`],
    ['Node.js', s.nodeVersion || '—'], ['последняя ошибка', f.lastError || '—'],
  ];
  const box = $('tab-diag');
  if (box.children.length !== rows.length) box.innerHTML = rows.map(() => '<div><span></span><span></span></div>').join('');
  rows.forEach(([k, v], i) => { const [a, b] = box.children[i].children; setText(a, k); setText(b, String(v)); b.title = String(v); });
}

function banner(s) {
  const f = s.feedStats || {};
  if (s.mode !== 'live') return null;
  const up = Date.now() - (f.startedAt || Date.now());
  if (s.feed === 'error') return ['bad', 'Живые данные не запускаются', f.lastError];
  if (s.feed !== 'live' && up > 10_000) {
    return ['bad', 'Нет подключения к pump.fun (pumpportal.fun)',
      `${f.lastError || 'Сервер не отвечает'}. Проверьте интернет. Если сайт pumpportal.fun у вас не открывается — включите VPN и перезапустите программу. Попыток: ${f.reconnects}.`];
  }
  if (s.feed === 'live' && f.lastMessageAt && Date.now() - f.lastMessageAt > 30_000) {
    return ['warn', 'Подключено, но данные не приходят', `Последнее сообщение ${short(Date.now() - f.lastMessageAt)} назад. Программа переподключится сама.`];
  }
  if (s.feed === 'live' && !f.creates && f.connectedAt && Date.now() - f.connectedAt > 60_000) {
    return ['warn', 'Подключено, но новых токенов нет', `Ответ сервера: ${f.lastServerMessage || '—'}. Пришлите файл data/diagnostics.json.`];
  }
  return null;
}

// ---------- connection ----------------------------------------------------

setup();
function connect() {
  const es = new EventSource('/events');
  es.onmessage = m => render(JSON.parse(m.data));
  es.onerror = () => {
    const hs = $('health');
    hs.className = 'health bad';
    setText(hs.lastChild, 'программа не отвечает — она запущена?');
  };
}
connect();
