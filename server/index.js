/* 服务入口
 * 零依赖：node:http + node:sqlite
 *
 * 环境变量（.env 由 scripts/load-env.js 读取）：
 *   PORT            端口，默认 8777
 *   HOST            监听地址，默认 0.0.0.0
 *   DB_PATH         数据库文件路径，默认 data/qzsf.db
 *   ADMIN_USER      首次启动自动创建的管理员用户名，默认 admin
 *   ADMIN_PASSWORD  首次启动自动创建的管理员密码（务必修改！）
 *   ALLOWED_ORIGIN  CORS 允许来源，默认同源
 */
'use strict';

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');

require('./scripts/load-env');

const db = require('./db');
const auth = require('./auth');
const { Router, serveStatic, fail } = require('./http');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8777);
const HOST = process.env.HOST || '0.0.0.0';
const DB_PATH = path.resolve(ROOT, process.env.DB_PATH || 'data/qzsf.db');

/* ---------- 初始化数据库 ---------- */
db.open(DB_PATH);
console.log(`[db] ${DB_PATH}`);

/* ---------- 首次启动创建管理员 ---------- */
(function bootstrapAdmin() {
  if (auth.countAdmins() > 0) return;
  const user = process.env.ADMIN_USER || 'admin';
  const pass = process.env.ADMIN_PASSWORD;

  if (!pass) {
    console.warn('');
    console.warn('  ⚠️  尚未创建管理员账号');
    console.warn('  请设置环境变量后重启，或运行：');
    console.warn('    node server/scripts/init-admin.js <用户名> <密码>');
    console.warn('');
    return;
  }
  if (pass.length < 8) {
    console.warn('[auth] ADMIN_PASSWORD 太短（至少 8 位），跳过创建');
    return;
  }
  auth.createAdmin(user, pass, 'admin', '系统管理员');
  console.log(`[auth] 已创建管理员：${user}`);
})();

/* ---------- 路由 ---------- */
const router = new Router();
require('./api')(router);
require('./map-config')(router);
const amapProxy = require('./amap-proxy');

/* ---------- 静态文件根目录（前端） ---------- */
const STATIC_ROOT = ROOT;

/* ---------- 服务器 ---------- */
const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch (e) {
    return fail(res, 400, '非法路径');
  }

  // CORS（跨域部署时使用，默认同源不生效）
  /* 注意：ok()/fail()/代理都用 writeHead 重建响应头，会覆盖 setHeader。
   * 所以这里不仅 setHeader，还要包一层 writeHead，把 CORS 头注入到每个响应里。
   */
  const origin = req.headers.origin;
  const allowed = process.env.ALLOWED_ORIGIN || '';
  let corsHeaders = null;
  if (origin && allowed && (allowed === '*' || allowed.split(',').map(s => s.trim()).includes(origin))) {
    corsHeaders = {
      'Access-Control-Allow-Origin': allowed === '*' ? '*' : origin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Run-Token,X-Participant-Token',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin'
    };
    Object.keys(corsHeaders).forEach((k) => res.setHeader(k, corsHeaders[k]));
    const rawWriteHead = res.writeHead.bind(res);
    res.writeHead = function (status, reasonOrHeaders, maybeHeaders) {
      let headers = reasonOrHeaders;
      if (typeof reasonOrHeaders === 'string') headers = maybeHeaders || {};
      const merged = Object.assign({}, corsHeaders, headers || {});
      return typeof reasonOrHeaders === 'string'
        ? rawWriteHead(status, reasonOrHeaders, merged)
        : rawWriteHead(status, merged);
    };
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // 高德 JS API 2.0 服务端安全代理：安全密钥只在这一层附加
  const amapCfg = amapProxy.readConfig();
  if (amapProxy.isProxyRequest(pathname, amapCfg.servicePath)) {
    return amapProxy.handle(req, res, pathname, amapCfg, { fail });
  }

  // API
  if (pathname.startsWith('/api/')) {
    const m = router.match(req.method, pathname);
    if (!m) return fail(res, 404, '接口不存在');
    req.params = m.params;
    try {
      await m.handler(req, res);
    } catch (err) {
      console.error(`[api] ${req.method} ${pathname}`, err);
      if (!res.headersSent) fail(res, err.status || 500, err.message || '服务器内部错误');
    }
    return;
  }

  // 静态资源
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (serveStatic(STATIC_ROOT, pathname === '/' ? '/index.html' : pathname, res)) return;
  }

  fail(res, 404, '资源不存在');
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  ┌─────────────────────────────────────────────┐');
  console.log('  │  泉州师范学院 · 校园定向越野                 │');
  console.log('  └─────────────────────────────────────────────┘');
  console.log(`  本机：  http://localhost:${PORT}`);
  const nets = require('node:os').networkInterfaces();
  Object.values(nets).flat().forEach((n) => {
    if (n && n.family === 'IPv4' && !n.internal) {
      console.log(`  局域网：http://${n.address}:${PORT}`);
    }
  });
  console.log(`  数据库：${DB_PATH}`);
  console.log(`  管理员：${auth.countAdmins()} 个`);
  const amapStatus = amapProxy.status();
  if (amapStatus.configured) {
    console.log(`  高德地图：已配置（服务端代理 ${amapStatus.servicePath}，密钥不下发浏览器）`);
  } else {
    console.log('  高德地图：未配置（在 .env 填写 AMAP_WEB_KEY 与 AMAP_SECURITY_JS_CODE 后重启）');
  }
  console.log('');
});

/* ---------- 优雅退出 ---------- */
['SIGINT', 'SIGTERM'].forEach((sig) => {
  process.on(sig, () => {
    console.log(`\n[server] 收到 ${sig}，正在关闭…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  });
});

/* 定期清理过期会话 */
setInterval(() => {
  try { auth.purgeExpired(); } catch (e) {}
}, 3600 * 1000).unref();

module.exports = server;
