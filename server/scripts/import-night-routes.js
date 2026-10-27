'use strict';
/* 把 build-night-routes.js 生成的 A/B 路线写入数据库（draft 草稿）
 *
 * 用法：node server/scripts/import-night-routes.js [baseUrl]
 * 默认 http://localhost:8778
 *
 * 说明：
 *   - 通过现有 PUT /api/course 接口写入，不直接改库
 *   - 状态一律 draft：管理员必须在编辑器里逐段核对、拖动修正后，
 *     填写现场核对证据才能发布
 *   - 打卡点全部 method=manual（GPS 只做接近提示，盖章由工作人员确认）
 */
const fs = require('node:fs');
const path = require('node:path');

const BASE = process.argv[2] || 'http://localhost:8778';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'Qzsf@2025';

const src = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../data/night-run-routes-draft.geojson'), 'utf8'));

async function api(method, url, body, cookie) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json, cookie: setCookie.map((c) => c.split(';')[0]).join('; ') };
}

(async () => {
  const login = await api('POST', '/api/admin/login', { username: ADMIN_USER, password: ADMIN_PASS });
  if (login.status !== 200) {
    console.error('登录失败', login.status, login.json);
    process.exit(1);
  }
  const cookie = login.cookie;
  console.log('已登录管理员');

  const ev = await api('GET', '/api/event', null, cookie);
  const eventId = ev.json.data.id;

  for (const key of ['A', 'B']) {
    const r = src.routes[key];
    const body = {
      eventId,
      routeKey: key,
      groupKey: null,
      name: r.name,
      status: 'draft',
      source: 'osm-trace',
      crs: 'gcj02',
      route: {
        routeKey: key,
        points: r.points,
        start: r.points[0],
        finish: r.points[r.points.length - 1],
        startRadius: 30,
        finishRadius: 30,
        closed: false
      },
      checkpoints: r.checkpoints.map((cp) => ({
        id: cp.id, order: cp.order, name: cp.name,
        lnglat: cp.lnglat, radius: cp.radius, required: true
      })),
      meta: { source: 'osm-trace', generatedAt: src.generatedAt, method: src.method }
    };
    const saved = await api('PUT', '/api/course', body, cookie);
    if (saved.status !== 200) {
      console.error(`${key} 保存失败`, saved.status, saved.json);
      continue;
    }
    console.log(`${key} 已保存：courseId=${saved.json.data.courseId} version=${saved.json.data.version} ` +
      `distance=${saved.json.data.distance}m points=${r.points.length} checkpoints=${r.checkpoints.length}`);
  }
})();
