/* Vercel 定位测试入口：地图配置与高德安全代理在 Vercel 运行。 */
'use strict';

const BACKEND = String(process.env.BACKEND_ORIGIN || '').replace(/\/+$/, '');
const AMAP_KEY = String(process.env.AMAP_WEB_KEY || '').trim();
const AMAP_SECURITY = String(process.env.AMAP_SECURITY_JS_CODE || '').trim();
const AMAP_PREFIX = '/_AMapService';

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function configured() {
  return AMAP_KEY.length >= 16 && AMAP_SECURITY.length >= 16;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error('REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

function requestUrl(req) {
  return new URL(req.headers['x-vercel-original-path'] || req.url || '/', 'https://local.invalid');
}

async function proxyAmap(req, res, incoming) {
  if (!configured()) return sendJson(res, 503, { ok: false, error: '高德地图环境变量未配置', code: 'AMAP_NOT_CONFIGURED' });
  if (req.method !== 'GET' && req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '地图代理只支持 GET / POST' });
  const upstreamPath = incoming.pathname.slice(AMAP_PREFIX.length) || '/';
  if (!/^\/v[345]\//.test(upstreamPath)) return sendJson(res, 403, { ok: false, error: '地图代理路径不在允许范围内' });
  const callback = incoming.searchParams.get('callback');
  if (callback && /^\/v[345]\/log\//.test(upstreamPath)) {
    const safe = String(callback).replace(/[^\w.$]/g, '').slice(0, 64);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.end(safe + '&&' + safe + '({});');
  }
  const target = new URL(upstreamPath, 'https://restapi.amap.com');
  incoming.searchParams.delete('_key');
  incoming.searchParams.set('_key', AMAP_SECURITY);
  target.search = incoming.searchParams.toString();
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase();
    if (['host','connection','content-length','cookie','authorization','origin','referer'].includes(lower)) continue;
    if (lower.startsWith('sec-') || lower.startsWith('x-vercel-')) continue;
    headers[key] = value;
  }
  try {
    const upstream = await fetch(target, { method: req.method, headers, body: req.method === 'POST' ? await readBody(req) : undefined, redirect: 'follow' });
    res.statusCode = upstream.status;
    const contentType = upstream.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (_) {
    sendJson(res, 502, { ok: false, error: '高德地图服务暂时不可达', code: 'AMAP_UPSTREAM' });
  }
}

async function proxyBackend(req, res) {
  if (!BACKEND) return sendJson(res, 503, { ok: false, error: '完整业务后端尚未在线；定位测试页可正常使用', code: 'NO_BACKEND' });
  try {
    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (['host','connection','content-length'].includes(key.toLowerCase())) continue;
      headers[key] = value;
    }
    const upstream = await fetch(BACKEND + req.url, { method: req.method, headers, body: ['GET','HEAD'].includes(req.method) ? undefined : await readBody(req), redirect: 'manual' });
    res.statusCode = upstream.status;
    upstream.headers.forEach((value, key) => {
      if (['content-encoding','content-length','transfer-encoding'].includes(key)) return;
      try { res.setHeader(key, value); } catch (_) {}
    });
    res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (_) {
    sendJson(res, 502, { ok: false, error: '完整业务后端暂时不可达', code: 'BACKEND_DOWN' });
  }
}

module.exports = async function handler(req, res) {
  const incoming = requestUrl(req);
  if (incoming.pathname === '/api/map/config') return sendJson(res, 200, { ok: true, data: { configured: configured(), key: configured() ? AMAP_KEY : '', serviceHost: configured() ? AMAP_PREFIX : '', version: '2.0', campus: { name: '泉州师范学院东海主校区' }, message: configured() ? '高德地图已配置' : '高德地图环境变量未配置' } });
  if (incoming.pathname === '/api/map/status') return sendJson(res, 200, { ok: true, data: { configured: configured(), servicePath: AMAP_PREFIX, version: '2.0' } });
  if (incoming.pathname === '/api/health') return sendJson(res, 200, { ok: true, data: { service: 'qzsf-location-test', mapConfigured: configured(), backendConfigured: !!BACKEND } });
  if (incoming.pathname === AMAP_PREFIX || incoming.pathname.startsWith(AMAP_PREFIX + '/')) return proxyAmap(req, res, incoming);
  return proxyBackend(req, res);
};
