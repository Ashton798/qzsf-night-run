/* 初始化赛事基础数据
 * 用法：node server/scripts/seed.js
 * 幂等：已存在则不覆盖
 */
'use strict';

require('./load-env');
const path = require('node:path');
const db = require('../db');
const DEFAULTS = require('../defaults');

const ROOT = path.resolve(__dirname, '..', '..');
db.open(path.resolve(ROOT, process.env.DB_PATH || 'data/qzsf.db'));

const now = Date.now();

/* 赛事日期按「当年 11 月」自动生成，避免写死年份导致过期 */
function isoLocal(y, m, d, hh = 9, mm = 0) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${y}-${pad(m)}-${pad(d)}T${pad(hh)}:${pad(mm)}:00+08:00`;
}
const YEAR = Number(process.env.EVENT_YEAR) || new Date().getFullYear();
const EVENT_DATE = isoLocal(YEAR, 11, 16, 9, 0);
const REG_DEADLINE = isoLocal(YEAR, 11, 10, 18, 0);

const EVENT = {
  code: 'qzsf-2025',
  name: '泉州师范学院校园定向越野',
  subtitle: '校园体育文化节 · 定向跑',
  campus_name: '泉州师范学院东海主校区',
  campus_lng: 118.671028,
  campus_lat: 24.868274,
  campus_zoom: 16,
  event_date: EVENT_DATE,
  reg_deadline: REG_DEADLINE,
  start_at: EVENT_DATE,
  close_minutes: 90,
  status: 'reg_open',
  reg_open: 1,
  start_name: '东门广场',
  finish_name: '东门广场',
  groups_json: JSON.stringify(DEFAULTS.GROUPS),
  colleges_json: JSON.stringify(DEFAULTS.COLLEGES),
  rules_text: '竞赛组单人计时排名，体验组不计时，同心组两人同行取较慢成绩。全程 6 个打卡点，须全部经过成绩方有效。禁止骑行、代跑。',
  created_at: now,
  updated_at: now
};

const existing = db.get('SELECT * FROM events WHERE code=?', [EVENT.code]);
if (existing) {
  console.log(`赛事已存在：#${existing.id} ${existing.name}`);
} else {
  const keys = Object.keys(EVENT);
  const ins = db.run(
    `INSERT INTO events (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
    keys.map((k) => EVENT[k])
  );
  console.log(`已创建赛事：#${ins.lastInsertRowid} ${EVENT.name}`);
}

console.log('');
console.log('当前数据：');
console.log('  赛事  ', db.get('SELECT COUNT(*) AS n FROM events').n);
console.log('  管理员', db.get('SELECT COUNT(*) AS n FROM admins').n);
console.log('  报名  ', db.get('SELECT COUNT(*) AS n FROM participants').n);
console.log('  路线  ', db.get('SELECT COUNT(*) AS n FROM courses').n);
console.log('  打卡点', db.get('SELECT COUNT(*) AS n FROM checkpoints').n);
