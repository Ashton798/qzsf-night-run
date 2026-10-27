'use strict';

/*
 * HTTP API for the campus event system.
 *
 * Security boundary:
 *   - administrator operations require a server session and role;
 *   - participant operations require a per-run access token;
 *   - GPS data is recomputed/validated on the server.  Client supplied
 *     distance, route status and finish status are never trusted.
 */

const crypto = require('node:crypto');
const db = require('./db');
const auth = require('./auth');
const DEFAULTS = require('./defaults');
const competition = require('./competition');
const night = require('./night-run');
const rules = require('./rules');
const { ok, fail, readBody, getClientIp, parseQuery } = require('./http');

const EVENT_CODE = 'qzsf-2025';
const RUN_TOKEN_HEADER = 'x-run-token';

function now() { return Date.now(); }
function getEvent(code) { return db.get('SELECT * FROM events WHERE code=?', [code || EVENT_CODE]); }
function bodyObject(body) { return body && typeof body === 'object' && !Array.isArray(body) ? body : {}; }
function json(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}
function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}
function tokenEquals(a, b) {
  if (!a || !b || String(a).length !== String(b).length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(String(a)), Buffer.from(String(b))); }
  catch (_) { return false; }
}
function bearer(req) {
  const h = String(req.headers.authorization || '');
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}
function runToken(req, body) {
  return String(
    req.headers[RUN_TOKEN_HEADER] ||
    req.headers['x-access-token'] ||
    (body && body.accessToken) ||
    parseQuery(req).accessToken || ''
  );
}
function audit(admin, action, target, detail, req) {
  db.run(
    'INSERT INTO audit_logs (admin_id, action, target, detail_json, ip, created_at) VALUES (?,?,?,?,?,?)',
    [admin ? admin.id : null, action, target == null ? null : String(target),
      detail == null ? null : JSON.stringify(detail).slice(0, 20000), getClientIp(req), now()]
  );
}
function requireAdmin(req, res, roles) { return auth.requireAdmin(req, res, roles); }
function validCourseId(id) { return Number.isInteger(Number(id)) && Number(id) > 0; }

function serializeEvent(e, withConfig = false) {
  if (!e) return null;
  const groups = json(e.groups_json, null);
  const colleges = json(e.colleges_json, null);
  const out = {
    code: e.code,
    name: e.name,
    subtitle: e.subtitle,
    campus: { name: e.campus_name, center: [e.campus_lng, e.campus_lat], zoom: e.campus_zoom },
    eventDate: e.event_date,
    regDeadline: e.reg_deadline,
    startAt: e.start_at,
    closeMinutes: e.close_minutes,
    status: e.status,
    statusText: DEFAULTS.STATUS_TEXT[e.status] || e.status,
    regOpen: e.reg_open === 0 ? false : true,
    startName: e.start_name || '起点',
    finishName: e.finish_name || '终点',
    groups: groups && Object.keys(groups).length ? groups : DEFAULTS.GROUPS,
    rules: e.rules_text || '',
    ruleConfig: rules.normalizeRules(e.rules_json),
    defaultRouteKey: e.default_route_key || 'default'
  };
  if (withConfig) {
    out.colleges = Array.isArray(colleges) && colleges.length ? colleges : DEFAULTS.COLLEGES;
    out.updatedAt = e.updated_at;
  }
  return out;
}

function regClosedReason(e) {
  if (!e) return '赛事不存在';
  if (e.reg_open === 0) return '报名通道已关闭';
  if (['reg_closed', 'running', 'finished', 'archived'].includes(e.status)) {
    return DEFAULTS.STATUS_TEXT[e.status] || '报名已结束';
  }
  if (e.reg_deadline && new Date(e.reg_deadline).getTime() < now()) return '报名已截止';
  return null;
}

function serializeParticipant(r) {
  if (!r) return null;
  return {
    id: r.id, sid: r.sid, name: r.name, college: r.college, phone: r.phone,
    group: r.group_key, teamCode: r.team_code,
    partner: r.partner_sid ? { sid: r.partner_sid, name: r.partner_name, college: r.partner_college } : null,
    bib: r.bib, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at
  };
}
function serializeCheckin(r) {
  if (!r) return null;
  return { id: r.id, ts: r.ts, lng: r.lng, lat: r.lat, rawLng: r.raw_lng, rawLat: r.raw_lat,
    accuracy: r.accuracy_m, distToStart: r.dist_to_start, method: r.method, verified: !!r.coordinate_verified };
}
function serializeHit(r) {
  if (!r) return null;
  return { id: r.id, checkpointId: r.checkpoint_id, code: r.code, name: r.name,
    order: r.order_index, ts: r.ts, elapsedMs: r.elapsed_ms, distM: r.dist_m,
    accuracy: r.accuracy_m, valid: !!r.valid, method: r.method || 'gps',
    rewardPoints: r.reward_points || 0, verified: !!r.coordinate_verified,
    flags: json(r.validation_flags, []) };
}
function serializeRun(r, quality) { return competition.runPublic(r, quality); }

function buildCourse(eventId, groupKey, routeKey, courseId) {
  const event = db.get('SELECT * FROM events WHERE id=?', [eventId]);
  const course = competition.selectCourse(eventId, groupKey, routeKey, courseId);
  if (!course) return null;
  return competition.coursePublic(course, event, competition.courseCheckpoints(course.id));
}

function getRun(id) {
  if (!Number.isInteger(Number(id))) return null;
  return db.get('SELECT * FROM runs WHERE id=?', [Number(id)]);
}
function runBelongsToEvent(run, eventId) { return !!run && Number(run.event_id) === Number(eventId); }
function canAccessRun(req, res, run, body, opts = {}) {
  if (!run) { fail(res, 404, '比赛记录不存在', 'NOT_FOUND'); return false; }
  if (opts.eventId && !runBelongsToEvent(run, opts.eventId)) { fail(res, 404, '比赛记录不存在', 'NOT_FOUND'); return false; }
  const admin = opts.admin !== false ? auth.getSession(req) : null;
  if (admin && (!opts.roles || opts.roles.includes(admin.role))) return admin;
  const supplied = runToken(req, body);
  if (!tokenEquals(supplied, run.access_token)) {
    fail(res, 401, '比赛访问令牌无效', 'UNAUTHORIZED');
    return false;
  }
  return { participant: true };
}

function participantAccess(req, res, p, body) {
  if (auth.getSession(req)) return true;
  if (p && tokenEquals(req.headers['x-participant-token'] || (body && body.participantToken), p.access_token)) return true;
  fail(res, 401, '请使用报名设备，或联系工作人员恢复报名凭证', 'PARTICIPANT_AUTH');
  return false;
}
function checkpointMethods(cp) { return json(cp.methods_json, ['gps']); }
function courseRoute(course) { return competition.parseCoursePoints(course); }
function currentRequiredDone(runId) {
  return db.get('SELECT COUNT(*) AS n FROM cp_hits WHERE run_id=? AND valid=1', [runId]).n;
}
function requiredTotal(courseId) {
  return db.get('SELECT COUNT(*) AS n FROM checkpoints WHERE course_id=? AND required=1', [courseId]).n;
}
function latestEvidence(runId, cp, maxAgeMs) {
  const cutoff = now() - maxAgeMs;
  return db.get(
    `SELECT * FROM track_points
      WHERE run_id=? AND accepted=1 AND server_ts>=?
      ORDER BY server_ts DESC, seq DESC LIMIT 50`, [runId, cutoff]
  );
}
function makePointFromBody(body) {
  return competition.normalizePoint(body || {}, { allowSimulation: true });
}
function updateParticipantStatus(run, status) {
  db.run('UPDATE participants SET status=?, updated_at=? WHERE id=?', [status, now(), run.participant_id]);
}

function coursePayloadFromBody(body, event, admin) {
  const b = bodyObject(body);
  const route = b.route || {};
  return {
    route,
    checkpoints: Array.isArray(b.checkpoints) ? b.checkpoints : [],
    name: b.name || event.name,
    crs: b.crs || 'gcj02',
    routeKey: b.routeKey || route.routeKey || 'default',
    groupKey: b.groupKey == null ? (route.groupKey || null) : b.groupKey,
    status: b.status || 'draft',
    source: (b.meta && b.meta.source) || b.source || 'manual',
    surveyedAt: b.surveyedAt || null,
    surveyedEvidence: b.surveyEvidence || b.surveyEvidenceJson || null,
    startRadius: route.startRadius || b.startRadius || 80,
    finishRadius: route.finishRadius || b.finishRadius || 80,
    admin
  };
}
function validateCoursePayload(payload) {
  const c = { route: payload.route, checkpoints: payload.checkpoints, crs: payload.crs,
    routeKey: payload.routeKey, groupKey: payload.groupKey };
  return competition.validateCourse(c);
}

module.exports = function register(router) {
  night.register(router);
  /* Health / public event configuration */
  router.get('/api/health', (req, res) => ok(res, {
    status: 'up', time: now(), version: require('../package.json').version,
    database: 'sqlite', admins: auth.countAdmins()
  }));
  router.get('/api/event', (req, res) => {
    const e = getEvent(parseQuery(req).code);
    if (!e) return fail(res, 404, '赛事不存在');
    ok(res, serializeEvent(e, true));
  });
  router.get('/api/event/config', (req, res) => {
    const e = getEvent(parseQuery(req).code);
    if (!e) return fail(res, 404, '赛事不存在');
    ok(res, serializeEvent(e, true));
  });

  /* Event and rule configuration */
  router.put('/api/event', async (req, res) => {
    const admin = requireAdmin(req, res, ['admin']);
    if (!admin) return;
    const body = bodyObject(await readBody(req));
    const e = getEvent(body.code || EVENT_CODE);
    if (!e) return fail(res, 404, '赛事不存在');
    if (body.status !== undefined && !DEFAULTS.STATUS.includes(body.status)) return fail(res, 400, '赛事状态不合法', 'VALIDATION');
    for (const k of ['eventDate', 'regDeadline', 'startAt']) {
      if (body[k] !== undefined && body[k] && Number.isNaN(new Date(body[k]).getTime())) return fail(res, 400, `${k} 日期格式不正确`, 'VALIDATION');
    }
    if (body.colleges !== undefined && !Array.isArray(body.colleges)) return fail(res, 400, '学院列表必须是数组', 'VALIDATION');
    if (body.groups !== undefined && (typeof body.groups !== 'object' || Array.isArray(body.groups))) return fail(res, 400, '组别配置必须是对象', 'VALIDATION');
    const fields = [], params = [];
    const map = {
      name: 'name', subtitle: 'subtitle', campusName: 'campus_name', campusLng: 'campus_lng', campusLat: 'campus_lat',
      campusZoom: 'campus_zoom', eventDate: 'event_date', regDeadline: 'reg_deadline', startAt: 'start_at',
      closeMinutes: 'close_minutes', status: 'status', rules: 'rules_text', startName: 'start_name', finishName: 'finish_name'
    };
    Object.keys(map).forEach((k) => { if (body[k] !== undefined) { fields.push(`${map[k]}=?`); params.push(body[k]); } });
    if (body.rulesConfig !== undefined) { fields.push('rules_json=?'); params.push(JSON.stringify(rules.normalizeRules(body.rulesConfig))); }
    if (body.defaultRouteKey !== undefined) {
      const key = String(body.defaultRouteKey || 'default');
      if (!/^[-A-Za-z0-9_]{1,64}$/.test(key)) return fail(res, 400, '默认路线键无效', 'VALIDATION');
      fields.push('default_route_key=?'); params.push(key);
    }
    if (body.groups !== undefined) { fields.push('groups_json=?'); params.push(JSON.stringify(body.groups)); }
    if (body.colleges !== undefined) {
      const list = body.colleges.map((x) => String(x).trim()).filter(Boolean);
      if (!list.length) return fail(res, 400, '学院列表不能为空', 'VALIDATION');
      fields.push('colleges_json=?'); params.push(JSON.stringify(list));
    }
    if (body.regOpen !== undefined) { fields.push('reg_open=?'); params.push(body.regOpen ? 1 : 0); }
    if (!fields.length) return fail(res, 400, '没有需要更新的字段');
    fields.push('updated_at=?'); params.push(now(), e.id);
    db.run(`UPDATE events SET ${fields.join(',')} WHERE id=?`, params);
    audit(admin, 'event.update', e.id, body, req);
    ok(res, serializeEvent(getEvent(e.code), true), { message: '赛事信息已更新' });
  });
  router.get('/api/rules', (req, res) => {
    const e = getEvent(parseQuery(req).code);
    if (!e) return fail(res, 404, '赛事不存在');
    ok(res, { rules: rules.normalizeRules(e.rules_json), groups: json(e.groups_json, {}) });
  });
  router.put('/api/rules', async (req, res) => {
    const admin = requireAdmin(req, res, ['admin']);
    if (!admin) return;
    const body = bodyObject(await readBody(req));
    const e = getEvent(body.code || EVENT_CODE);
    if (!e) return fail(res, 404, '赛事不存在');
    const normalized = rules.normalizeRules(body.rules || body);
    db.run('UPDATE events SET rules_json=?, updated_at=? WHERE id=?', [JSON.stringify(normalized), now(), e.id]);
    audit(admin, 'rules.update', e.id, normalized, req);
    ok(res, { rules: normalized });
  });

  /* Routes */
  router.get('/api/course', (req, res) => {
    const q = parseQuery(req); const e = getEvent(q.code);
    if (!e) return fail(res, 404, '赛事不存在');
    ok(res, buildCourse(e.id, q.group, q.routeKey, q.courseId ? Number(q.courseId) : null));
  });
  router.get('/api/courses', (req, res) => {
    const q = parseQuery(req); const e = getEvent(q.code);
    if (!e) return fail(res, 404, '赛事不存在');
    const rows = db.all(`SELECT id,version,name,distance_m,status,is_active,route_key,group_key,published_at,locked_at,created_at,updated_at
      FROM courses WHERE event_id=? ORDER BY route_key, group_key, version DESC`, [e.id]);
    ok(res, rows.map((r) => Object.assign({}, r, { active: !!r.is_active, locked: !!r.locked_at })));
  });
  router.get('/api/course/history', (req, res) => {
    const admin = requireAdmin(req, res, ['admin', 'referee', 'viewer']); if (!admin) return;
    const e = getEvent();
    ok(res, db.all(`SELECT id,version,name,distance_m,status,is_active,route_key,group_key,published_at,locked_at,created_at,updated_at
      FROM courses WHERE event_id=? ORDER BY version DESC`, [e.id]));
  });
  router.put('/api/course', async (req, res) => {
    const admin = requireAdmin(req, res, ['admin']); if (!admin) return;
    const body = bodyObject(await readBody(req)); const e = getEvent(body.eventId || EVENT_CODE);
    if (!e) return fail(res, 404, '赛事不存在');
    const p = coursePayloadFromBody(body, e, admin); const errors = validateCoursePayload(p);
    if (errors.length) return fail(res, 400, errors[0], 'VALIDATION');
    if (p.status === 'published') return fail(res,400,'请先保存草稿，再经现场核对发布','REVIEW_REQUIRED');
    const route = p.route; const points = route.points;
    const closed = !!route.closed;
    let dist = competition.pathDistance(points);
    if (closed && points.length > 1) dist += competition.distanceM(points[points.length - 1], points[0]);
    const routeKey = String(p.routeKey || 'default'); const groupKey = p.groupKey == null || p.groupKey === '' ? null : String(p.groupKey);
    const active = db.get(`SELECT * FROM courses WHERE event_id=? AND is_active=1 AND route_key=? AND
      (group_key IS ? OR group_key=?) ORDER BY version DESC LIMIT 1`, [e.id, routeKey, groupKey, groupKey]);
    if (active && active.locked_at && !body.forceNewVersion) return fail(res, 409, '该路线已锁定，请先解锁或明确创建新版本', 'ROUTE_LOCKED');
    try {
      const result = db.tx(() => {
        const prev = db.get('SELECT MAX(version) AS v FROM courses WHERE event_id=? AND route_key=? AND (group_key IS ? OR group_key=?)', [e.id, routeKey, groupKey, groupKey]);
        const version = Number(prev && prev.v || 0) + 1;
        db.run('UPDATE courses SET is_active=0 WHERE event_id=? AND route_key=? AND (group_key IS ? OR group_key=?)', [e.id, routeKey, groupKey, groupKey]);
        const status = ['draft', 'surveyed', 'published'].includes(p.status) ? p.status : 'draft';
        const publishedAt = status === 'published' ? now() : null;
        const ins = db.run(`INSERT INTO courses
          (event_id,version,name,points_json,start_lng,start_lat,finish_lng,finish_lat,start_radius_m,finish_radius_m,closed,distance_m,source,crs,status,surveyed_at,surveyed_by,is_active,route_key,group_key,published_at,locked_at,survey_evidence_json,updated_at,created_by,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [e.id, version, p.name, JSON.stringify(points), route.start[0], route.start[1], route.finish[0], route.finish[1],
            clampInt(p.startRadius, 80, 5, 500), clampInt(p.finishRadius, 80, 5, 500), closed ? 1 : 0, Math.round(dist), p.source,
            'gcj02', status, p.surveyedAt || null, p.surveyedAt ? admin.id : null, 1, routeKey, groupKey, publishedAt, null,
            p.surveyedEvidence ? JSON.stringify(p.surveyedEvidence).slice(0, 20000) : null, now(), admin.id, now()]);
        const courseId = Number(ins.lastInsertRowid);
        p.checkpoints.forEach((cp, i) => {
          const methods = ['manual'];
          db.run(`INSERT INTO checkpoints (course_id,code,name,order_index,lng,lat,radius_m,required,reward_points,methods_json,created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [courseId, String(cp.id || `CP${i + 1}`), String(cp.name).trim(), Number(cp.order || i + 1),
            Number(cp.lnglat[0]), Number(cp.lnglat[1]), clampInt(cp.radius, 30, 5, 500), cp.required === false ? 0 : 1,
            clampInt(cp.rewardPoints, 0, 0, 1000), JSON.stringify(methods), now()]);
        });
        return { courseId, version, distance: Math.round(dist), routeKey, groupKey, status };
      });
      audit(admin, 'course.save', result.courseId, result, req);
      ok(res, Object.assign({ saved: true }, result), { message: '路线已保存' });
    } catch (err) {
      console.error('[course.save]', err); fail(res, 500, '保存失败：' + err.message);
    }
  });
  router.post('/api/course/:id/activate', async (req, res) => {
    const admin = requireAdmin(req, res, ['admin']); if (!admin) return;
    const id = Number(req.params.id); const c = db.get('SELECT * FROM courses WHERE id=?', [id]);
    if (!c) return fail(res, 404, '路线版本不存在');
    if (c.locked_at) return fail(res, 409, '路线已锁定，不能切换', 'ROUTE_LOCKED');
    db.tx(() => {
      db.run('UPDATE courses SET is_active=0 WHERE event_id=? AND route_key=? AND (group_key IS ? OR group_key=?)', [c.event_id, c.route_key || 'default', c.group_key, c.group_key]);
      db.run('UPDATE courses SET is_active=1 WHERE id=?', [id]);
    });
    audit(admin, 'course.activate', id, null, req); ok(res, { activated: true, courseId: id });
  });
  router.post('/api/course/:id/publish', async (req, res) => {
    const admin = requireAdmin(req, res, ['admin']); if (!admin) return;
    const id = Number(req.params.id); const c = db.get('SELECT * FROM courses WHERE id=?', [id]);
    if (!c) return fail(res, 404, '路线版本不存在');
    return fail(res,400,'请使用荧光夜跑审核发布入口，逐项核对策划必经点','REVIEW_REQUIRED');
    db.run("UPDATE courses SET status='published', published_at=?, is_active=1, updated_at=? WHERE id=?", [now(), now(), id]);
    audit(admin, 'course.publish', id, null, req); ok(res, { published: true, courseId: id });
  });
  router.post('/api/course/:id/lock', async (req, res) => {
    const admin = requireAdmin(req, res, ['admin']); if (!admin) return;
    const id = Number(req.params.id); const c = db.get('SELECT * FROM courses WHERE id=?', [id]);
    if (!c) return fail(res, 404, '路线版本不存在');
    db.run('UPDATE courses SET locked_at=?, locked_by=?, updated_at=? WHERE id=?', [now(), admin.id, now(), id]);
    audit(admin, 'course.lock', id, null, req); ok(res, { locked: true, courseId: id });
  });
  router.post('/api/course/:id/unlock', async (req, res) => {
    const admin = requireAdmin(req, res, ['admin']); if (!admin) return;
    const id = Number(req.params.id); if (!db.get('SELECT id FROM courses WHERE id=?', [id])) return fail(res, 404, '路线版本不存在');
    db.run('UPDATE courses SET locked_at=NULL, locked_by=NULL, updated_at=? WHERE id=?', [now(), id]);
    audit(admin, 'course.unlock', id, null, req); ok(res, { locked: false, courseId: id });
  });

  /* Administrator authentication */
  router.post('/api/admin/login', async (req, res) => {
    const body = bodyObject(await readBody(req)); const ip = getClientIp(req);
    const username = String(body.username || '').trim() || 'admin'; const password = String(body.password || body.passcode || '');
    const key = `${ip}|${username}`; const rl = auth.checkRateLimit(key);
    if (!rl.ok) return fail(res, 429, `尝试次数过多，请 ${Math.ceil(rl.retryAfter / 60)} 分钟后再试`, 'RATE_LIMIT');
    if (!password) return fail(res, 400, '请输入密码');
    const admin = db.get('SELECT * FROM admins WHERE username=?', [username]);
    if (!admin || !auth.verifyPassword(password, admin.password_hash)) {
      auth.noteFailure(key); audit(null, 'admin.login.fail', username, { ip }, req); return fail(res, 401, '用户名或密码错误', 'BAD_CREDENTIALS');
    }
    auth.clearFailures(key); db.run('UPDATE admins SET last_login_at=? WHERE id=?', [now(), admin.id]);
    const token = auth.createSession(admin.id, req, res); audit(admin, 'admin.login', admin.id, { ip }, req);
    ok(res, { token, admin: { id: admin.id, username: admin.username, role: admin.role, displayName: admin.display_name }, expiresIn: auth.SESSION_TTL });
  });
  router.post('/api/admin/logout', (req, res) => { const a = auth.getSession(req); auth.destroySession(req, res); if (a) audit(a, 'admin.logout', a.id, null, req); ok(res, { loggedOut: true }); });
  router.get('/api/admin/me', (req, res) => {
    const a = auth.getSession(req); if (!a) return fail(res, 401, '未登录', 'UNAUTHORIZED');
    ok(res, { id: a.id, username: a.username, role: a.role, displayName: a.display_name, expiresAt: a.session.expires_at });
  });
  router.post('/api/admin/password', async (req, res) => {
    const a = requireAdmin(req, res); if (!a) return;
    const b = bodyObject(await readBody(req)); const cur = db.get('SELECT * FROM admins WHERE id=?', [a.id]);
    if (!auth.verifyPassword(String(b.oldPassword || ''), cur.password_hash)) return fail(res, 401, '原密码错误');
    if (String(b.newPassword || '').length < 8) return fail(res, 400, '新密码至少 8 位');
    auth.setPassword(a.id, b.newPassword); db.run('UPDATE sessions SET revoked_at=? WHERE admin_id=? AND token<>?', [now(), a.id, a.token]);
    audit(a, 'admin.password.change', a.id, null, req); ok(res, { changed: true });
  });

  /* Registration and check-in */
  router.post('/api/participants', async (req, res) => {
    const body = bodyObject(await readBody(req)); const e = getEvent(); if (!e) return fail(res, 404, '赛事不存在');
    const closed = regClosedReason(e); if (closed) return fail(res, 400, closed, 'REG_CLOSED');
    const sid = String(body.sid || '').trim(), name = String(body.name || '').trim(), college = String(body.college || '').trim();
    const groupKey = String(body.group || body.groupKey || '').trim(), phone = String(body.phone || '').trim();
    const groups = json(e.groups_json, DEFAULTS.GROUPS) || DEFAULTS.GROUPS;
    const errors = [];
    if (!/^\d{6,12}$/.test(sid)) errors.push('学号应为 6-12 位数字');
    if (name.length < 2) errors.push('请填写姓名'); if (!college) errors.push('请选择学院');
    if (!Object.keys(groups).includes(groupKey)) errors.push('请选择组别');
    if (phone && !/^1\d{10}$/.test(phone)) errors.push('手机号格式不正确');
    if (groupKey === 'unity') {
      const p = body.partner || {};
      if (!/^\d{6,12}$/.test(String(p.sid || ''))) errors.push('队友学号应为 6-12 位数字');
      if (String(p.name || '').trim().length < 2) errors.push('请填写队友姓名'); if (!p.college) errors.push('请选择队友学院');
      if (String(p.sid) === sid) errors.push('队友学号不能与自己相同');
      if (db.get('SELECT id FROM participants WHERE event_id=? AND sid=?', [e.id, String(p.sid || '')])) errors.push('队友学号已报名');
    }
    if (errors.length) return fail(res, 400, errors[0], 'VALIDATION');
    const existing = db.get('SELECT * FROM participants WHERE event_id=? AND (sid=? OR partner_sid=?)', [e.id, sid, sid]);
    if (existing) {
      if (!participantAccess(req,res,existing,body)) return;
      return ok(res, serializeParticipant(existing), { existed: true, message: '该学号已报名' });
    }
    if (groupKey === 'unity' && db.get('SELECT id FROM participants WHERE event_id=? AND (sid=? OR partner_sid=?)',[e.id,String(body.partner.sid),String(body.partner.sid)])) return fail(res,400,'队友已报名');
    const partner = groupKey === 'unity' ? body.partner : null;
    const ins = db.run(`INSERT INTO participants
      (event_id,sid,name,college,phone,group_key,team_code,partner_sid,partner_name,partner_college,status,device_id,ip,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [e.id, sid, name, college, phone || null, groupKey,
      partner ? `T${sid}-${partner.sid}` : null, partner ? String(partner.sid) : null, partner ? String(partner.name).trim() : null,
      partner ? String(partner.college) : null, 'registered', String(body.deviceId || '').slice(0, 128), getClientIp(req), now(), now()]);
    const participantToken = crypto.randomBytes(32).toString('hex');
    db.run('UPDATE participants SET access_token=? WHERE id=?',[participantToken,Number(ins.lastInsertRowid)]);
    ok(res, Object.assign(serializeParticipant(db.get('SELECT * FROM participants WHERE id=?', [Number(ins.lastInsertRowid)])),{participantToken}), { message: '报名成功' });
  });
  router.get('/api/participants/:sid', (req, res) => {
    const e = getEvent(); const p = e && db.get('SELECT * FROM participants WHERE event_id=? AND sid=?', [e.id, req.params.sid]);
    if (!p) return fail(res, 404, '未找到报名记录');
    if (!participantAccess(req,res,p)) return;
    ok(res, serializeParticipant(p));
  });
  router.get('/api/participants', (req, res) => {
    const a = requireAdmin(req, res, ['admin', 'referee', 'viewer']); if (!a) return;
    const e = getEvent(); const q = parseQuery(req); let sql = 'SELECT * FROM participants WHERE event_id=?'; const p = [e.id];
    if (q.group) { sql += ' AND group_key=?'; p.push(q.group); } if (q.status) { sql += ' AND status=?'; p.push(q.status); }
    if (q.q) { sql += ' AND (sid LIKE ? OR name LIKE ? OR college LIKE ?)'; const x = `%${q.q}%`; p.push(x, x, x); }
    sql += ' ORDER BY created_at DESC LIMIT ?'; p.push(Math.min(Number(q.limit) || 1000, 5000)); ok(res, db.all(sql, p).map(serializeParticipant));
  });
  router.patch('/api/participants/:id', async (req, res) => {
    const a = requireAdmin(req, res, ['admin', 'referee']); if (!a) return;
    const id = Number(req.params.id); const rec = db.get('SELECT * FROM participants WHERE id=?', [id]); if (!rec) return fail(res, 404, '选手不存在');
    const b = bodyObject(await readBody(req)); const allowedStatus = ['registered', 'checked', 'running', 'finished', 'dnf', 'dsq'];
    const fields = [], p = []; for (const [k, col] of Object.entries({ name: 'name', college: 'college', phone: 'phone', status: 'status', bib: 'bib' })) {
      if (b[k] !== undefined) { if (k === 'status' && !allowedStatus.includes(String(b[k]))) return fail(res, 400, '状态不合法', 'VALIDATION'); fields.push(`${col}=?`); p.push(b[k]); }
    }
    if (!fields.length) return fail(res, 400, '没有需要更新的字段'); fields.push('updated_at=?'); p.push(now(), id);
    db.run(`UPDATE participants SET ${fields.join(',')} WHERE id=?`, p); audit(a, 'participant.update', id, b, req); ok(res, serializeParticipant(db.get('SELECT * FROM participants WHERE id=?', [id])));
  });
  router.delete('/api/participants/:id', (req, res) => {
    const a = requireAdmin(req, res, ['admin']); if (!a) return; const id = Number(req.params.id); const p = db.get('SELECT * FROM participants WHERE id=?', [id]);
    if (!p) return fail(res, 404, '选手不存在'); db.run('DELETE FROM participants WHERE id=?', [id]); audit(a, 'participant.delete', id, { sid: p.sid }, req); ok(res, { deleted: true });
  });
  router.get('/api/participants/export.csv', (req, res) => {
    const a = requireAdmin(req, res, ['admin', 'referee', 'viewer']); if (!a) return; const e = getEvent();
    const list = db.all('SELECT * FROM participants WHERE event_id=? ORDER BY created_at ASC', [e.id]);
    const head = ['学号', '姓名', '学院', '组别', '队友学号', '队友姓名', '队友学院', '手机号', '状态', '报名时间'];
    const groups = json(e.groups_json, DEFAULTS.GROUPS); const rows = [head.join(',')];
    list.forEach((r) => rows.push([r.sid, r.name, r.college, (groups[r.group_key] || {}).name || r.group_key, r.partner_sid || '', r.partner_name || '', r.partner_college || '', r.phone || '', r.status, new Date(r.created_at).toLocaleString('zh-CN')].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')));
    audit(a, 'participants.export', null, { count: list.length }, req); res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="participants-${Date.now()}.csv"` }); res.end('\ufeff' + rows.join('\r\n'));
  });

  router.post('/api/checkins', async (req, res) => {
    const b = bodyObject(await readBody(req)); const e = getEvent(); const p = db.get('SELECT * FROM participants WHERE event_id=? AND sid=?', [e.id, String(b.sid || '').trim()]);
    if (!p) return fail(res, 404, '请先完成报名', 'NOT_REGISTERED');
    if (!participantAccess(req,res,p,b)) return;
    const old = db.get('SELECT * FROM checkins WHERE participant_id=?', [p.id]); if (old) return ok(res, serializeCheckin(old), { existed: true });
    const course = night.selected(e.id, p.group_key); if (!course) return fail(res, 400, '本组路线尚未审核发布', 'NO_COURSE');
    const method = String(b.method || 'gps'); const isManual = method === 'manual' || method === 'qrcode';
    if (isManual) return fail(res, 403, '签到方式需要裁判端操作', 'FORBIDDEN');
    const point = competition.normalizePoint(b, { allowSimulation: false }); if (!point.ok) return fail(res, 400, point.error || '请提供 GPS 原始坐标', 'VALIDATION');
    const dist = competition.distanceM([point.lng, point.lat], [course.start_lng, course.start_lat]);
    const cfg = rules.rulesForEvent(e, p.group_key); const radius = Number(course.start_radius_m || cfg.startRadiusM);
    if (point.accuracy == null || point.accuracy > cfg.unreliableAccuracyM || !point.clientTs || Math.abs(now()-point.clientTs)>45000) return fail(res,400,'签到需要45秒内、精度可靠的定位');
    if (dist > radius + (point.accuracy || 0) * cfg.accuracyFactor) return fail(res, 400, `尚未进入签到范围（距起点约 ${Math.round(dist)} 米）`, 'OUT_OF_RANGE');
    const t = now(); const ins = db.run(`INSERT INTO checkins
      (participant_id,event_id,ts,lng,lat,raw_lng,raw_lat,accuracy_m,dist_to_start,method,created_at,coordinate_verified)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [p.id, e.id, t, point.lng, point.lat, point.rawLng, point.rawLat, point.accuracy, dist, 'gps', t, point.coordinateVerified ? 1 : 0]);
    db.run("UPDATE participants SET status='checked', updated_at=? WHERE id=?", [t, p.id]); ok(res, serializeCheckin(db.get('SELECT * FROM checkins WHERE id=?', [Number(ins.lastInsertRowid)])), { message: '签到成功' });
  });
  router.get('/api/checkins/:sid', (req, res) => {
    const e = getEvent(); const p = e && db.get('SELECT * FROM participants WHERE event_id=? AND sid=?', [e.id, req.params.sid]); if (!p) return fail(res, 404, '未报名');
    if (!participantAccess(req,res,p)) return;
    const c = db.get('SELECT * FROM checkins WHERE participant_id=? ORDER BY id DESC LIMIT 1', [p.id]); ok(res, c ? serializeCheckin(c) : null);
  });

  /* Run lifecycle and server-side GPS/rule engine */
  router.post('/api/runs/start', async (req, res) => {
    const b = bodyObject(await readBody(req)); const e = getEvent(); const p = db.get('SELECT * FROM participants WHERE event_id=? AND sid=?', [e.id, String(b.sid || '').trim()]);
    if (!p) return fail(res, 404, '请先报名', 'NOT_REGISTERED');
    if (!participantAccess(req,res,p,b)) return;
    const cfgGroup = rules.groupConfig(e,p.group_key) || {};
    const startAt = new Date(cfgGroup.startAt || e.start_at).getTime();
    const cutoff = new Date(cfgGroup.closeAt || (startAt + Number(e.close_minutes)*60000)).getTime();
    if (e.status !== 'running' || !Number.isFinite(startAt) || now()<startAt || now()>cutoff) return fail(res,400,'未到本组开跑时间、赛事未开启或已截止','EVENT_CLOSED');
    const existing = db.get("SELECT * FROM runs WHERE participant_id=? AND status='running'", [p.id]); if (existing) return ok(res, Object.assign(serializeRun(existing), { accessToken: existing.access_token }), { existed: true });
    if (!db.get('SELECT id FROM checkins WHERE participant_id=?', [p.id]) && String(b.mode || 'gps') !== 'simulation') return fail(res, 400, '请先完成现场签到', 'NOT_CHECKED');
    const mode = String(b.mode || 'gps'); if (mode !== 'gps') return fail(res, 400, '正式比赛仅接受真实 GPS', 'VALIDATION');
    const course = night.selected(e.id, p.group_key); if (!course) return fail(res, 400, '本组路线尚未审核发布', 'NO_COURSE');
    const cps = competition.courseCheckpoints(course.id); const accessToken = crypto.randomBytes(32).toString('hex'); const t = now();
    const ins = db.run(`INSERT INTO runs
      (participant_id,event_id,course_id,started_at,cp_total,status,mode,access_token,created_at,updated_at,review_status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [p.id, e.id, course.id, t, cps.filter((x) => x.required).length, 'running', mode, accessToken, t, t, 'pending']);
    db.run("UPDATE participants SET status='running', updated_at=? WHERE id=?", [t, p.id]);
    ok(res, Object.assign(serializeRun(db.get('SELECT * FROM runs WHERE id=?', [Number(ins.lastInsertRowid)])), { accessToken }));
  });
  router.post('/api/runs/:id/track', async (req, res) => {
    const b = bodyObject(await readBody(req)); const run = getRun(req.params.id); const access = canAccessRun(req, res, run, b, { eventId: run && run.event_id }); if (!access) return;
    if (run.status !== 'running') return fail(res, 400, '比赛已结束', 'RUN_FINISHED');
    if (!Array.isArray(b.points) || !b.points.length) return fail(res, 400, '没有轨迹点', 'VALIDATION');
    if (b.points.length > 200) b.points = b.points.slice(0, 200);
    if (run.mode === 'gps' && b.points.some((p) => p && String(p.source || 'gps') === 'simulation')) return fail(res, 400, '真实比赛不接受模拟轨迹', 'SIMULATION_NOT_ALLOWED');
    const e = getEvent(); let result;
    try { result = db.tx(() => competition.processTrackBatch(run, e, b, { groupKey: db.get('SELECT group_key FROM participants WHERE id=?', [run.participant_id]).group_key, allowSimulation: run.mode === 'simulation' })); }
    catch (err) { console.error('[track]', err); return fail(res, 500, '轨迹处理失败：' + err.message); }
    ok(res, result);
  });
  router.post('/api/runs/:id/hit', async (req, res) => {
    const b = bodyObject(await readBody(req)); const run = getRun(req.params.id); const access = canAccessRun(req, res, run, b, { eventId: run && run.event_id }); if (!access) return;
    if (run.status !== 'running') return fail(res, 400, '比赛已结束', 'RUN_FINISHED');
    const cp = b.code ? db.get('SELECT * FROM checkpoints WHERE course_id=? AND code=?', [run.course_id, String(b.code)]) : db.get('SELECT * FROM checkpoints WHERE course_id=? AND id=?', [run.course_id, Number(b.checkpointId)]);
    if (!cp) return fail(res, 404, '打卡点不存在');
    const duplicate = db.get('SELECT * FROM cp_hits WHERE run_id=? AND checkpoint_id=?', [run.id, cp.id]); if (duplicate) return ok(res, { duplicate: true, hit: serializeHit(duplicate) }, { message: '已打过该点' });
    const participant = db.get('SELECT * FROM participants WHERE id=?', [run.participant_id]); const event = getEvent(); const cfg = rules.rulesForEvent(event, participant.group_key);
    const method = String(b.method || 'gps'); const methods = checkpointMethods(cp); let point = null; let dist = null; let reason = null; let evidence = null; let verified = 0;
    const operator = auth.getSession(req);
    if (method !== 'manual' || !operator || !['admin','referee'].includes(operator.role)) return fail(res,403,'GPS仅判断接近；游戏必须由现场工作人员盖章','STAFF_REQUIRED');
    if (b.gameCompleted !== true || !String(b.note||'').trim()) return fail(res,400,'请确认现场游戏成功并填写凭证/核验备注');
    if (participant.group_key === 'unity' && b.bothPresent !== true) return fail(res,400,'请确认同心组两人均在现场');
    if (method === 'gps') {
      evidence = competition.latestAcceptedPoint(run.id);
      const submitted = makePointFromBody(b);
      if (!evidence && !submitted.ok) reason = '没有可用的服务器轨迹证据';
      else {
        const lng = evidence ? evidence.lng : submitted.lng; const lat = evidence ? evidence.lat : submitted.lat; const acc = evidence ? evidence.accuracy_m : submitted.accuracy;
        dist = competition.distanceM([lng, lat], [cp.lng, cp.lat]);
        const age = evidence ? now() - evidence.server_ts : Infinity;
        const effective = Number(cp.radius_m || cfg.checkpointDefaultRadiusM) + (acc || 0) * cfg.checkpointAccuracyFactor;
        if (!methods.includes('gps')) reason = '该打卡点不允许 GPS 打卡';
        else if (!evidence && run.mode !== 'simulation') reason = '请先上传定位轨迹';
        else if (evidence && age > cfg.checkpointMaxAgeSec * 1000) reason = '定位证据已过期';
        else if (acc == null || acc > cfg.unreliableAccuracyM) reason = '定位精度不足，暂不能确认打卡';
        else if (dist > effective) reason = `距离打卡点约 ${Math.round(dist)} 米`;
        else { verified = evidence ? 1 : 0; }
      }
    } else if (method === 'qrcode' || method === 'manual') {
      if (!methods.includes(method) || !cfg[`allow${method === 'qrcode' ? 'Qr' : 'Manual'}Checkpoint`]) reason = '该打卡方式未启用';
      else if (!auth.getSession(req)) reason = '该方式需要裁判操作';
      else verified = 1;
    } else reason = '打卡方式不合法';
    const required = competition.requiredCheckpoints(run.course_id); const doneIds = new Set(db.all('SELECT checkpoint_id FROM cp_hits WHERE run_id=? AND valid=1', [run.id]).map((x) => x.checkpoint_id));
    const next = required.find((x) => !doneIds.has(x.id));
    if (!reason && cfg.requireOrderedCheckpoints && cp.required && next && cp.id !== next.id) {
      reason = `请先通过 ${next.name}`;
      competition.addAnomaly(run, 'cp_out_of_order', 'warn', { checkpointId: cp.id, expected: next.id }, evidence ? { lng: evidence.lng, lat: evidence.lat } : null, run.event_id);
    }
    const t = now(); const valid = !reason;
    db.run(`INSERT INTO checkpoint_attempts
      (run_id,participant_id,checkpoint_id,event_id,ts,method,lng,lat,raw_lng,raw_lat,accuracy_m,dist_m,valid,reason,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [run.id, run.participant_id, cp.id, run.event_id, t, method,
      evidence ? evidence.lng : null, evidence ? evidence.lat : null, evidence ? evidence.raw_lng : null, evidence ? evidence.raw_lat : null,
      evidence ? evidence.accuracy_m : null, dist, valid ? 1 : 0, reason, t]);
    if (!valid) return ok(res, { valid: false, reason, distM: dist, cpDone: currentRequiredDone(run.id), cpTotal: run.cp_total });
    const elapsed = run.started_at ? t - run.started_at : null; const reward = Number(cp.reward_points || 0);
    const ins = db.run(`INSERT INTO cp_hits
      (run_id,participant_id,checkpoint_id,event_id,ts,elapsed_ms,lng,lat,dist_m,valid,accuracy_m,coordinate_verified,validation_flags,reward_points,evidence_point_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [run.id, run.participant_id, cp.id, run.event_id, t, elapsed,
      evidence ? evidence.lng : null, evidence ? evidence.lat : null, dist, 1, evidence ? evidence.accuracy_m : null, verified, null, reward, evidence ? evidence.id : null, t]);
    db.run('UPDATE cp_hits SET method=?,operator_id=?,note=? WHERE id=?',[method,operator.id,String(b.note).slice(0,2000),Number(ins.lastInsertRowid)]);
    audit(operator,'game.stamp',run.id,{code:cp.code,note:b.note,bothPresent:!!b.bothPresent},req);
    const done = currentRequiredDone(run.id); db.run('UPDATE runs SET cp_done=?, reward_points=reward_points+?, updated_at=? WHERE id=?', [done, reward, t, run.id]);
    ok(res, { hit: serializeHit(Object.assign(db.get('SELECT * FROM cp_hits WHERE id=?', [Number(ins.lastInsertRowid)]), { code: cp.code, name: cp.name, order_index: cp.order_index })), cpDone: done, cpTotal: run.cp_total, valid: true });
  });
  router.post('/api/runs/:id/finish', async (req, res) => {
    const b = bodyObject(await readBody(req)); const run = getRun(req.params.id); const access = canAccessRun(req, res, run, b, { eventId: run && run.event_id }); if (!access) return;
    if (run.status !== 'running') return ok(res, serializeRun(run), { existed: true });
    const e = getEvent(); const participant = db.get('SELECT * FROM participants WHERE id=?', [run.participant_id]); const cfg = rules.rulesForEvent(e, participant.group_key);
    const course = db.get('SELECT * FROM courses WHERE id=?', [run.course_id]); const evidence = competition.latestAcceptedPoint(run.id); let finishDist = null; let finishValid = false;
    if (evidence && course) { finishDist = competition.distanceM([evidence.lng, evidence.lat], [course.finish_lng, course.finish_lat]); finishValid = finishDist <= Number(course.finish_radius_m || cfg.finishRadiusM) + (evidence.accuracy_m || 0) * cfg.accuracyFactor && evidence.accuracy_m != null && evidence.accuracy_m <= cfg.unreliableAccuracyM && now() - evidence.client_ts <= cfg.checkpointMaxAgeSec*1000;  }
    const proof = json(course && course.survey_evidence_json, {});
    const route = competition.parseCoursePoints(course);
    const missing = (proof.landmarks || []).filter(mark => {
      const target=route[mark.nodeIndex]; if (!target) return true;
      return !db.all('SELECT lng,lat,accuracy_m FROM track_points WHERE run_id=? AND accepted=1 AND reliable=1',[run.id]).some(p=>competition.distanceM([p.lng,p.lat],target)<=30+Math.min(p.accuracy_m||0,30));
    });
    if (missing.length) competition.addAnomaly(run,'mandatory_points_missing','warn',{names:missing.map(m=>m.name)},null,run.event_id);
    const cpDone = currentRequiredDone(run.id); const completed = cpDone >= run.cp_total && (!cfg.requireFinish || finishValid); const t = now(); const elapsed = run.started_at ? t - run.started_at : 0;
    if (!completed) return fail(res,400,'请按顺序完成三个现场游戏，并在终点获得新鲜、精度可靠的定位。失联请联系工作人员记录纸质凭证。','FINISH_PENDING');
    if (!finishValid) competition.addAnomaly(run, 'finish_invalid', 'warn', { distanceM: finishDist }, evidence ? { lng: evidence.lng, lat: evidence.lat } : null, run.event_id, t);
    db.tx(() => {
      db.run(`UPDATE runs SET ended_at=?,elapsed_ms=?,cp_done=?,completed=?,status=?,finish_dist_m=?,finish_valid=?,updated_at=? WHERE id=?`, [t, elapsed, cpDone, completed ? 1 : 0, completed ? 'finished' : 'dnf', finishDist, finishValid ? 1 : 0, t, run.id]);
      db.run('UPDATE participants SET status=?, updated_at=? WHERE id=?', [completed ? 'finished' : 'dnf', t, run.participant_id]);
    });
    const fresh = db.get('SELECT * FROM runs WHERE id=?', [run.id]); competition.summarizeRun(fresh); ok(res, serializeRun(db.get('SELECT * FROM runs WHERE id=?', [run.id])));
  });
  router.get('/api/runs/:id', (req, res) => {
    const run = getRun(req.params.id); const access = canAccessRun(req, res, run, null, { eventId: run && run.event_id }); if (!access) return;
    const hits = db.all(`SELECT h.*,c.code,c.name,c.order_index FROM cp_hits h JOIN checkpoints c ON c.id=h.checkpoint_id WHERE h.run_id=? ORDER BY c.order_index`, [run.id]);
    const quality = json(run.quality_json, null); ok(res, Object.assign(serializeRun(run, quality), { hits: hits.map(serializeHit) }));
  });
  router.get('/api/runs/:id/track.gpx', (req, res) => {
    const a = requireAdmin(req, res, ['admin', 'referee', 'viewer']); if (!a) return; const run = getRun(req.params.id); if (!run) return fail(res, 404, '比赛记录不存在');
    const pts = db.all('SELECT * FROM track_points WHERE run_id=? ORDER BY seq', [run.id]); const p = db.get('SELECT name,sid FROM participants WHERE id=?', [run.participant_id]);
    const lines = pts.filter((x) => x.raw_lat != null && x.raw_lng != null).map((x) => `      <trkpt lat="${Number(x.raw_lat).toFixed(8)}" lon="${Number(x.raw_lng).toFixed(8)}"><time>${new Date(x.client_ts || x.server_ts).toISOString()}</time></trkpt>`).join('\n');
    const gpx = `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="qzsf-orienteering" xmlns="http://www.topografix.com/GPX/1/1"><metadata><name>${p ? p.name : 'run'} ${p ? p.sid : ''}</name><desc>原始轨迹坐标：WGS84；服务器另存 GCJ-02 显示坐标</desc></metadata><trk><trkseg>\n${lines}\n  </trkseg></trk></gpx>`;
    res.writeHead(200, { 'Content-Type': 'application/gpx+xml; charset=utf-8', 'Content-Disposition': `attachment; filename="run-${run.id}.gpx"` }); res.end(gpx);
  });

  /* Leaderboard and public stats */
  router.get('/api/leaderboard', (req, res) => {
    const e = getEvent(); const q = parseQuery(req); let sql = `SELECT r.*,p.name,p.sid,p.college,p.group_key,p.partner_name FROM runs r JOIN participants p ON p.id=r.participant_id WHERE r.event_id=? AND r.status='finished' AND r.completed=1 AND r.mode='gps' AND r.review_status='cleared'`;
    const p = [e.id]; if (q.group && q.group !== 'all') { sql += ' AND p.group_key=?'; p.push(q.group); } sql += ' ORDER BY r.elapsed_ms ASC LIMIT ?'; p.push(Math.min(Number(q.limit) || 200, 1000));
    ok(res, db.all(sql, p).map((r, i) => ({ rank: i + 1, sid: r.sid, name: r.name, college: r.college, group: r.group_key, partner: r.partner_name, elapsedMs: r.elapsed_ms, distance: Math.round(r.distance_m || 0), cpDone: r.cp_done, cpTotal: r.cp_total, finishedAt: r.ended_at })));
  });
  router.get('/api/public/stats', (req, res) => { const e = getEvent(); if (!e) return ok(res, { total: 0, checked: 0, finished: 0 });
    ok(res, { total: db.get('SELECT COUNT(*) AS n FROM participants WHERE event_id=?', [e.id]).n, checked: db.get("SELECT COUNT(*) AS n FROM participants WHERE event_id=? AND status IN ('checked','running','finished')", [e.id]).n, finished: db.get("SELECT COUNT(*) AS n FROM runs WHERE event_id=? AND status='finished'", [e.id]).n });
  });

  /* Admin live monitor / evidence / review */
  router.get('/api/admin/live', (req, res) => {
    const a = requireAdmin(req, res, ['admin', 'referee', 'viewer']); if (!a) return; const e = getEvent(); const q = parseQuery(req); const cutoff = now() - clampInt(q.staleSec, 45, 10, 3600) * 1000;
    const rows = db.all(`SELECT r.*,p.sid,p.name,p.college,p.group_key,p.bib FROM runs r JOIN participants p ON p.id=r.participant_id WHERE r.event_id=? AND r.status='running' ORDER BY r.updated_at DESC`, [e.id]);
    const anomalies = db.get('SELECT COUNT(*) AS n FROM anomalies WHERE event_id=? AND reviewed=0', [e.id]).n;
    ok(res, { serverTime: now(), online: rows.filter((r) => r.last_point_at && r.last_point_at >= cutoff).length, running: rows.length, unreviewedAnomalies: anomalies,
      rows: rows.map((r) => ({ runId: r.id, participantId: r.participant_id, sid: r.sid, name: r.name, college: r.college, group: r.group_key, bib: r.bib,
        status: r.last_point_at && r.last_point_at >= cutoff ? 'online' : 'stale', lastPointAt: r.last_point_at, lng: r.last_lng, lat: r.last_lat,
        accuracy: r.last_accuracy, routeDistance: r.last_route_distance, distance: Math.round(r.distance_m || 0), cpDone: r.cp_done, cpTotal: r.cp_total,
        warningCount: r.warning_count || 0, criticalCount: r.critical_count || 0, acceptedPoints: r.accepted_points || 0, rejectedPoints: r.rejected_points || 0 })) });
  });
  router.get('/api/admin/runs', (req, res) => {
    const a = requireAdmin(req, res, ['admin', 'referee', 'viewer']); if (!a) return; const e = getEvent(); const q = parseQuery(req); let sql = `SELECT r.*,p.sid,p.name,p.college,p.group_key FROM runs r JOIN participants p ON p.id=r.participant_id WHERE r.event_id=?`; const p = [e.id];
    if (q.status) { sql += ' AND r.status=?'; p.push(q.status); } if (q.q) { sql += ' AND (p.sid LIKE ? OR p.name LIKE ?)'; const x = `%${q.q}%`; p.push(x, x); } sql += ' ORDER BY r.updated_at DESC LIMIT ?'; p.push(Math.min(Number(q.limit) || 500, 2000));
    ok(res, db.all(sql, p).map((r) => Object.assign(serializeRun(r, json(r.quality_json, null)), { sid: r.sid, name: r.name, college: r.college, group: r.group_key })));
  });
  router.get('/api/admin/runs/:id', (req, res) => {
    const a = requireAdmin(req, res, ['admin', 'referee', 'viewer']); if (!a) return; const run = getRun(req.params.id); if (!run) return fail(res, 404, '比赛记录不存在');
    const p = db.get('SELECT * FROM participants WHERE id=?', [run.participant_id]); const hits = db.all(`SELECT h.*,c.code,c.name,c.order_index FROM cp_hits h JOIN checkpoints c ON c.id=h.checkpoint_id WHERE h.run_id=? ORDER BY c.order_index`, [run.id]);
    const anomalies = db.all('SELECT * FROM anomalies WHERE run_id=? ORDER BY ts DESC', [run.id]); const attempts = db.all(`SELECT a.*,c.code,c.name FROM checkpoint_attempts a JOIN checkpoints c ON c.id=a.checkpoint_id WHERE a.run_id=? ORDER BY a.ts DESC LIMIT 200`, [run.id]);
    ok(res, { run: Object.assign(serializeRun(run, json(run.quality_json, null)), { sid: p && p.sid, name: p && p.name, college: p && p.college, group: p && p.group_key }), hits: hits.map(serializeHit), anomalies, attempts });
  });
  router.get('/api/admin/runs/:id/track', (req, res) => {
    const a = requireAdmin(req, res, ['admin', 'referee', 'viewer']); if (!a) return; const run = getRun(req.params.id); if (!run) return fail(res, 404, '比赛记录不存在'); const q = parseQuery(req);
    const since = Number(q.since || 0); const limit = Math.min(Number(q.limit) || 1000, 5000); const pts = db.all(`SELECT * FROM track_points WHERE run_id=? AND id>? ORDER BY id LIMIT ?`, [run.id, since, limit]);
    ok(res, { runId: run.id, points: pts.map((p) => ({ id: p.id, seq: p.seq, lng: p.lng, lat: p.lat, rawLng: p.raw_lng, rawLat: p.raw_lat, accuracy: p.accuracy_m, speed: p.speed, clientTs: p.client_ts, serverTs: p.server_ts, accepted: !!p.accepted, reliable: !!p.reliable, backfill: !!p.is_backfill, flags: json(p.validation_flags, []), routeDistance: p.route_distance_m })) });
  });
  router.get('/api/anomalies', (req, res) => {
    const a = requireAdmin(req, res, ['admin', 'referee']); if (!a) return; const e = getEvent(); const q = parseQuery(req); let sql = `SELECT a.*,p.sid,p.name FROM anomalies a LEFT JOIN participants p ON p.id=a.participant_id WHERE a.event_id=?`; const p = [e.id];
    if (q.reviewed !== undefined) { sql += ' AND a.reviewed=?'; p.push(q.reviewed === '1' ? 1 : 0); } if (q.severity) { sql += ' AND a.severity=?'; p.push(q.severity); } if (q.runId) { sql += ' AND a.run_id=?'; p.push(Number(q.runId)); }
    sql += ' ORDER BY a.ts DESC LIMIT ?'; p.push(Math.min(Number(q.limit) || 500, 2000)); ok(res, db.all(sql, p).map((x) => Object.assign(x, { detail: json(x.detail_json, null) })));
  });
  router.patch('/api/anomalies/:id', async (req, res) => {
    const a = requireAdmin(req, res, ['admin', 'referee']); if (!a) return; const id = Number(req.params.id); const old = db.get('SELECT * FROM anomalies WHERE id=?', [id]); if (!old) return fail(res, 404, '异常记录不存在'); const b = bodyObject(await readBody(req));
    const reviewed = b.reviewed === undefined ? 1 : (b.reviewed ? 1 : 0); const resolution = String(b.resolution || (reviewed ? 'reviewed' : 'reopened')).slice(0, 2000);
    db.run('UPDATE anomalies SET reviewed=?,reviewed_by=?,resolved_at=?,resolution=? WHERE id=?', [reviewed, a.id, reviewed ? now() : null, resolution, id]); audit(a, 'anomaly.review', id, { reviewed, resolution }, req); ok(res, db.get('SELECT * FROM anomalies WHERE id=?', [id]));
  });
  router.patch('/api/admin/runs/:id/review', async (req, res) => {
    const a = requireAdmin(req, res, ['admin', 'referee']); if (!a) return; const run = getRun(req.params.id); if (!run) return fail(res, 404, '比赛记录不存在'); const b = bodyObject(await readBody(req)); const status = String(b.status || 'cleared');
    if (!['pending', 'cleared', 'penalized'].includes(status)) return fail(res, 400, '复核状态不合法', 'VALIDATION');
    if (status === 'cleared' && (!String(b.note||'').trim() || db.get('SELECT COUNT(*) AS n FROM anomalies WHERE run_id=? AND reviewed=0',[run.id]).n>0)) return fail(res,400,'请先复核全部异常并填写成绩审核依据');
    if (status === 'penalized' && a.role !== 'admin') return fail(res, 403, '只有管理员可以执行判罚', 'FORBIDDEN');
    db.run("UPDATE runs SET review_status=?,review_note=?,status=?,completed=CASE WHEN ?='penalized' THEN 0 ELSE completed END,updated_at=? WHERE id=?", [status, String(b.note || '').slice(0, 2000), status === 'penalized' ? 'dsq' : run.status, status, now(), run.id]);
    if (status === 'penalized') db.run("UPDATE participants SET status='dsq',updated_at=? WHERE id=?", [now(), run.participant_id]);
    audit(a, 'run.review', run.id, { status, note: b.note || '' }, req); ok(res, serializeRun(db.get('SELECT * FROM runs WHERE id=?', [run.id])));
  });

  router.get('/api/stats', (req, res) => {
    const a = requireAdmin(req, res, ['admin', 'referee', 'viewer']); if (!a) return; const e = getEvent();
    const total = db.get('SELECT COUNT(*) AS n FROM participants WHERE event_id=?', [e.id]).n; const byStatus = db.all('SELECT status,COUNT(*) AS n FROM participants WHERE event_id=? GROUP BY status', [e.id]);
    const byGroup = db.all('SELECT group_key,COUNT(*) AS n FROM participants WHERE event_id=? GROUP BY group_key', [e.id]); const byCollege = db.all('SELECT college,COUNT(*) AS n FROM participants WHERE event_id=? GROUP BY college ORDER BY n DESC LIMIT 20', [e.id]);
    const finished = db.get("SELECT COUNT(*) AS n FROM runs WHERE event_id=? AND status='finished'", [e.id]).n; const best = db.get("SELECT MIN(elapsed_ms) AS t FROM runs WHERE event_id=? AND status='finished'", [e.id]); const avg = db.get("SELECT AVG(elapsed_ms) AS t FROM runs WHERE event_id=? AND status='finished'", [e.id]);
    ok(res, { total, finished, live: db.get("SELECT COUNT(*) AS n FROM runs WHERE event_id=? AND status='running'", [e.id]).n, anomalies: db.get('SELECT COUNT(*) AS n FROM anomalies WHERE event_id=? AND reviewed=0', [e.id]).n, byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.n])), byGroup: Object.fromEntries(byGroup.map((r) => [r.group_key, r.n])), byCollege, bestMs: best && best.t, avgMs: avg && avg.t != null ? Math.round(avg.t) : null });
  });
  router.post('/api/anomalies', async (req, res) => {
    const b = bodyObject(await readBody(req)); const run = getRun(b.runId); const access = canAccessRun(req, res, run, b, { eventId: run && run.event_id }); if (!access) return;
    const e = getEvent(); const p = b.lng != null && b.lat != null ? { lng: Number(b.lng), lat: Number(b.lat) } : null; const an = competition.addAnomaly(run, String(b.type || 'client_report').slice(0, 64), String(b.severity || 'warn'), b.detail || null, p, e.id); ok(res, an || { duplicate: true });
  });
  router.post('/api/admin/reset-ratelimit', (req, res) => { const a = requireAdmin(req, res, ['admin']); if (!a) return; auth.resetRateLimit(); audit(a, 'admin.ratelimit.reset', null, null, req); ok(res, { reset: true }); });
  router.get('/api/audit', (req, res) => { const a = requireAdmin(req, res, ['admin']); if (!a) return; ok(res, db.all(`SELECT a.*,ad.username FROM audit_logs a LEFT JOIN admins ad ON ad.id=a.admin_id ORDER BY a.created_at DESC LIMIT 300`)); });

  return router;
};

module.exports.serializeParticipant = serializeParticipant;
