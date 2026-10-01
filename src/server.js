// 零依赖 HTTP 服务：JSON API + 静态前端 + 组件“截图”SVG（标注令牌来源，可追溯）。

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService } from './service.js';
import { seed } from './seed.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..', 'web');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

export async function buildApp({ databaseUrl, reseed = true } = {}) {
  const svc = await createService({ databaseUrl });
  // 内存存储每次启动重种；PG 仅在库为空时播种
  const empty = (await svc.listScopes()).length === 0;
  if (reseed && (empty || !databaseUrl)) await seed(svc);

  const routes = [];
  const route = (method, re, fn) => routes.push({ method, re, fn });

  route('GET', /^\/api\/health$/, () => ({ ok: true, store: databaseUrl ? 'pg' : 'memory' }));

  route('GET', /^\/api\/scopes$/, () => svc.listScopes());
  route('POST', /^\/api\/scopes$/, (_, b) => svc.createScope(b));
  route('PUT', /^\/api\/scopes$/, (_, b) => svc.updateScope(b));

  route('POST', /^\/api\/tokens$/, (_, b) => svc.putToken(b));
  // scope 可能含 "/"（如 theme/dark），统一用查询参数指定
  route('GET', /^\/api\/resolve$/, (_m, _b, q) => svc.resolveToken(q.scope, q.name));
  route('DELETE', /^\/api\/tokens$/, (_m, b) => svc.deleteToken(b.scope, b.name));

  route('GET', /^\/api\/expand\/(.+)$/, (m, _b, q) =>
    svc.expand(decodeURIComponent(m[0]), { useCache: q.cache !== '0' }));
  route('POST', /^\/api\/impact$/, (_, b) => svc.computeImpact(b.scope, b.name));

  route('GET', /^\/api\/components$/, () => svc.listComponents());
  route('POST', /^\/api\/components$/, (_, b) => svc.putComponent(b));

  route('GET', /^\/api\/versions$/, () => svc.listVersions());
  route('POST', /^\/api\/versions$/, (_, b) => svc.createVersion(b));

  route('GET', /^\/api\/shots$/, () => svc.listShots());
  route('POST', /^\/api\/shots$/, (_, b) => svc.startShot({
    componentId: b.componentId, theme: b.theme, framesTotal: b.framesTotal ?? 4
  }, b.failAtFrame !== undefined ? makeFailingRunner(b.failAtFrame) : makeRunner()));
  route('GET', /^\/api\/shots\/([^/]+)\/image\.svg$/, (m) => shotSvg(svc, decodeURIComponent(m[0])));
  route('POST', /^\/api\/shots\/([^/]+)\/interrupt$/, (m) => svc.interruptShot(decodeURIComponent(m[0])));
  route('POST', /^\/api\/shots\/([^/]+)\/resume$/, (m) => svc.resumeShot(decodeURIComponent(m[0]), makeRunner()));
  route('GET', /^\/api\/shots\/([^/]+)$/, (m) => svc.getShot(decodeURIComponent(m[0])));

  route('GET', /^\/api\/confirmations$/, () => svc.listConfirmations());
  route('POST', /^\/api\/confirmations$/, (_, b) => svc.confirm(b));

  route('GET', /^\/api\/reports$/, () => svc.listReports());
  route('POST', /^\/api\/reports$/, (_, b) => svc.runReport(b));
  route('GET', /^\/api\/reports\/(.+)$/, (m) => svc.getReport(decodeURIComponent(m[0])));

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        const body = await readJson(req);
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = url.pathname.match(r.re);
          if (m) {
            const query = Object.fromEntries(url.searchParams);
            const data = await r.fn(m.slice(1), body, query);
            if (data && data.__svg) return send(res, 200, data.body, { 'content-type': 'image/svg+xml' });
            return json(res, 200, data);
          }
        }
        return json(res, 404, { error: 'not found', path: url.pathname });
      }
      return serveStatic(res, url.pathname);
    } catch (err) {
      return json(res, err.status || 500, { error: err.message, ...(err.extra || {}) });
    }
  });

  return { server, svc };
}

function makeRunner() {
  return async () => { await new Promise((r) => setTimeout(r, 5)); };
}
function makeFailingRunner(failAtFrame) {
  return async (frame) => {
    await new Promise((r) => setTimeout(r, 2));
    if (frame.index === failAtFrame) throw new Error('模拟渲染失败 @frame ' + frame.index);
  };
}

// 截图产物：SVG 中显式标注每个颜色来自哪个令牌/scope/版本，保证可追溯
async function shotSvg(svc, shotId) {
  const shot = await svc.getShot(shotId);
  if (shot.status !== 'completed') throw Object.assign(new Error('截图未完成: ' + shot.status), { status: 409 });
  const exp = svc.expand(shot.theme);
  const pick = (name) => exp.tokens.find((t) => t.name === name);
  const bg = pick('color.bg.default');
  const text = pick('color.action.text');
  const actionBg = pick('color.action.bg');
  const component = await svc.getComponent(shot.componentId);
  const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="520" height="220" viewBox="0 0 520 220" font-family="sans-serif">
  <rect width="520" height="220" fill="${esc(bg.value)}" data-token="color.bg.default" data-source="${esc(bg.source)}" data-theme="${esc(shot.theme)}"/>
  <rect x="140" y="70" width="240" height="56" rx="8" fill="${esc(actionBg.value)}" data-token="color.action.bg" data-source="${esc(actionBg.source)}"/>
  <text x="260" y="105" text-anchor="middle" font-size="16" fill="${esc(text.value)}" data-token="color.action.text" data-source="${esc(text.source)}">${esc(component.name)}</text>
  <text x="12" y="200" font-size="10" fill="${esc(pick('color.text.primary').value)}" data-token="color.text.primary">
    shot=${esc(shot.id)} · tokenVersion=v${shot.tokenVersion} · theme=${esc(shot.theme)} · frames=${shot.framesDone}/${shot.framesTotal}
  </text>
  <text x="12" y="214" font-size="10" fill="${esc(pick('color.text.primary').value)}">
    来源: bg@${esc(bg.source)} actionBg@${esc(actionBg.source)} text@${esc(text.source)}
  </text>
</svg>`;
  return { __svg: true, body: svg };
}

async function serveStatic(res, pathname) {
  const p = pathname === '/' ? '/index.html' : pathname;
  const file = join(WEB, p.replace(/^\/+/, ''));
  if (!file.startsWith(WEB)) return json(res, 403, { error: 'forbidden' });
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 2e6) reject(new Error('body too large')); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data, null, 2));
}
function send(res, status, body, headers = {}) {
  res.writeHead(status, headers); res.end(body);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 3000);
  buildApp({ databaseUrl: process.env.DATABASE_URL }).then(({ server }) => {
    server.listen(port, () => {
      console.log(`设计规范手册: http://localhost:${port}  (存储: ${process.env.DATABASE_URL ? 'PostgreSQL' : '内存'})`);
    });
  });
}
