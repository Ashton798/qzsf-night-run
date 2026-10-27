/* HTTP 基础设施：路由、JSON 解析、Cookie、静态文件
 * 零依赖，只用 node:http
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.gpx': 'application/gpx+xml; charset=utf-8',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json'
};

class Router {
  constructor() {
    this.routes = [];
  }
  add(method, pattern, handler) {
    // pattern: '/api/participants/:sid'
    const keys = [];
    const regex = new RegExp(
      '^' + pattern.replace(/:[A-Za-z0-9_]+/g, (m) => {
        keys.push(m.slice(1));
        return '([^/]+)';
      }).replace(/\*/g, '.*') + '$'
    );
    this.routes.push({ method, regex, keys, handler });
  }
  get(p, h) { this.add('GET', p, h); }
  post(p, h) { this.add('POST', p, h); }
  put(p, h) { this.add('PUT', p, h); }
  patch(p, h) { this.add('PATCH', p, h); }
  delete(p, h) { this.add('DELETE', p, h); }

  match(method, pathname) {
    // 静态路径优先匹配，避免 /api/x/export.csv 被 /api/x/:id 抢走
    const sorted = this.routes
      .filter((r) => r.method === method)
      .sort((a, b) => {
        const sa = a.regex.source.includes('([^/]+)') ? 1 : 0;
        const sb = b.regex.source.includes('([^/]+)') ? 1 : 0;
        if (sa !== sb) return sa - sb;
        return b.regex.source.length - a.regex.source.length;
      });
    for (const r of sorted) {
      if (r.method !== method) continue;
      const m = pathname.match(r.regex);
      if (m) {
        const params = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        return { handler: r.handler, params };
      }
    }
    return null;
  }
}

/* ---------- 请求体解析 ---------- */
function readBody(req, limitBytes = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      const ct = String(req.headers['content-type'] || '');
      if (ct.includes('application/json')) {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(Object.assign(new Error('JSON 格式错误'), { status: 400 })); }
      } else if (ct.includes('application/x-www-form-urlencoded')) {
        resolve(Object.fromEntries(new URLSearchParams(raw)));
      } else {
        resolve(raw);
      }
    });
    req.on('error', reject);
  });
}

/* ---------- Cookie ---------- */
function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (!h) return out;
  h.split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function setCookie(res, name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path || '/'}`);
  if (opts.maxAge != null) parts.push(`Max-Age=${Math.floor(opts.maxAge / 1000)}`);
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  /* 跨站部署（前端在 Vercel、后端在隧道）时，浏览器要求
   * SameSite=None + Secure 才会在跨站请求里带上 Cookie。
   * 本地 http 开发不能用 None（会被浏览器丢弃），所以用环境变量控制。
   */
  const crossSite = String(process.env.COOKIE_CROSS_SITE || '').toLowerCase() === '1';
  const sameSite = opts.sameSite || (crossSite ? 'None' : 'Lax');
  parts.push(`SameSite=${sameSite}`);
  if (opts.secure || sameSite === 'None') parts.push('Secure');
  const prev = res.getHeader('Set-Cookie');
  const list = prev ? (Array.isArray(prev) ? prev : [prev]) : [];
  list.push(parts.join('; '));
  res.setHeader('Set-Cookie', list);
}

function clearCookie(res, name) {
  setCookie(res, name, '', { maxAge: 0 });
}

/* ---------- 响应 ---------- */
function sendJson(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  }, headers));
  res.end(body);
}

function ok(res, data, extra) {
  sendJson(res, 200, Object.assign({ ok: true, data }, extra || {}));
}

function fail(res, status, message, code) {
  sendJson(res, status, { ok: false, error: message, code: code || status });
}

/* ---------- 静态文件 ---------- */
function serveStatic(rootDir, pathname, res) {
  // 防目录穿越
  const relative = pathname.replace(/^[/\\]+/, '');
  const allowed = /^(index\.html|config\.js|assets\/[^/]+\.(js|css)|vendor\/leaflet\/[\w./-]+|data\/campus\.js|data\/assets\/[\w-]+\.(png|jpg|jpeg))$/;
  if (!allowed.test(relative)) { fail(res, 403, '禁止访问'); return true; }
  let filePath = path.resolve(rootDir, relative);
  if (!filePath.startsWith(path.resolve(rootDir) + path.sep)) { fail(res, 403, '禁止访问'); return true; }

  let stat = null;
  try { stat = fs.statSync(filePath); } catch (e) { return false; }

  if (stat.isDirectory()) {
    filePath = path.join(filePath, 'index.html');
    try { stat = fs.statSync(filePath); } catch (e) { return false; }
  }

  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';

  // 配置文件绝不缓存，便于改 Key 后立即生效
  const isConfig = /(^|[/\\])config(\.example)?\.js$/.test(filePath);
  const headers = {
    'Content-Type': mime,
    'Cache-Control': isConfig ? 'no-store' : (ext === '.html' ? 'no-cache' : 'public, max-age=3600'),
    'X-Content-Type-Options': 'nosniff'
  };

  const buf = fs.readFileSync(filePath);
  res.writeHead(200, headers);
  res.end(buf);
  return true;
}

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || '';
}

function parseQuery(req) {
  return Object.fromEntries(new URL(req.url, 'http://x').searchParams);
}

module.exports = {
  Router, readBody, parseCookies, setCookie, clearCookie,
  sendJson, ok, fail, serveStatic, getClientIp, parseQuery, url
};
