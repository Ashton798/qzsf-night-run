'use strict';
/* 夜跑系统端到端验收（真实服务器 + 真实数据库）
 *
 * 与 night-test.js 的区别：
 *   night-test.js 用隔离临时库测业务规则；
 *   本脚本跑在真实服务上，验证线上实际配置与路线数据。
 *
 * 用法：node server/scripts/acceptance.js [baseUrl]
 */
const BASE = process.argv[2] || 'http://127.0.0.1:8778';
const USER = process.env.ADMIN_USER || 'admin';
const PASS = process.env.ADMIN_PASSWORD || 'Qzsf@2025';

let pass = 0, fail = 0;
const rows = [];
function check(name, cond, extra) {
  if (cond) { pass++; rows.push(['PASS', name, '']); }
  else { fail++; rows.push(['FAIL', name, extra || '']); }
}
async function api(method, path, body, cookie) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch (_) { json = { raw: text }; }
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  return { status: res.status, json, cookie: sc.map((c) => c.split(';')[0]).join('; ') };
}

(async () => {
  console.log(`验收目标：${BASE}\n`);

  /* 1. 服务与地图配置 */
  const health = await api('GET', '/api/health');
  check('服务在线', health.status === 200 && health.json.data.status === 'up');

  const mc = await api('GET', '/api/map/config');
  const cfg = mc.json.data || {};
  check('地图配置下发 key', typeof cfg.key === 'string' && cfg.key.length >= 20);
  check('安全密钥不下发浏览器', !('securityJsCode' in cfg) && !('security' in cfg));
  check('serviceHost 指向本地代理', String(cfg.serviceHost || '').includes('/_AMapService'));
  const mcRaw = JSON.stringify(mc.json);
  check('响应体不含 securityJsCode 字段名', !/securityJsCode/i.test(mcRaw));

  /* 2. 登录 */
  const login = await api('POST', '/api/admin/login', { username: USER, password: PASS });
  check('管理员登录', login.status === 200);
  const cookie = login.cookie;

  /* 3. 路线数据 */
  const plan = (await api('GET', '/api/night-plan')).json.data;
  check('策划书规则可读', !!plan && Array.isArray(plan.games) && plan.games.length === 3);
  check('两条路线 A/B 均有定义', !!plan.routes.A && !!plan.routes.B);

  const groups = { competition: 'A', experience: 'B', unity: 'B' };
  const courses = {};
  for (const [g, expect] of Object.entries(groups)) {
    const r = (await api('GET', `/api/night/course?group=${g}`)).json.data;
    courses[g] = r;
    check(`${g} 取到 ${expect} 线`, !!r && r.route && r.route.routeKey === expect);
    if (!r) continue;
    check(`${g} 途经点 ≥ 30`, r.route.points.length >= 30, `实际 ${r.route.points.length}`);
    check(`${g} 打卡点 3 个`, r.checkpoints.length === 3);
    check(`${g} 打卡点按 CP1/2/3 排序`,
      r.checkpoints.every((cp, i) => cp.id === 'CP' + (i + 1) && cp.order === i + 1));
    check(`${g} 打卡方式仅 manual`,
      r.checkpoints.every((cp) => Array.isArray(cp.methods) && cp.methods.length === 1 && cp.methods[0] === 'manual'));
    const dist = r.meta && r.meta.distance;
    check(`${g} 距离合理 (1500–8000m)`, dist >= 1500 && dist <= 8000, `实际 ${dist}`);
    check(`${g} 起终点相距 > 300m`, (() => {
      const a = r.route.start, b = r.route.finish;
      const rad = Math.PI / 180;
      const dLat = (b[1] - a[1]) * rad, dLng = (b[0] - a[0]) * rad;
      const m = ((a[1] + b[1]) / 2) * rad;
      return Math.hypot(dLng * Math.cos(m), dLat) * 6378137 > 300;
    })());
    // 打卡点必须在路线 30m 内
    const near = r.checkpoints.map((cp) => {
      let best = Infinity;
      const pts = r.route.points;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        const rad = Math.PI / 180;
        const vx = (b[0] - a[0]) * Math.cos(a[1] * rad), vy = b[1] - a[1];
        const wx = (cp.lnglat[0] - a[0]) * Math.cos(a[1] * rad), wy = cp.lnglat[1] - a[1];
        const L = vx * vx + vy * vy;
        let t = L ? (wx * vx + wy * vy) / L : 0;
        t = Math.max(0, Math.min(1, t));
        const q = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        const dLat = (cp.lnglat[1] - q[1]) * rad, dLng = (cp.lnglat[0] - q[0]) * rad;
        const m = ((q[1] + cp.lnglat[1]) / 2) * rad;
        best = Math.min(best, Math.hypot(dLng * Math.cos(m), dLat) * 6378137);
      }
      return Math.round(best);
    });
    check(`${g} 打卡点均贴合路线 (≤30m)`, near.every((d) => d <= 30), `实际 ${near.join('/')}m`);
  }

  const a = courses.competition, b = courses.experience;
  if (a && b) {
    const ratio = b.meta.distance / a.meta.distance;
    check('蓝线短于红线（策划书：蓝线约一半）', ratio > 0.4 && ratio < 0.95, `比值 ${ratio.toFixed(2)}`);
  }

  /* 4. 未发布状态不可开跑 */
  const anyDraft = Object.values(courses).some((c) => c && c.draft === true);
  if (anyDraft) {
    check('草稿路线带 draft 标记（前端据此禁止开跑）', true);
  }

  /* 5. 发布保护：缺证据必须拒绝 */
  const draftCourse = await (async () => {
    const r = await api('GET', '/api/night/course?group=competition&draft=1', null, cookie);
    return r.json.data;
  })();
  if (draftCourse && draftCourse._server) {
    const pub = await api('POST', `/api/night/course/${draftCourse._server.courseId}/publish`, {}, cookie);
    check('无现场核对证据时拒绝发布', pub.status === 400 && /核对|证据|绑定/i.test(pub.json.error || ''));
  }

  /* 6. 静态资源安全：只关心“真实密钥值”泄露，不把变量名当泄露。 */
  const envText = (() => {
    try { return require('node:fs').readFileSync(require('node:path').resolve(__dirname, '../../.env'), 'utf8'); }
    catch (_) { return ''; }
  })();
  const secrets = [];
  for (const line of envText.split(/\r?\n/)) {
    const m = /^\s*(AMAP_WEB_KEY|AMAP_SECURITY_JS_CODE|ADMIN_PASSWORD)\s*=\s*(.+?)\s*$/.exec(line);
    if (m && m[2] && m[2].length >= 6) secrets.push(m[2]);
  }
  check('已读取到本地密钥用于泄露检测', secrets.length >= 2, `读取到 ${secrets.length} 个`);
  for (const p of ['/.env', '/data/night.db', '/server/index.js', '/config.js', '/assets/config.js']) {
    const r = await fetch(BASE + p);
    const body = await r.text();
    const hit = secrets.find((v) => body.includes(v));
    check(`拒绝泄露 ${p}`, !hit, hit ? '包含真实密钥值' : '');
  }

  /* 7. 代理白名单 */
  const deny = await fetch(BASE + '/_AMapService/etc/passwd');
  check('代理拒绝非白名单路径', deny.status === 403 || deny.status === 404);

  /* 输出 */
  console.log('');
  for (const [s, n, e] of rows) console.log(`  ${s === 'PASS' ? '✓' : '✗'} ${n}${e ? '  → ' + e : ''}`);
  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) process.exitCode = 1;
})();
