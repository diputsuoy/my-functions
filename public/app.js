const $ = id => document.getElementById(id);
const fmt = (n, d = 4) => (n ?? 0).toFixed(d);
const signed = (n, d = 4) => `${n >= 0 ? '+' : ''}${fmt(n, d)}`;
const cls = n => (n >= 0 ? 'pos' : 'neg');
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const time = ts => new Date(ts).toLocaleTimeString('ru-RU', { hour12: false });
const dur = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return [s / 3600, (s % 3600) / 60, s % 60].map(v => String(Math.floor(v)).padStart(2, '0')).join(':'); };
const tokenLink = r => r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener" title="Открыть в Axiom">${esc(r.symbol)}</a>` : esc(r.symbol);

let state = null;

function render(s) {
  state = s;
  $('mode').textContent = s.mode === 'demo' ? 'PAPER · DEMO MARKET' : 'PAPER · LIVE DATA';
  $('feed').textContent = s.feed.toUpperCase();
  $('feed').className = `badge ${s.feed === 'live' || s.feed === 'demo' ? 'good' : 'warn'}`;
  $('halt').hidden = !s.halted;
  $('pause').textContent = s.paused ? 'Продолжить' : 'Пауза';
  $('start').textContent = `${fmt(s.team.start, 3)} SOL`;
  $('equity').textContent = `${fmt(s.team.equity, 3)} SOL`;
  $('pnl').innerHTML = `<span class="${cls(s.team.pnl)}">${signed(s.team.pnl, 3)}</span> <span class="muted" style="font-size:14px">${signed(s.team.pnlPct, 1)}%</span>`;
  $('elapsed').textContent = dur(s.now - s.startedAt);

  const ranked = [...s.agents].sort((a, b) => b.hourReturnPct - a.hourReturnPct);
  $('agents').innerHTML = s.agents.map(a => {
    const rank = ranked.indexOf(a) + 1;
    const mark = rank === 1 ? 'best' : rank === ranked.length ? 'worst' : '';
    const c = a.current;
    return `<div class="card ${mark}">
      <div class="rank">#${rank}</div>
      <div class="who"><div class="avatar" style="background:var(--${a.name})">${a.name[0]}</div>
        <div><div class="name">${a.name}</div><div class="style">${a.style}</div></div></div>
      <div class="bal mono">${fmt(a.equity)} <span class="muted" style="font-size:12px">SOL</span></div>
      <div class="row"><span class="label">H${String(s.hour).padStart(2, '0')} return</span><span class="mono ${cls(a.hourReturnPct)}">${signed(a.hourReturnPct, 2)}%</span></div>
      <div class="row"><span class="label">total</span><span class="mono ${cls(a.totalReturnPct)}">${signed(a.totalReturnPct, 2)}%</span></div>
      <div class="row"><span class="label">W / L</span><span class="mono">${a.wins} / ${a.losses}</span></div>
      <div class="cur mono">${c ? `<span>${esc(c.symbol)}</span><span class="st st-${c.state}">${c.state === 'open' ? 'HOLD' : c.state === 'bid' ? 'BUY' : esc(c.exitReason || c.state).toUpperCase()}</span><span class="${cls(c.pnlPct)}">${signed(c.pnlPct, 1)}%</span>` : '<span class="muted">scanning…</span>'}</div>
    </div>`;
  }).join('');

  const rows = [
    ...s.open.map(r => ({ ...r })),
    ...s.watching.slice(-6).reverse(),
    ...s.closed,
  ].slice(0, 30);
  $('trades').innerHTML = rows.map(r => `<tr>
      <td>${tokenLink(r)}</td><td>${r.agent}</td>
      <td><span class="st st-${r.state}">${r.state}</span> <span class="why">${esc(r.reason)}</span></td>
      <td class="r mono ${r.state === 'watch' ? 'muted' : cls(r.pnl)}">${r.state === 'watch' ? '—' : signed(r.pnl)}</td></tr>`).join('')
    || '<tr><td colspan="4" class="muted">ждём сигналов…</td></tr>';

  $('alloc-rule').textContent = '50% WORST → BEST';
  $('allocations').innerHTML = s.allocations.map(a => `<tr><td>${String(a.hour).padStart(2, '0')}:00</td><td>${a.from} → ${a.to}</td><td class="r mono">${fmt(a.amount)}</td></tr>`).join('')
    || '<tr><td colspan="3" class="muted">первое перераспределение через час</td></tr>';
  const top = ranked.length ? [...s.agents].sort((a, b) => b.share - a.share)[0] : null;
  $('share-top').textContent = top ? `${top.name} ${fmt(top.share, 1)}%` : '';
  $('share').innerHTML = s.agents.map(a => `<div title="${a.name} ${fmt(a.share, 1)}%" style="width:${a.share}%;background:var(--${a.name})"></div>`).join('');
  $('next-alloc').textContent = `следующее перераспределение через ${dur(s.nextAllocationAt - s.now)}`;
  $('market').textContent = `токенов отслеживается: ${s.market.watched} · новых: ${s.market.created} · сделок в потоке: ${s.market.trades} · миграций: ${s.market.migrations}`;

  $('log').innerHTML = s.events.map(e => `<div class="k-${e.kind}"><span>${time(e.ts)}</span><span>${esc(e.agent)}</span><span>${esc(e.token)}</span><span>${e.kind}</span><span title="${esc(e.text)}">${esc(e.text)}</span></div>`).join('');
}

function connect() {
  const es = new EventSource('/events');
  es.onmessage = m => render(JSON.parse(m.data));
  es.onerror = () => { $('feed').textContent = 'OFFLINE'; $('feed').className = 'badge bad'; };
}

async function post(action, confirmText) {
  if (confirmText && !confirm(confirmText)) return;
  await fetch(`/api/${action}`, { method: 'POST' });
}
$('pause').onclick = () => post(state?.paused ? 'resume' : 'pause');
$('close-all').onclick = () => post('close-all', 'Закрыть все бумажные позиции?');
$('reset').onclick = () => post('reset', 'Начать новую сессию? История и балансы будут сброшены.');
connect();
