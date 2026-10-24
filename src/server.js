// Local dashboard server: static files, JSON state, server-sent events, controls.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './config.js';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

export function startServer({ port, getSnapshot, actions }) {
  const clients = new Set();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(getSnapshot(true))}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (url.pathname === '/api/state') return json(res, getSnapshot(true));
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      const action = actions[url.pathname.slice(5)];
      if (!action) return json(res, { error: 'unknown action' }, 404);
      await action();
      return json(res, { ok: true });
    }
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const full = path.join(ROOT, 'public', path.normalize(file));
    if (!full.startsWith(path.join(ROOT, 'public'))) return json(res, { error: 'forbidden' }, 403);
    try {
      const body = await readFile(full);
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      json(res, { error: 'not found' }, 404);
    }
  });

  // 4 updates/s keep the UI lively; the equity history (heavier) rides every 2 s.
  let n = 0;
  setInterval(() => {
    if (!clients.size) return;
    const msg = `data: ${JSON.stringify(getSnapshot(n++ % 8 === 0))}\n\n`;
    for (const c of clients) c.write(msg);
  }, 250);

  server.listen(port, '127.0.0.1');
  return server;
}

function json(res, obj, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
