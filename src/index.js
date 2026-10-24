// Entry point: node src/index.js [--demo] [--fresh] [--no-open] [--port N]
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { exec } from 'node:child_process';
import path from 'node:path';
import { loadConfig, ROOT } from './config.js';
import { Market } from './market.js';
import { Team } from './team.js';
import { createAgents } from './agents/index.js';
import { PumpPortalFeed } from './feeds/pumpportal.js';
import { SimulatorFeed } from './feeds/simulator.js';
import { startServer } from './server.js';

const args = process.argv.slice(2);
const flag = f => args.includes(f);
const portArg = args.indexOf('--port');
const cfg = loadConfig(portArg >= 0 ? { port: Number(args[portArg + 1]) } : {});
const mode = flag('--demo') ? 'demo' : 'live';

const dataDir = path.join(ROOT, 'data');
mkdirSync(dataDir, { recursive: true });
const statePath = path.join(dataDir, `state-${mode}.json`);
const tradesPath = path.join(dataDir, `trades-${mode}.csv`);

const market = new Market(cfg);
const feed = mode === 'demo' ? new SimulatorFeed() : new PumpPortalFeed();
let team = makeTeam();

function makeTeam() {
  const t = new Team(cfg, createAgents(cfg), market);
  t.on('closed', p => {
    if (!existsSync(tradesPath)) appendFileSync(tradesPath, 'closed_at,agent,symbol,mint,state,reason,sol_in,sol_out,pnl_sol\n');
    appendFileSync(tradesPath, [new Date(p.closedAt).toISOString(), p.agent, p.symbol, p.mint, p.state,
      JSON.stringify(p.exitReason || ''), p.solIn.toFixed(6), (p.solOut ?? 0).toFixed(6), (p.pnl ?? 0).toFixed(6)].join(',') + '\n');
  });
  return t;
}

if (flag('--fresh')) rmSync(statePath, { force: true });
if (existsSync(statePath)) {
  try { team.restore(JSON.parse(readFileSync(statePath, 'utf8'))); } catch (e) { console.warn('state not restored:', e.message); }
}

market.on('token', t => feed.follow(t.mint));
market.on('dropped', mints => feed.unfollow(mints));
feed.on('event', ev => market.handle(ev));
feed.on('status', s => team.log('info', 'FEED', '', `pumpportal: ${s}`));
feed.start();
if (mode === 'live') {
  setTimeout(() => {
    if (feed.status !== 'live') team.log('info', 'FEED', '', 'нет подключения к pumpportal.fun — проверьте интернет/VPN или запустите демо: npm run demo');
  }, 20_000);
}

setInterval(() => team.tick(), 1000);
const save = () => writeFileSync(statePath, JSON.stringify(team.toJSON()));
setInterval(save, 15_000);

const snapshot = () => team.snapshot({
  mode, feed: feed.status, solUsd: cfg.solUsd,
  market: { watched: market.tokens.size, ...market.stats },
});

startServer({
  port: cfg.port,
  getSnapshot: snapshot,
  actions: {
    pause: () => { team.paused = true; team.log('info', 'TEAM', '', 'paused: no new entries'); },
    resume: () => { team.paused = false; team.halted = false; team.log('info', 'TEAM', '', 'resumed'); },
    'close-all': () => team.closeAll('manual'),
    reset: () => { team.closeAll('reset'); rmSync(statePath, { force: true }); team = makeTeam(); team.log('info', 'TEAM', '', 'new session'); },
  },
});

const url = `http://localhost:${cfg.port}`;
console.log(`\n  Solana Meme Trader — PAPER TRADING (${mode === 'demo' ? 'demo market' : 'live pump.fun data'})`);
console.log(`  Dashboard: ${url}\n  Stop: Ctrl+C\n`);
if (cfg.openBrowser && !flag('--no-open')) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open ${url}` : `xdg-open ${url}`;
  exec(cmd, () => {});
}

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { save(); process.exit(0); });
