/**
 * Vercel Serverless API — 只读模式
 *
 * Vercel 文件系统只读，无法使用 SQLite。
 * 路线数据预导出于 data/routes-static.json。
 * 部署前确保运行过: node server/update-routes.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

// ── 预加载静态数据 ──
let _routes = null, _plan = null;

function routes() {
  if (!_routes) {
    try {
      _routes = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'routes-static.json'), 'utf8'));
    } catch (_) { _routes = { routes: {} }; }
  }
  return _routes;
}
function plan() {
  if (!_plan) {
    try {
      _plan = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'night-run-plan.json'), 'utf8'));
    } catch (_) { _plan = null; }
  }
  return _plan;
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Run-Token,X-Participant-Token',
  'Access-Control-Max-Age': '86400'
};

function json(res, code, data) {
  res.writeHead(code, { ...cors, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function ok(res, d)   { json(res, 200, { ok: true, data: d }); }
function fail(res, c, msg) { json(res, c, { ok: false, error: msg }); }

// ── 路由表 ──
const GET = {
  '/api/night-plan': () => { return plan(); },
  '/api/night/course': (q) => {
    const key = (q.get('group') || 'competition') === 'competition' ? 'A' : 'B';
    const c = routes().routes[key] || null;
    if (!c) return null;
    return {
      route:   { points: c.points, start: c.start, finish: c.finish },
      checkpoints: c.checkpoints,
      meta:    c.meta,
      draft:   c.status !== 'published',
      name:    c.name,
      _server: { courseId: c.id }
    };
  },
  '/api/events': () => [{ id: 1, code: 'qzsf-2025', name: '泉州师范学院第九届校园荧光夜跑' }],
  '/api/config': () => ({ apiBase: '', mapProvider: 'amap' }),
  '/api/health': () => ({ routes: Object.keys(routes().routes), updated: routes().updatedAt }),
};

// Write endpoints → 503
const READONLY = [/^\/api\/(register|checkins|runs|login|admin)/];

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    return res.end();
  }

  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  // Read-only endpoints
  if (req.method === 'GET' && GET[pathname]) {
    try {
      const result = GET[pathname](url.searchParams);
      if (result === null || result === undefined) return fail(res, 404, '数据未找到');
      return ok(res, result);
    } catch (e) {
      return fail(res, 500, e.message);
    }
  }

  // Parameterized course route
  if (req.method === 'GET' && /^\/api\/courses?\/\d+$/.test(pathname)) {
    const key = 'A'; // default to competition
    const c = routes().routes[key];
    if (!c) return fail(res, 404, '路线未找到');
    return ok(res, c);
  }

  // Write operations → readonly
  for (const re of READONLY) {
    if (re.test(pathname)) {
      return fail(res, 503, 'Vercel 部署为只读模式。报名和比赛请使用本地服务器。');
    }
  }

  fail(res, 404, '接口不存在');
};