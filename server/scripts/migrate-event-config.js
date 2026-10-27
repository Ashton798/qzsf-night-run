/* 补齐赛事配置字段
 * 用法：node server/scripts/migrate-event-config.js
 * 幂等：只填空值，不覆盖管理员已修改的内容
 */
'use strict';

require('./load-env');
const path = require('node:path');
const db = require('../db');
const DEFAULTS = require('../defaults');

const ROOT = path.resolve(__dirname, '..', '..');
db.open(path.resolve(ROOT, process.env.DB_PATH || 'data/qzsf.db'));

const events = db.all('SELECT * FROM events');
if (!events.length) {
  console.log('没有赛事记录，请先运行 node server/scripts/seed.js');
  process.exit(0);
}

let changed = 0;
for (const e of events) {
  const patch = {};
  if (!e.colleges_json) patch.colleges_json = JSON.stringify(DEFAULTS.COLLEGES);
  if (!e.groups_json) patch.groups_json = JSON.stringify(DEFAULTS.GROUPS);
  if (!e.start_name) patch.start_name = '东门广场';
  if (!e.finish_name) patch.finish_name = '东门广场';
  if (e.reg_open === null || e.reg_open === undefined) patch.reg_open = 1;

  const keys = Object.keys(patch);
  if (!keys.length) {
    console.log(`赛事 #${e.id} ${e.code} 已完整，无需迁移`);
    continue;
  }
  db.run(
    `UPDATE events SET ${keys.map((k) => k + '=?').join(',')}, updated_at=? WHERE id=?`,
    [...keys.map((k) => patch[k]), Date.now(), e.id]
  );
  changed++;
  console.log(`赛事 #${e.id} ${e.code} 已补齐：${keys.join(', ')}`);
}

console.log('');
console.log(`完成：${changed} 个赛事被更新，共 ${events.length} 个`);
