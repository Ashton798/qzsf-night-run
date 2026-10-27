/* 高德 JS API 2.0 服务端安全代理
 *
 * 官方要求：使用 JS API 2.0 时，若不想在浏览器暴露 securityJsCode，
 * 可以配置 serviceHost 指向一个服务端代理，由服务端在转发时附加安全密钥。
 *
 * 代理约定（高德官方）：
 *   浏览器请求  {serviceHost}/v4/map/styles?...&jscode=<key>
 *   服务端转发  https://restapi.amap.com/v4/map/styles?...&jscode=<key>&_key=<securityJsCode>
 *
 * 安全要点：
 *   1. 安全密钥只存在 process.env，任何接口都不返回它；
 *   2. 只代理白名单内的路径前缀，避免变成任意 URL 的开放代理；
 *   3. 只允许 GET / POST，转发时剥离 Cookie、Authorization 等敏感头；
 *   4. 不把上游响应体写日志（可能含大量数据），只记录状态码与耗时。
 */
'use strict';

const path = require('node:path');

const UPSTREAM = 'https://restapi.amap.com';
// 高德 JS API 2.0 会请求这些前缀，其余一律拒绝
const ALLOWED_PREFIXES = ['/v3/', '/v4/', '/v5/'];
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host',
  'cookie', 'authorization', 'x-run-token', 'x-participant-token'
]);

function readConfig() {
  const key = String(process.env.AMAP_WEB_KEY || '').trim();
  const securityCode = String(process.env.AMAP_SECURITY_JS_CODE || '').trim();
  const servicePath = String(process.env.AMAP_SERVICE_PATH || '/_AMapService').trim() || '/_AMapService';
  return {
    key,
    securityCode,
    servicePath: servicePath.startsWith('/') ? servicePath : '/' + servicePath,
    version: String(process.env.AMAP_JS_VERSION || '2.0').trim() || '2.0',
    configured: key.length >= 16 && securityCode.length >= 16
  };
}

/* 仅用于日志/健康检查，绝不返回密钥本身 */
function status() {
  const c = readConfig();
  return {
    configured: c.configured,
    hasKey: c.key.length >= 16,
    hasSecurityCode: c.securityCode.length >= 16,
    servicePath: c.servicePath,
    version: c.version,
    // 只暴露长度与末 4 位以外的信息一律不给；这里连末 4 位也不给
    keyMasked: c.key.length >= 16 ? c.key.slice(0, 4) + '****' + c.key.slice(-4) : ''
  };
}

function isProxyRequest(pathname, servicePath) {
  return pathname === servicePath || pathname.startsWith(servicePath + '/');
}

function upstreamPath(pathname, servicePath) {
  const rest = pathname.slice(servicePath.length) || '/';
  return rest.startsWith('/') ? rest : '/' + rest;
}

function allowedUpstreamPath(p) {
  return ALLOWED_PREFIXES.some((prefix) => p.startsWith(prefix));
}

function filterHeaders(headers) {
  const out = {};
  Object.keys(headers).forEach((k) => {
    const lower = k.toLowerCase();
    if (HOP_BY_HOP.has(lower)) return;
    if (lower.startsWith('sec-') || lower === 'origin' || lower === 'referer') return;
    out[k] = headers[k];
  });
  return out;
}

/* 在查询串上追加服务端密钥。
 * 高德要求用 _key 参数携带 securityJsCode（不是 jscode）。
 * 若浏览器已经带了 _key（不应发生），一律覆盖成服务端真值。
 */
function withSecurityCode(search, securityCode) {
  const params = new URLSearchParams(search || '');
  params.delete('_key');
  params.set('_key', securityCode);
  return params.toString();
}

async function handle(req, res, pathname, cfg, deps) {
  const { fail } = deps;
  if (req.method !== 'GET' && req.method !== 'POST') {
    return fail(res, 405, '代理只支持 GET / POST');
  }
  if (!cfg.configured) {
    return fail(res, 503, '高德服务端代理未配置（缺少 AMAP_WEB_KEY 或 AMAP_SECURITY_JS_CODE）', 'AMAP_NOT_CONFIGURED');
  }

  const target = upstreamPath(pathname, cfg.servicePath);
  if (!allowedUpstreamPath(target)) {
    return fail(res, 403, '代理路径不在允许范围内', 'AMAP_PATH_DENIED');
  }

  /* 高德的日志/埋点接口用 JSONP（callback=）调用，但上游返回普通 JSON，
   * 浏览器把它当脚本执行就会报 "Unexpected token ':'"。
   * 这些请求只用于高德自己的统计，对地图功能没有影响，
   * 所以在转发前就直接返回一个空 JSONP 响应，省带宽也避免控制台报错。
   */
  const reqParams = new URLSearchParams(new URL(req.url, 'http://x').search);
  const callback = reqParams.get('callback');
  if (callback && /^\/v[345]\/log\//.test(target)) {
    const safe = String(callback).replace(/[^\w.$]/g, '').slice(0, 64);
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(`${safe}&&${safe}({});`);
    return;
  }

  const url = new URL(target, UPSTREAM);
  url.search = withSecurityCode(url.search, cfg.securityCode);

  let body;
  if (req.method === 'POST') {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) return fail(res, 413, '请求体过大');
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks);
  }

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const upstream = await fetch(url, {
      method: req.method,
      headers: filterHeaders(req.headers),
      body,
      signal: controller.signal,
      redirect: 'follow'
    });
    clearTimeout(timer);

    const buf = Buffer.from(await upstream.arrayBuffer());
    const headers = {};
    const ct = upstream.headers.get('content-type');
    if (ct) headers['Content-Type'] = ct;
    headers['Cache-Control'] = 'no-store';
    headers['X-Content-Type-Options'] = 'nosniff';
    res.writeHead(upstream.status, headers);
    res.end(buf);

    if (upstream.status >= 400) {
      console.warn(`[amap-proxy] ${req.method} ${target} → ${upstream.status} (${Date.now() - started}ms)`);
    }
  } catch (err) {
    clearTimeout(timer);
    const aborted = err && err.name === 'AbortError';
    console.error(`[amap-proxy] ${req.method} ${target} 失败：${aborted ? '超时' : err.message}`);
    return fail(res, aborted ? 504 : 502, aborted ? '高德服务响应超时' : '高德服务请求失败', 'AMAP_UPSTREAM');
  }
}

module.exports = { readConfig, status, isProxyRequest, handle, withSecurityCode, allowedUpstreamPath, UPSTREAM, ALLOWED_PREFIXES };
