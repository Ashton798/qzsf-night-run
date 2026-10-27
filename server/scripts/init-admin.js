/* 创建/重置管理员账号
 * 用法：
 *   node server/scripts/init-admin.js <用户名> <密码> [角色]
 *   node server/scripts/init-admin.js admin "MyStr0ngPass!" admin
 */
'use strict';

require('./load-env');
const path = require('node:path');
const db = require('../db');
const auth = require('../auth');

const ROOT = path.resolve(__dirname, '..', '..');
db.open(path.resolve(ROOT, process.env.DB_PATH || 'data/qzsf.db'));

const [username, password, role = 'admin'] = process.argv.slice(2);

if (!username || !password) {
  console.log('用法: node server/scripts/init-admin.js <用户名> <密码> [admin|referee|viewer]');
  console.log('');
  const list = db.all('SELECT id, username, role, last_login_at FROM admins');
  if (list.length) {
    console.log('现有管理员：');
    list.forEach((a) => console.log(`  #${a.id} ${a.username} (${a.role})`));
  } else {
    console.log('当前没有任何管理员账号。');
  }
  process.exit(0);
}

if (password.length < 8) {
  console.error('密码至少 8 位');
  process.exit(1);
}

const exists = db.get('SELECT * FROM admins WHERE username=?', [username]);
if (exists) {
  auth.setPassword(exists.id, password);
  db.run('UPDATE admins SET role=? WHERE id=?', [role, exists.id]);
  db.run('UPDATE sessions SET revoked_at=? WHERE admin_id=?', [Date.now(), exists.id]);
  console.log(`已重置密码并吊销所有会话：${username} (${role})`);
} else {
  auth.createAdmin(username, password, role, username);
  console.log(`已创建管理员：${username} (${role})`);
}

console.log(`数据库：${path.resolve(ROOT, process.env.DB_PATH || 'data/qzsf.db')}`);
