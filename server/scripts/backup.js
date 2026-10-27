/* 数据库备份
 * 用法：
 *   node server/scripts/backup.js           备份到 backups/
 *   node server/scripts/backup.js restore <文件>   从备份恢复
 */
'use strict';

require('./load-env');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const DB_PATH = path.resolve(ROOT, process.env.DB_PATH || 'data/qzsf.db');
const BACKUP_DIR = path.resolve(ROOT, 'backups');

const cmd = process.argv[2];

if (cmd === 'restore') {
  const file = process.argv[3];
  if (!file || !fs.existsSync(file)) {
    console.error('请指定备份文件：node server/scripts/backup.js restore backups/xxx.db');
    process.exit(1);
  }
  if (fs.existsSync(DB_PATH)) {
    const bak = DB_PATH + '.before-restore-' + Date.now();
    fs.copyFileSync(DB_PATH, bak);
    console.log('已备份当前数据库到', bak);
  }
  fs.copyFileSync(file, DB_PATH);
  console.log('已从', file, '恢复');
  process.exit(0);
}

fs.mkdirSync(BACKUP_DIR, { recursive: true });
if (!fs.existsSync(DB_PATH)) {
  console.error('数据库不存在：', DB_PATH);
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const target = path.join(BACKUP_DIR, `qzsf-${stamp}.db`);

// WAL 模式下需要先 checkpoint 再复制
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(DB_PATH);
try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) {}
db.close();

fs.copyFileSync(DB_PATH, target);
const size = (fs.statSync(target).size / 1024).toFixed(1);
console.log(`备份完成：${target} (${size} KB)`);

// 保留最近 30 个
const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.db')).sort();
if (files.length > 30) {
  files.slice(0, files.length - 30).forEach((f) => fs.unlinkSync(path.join(BACKUP_DIR, f)));
  console.log(`已清理 ${files.length - 30} 个旧备份`);
}
