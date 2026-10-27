/* 管理员认证：scrypt 密码哈希 + 服务端会话 + 限流
 *
 * 安全要点：
 *  - 密码只以 scrypt(salt, N=16384) 哈希存储，无法反推
 *  - 会话 token 为 32 字节随机数，存数据库，服务端校验，可吊销
 *  - 登录失败按 IP + 用户名双维度限流，防暴力破解
 *  - Cookie 为 HttpOnly + SameSite=Lax，前端 JS 读不到
 */
'use strict';

const crypto = require('node:crypto');
const db = require('./db');
const { parseCookies, setCookie, clearCookie, getClientIp } = require('./http');

const SESSION_TTL = 8 * 3600 * 1000;
const COOKIE_NAME = 'qzsf_session';
const SCRYPT_N = 16384;

/* ---------- 密码 ---------- */
function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(plain), salt, 64, { N: SCRYPT_N });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(plain, stored) {
  try {
    const [algo, saltHex, hashHex] = String(stored).split('$');
    if (algo !== 'scrypt') return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(String(plain), salt, expected.length, { N: SCRYPT_N });
    return crypto.timingSafeEqual(expected, actual);
  } catch (e) {
    return false;
  }
}

/* ---------- 登录限流（内存，进程重启后重置） ---------- */
const attempts = new Map();   // key -> { count, firstAt, lockedUntil }
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;

function checkRateLimit(key) {
  const now = Date.now();
  const rec = attempts.get(key);
  if (!rec) return { ok: true };
  if (rec.lockedUntil && rec.lockedUntil > now) {
    return { ok: false, retryAfter: Math.ceil((rec.lockedUntil - now) / 1000) };
  }
  if (now - rec.firstAt > WINDOW_MS) { attempts.delete(key); return { ok: true }; }
  if (rec.count >= MAX_ATTEMPTS) {
    rec.lockedUntil = now + LOCK_MS;
    return { ok: false, retryAfter: Math.ceil(LOCK_MS / 1000) };
  }
  return { ok: true };
}

function noteFailure(key) {
  const now = Date.now();
  const rec = attempts.get(key) || { count: 0, firstAt: now };
  rec.count++;
  attempts.set(key, rec);
}

function clearFailures(key) { attempts.delete(key); }

/* ---------- 会话 ---------- */
function createSession(adminId, req, res) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.run(
    `INSERT INTO sessions (token, admin_id, ip, user_agent, created_at, expires_at)
     VALUES (?,?,?,?,?,?)`,
    [token, adminId, getClientIp(req), String(req.headers['user-agent'] || '').slice(0, 300), now, now + SESSION_TTL]
  );
  setCookie(res, COOKIE_NAME, token, {
    maxAge: SESSION_TTL,
    httpOnly: true,
    sameSite: 'Lax',
    secure: req.secure || String(req.headers['x-forwarded-proto'] || '') === 'https'
  });
  return token;
}

function destroySession(req, res) {
  const cookies = parseCookies(req);
  const token = cookies[COOKIE_NAME] || bearer(req);
  if (token) {
    db.run('UPDATE sessions SET revoked_at=? WHERE token=?', [Date.now(), token]);
  }
  clearCookie(res, COOKIE_NAME);
}

function bearer(req) {
  const h = String(req.headers.authorization || '');
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

/* 从 Cookie 或 Authorization 中解析会话，返回 admin 或 null */
function getSession(req) {
  const cookies = parseCookies(req);
  const token = cookies[COOKIE_NAME] || bearer(req);
  if (!token) return null;

  const s = db.get('SELECT * FROM sessions WHERE token=?', [token]);
  if (!s) return null;
  if (s.revoked_at) return null;
  if (s.expires_at < Date.now()) return null;

  const admin = db.get('SELECT id, username, role, display_name FROM admins WHERE id=?', [s.admin_id]);
  if (!admin) return null;
  return Object.assign({}, admin, { token, session: s });
}

/* 中间件：要求管理员权限 */
function requireAdmin(req, res, roles) {
  const admin = getSession(req);
  if (!admin) {
    require('./http').fail(res, 401, '请先登录管理员', 'UNAUTHORIZED');
    return null;
  }
  if (roles && roles.length && roles.indexOf(admin.role) < 0) {
    require('./http').fail(res, 403, '权限不足', 'FORBIDDEN');
    return null;
  }
  return admin;
}

/* ---------- 账号管理 ---------- */
function createAdmin(username, password, role = 'admin', displayName = '') {
  const now = Date.now();
  const hash = hashPassword(password);
  return db.run(
    'INSERT INTO admins (username, password_hash, role, display_name, created_at) VALUES (?,?,?,?,?)',
    [username, hash, role, displayName, now]
  );
}

function setPassword(adminId, password) {
  db.run('UPDATE admins SET password_hash=? WHERE id=?', [hashPassword(password), adminId]);
}

function countAdmins() {
  return db.get('SELECT COUNT(*) AS n FROM admins').n;
}

/* 清理过期会话 */
function purgeExpired() {
  db.run('DELETE FROM sessions WHERE expires_at < ? OR revoked_at IS NOT NULL', [Date.now() - 86400000]);
}

/* 开发/运维用：清空所有登录限流记录 */
function resetRateLimit() { attempts.clear(); }

module.exports = {
  hashPassword, verifyPassword, resetRateLimit,
  checkRateLimit, noteFailure, clearFailures,
  createSession, destroySession, getSession, requireAdmin,
  createAdmin, setPassword, countAdmins, purgeExpired,
  COOKIE_NAME, SESSION_TTL
};
