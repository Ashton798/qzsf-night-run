'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const adminService = require('./admin-service');
const Coord = require('../assets/coord');
const {csvCell}=require('./admin-domain');

const EVENT_ID = 'qzsf-2025';
const EVENT_TITLE = '泉州师范学院第九届校园荧光夜跑';
const COOKIE = 'qzsf_student_session';
const ADMIN_COOKIE = 'qzsf_admin_session';
const MAX_BATCH = 200;

let sqlClient = null;
let schemaPromise = null;

function databaseUrl() {
  return String(process.env.DATABASE_URL || process.env.POSTGRES_URL || '').trim();
}

function sql() {
  if (!databaseUrl()) return null;
  if (!sqlClient) {
    const postgres = require('postgres');
    sqlClient = postgres(databaseUrl(), { max: 1, prepare: false, idle_timeout: 20, connect_timeout: 15 });
  }
  return sqlClient;
}

async function ensureSchema() {
  const db = sql();
  if (!db) throw coded('DB_NOT_CONFIGURED', '云端数据库尚未配置', 503);
  if (!schemaPromise) {
    schemaPromise = Promise.resolve().then(async () => {
      const source = fs.readFileSync(path.join(__dirname, 'migrations', '001_stage2.sql'), 'utf8');
      await db.unsafe(source);
      await db.unsafe(fs.readFileSync(path.join(__dirname, 'migrations', '002_admin.sql'), 'utf8'));
      await db`UPDATE qz_events SET title=${EVENT_TITLE}, updated_at=NOW() WHERE id=${EVENT_ID}`;
    }).catch((err) => { schemaPromise = null; throw err; });
  }
  return schemaPromise;
}

function coded(code, message, status) {
  const err = new Error(message);
  err.code = code;
  err.status = status || 400;
  return err;
}

function send(res, status, payload, headers) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  Object.entries(headers || {}).forEach(([k, v]) => res.setHeader(k, v));
  res.end(JSON.stringify(payload));
}

function ok(res, data, extra) { send(res, 200, Object.assign({ ok: true, data }, extra || {})); }
function fail(res, err) { send(res, err.status || 500, { ok: false, error: err.message || '服务器错误', code: err.code || 'SERVER_ERROR' }); }
function uid(prefix) { return prefix + '_' + crypto.randomUUID(); }
function hash(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function hmac(value) {
  const secret = String(process.env.SESSION_SECRET || '');
  if (secret.length < 24) throw coded('SESSION_SECRET_MISSING', '服务端会话密钥尚未安全配置', 503);
  return crypto.createHmac('sha256', secret).update(String(value)).digest('hex');
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function cookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map((part) => {
    const i = part.indexOf('=');
    return i < 0 ? ['', ''] : [part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim())];
  }).filter((x) => x[0]));
}

function setCookie(res, name, value, maxAge) {
  res.setHeader('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`);
}

async function body(req) {
  if (req.body !== undefined) {
    if (Buffer.byteLength(typeof req.body==='string'?req.body:JSON.stringify(req.body))>1024*1024) throw coded('TOO_LARGE','请求内容过大',413);
    if(req.body && typeof req.body==='object'&&!Buffer.isBuffer(req.body))return req.body;
    try{return JSON.parse(String(req.body||'{}'));}catch(_){throw coded('INVALID_JSON','请求格式不正确',400);}
  }
  const parts = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw coded('TOO_LARGE', '请求内容过大', 413);
    parts.push(chunk);
  }
  if (!parts.length) return {};
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch (_) { throw coded('INVALID_JSON', '请求格式不正确', 400); }
}

function clean(value, max) { return String(value == null ? '' : value).trim().slice(0, max); }
function validStudentId(v) { return /^[A-Za-z0-9_-]{6,24}$/.test(v); }
function validPhone(v) { return /^1[3-9]\d{9}$/.test(v); }
function passwordHash(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return 'scrypt$16384$' + salt.toString('base64url') + '$' + derived.toString('base64url');
}
function verifyPassword(password, encoded) {
  try {
    const parts = String(encoded || '').split('$');
    if (parts.length !== 4 || parts[0] !== 'scrypt' || parts[1] !== '16384') return false;
    const salt = Buffer.from(parts[2], 'base64url');
    const expected = Buffer.from(parts[3], 'base64url');
    const actual = crypto.scryptSync(password, salt, expected.length, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch (_) { return false; }
}
function validPassword(value) { return typeof value === 'string' && value.length >= 10 && value.length <= 128; }
function maskPhone(v) { return String(v || '').replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2'); }
function number(v) { if(v==null||v==='')return null; const n = Number(v); return Number.isFinite(n) ? n : null; }

function studentPublic(row) {
  return row && {
    id: row.id, studentId: row.student_id, name: row.name, college: row.college,
    className: row.class_name, phone: row.phone, createdAt: row.created_at, updatedAt: row.updated_at
  };
}

function eventPublic(row) {
  return row && {
    id: row.id, title: row.title, startTime: row.start_time, endTime: row.end_time,
    registrationStatus: row.registration_status, eventStatus: row.event_status
  };
}

function runPublic(row) {
  if (!row) return null;
  const duration = Number(row.duration_seconds || 0);
  const distance = Number(row.distance_meters || 0);
  return {
    id: row.id, eventId: row.event_id, startTime: row.start_time, endTime: row.end_time,
    duration, distance, status: row.status, sampleCount: Number(row.sample_count || 0),
    acceptedCount: Number(row.accepted_count || 0), rejectedCount: Number(row.rejected_count || 0), reviewStatus:row.review_status||'pending',
    gapCount: Number(row.gap_count || 0), quality: row.quality_json || {},
    averageSpeed: duration > 0 ? distance / duration : 0,
    averagePace: distance > 0 ? duration / 60 / (distance / 1000) : null,
    createdAt: row.created_at
  };
}

async function currentStudent(req) {
  const token = cookies(req)[COOKIE];
  if (!token) return null;
  const db = sql();
  const rows = await db`
    SELECT s.* FROM qz_student_sessions ss
    JOIN qz_students s ON s.id=ss.student_id
    WHERE ss.token_hash=${hash(token)} AND ss.revoked_at IS NULL AND ss.expires_at>NOW()
    LIMIT 1`;
  return rows[0] || null;
}

async function requireStudent(req) {
  const student = await currentStudent(req);
  if (!student) throw coded('AUTH_REQUIRED', '请先完成手机验证', 401);
  return student;
}

function adminToken(username) {
  const payload = Buffer.from(JSON.stringify({ u: username, exp: Date.now() + 8 * 3600 * 1000 })).toString('base64url');
  return payload + '.' + hmac(payload);
}

function currentAdmin(req) {
  const token = cookies(req)[ADMIN_COOKIE];
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig || !safeEqual(hmac(payload), sig)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.exp > Date.now() ? data : null;
  } catch (_) { return null; }
}

function requireAdmin(req) {
  const admin = currentAdmin(req);
  if (!admin) throw coded('ADMIN_AUTH_REQUIRED', '管理员登录已失效', 401);
  return admin;
}

function distanceM(aLat, aLng, bLat, bLng) {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad; const dLng = (bLng - aLng) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return 6371008.8 * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

function pointPublic(p) {
  const display=p.coordinate_system==='gcj02'?[Number(p.latitude),Number(p.longitude)]:Coord.wgs2gcj(Number(p.latitude),Number(p.longitude));
  return {
    seq: p.seq, latitude: Number(p.latitude), longitude: Number(p.longitude),
    displayLatitude: display[0],
    displayLongitude: display[1],
    accuracy: p.accuracy == null ? null : Number(p.accuracy), speed: p.speed == null ? null : Number(p.speed),
    heading: p.heading == null ? null : Number(p.heading), altitude: p.altitude == null ? null : Number(p.altitude),
    timestamp: p.recorded_at, coordinateSystem: p.coordinate_system,
    validityStatus: p.validity_status, validityFlags: p.validity_flags || [],
    isBackfill: !!p.is_backfill, segmentNo: Number(p.segment_no || 0)
  };
}

async function reportFor(run, includePoints, connection) {
  const db = connection || sql();
  const points = includePoints ? await db`SELECT * FROM qz_location_points WHERE session_id=${run.id} ORDER BY seq` : [];
  const accepted = points.filter((p) => p.validity_status === 'accepted');
  const accuracies = accepted.filter(p=>p.accuracy!=null).map((p) => Number(p.accuracy)).filter(Number.isFinite).sort((a, b) => a - b);
  const median = accuracies.length ? accuracies[Math.floor(accuracies.length / 2)] : null;
  const interruptions = includePoints ? await db`SELECT interruption_type,started_at,ended_at,note FROM qz_run_interruptions WHERE session_id=${run.id} ORDER BY started_at` : [];
  const pub = runPublic(run);
  pub.accuracy = { median, best: accuracies.length ? accuracies[0] : null, worst: accuracies.length ? accuracies[accuracies.length - 1] : null };
  pub.traceComplete = pub.status === 'finished' && pub.acceptedCount >= 2 && pub.gapCount === 0 && pub.rejectedCount === 0;
  pub.complete = run.review_status === 'approved';
  pub.reviewStatus = run.review_status || 'pending';
  if (includePoints) { pub.points = points.map(pointPublic); pub.interruptions = interruptions; }
  return pub;
}

async function route(req, res, url) {
  const db = sql();
  const p = url.pathname;

  if (req.method === 'GET' && p === '/api/v2/health') {
    return ok(res, {
      service: 'qzsf-night-run-stage2', databaseConfigured: !!databaseUrl(),
      sessionConfigured: String(process.env.SESSION_SECRET || '').length >= 24,
      authMode: 'student-id-password'
    });
  }

  if(p.startsWith('/api/v2/admin/')&&!['/api/v2/admin/login','/api/v2/admin/logout'].includes(p))requireAdmin(req);
  await ensureSchema();
  res.setHeader('Cache-Control', 'no-store');
  if (await adminService(req,res,url,{db,requireAdmin,ok,body,coded,uid,reportFor,EVENT_ID})) return;

  if (req.method === 'GET' && p === '/api/v2/config') {
    const events = await db`SELECT * FROM qz_events ORDER BY created_at DESC`;
    const current = events.find((e) => e.id === EVENT_ID);
    return ok(res, { colleges: current && Array.isArray(current.colleges_json) ? current.colleges_json : [], events: events.map(eventPublic) });
  }

  if (req.method === 'POST' && p === '/api/v2/auth/register') {
    const b = await body(req); const sid = clean(b.studentId, 24); const phone = clean(b.phone, 11);
    const name = clean(b.name, 30); const college = clean(b.college, 80); const className = clean(b.className, 60);
    const password = String(b.password || '');
    if (!validStudentId(sid) || !validPhone(phone) || !name || !className || !validPassword(password)) throw coded('VALIDATION', '请填写有效的学号、姓名、班级、手机号，并设置至少 10 位密码');
    if (!b.privacyConsent) throw coded('CONSENT_REQUIRED', '请先阅读并同意必要的个人信息处理说明');
    const configRows = await db`SELECT colleges_json FROM qz_events WHERE id=${EVENT_ID} LIMIT 1`;
    const colleges = configRows[0] && Array.isArray(configRows[0].colleges_json) ? configRows[0].colleges_json : [];
    if (!colleges.includes(college)) throw coded('COLLEGE_INVALID', '请选择系统配置中的学院');
    const eventRows = await db`SELECT * FROM qz_events WHERE id=${EVENT_ID} LIMIT 1`;
    if (!eventRows[0] || eventRows[0].registration_status !== 'open') throw coded('REGISTRATION_CLOSED', '当前活动未开放报名', 409);
    let student;
    try {
      await db.begin(async (tx) => {
        const created = await tx`INSERT INTO qz_students (id,student_id,name,college,class_name,phone,password_hash,profile_verified_at,privacy_consent_at) VALUES (${uid('stu')},${sid},${name},${college},${className},${phone},${passwordHash(password)},NOW(),NOW()) RETURNING *`;
        student = created[0];
        await tx`INSERT INTO qz_registrations (id,student_id,event_id) VALUES (${uid('reg')},${student.id},${EVENT_ID})`;
      });
    } catch (err) {
      if (err.code === '23505') throw coded('STUDENT_EXISTS', '该学号已建立档案，请使用密码登录', 409);
      throw err;
    }
    const token = crypto.randomBytes(32).toString('base64url');
    await db`INSERT INTO qz_student_sessions (token_hash,student_id,expires_at) VALUES (${hash(token)},${student.id},NOW()+INTERVAL '30 days')`;
    setCookie(res, COOKIE, token, 30 * 24 * 3600);
    return ok(res, { student: studentPublic(student), registered: true }, { message: '学生档案已建立并报名成功' });
  }

  if (req.method === 'POST' && p === '/api/v2/auth/login') {
    const b = await body(req); const sid = clean(b.studentId, 24); const password = String(b.password || '');
    if (!validStudentId(sid) || !password) throw coded('VALIDATION', '请输入学号和密码');
    const studentKey = hash(sid.toLowerCase());
    const failures = await db`SELECT failed_count,locked_until FROM qz_auth_failures WHERE student_key=${studentKey} LIMIT 1`;
    if (failures[0] && failures[0].locked_until && new Date(failures[0].locked_until) > new Date()) throw coded('LOGIN_RATE_LIMIT', '尝试次数过多，请 15 分钟后再试', 429);
    const rows = await db`SELECT * FROM qz_students WHERE student_id=${sid} LIMIT 1`;
    const student = rows[0];
    const valid = student && student.password_hash ? verifyPassword(password, student.password_hash) : (crypto.scryptSync(password, 'qzsf-night-run-dummy', 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }), false);
    if (!valid) {
      await db`INSERT INTO qz_auth_failures (student_key,failed_count,window_started_at,locked_until) VALUES (${studentKey},1,NOW(),NULL)
        ON CONFLICT (student_key) DO UPDATE SET
        failed_count=CASE WHEN qz_auth_failures.window_started_at<NOW()-INTERVAL '15 minutes' THEN 1 ELSE qz_auth_failures.failed_count+1 END,
        window_started_at=CASE WHEN qz_auth_failures.window_started_at<NOW()-INTERVAL '15 minutes' THEN NOW() ELSE qz_auth_failures.window_started_at END,
        locked_until=CASE WHEN (CASE WHEN qz_auth_failures.window_started_at<NOW()-INTERVAL '15 minutes' THEN 1 ELSE qz_auth_failures.failed_count+1 END)>=5 THEN NOW()+INTERVAL '15 minutes' ELSE NULL END`;
      throw coded('LOGIN_FAILED', '学号或密码错误', 401);
    }
    await db`DELETE FROM qz_auth_failures WHERE student_key=${studentKey}`;
    const token = crypto.randomBytes(32).toString('base64url');
    await db`INSERT INTO qz_student_sessions (token_hash,student_id,expires_at) VALUES (${hash(token)},${student.id},NOW()+INTERVAL '30 days')`;
    setCookie(res, COOKIE, token, 30 * 24 * 3600);
    return ok(res, { student: studentPublic(student) });
  }

  if (req.method === 'POST' && p === '/api/v2/auth/logout') {
    const token = cookies(req)[COOKIE];
    if (token) await db`UPDATE qz_student_sessions SET revoked_at=NOW() WHERE token_hash=${hash(token)}`;
    setCookie(res, COOKIE, '', 0); return ok(res, { loggedOut: true });
  }

  if (req.method === 'GET' && p === '/api/v2/me') {
    const student = await requireStudent(req);
    const regs = await db`SELECT r.*,e.title,e.start_time,e.end_time,e.event_status FROM qz_registrations r JOIN qz_events e ON e.id=r.event_id WHERE r.student_id=${student.id} ORDER BY r.registered_at DESC`;
    const runs = await db`SELECT * FROM qz_run_sessions WHERE student_id=${student.id} ORDER BY created_at DESC LIMIT 50`;
    return ok(res, { student: studentPublic(student), registrations: regs.map((r) => ({ id: r.id, eventId: r.event_id, title: r.title, status: r.status, registeredAt: r.registered_at, startTime: r.start_time, endTime: r.end_time, eventStatus: r.event_status })), runs: runs.map(runPublic) });
  }

  if (req.method === 'PATCH' && p === '/api/v2/me') {
    const student = await requireStudent(req); const b = await body(req); const phone = clean(b.phone, 11); const currentPassword = String(b.currentPassword || '');
    const name = clean(b.name, 30); const college = clean(b.college, 80); const className = clean(b.className, 60);
    const configRows = await db`SELECT colleges_json FROM qz_events WHERE id=${EVENT_ID} LIMIT 1`;
    const colleges = configRows[0] && Array.isArray(configRows[0].colleges_json) ? configRows[0].colleges_json : [];
    if (!name || !colleges.includes(college) || !className || !validPhone(phone)) throw coded('VALIDATION', '资料格式不正确');
    if (!student.password_hash || !verifyPassword(currentPassword, student.password_hash)) throw coded('PASSWORD_REQUIRED', '请先输入正确的当前密码', 401);
    await db`UPDATE qz_students SET name=${name},college=${college},class_name=${className},phone=${phone},updated_at=NOW() WHERE id=${student.id}`;
    const updated = (await db`SELECT * FROM qz_students WHERE id=${student.id}`)[0];
    return ok(res, studentPublic(updated));
  }

  if (req.method === 'DELETE' && p === '/api/v2/me') {
    const student = await requireStudent(req);
    await db`DELETE FROM qz_students WHERE id=${student.id}`;
    setCookie(res, COOKIE, '', 0);
    return ok(res, { deleted: true });
  }

  if (req.method === 'POST' && p === '/api/v2/registrations') {
    const student = await requireStudent(req); const b = await body(req); const eventId = clean(b.eventId || EVENT_ID, 80);
    const events = await db`SELECT * FROM qz_events WHERE id=${eventId} LIMIT 1`; const event = events[0];
    if (!event || event.registration_status !== 'open') throw coded('REGISTRATION_CLOSED', '当前活动未开放报名', 409);
    const inserted = await db`INSERT INTO qz_registrations (id,student_id,event_id) VALUES (${uid('reg')},${student.id},${eventId}) ON CONFLICT (student_id,event_id) DO NOTHING RETURNING *`;
    const reg = inserted[0] || (await db`SELECT * FROM qz_registrations WHERE student_id=${student.id} AND event_id=${eventId}`)[0];
    return ok(res, { id: reg.id, eventId: reg.event_id, status: reg.status, registeredAt: reg.registered_at }, { existed: !inserted.length });
  }

  if (req.method === 'POST' && p === '/api/v2/runs/start') {
    const student = await requireStudent(req); const b = await body(req); const eventId = clean(b.eventId || EVENT_ID, 80);
    if (b.locationConsent !== true) throw coded('LOCATION_CONSENT_REQUIRED', '开始运动前必须单独同意精准定位采集', 400);
    const regs = await db`SELECT id FROM qz_registrations WHERE student_id=${student.id} AND event_id=${eventId} AND status='registered'`;
    if (!regs.length) throw coded('NOT_REGISTERED', '请先报名本场活动', 403);
    const active = await db`SELECT * FROM qz_run_sessions WHERE student_id=${student.id} AND event_id=${eventId} AND status IN ('running','paused','uploading') ORDER BY created_at DESC LIMIT 1`;
    if (active[0]) return ok(res, runPublic(active[0]), { resumed: true });
    const rows = await db`INSERT INTO qz_run_sessions (id,student_id,event_id,start_time,location_consent_at) VALUES (${uid('run')},${student.id},${eventId},NOW(),NOW()) ON CONFLICT (student_id,event_id) WHERE status IN ('running','paused') DO NOTHING RETURNING *`;
    if (rows[0]) return ok(res, runPublic(rows[0]));
    const raced = await db`SELECT * FROM qz_run_sessions WHERE student_id=${student.id} AND event_id=${eventId} AND status IN ('running','paused') ORDER BY created_at DESC LIMIT 1`;
    if (raced[0]) return ok(res, runPublic(raced[0]), { resumed: true });
    throw coded('RUN_START_CONFLICT', '运动记录暂时无法开始，请重试', 409);
  }

  let match = p.match(/^\/api\/v2\/runs\/([^/]+)\/points$/);
  if (req.method === 'POST' && match) {
    const student = await requireStudent(req); const runId = match[1]; const b = await body(req);
    const runs = await db`SELECT * FROM qz_run_sessions WHERE id=${runId} AND student_id=${student.id} LIMIT 1`; let run = runs[0];
    if (!run || !['running', 'paused', 'uploading'].includes(run.status)) throw coded('RUN_NOT_ACTIVE', '运动记录不存在或已经提交', 409);
    const uploaded = await db.begin(async (tx) => {
    await tx`SELECT id FROM qz_run_sessions WHERE id=${runId} FOR UPDATE`;
    const locked = (await tx`SELECT * FROM qz_run_sessions WHERE id=${runId}`)[0];
    if (!locked || !['running','paused','uploading'].includes(locked.status)) throw coded('RUN_NOT_ACTIVE','运动记录已经提交',409);
    run=locked;
    const db = tx;
    if(!Array.isArray(b.points)||b.points.length>MAX_BATCH)throw coded('INVALID_BATCH','轨迹批次最多 200 个采样点');
    const input = b.points;
    if (!input.length) return { inserted: 0, accepted: 0, rejected: 0 };
    const lastRows = await db`SELECT * FROM qz_location_points WHERE session_id=${runId} AND validity_status='accepted' ORDER BY seq DESC LIMIT 1`;
    let prev = lastRows[0] || null; let segment = prev ? Number(prev.segment_no || 0) : 0;
    let inserted = 0; let accepted = 0; let rejected = 0; let gaps = 0; let distance = 0;
    input.sort((a, b) => Number(a.seq) - Number(b.seq));
    for (const raw of input) {
      const seq = number(raw.seq); const lat = number(raw.latitude); const lng = number(raw.longitude);
      const accuracy = number(raw.accuracy); const speed = number(raw.speed); const ts = new Date(raw.timestamp || 0);
      if (!Number.isInteger(seq) || seq < 0 || lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180 || Number.isNaN(ts.getTime())) throw coded('INVALID_POINT','轨迹采样格式不正确');
      if((await db`SELECT seq FROM qz_location_points WHERE session_id=${runId} AND seq=${seq}`).length)continue;
      if(raw.coordinateSystem && !['wgs84','gcj02'].includes(raw.coordinateSystem))throw coded('INVALID_CRS','不支持的坐标系统');
      const coordinateSystem=raw.coordinateSystem||'wgs84';
      const display=coordinateSystem==='gcj02'?[lat,lng]:Coord.wgs2gcj(lat,lng);
      const flags = []; let status = 'accepted'; let delta = 0;
      if (accuracy == null || accuracy < 0 || accuracy > 80) { flags.push('accuracy_poor'); status = 'rejected'; }
      if (ts.getTime() > Date.now()+30000 || ts.getTime() < new Date(run.start_time).getTime()-30000 || (run.end_time && ts.getTime()>new Date(run.end_time).getTime()+30000)) { flags.push('time_outside_run'); status='rejected'; }
      if (prev) {
        const dt = (ts.getTime() - new Date(prev.recorded_at).getTime()) / 1000;
        const prevWgs=prev.coordinate_system==='gcj02'?Coord.gcj2wgs(Number(prev.latitude),Number(prev.longitude)):[Number(prev.latitude),Number(prev.longitude)];
        const wgs=coordinateSystem==='gcj02'?Coord.gcj2wgs(lat,lng):[lat,lng];
        const d = distanceM(prevWgs[0],prevWgs[1],wgs[0],wgs[1]);
        if (dt <= 0) { flags.push('time_reverse'); status = 'rejected'; }
        else if (dt > 60) { flags.push('gap_before'); if(status==='accepted'){segment += 1; gaps += 1;} }
        else if (d / dt > 12 && d > 35) { flags.push('jump'); status = 'rejected'; }
        else if (status === 'accepted' && d >= 2) delta = d;
      }
      const backfill = Date.now() - ts.getTime() > 30000;
      const rows = await db`INSERT INTO qz_location_points (session_id,student_id,seq,latitude,longitude,display_latitude,display_longitude,accuracy,speed,heading,altitude,recorded_at,coordinate_system,validity_status,validity_flags,is_backfill,segment_no,distance_delta) VALUES (${runId},${student.id},${seq},${lat},${lng},${display[0]},${display[1]},${accuracy},${speed},${number(raw.heading)},${number(raw.altitude)},${ts.toISOString()},${coordinateSystem},${status},${db.json(flags)},${backfill},${segment},${delta}) ON CONFLICT (session_id,seq) DO NOTHING RETURNING *`;
      if (!rows.length) continue;
      inserted += 1;
      if (status === 'accepted') { accepted += 1; distance += delta; prev = rows[0]; } else rejected += 1;
    }
    await db`UPDATE qz_run_sessions SET sample_count=sample_count+${inserted},accepted_count=accepted_count+${accepted},rejected_count=rejected_count+${rejected},gap_count=gap_count+${gaps},distance_meters=distance_meters+${distance},updated_at=NOW() WHERE id=${runId}`;
    return { inserted, accepted, rejected, gaps, distanceAdded: distance };
    });
    return ok(res,uploaded);
  }

  match = p.match(/^\/api\/v2\/runs\/([^/]+)\/(pause|resume|finish|end|interruptions)$/);
  if (req.method === 'POST' && match) {
    const student = await requireStudent(req); const runId = match[1]; const action = match[2]; const b = await body(req);
    const rows = await db`SELECT * FROM qz_run_sessions WHERE id=${runId} AND student_id=${student.id} LIMIT 1`; let run = rows[0];
    if (!run) throw coded('NOT_FOUND', '运动记录不存在', 404);
    if (action === 'pause' && run.status === 'running') await db`UPDATE qz_run_sessions SET status='paused',paused_at=NOW(),updated_at=NOW() WHERE id=${runId}`;
    if (action === 'resume' && run.status === 'paused') await db`UPDATE qz_run_sessions SET status='running',paused_seconds=paused_seconds+GREATEST(0,EXTRACT(EPOCH FROM (NOW()-paused_at))::int),paused_at=NULL,updated_at=NOW() WHERE id=${runId}`;
    if (action === 'interruptions') {
      const type = clean(b.type || 'background', 40); const started = new Date(b.startedAt || Date.now()); const ended = b.endedAt ? new Date(b.endedAt) : null;
      await db`INSERT INTO qz_run_interruptions (session_id,student_id,interruption_type,started_at,ended_at,note) VALUES (${runId},${student.id},${type},${started.toISOString()},${ended && ended.toISOString()},${clean(b.note, 200)})`;
    }
    if (action === 'finish' || action === 'end') {
      if (!['running', 'paused','uploading'].includes(run.status)) return ok(res, await reportFor(run, false));
      await db.begin(async tx=>{
        await tx`SELECT id FROM qz_run_sessions WHERE id=${runId} FOR UPDATE`;
        const next=action==='end'?'uploading':'finished';
        await tx`UPDATE qz_run_sessions SET status=${next},end_time=COALESCE(end_time,NOW()),duration_seconds=CASE WHEN end_time IS NOT NULL THEN duration_seconds ELSE GREATEST(0,EXTRACT(EPOCH FROM (NOW()-start_time))::int-paused_seconds-CASE WHEN status='paused' AND paused_at IS NOT NULL THEN GREATEST(0,EXTRACT(EPOCH FROM (NOW()-paused_at))::int) ELSE 0 END) END,updated_at=NOW() WHERE id=${runId} AND status IN ('running','paused','uploading')`;
      });
    }
    run = (await db`SELECT * FROM qz_run_sessions WHERE id=${runId}`)[0];
    return ok(res, action === 'finish' ? await reportFor(run, false) : runPublic(run));
  }

  match = p.match(/^\/api\/v2\/runs\/([^/.]+)(?:\.(json|gpx))?$/);
  if (req.method === 'GET' && match) {
    const runId = match[1]; const format = match[2]; const admin = currentAdmin(req); const student = admin ? null : await requireStudent(req);
    const rows = admin ? await db`SELECT * FROM qz_run_sessions WHERE id=${runId}` : await db`SELECT * FROM qz_run_sessions WHERE id=${runId} AND student_id=${student.id}`;
    const run = rows[0]; if (!run) throw coded('NOT_FOUND', '运动记录不存在', 404);
    const report = await reportFor(run, true);
    if (format === 'json') {
      res.statusCode = 200; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="${runId}.json"`); return res.end(JSON.stringify({ format: 'qzsf-run-report', version: 1, report }, null, 2));
    }
    if (format === 'gpx') {
      const segments = new Map();
      report.points.filter((x) => x.validityStatus === 'accepted').forEach((x) => {
        const key = Number(x.segmentNo || 0);
        if (!segments.has(key)) segments.set(key, []);
        segments.get(key).push(x);
      });
      const gpxSegments = Array.from(segments.values()).map((pts) => '<trkseg>' + pts.map((x) => `<trkpt lat="${x.latitude}" lon="${x.longitude}"><time>${new Date(x.timestamp).toISOString()}</time></trkpt>`).join('') + '</trkseg>').join('');
      const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="qzsf-night-run" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>QZSF Run</name>' + gpxSegments + '</trk></gpx>';
      res.statusCode = 200; res.setHeader('Content-Type', 'application/gpx+xml; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="${runId}.gpx"`); return res.end(xml);
    }
    return ok(res, report);
  }

  match = p.match(/^\/api\/v2\/runs\/([^/]+)$/);
  if (req.method === 'DELETE' && match) {
    const runId = match[1]; const admin = currentAdmin(req); const student = admin ? null : await requireStudent(req);
    const removed = admin
      ? await db`DELETE FROM qz_run_sessions WHERE id=${runId} RETURNING id`
      : await db`DELETE FROM qz_run_sessions WHERE id=${runId} AND student_id=${student.id} RETURNING id`;
    if (!removed.length) throw coded('NOT_FOUND', '运动记录不存在或无权删除', 404);
    return ok(res, { deleted: true, id: runId });
  }

  if (req.method === 'POST' && p === '/api/v2/admin/login') {
    const b = await body(req); const user = clean(b.username, 60); const pass = String(b.password || '');
    const expectedUser = String(process.env.ADMIN_USERNAME || 'admin'); const expectedPass = String(process.env.ADMIN_PASSWORD || '');
    const key=hash('admin:'+user.toLowerCase());
    const attempts=await db`INSERT INTO qz_admin_login_attempts(key,count,expires_at) VALUES(${key},1,NOW()+INTERVAL '15 minutes') ON CONFLICT(key) DO UPDATE SET count=CASE WHEN qz_admin_login_attempts.expires_at<NOW() THEN 1 ELSE qz_admin_login_attempts.count+1 END,expires_at=CASE WHEN qz_admin_login_attempts.expires_at<NOW() THEN NOW()+INTERVAL '15 minutes' ELSE qz_admin_login_attempts.expires_at END RETURNING count`;
    if(attempts[0].count>10)throw coded('LOGIN_RATE_LIMIT','尝试过多，请 15 分钟后再试',429);
    if (!expectedPass || !safeEqual(user, expectedUser) || !safeEqual(hmac(pass), hmac(expectedPass))) throw coded('ADMIN_LOGIN_FAILED', '管理员账号或密码错误', 401);
    await db`DELETE FROM qz_admin_login_attempts WHERE key=${key}`;
    setCookie(res, ADMIN_COOKIE, adminToken(user), 8 * 3600); return ok(res, { username: user });
  }

  if (req.method === 'POST' && p === '/api/v2/admin/logout') { setCookie(res, ADMIN_COOKIE, '', 0); return ok(res, { loggedOut: true }); }

  if (req.method === 'PUT' && p === '/api/v2/admin/config/colleges') {
    requireAdmin(req);
    const b = await body(req);
    const values = Array.isArray(b.colleges) ? b.colleges.map((x) => clean(x, 80)).filter(Boolean) : [];
    const colleges = Array.from(new Set(values));
    if (!colleges.length || colleges.length > 100 || colleges.length !== values.length) throw coded('COLLEGE_CONFIG_INVALID', '学院列表必须包含 1 至 100 个不重复名称', 400);
    await db`UPDATE qz_events SET colleges_json=${db.json(colleges)},updated_at=NOW() WHERE id=${EVENT_ID}`;
    return ok(res, { colleges });
  }

  if (req.method === 'GET' && p === '/api/v2/admin/overview') {
    requireAdmin(req); const q = clean(url.searchParams.get('q'), 80); const college = clean(url.searchParams.get('college'), 80);
    const students = await db`SELECT s.*,r.id AS registration_id,r.status AS registration_status,r.registered_at FROM qz_students s JOIN qz_registrations r ON r.student_id=s.id WHERE r.event_id=${EVENT_ID} AND (${q}='' OR s.name ILIKE ${'%' + q + '%'} OR s.student_id ILIKE ${'%' + q + '%'} OR s.class_name ILIKE ${'%' + q + '%'}) AND (${college}='' OR s.college=${college}) ORDER BY s.created_at DESC LIMIT 2000`;
    const runs = await db`SELECT rs.*,s.student_id AS sid,s.name,s.college,s.class_name FROM qz_run_sessions rs JOIN qz_students s ON s.id=rs.student_id WHERE rs.event_id=${EVENT_ID} ORDER BY rs.created_at DESC LIMIT 2000`;
    return ok(res, { students: students.map((s) => Object.assign(studentPublic(s), { phone: maskPhone(s.phone), registrationStatus: s.registration_status || null, registeredAt: s.registered_at })), runs: runs.map((r) => Object.assign(runPublic(r), { studentId: r.sid, studentName: r.name, college: r.college, className: r.class_name })), counts: { students: students.length, registrations: students.filter((s) => s.registration_id).length, runs: runs.length } });
  }

  if (req.method === 'GET' && p === '/api/v2/admin/export.csv') {
    requireAdmin(req); const rows = await db`SELECT s.student_id,s.name,s.college,s.class_name,s.phone,r.registered_at,r.status FROM qz_registrations r JOIN qz_students s ON s.id=r.student_id WHERE r.event_id=${EVENT_ID} ORDER BY r.registered_at`;
    const csv = '\ufeff学号,姓名,学院,班级,手机号,报名时间,状态\n' + rows.map((r) => [r.student_id,r.name,r.college,r.class_name,r.phone,r.registered_at.toISOString(),r.status].map(csvCell).join(',')).join('\n');
    res.statusCode = 200; res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', 'attachment; filename="qzsf-registrations.csv"'); return res.end(csv);
  }

  if (req.method === 'GET' && p === '/api/v2/admin/runs.csv') {
    requireAdmin(req); const rows = await db`SELECT s.student_id,s.name,s.college,s.class_name,rs.start_time,rs.end_time,rs.duration_seconds,rs.distance_meters,rs.sample_count,rs.rejected_count,rs.gap_count,rs.status FROM qz_run_sessions rs JOIN qz_students s ON s.id=rs.student_id WHERE rs.event_id=${EVENT_ID} ORDER BY rs.created_at`;
    const csv = '\ufeff学号,姓名,学院,班级,开始时间,结束时间,用时秒,距离米,采样点,异常点,断点,状态\n' + rows.map((r) => [r.student_id,r.name,r.college,r.class_name,r.start_time,r.end_time,r.duration_seconds,r.distance_meters,r.sample_count,r.rejected_count,r.gap_count,r.status].map(csvCell).join(',')).join('\n');
    res.statusCode = 200; res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', 'attachment; filename="qzsf-run-results.csv"'); return res.end(csv);
  }

  throw coded('NOT_FOUND', '接口不存在', 404);
}

async function handle(req, res, url) {
  if (!url.pathname.startsWith('/api/v2/')) return false;
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return true; }
  try {
    if (!['GET','HEAD','OPTIONS'].includes(req.method)) {
      const origin=req.headers.origin;
      const host=req.headers['x-forwarded-host']||req.headers.host;
      if(req.headers['sec-fetch-site']==='cross-site'||(origin&&new URL(origin).host!==host))throw coded('ORIGIN_DENIED','不允许跨站修改数据',403);
    }
    await route(req, res, url);
  }
  catch (err) { console.error('[stage2]', err.code || 'ERROR', err.message); fail(res, err); }
  return true;
}

module.exports = { handle, _test: { distanceM, validPhone, validStudentId, maskPhone, runPublic } };
