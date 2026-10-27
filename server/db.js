/* 数据库：SQLite（node:sqlite 内置模块，零依赖）
 *
 * 为什么选 SQLite：
 *  - 单文件，备份 = 复制文件，重启不丢数据
 *  - 支持并发读 + WAL 模式，500 人规模（峰值几十次写入/秒）完全够用
 *  - 零依赖，国内服务器部署不需要 npm install，也不怕内网不通
 *  - 后续要换 MySQL/PostgreSQL，只需替换本文件里的 query 实现
 *
 * 表结构设计说明：
 *  - 所有坐标存 GCJ-02（高德坐标系），单位：经纬度 double
 *  - 轨迹点单独建表（track_points），避免单行过大
 *  - 预留 500 人并发相关字段：server_ts、seq、accuracy、source 等
 */
'use strict';

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

let db = null;

function open(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath);

  // WAL：读写不互相阻塞，显著提升并发读性能
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  migrate();
  return db;
}

function migrate() {
  db.exec(`
  /* ============ 赛事信息 ============ */
  CREATE TABLE IF NOT EXISTS events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    code          TEXT UNIQUE NOT NULL,          -- 赛事编码，如 qzsf-2025
    name          TEXT NOT NULL,
    subtitle      TEXT,
    campus_name   TEXT,
    campus_lng    REAL,                          -- 校园中心 GCJ-02
    campus_lat    REAL,
    campus_zoom   INTEGER DEFAULT 16,
    event_date    TEXT,                          -- ISO 时间
    reg_deadline  TEXT,
    start_at      TEXT,
    close_minutes INTEGER DEFAULT 90,
    status        TEXT DEFAULT 'draft',          -- draft|reg_open|reg_closed|running|finished|archived
    groups_json   TEXT,                          -- 组别配置 JSON
    colleges_json TEXT,                          -- 学院列表 JSON（前端报名下拉）
    start_name    TEXT,                          -- 起点名称（展示用）
    finish_name   TEXT,                          -- 终点名称（展示用）
    reg_open      INTEGER DEFAULT 1,             -- 报名开关（1 开 / 0 关，独立于截止时间）
    rules_text    TEXT,                          -- 赛事须知
    rules_json    TEXT,                          -- 可配置规则 JSON
    default_route_key TEXT DEFAULT 'default',    -- 默认路线键
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );

  /* ============ 管理员 ============ */
  CREATE TABLE IF NOT EXISTS admins (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,                 -- scrypt: salt:hash
    role          TEXT DEFAULT 'admin',          -- admin|referee|viewer
    display_name  TEXT,
    last_login_at INTEGER,
    created_at    INTEGER NOT NULL
  );

  /* ============ 会话（服务端会话，不把密码放前端） ============ */
  CREATE TABLE IF NOT EXISTS sessions (
    token         TEXT PRIMARY KEY,              -- 随机 32 字节 hex
    admin_id      INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
    ip            TEXT,
    user_agent    TEXT,
    created_at    INTEGER NOT NULL,
    expires_at    INTEGER NOT NULL,
    revoked_at    INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_admin ON sessions(admin_id);

  /* ============ 比赛路线（版本化，保留历史） ============ */
  CREATE TABLE IF NOT EXISTS courses (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id      INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    version       INTEGER NOT NULL,              -- 递增版本号
    name          TEXT,
    points_json   TEXT NOT NULL,                 -- [[lng,lat],...]
    start_lng     REAL, start_lat REAL,
    finish_lng    REAL, finish_lat REAL,
    start_radius_m INTEGER DEFAULT 80,
    finish_radius_m INTEGER DEFAULT 80,
    closed        INTEGER DEFAULT 0,
    distance_m    INTEGER DEFAULT 0,
    source        TEXT DEFAULT 'manual',         -- manual|gps|import
    crs           TEXT DEFAULT 'gcj02',          -- 坐标系：gcj02（高德）
    status        TEXT DEFAULT 'draft',          -- draft|surveyed|published
    surveyed_at   INTEGER,                       -- 实地勘测确认时间
    surveyed_by   INTEGER REFERENCES admins(id),
    is_active     INTEGER DEFAULT 1,
    route_key     TEXT DEFAULT 'default',
    group_key     TEXT,
    published_at  INTEGER,
    locked_at     INTEGER,
    locked_by     INTEGER REFERENCES admins(id),
    survey_evidence_json TEXT,
    updated_at    INTEGER,
    created_by    INTEGER REFERENCES admins(id),
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_courses_event ON courses(event_id, is_active);

  /* ============ 打卡点（隶属某个路线版本） ============ */
  CREATE TABLE IF NOT EXISTS checkpoints (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    course_id     INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    code          TEXT NOT NULL,                 -- CP1..CP6
    name          TEXT NOT NULL,
    order_index   INTEGER NOT NULL,
    lng           REAL NOT NULL,
    lat           REAL NOT NULL,
    radius_m      INTEGER DEFAULT 30,
    required      INTEGER DEFAULT 1,
    reward_points INTEGER DEFAULT 0,
    methods_json  TEXT DEFAULT '["gps"]',
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_cp_course ON checkpoints(course_id, order_index);

  /* ============ 参赛选手 / 报名 ============ */
  CREATE TABLE IF NOT EXISTS participants (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id      INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    sid           TEXT NOT NULL,                 -- 学号
    name          TEXT NOT NULL,
    college       TEXT,
    phone         TEXT,
    group_key     TEXT NOT NULL,                 -- competition|experience|unity
    team_code     TEXT,                          -- 同心组队伍编码
    partner_sid   TEXT,
    partner_name  TEXT,
    partner_college TEXT,
    bib           TEXT,                          -- 号码布，预留
    status        TEXT DEFAULT 'registered',     -- registered|checked|running|finished|dnf|dsq
    device_id     TEXT,                          -- 浏览器设备标识，用于找回报名
    ip            TEXT,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    UNIQUE(event_id, sid)
  );
  CREATE INDEX IF NOT EXISTS idx_participants_event ON participants(event_id, status);
  CREATE INDEX IF NOT EXISTS idx_participants_team ON participants(event_id, team_code);

  /* ============ 签到记录 ============ */
  CREATE TABLE IF NOT EXISTS checkins (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    event_id      INTEGER NOT NULL,
    ts            INTEGER NOT NULL,
    lng           REAL, lat REAL,
    accuracy_m    REAL,
    dist_to_start REAL,
    method        TEXT DEFAULT 'gps',            -- gps|qrcode|manual
    operator_id   INTEGER REFERENCES admins(id), -- 手动签到的裁判
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_checkins_p ON checkins(participant_id);

  /* ============ 比赛成绩 / 场次 ============ */
  CREATE TABLE IF NOT EXISTS runs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    event_id      INTEGER NOT NULL,
    course_id     INTEGER REFERENCES courses(id),
    started_at    INTEGER,
    ended_at      INTEGER,
    elapsed_ms    INTEGER,
    distance_m    REAL DEFAULT 0,
    cp_done       INTEGER DEFAULT 0,
    cp_total      INTEGER DEFAULT 6,
    completed     INTEGER DEFAULT 0,
    off_route_cnt INTEGER DEFAULT 0,
    max_speed     REAL,                          -- m/s，用于反作弊
    avg_speed     REAL,
    mode          TEXT DEFAULT 'gps',            -- gps|simulation|manual
    status        TEXT DEFAULT 'running',        -- running|finished|dnf|dsq
    access_token  TEXT UNIQUE,
    last_seq      INTEGER DEFAULT -1,
    last_point_at INTEGER,
    last_client_ts INTEGER,
    last_lng      REAL,
    last_lat      REAL,
    last_accuracy REAL,
    last_route_distance REAL,
    warning_count INTEGER DEFAULT 0,
    critical_count INTEGER DEFAULT 0,
    off_route_streak INTEGER DEFAULT 0,
    off_route_started_at INTEGER,
    lost_at       INTEGER,
    accepted_points INTEGER DEFAULT 0,
    rejected_points INTEGER DEFAULT 0,
    backfill_points INTEGER DEFAULT 0,
    quality_json  TEXT,
    review_status TEXT DEFAULT 'pending',
    review_note   TEXT,
    finish_dist_m REAL,
    finish_valid INTEGER DEFAULT 0,
    reward_points INTEGER DEFAULT 0,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_runs_event ON runs(event_id, status);
  CREATE INDEX IF NOT EXISTS idx_runs_p ON runs(participant_id);

  /* ============ GPS 轨迹点（预留 500 人并发） ============ */
  CREATE TABLE IF NOT EXISTS track_points (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id        INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    participant_id INTEGER NOT NULL,
    event_id      INTEGER NOT NULL,
    seq           INTEGER NOT NULL,              -- 客户端递增序号，用于去重/排序
    lng           REAL NOT NULL,                 -- GCJ-02（显示坐标）
    lat           REAL NOT NULL,
    raw_lng       REAL,                          -- WGS-84 原始经度（永不覆盖）
    raw_lat       REAL,                          -- WGS-84 原始纬度
    crs           TEXT DEFAULT 'gcj02',          -- lng/lat 的坐标系
    accuracy_m    REAL,
    speed         REAL,
    heading       REAL,
    altitude      REAL,
    client_ts     INTEGER,                       -- 客户端时间
    server_ts     INTEGER NOT NULL,              -- 服务器接收时间（防篡改）
    source        TEXT DEFAULT 'gps',             -- gps|network|fused|simulation
    accepted      INTEGER DEFAULT 1,
    reliable      INTEGER DEFAULT 1,
    coordinate_verified INTEGER DEFAULT 0,
    is_backfill   INTEGER DEFAULT 0,
    validation_flags TEXT,
    route_distance_m REAL,
    batch_id      TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_track_run ON track_points(run_id, seq);
  CREATE INDEX IF NOT EXISTS idx_track_pid ON track_points(participant_id, server_ts);

  /* ============ 打卡记录 ============ */
  CREATE TABLE IF NOT EXISTS cp_hits (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id        INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    participant_id INTEGER NOT NULL,
    checkpoint_id INTEGER NOT NULL REFERENCES checkpoints(id),
    event_id      INTEGER NOT NULL,
    ts            INTEGER NOT NULL,
    elapsed_ms    INTEGER,                       -- 距起跑
    lng           REAL, lat REAL,
    dist_m        REAL,                          -- 距打卡点中心距离
    valid         INTEGER DEFAULT 1,
    accuracy_m    REAL,
    coordinate_verified INTEGER DEFAULT 0,
    validation_flags TEXT,
    reward_points INTEGER DEFAULT 0,
    evidence_point_id INTEGER,
    created_at    INTEGER NOT NULL,
    UNIQUE(run_id, checkpoint_id)                -- 同一场次同一打卡点只记一次
  );
  CREATE INDEX IF NOT EXISTS idx_cphits_run ON cp_hits(run_id);

  /* ============ 异常 / 偏航记录（预留） ============ */
  CREATE TABLE IF NOT EXISTS anomalies (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id        INTEGER REFERENCES runs(id) ON DELETE CASCADE,
    participant_id INTEGER,
    event_id      INTEGER NOT NULL,
    type          TEXT NOT NULL,                 -- off_route|speed_anomaly|gps_lost|cp_out_of_order|duplicate
    severity      TEXT DEFAULT 'warn',           -- info|warn|critical
    detail_json   TEXT,
    lng           REAL, lat REAL,
    ts            INTEGER NOT NULL,
    reviewed      INTEGER DEFAULT 0,             -- 裁判是否已复核
    reviewed_by   INTEGER REFERENCES admins(id),
    resolved_at   INTEGER,
    resolution    TEXT,
    fingerprint   TEXT,
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_anomalies_event ON anomalies(event_id, type);

  /* ============ 审计日志（管理员操作留痕） ============ */
  CREATE TABLE IF NOT EXISTS audit_logs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id      INTEGER REFERENCES admins(id),
    action        TEXT NOT NULL,
    target        TEXT,
    detail_json   TEXT,
    ip            TEXT,
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_audit_admin ON audit_logs(admin_id, created_at);
  `);

  // 兼容已有数据库：补列（SQLite 不支持 IF NOT EXISTS 加列，用 try 包住）
  addColumnIfMissing('courses', 'crs', "TEXT DEFAULT 'gcj02'");
  addColumnIfMissing('courses', 'status', "TEXT DEFAULT 'draft'");
  addColumnIfMissing('courses', 'surveyed_at', 'INTEGER');
  addColumnIfMissing('courses', 'surveyed_by', 'INTEGER');
  addColumnIfMissing('courses', 'route_key', "TEXT DEFAULT 'default'");
  addColumnIfMissing('courses', 'group_key', 'TEXT');
  addColumnIfMissing('courses', 'published_at', 'INTEGER');
  addColumnIfMissing('courses', 'locked_at', 'INTEGER');
  addColumnIfMissing('courses', 'locked_by', 'INTEGER');
  addColumnIfMissing('courses', 'survey_evidence_json', 'TEXT');
  addColumnIfMissing('courses', 'updated_at', 'INTEGER');
  addColumnIfMissing('courses', 'start_radius_m', 'INTEGER DEFAULT 80');
  addColumnIfMissing('courses', 'finish_radius_m', 'INTEGER DEFAULT 80');

  addColumnIfMissing('checkpoints', 'reward_points', 'INTEGER DEFAULT 0');
  addColumnIfMissing('checkpoints', 'methods_json', "TEXT DEFAULT '[\"gps\"]'");

  addColumnIfMissing('track_points', 'raw_lng', 'REAL');
  addColumnIfMissing('track_points', 'raw_lat', 'REAL');
  addColumnIfMissing('track_points', 'crs', "TEXT DEFAULT 'gcj02'");
  addColumnIfMissing('track_points', 'accepted', 'INTEGER DEFAULT 1');
  addColumnIfMissing('track_points', 'reliable', 'INTEGER DEFAULT 1');
  addColumnIfMissing('track_points', 'coordinate_verified', 'INTEGER DEFAULT 0');
  addColumnIfMissing('track_points', 'is_backfill', 'INTEGER DEFAULT 0');
  addColumnIfMissing('track_points', 'validation_flags', 'TEXT');
  addColumnIfMissing('track_points', 'route_distance_m', 'REAL');
  addColumnIfMissing('track_points', 'batch_id', 'TEXT');

  addColumnIfMissing('events', 'colleges_json', 'TEXT');
  addColumnIfMissing('events', 'start_name', 'TEXT');
  addColumnIfMissing('events', 'finish_name', 'TEXT');
  addColumnIfMissing('events', 'reg_open', 'INTEGER DEFAULT 1');
  addColumnIfMissing('events', 'rules_json', 'TEXT');
  addColumnIfMissing('events', 'default_route_key', "TEXT DEFAULT 'default'");

  addColumnIfMissing('runs', 'access_token', 'TEXT');
  addColumnIfMissing('runs', 'last_seq', 'INTEGER DEFAULT -1');
  addColumnIfMissing('runs', 'last_point_at', 'INTEGER');
  addColumnIfMissing('runs', 'last_client_ts', 'INTEGER');
  addColumnIfMissing('runs', 'last_lng', 'REAL');
  addColumnIfMissing('runs', 'last_lat', 'REAL');
  addColumnIfMissing('runs', 'last_accuracy', 'REAL');
  addColumnIfMissing('runs', 'last_route_distance', 'REAL');
  addColumnIfMissing('runs', 'warning_count', 'INTEGER DEFAULT 0');
  addColumnIfMissing('runs', 'critical_count', 'INTEGER DEFAULT 0');
  addColumnIfMissing('runs', 'lost_at', 'INTEGER');
  addColumnIfMissing('runs', 'accepted_points', 'INTEGER DEFAULT 0');
  addColumnIfMissing('runs', 'rejected_points', 'INTEGER DEFAULT 0');
  addColumnIfMissing('runs', 'backfill_points', 'INTEGER DEFAULT 0');
  addColumnIfMissing('runs', 'off_route_streak', 'INTEGER DEFAULT 0');
  addColumnIfMissing('runs', 'off_route_started_at', 'INTEGER');
  addColumnIfMissing('runs', 'quality_json', 'TEXT');
  addColumnIfMissing('runs', 'review_status', "TEXT DEFAULT 'pending'");
  addColumnIfMissing('runs', 'review_note', 'TEXT');
  addColumnIfMissing('runs', 'finish_dist_m', 'REAL');
  addColumnIfMissing('runs', 'finish_valid', 'INTEGER DEFAULT 0');
  addColumnIfMissing('runs', 'reward_points', 'INTEGER DEFAULT 0');

  addColumnIfMissing('checkins', 'raw_lng', 'REAL');
  addColumnIfMissing('checkins', 'raw_lat', 'REAL');
  addColumnIfMissing('checkins', 'coordinate_verified', 'INTEGER DEFAULT 0');
  addColumnIfMissing('participants', 'access_token', 'TEXT');
  addColumnIfMissing('cp_hits', 'method', "TEXT DEFAULT 'gps'");
  addColumnIfMissing('cp_hits', 'operator_id', 'INTEGER');
  addColumnIfMissing('cp_hits', 'note', 'TEXT');
  addColumnIfMissing('cp_hits', 'accuracy_m', 'REAL');
  addColumnIfMissing('cp_hits', 'coordinate_verified', 'INTEGER DEFAULT 0');
  addColumnIfMissing('cp_hits', 'validation_flags', 'TEXT');
  addColumnIfMissing('cp_hits', 'reward_points', 'INTEGER DEFAULT 0');
  addColumnIfMissing('cp_hits', 'evidence_point_id', 'INTEGER');

  addColumnIfMissing('anomalies', 'resolved_at', 'INTEGER');
  addColumnIfMissing('anomalies', 'resolution', 'TEXT');
  addColumnIfMissing('anomalies', 'fingerprint', 'TEXT');

  // 所有无效打卡尝试也保留，正式 cp_hits 只保存通过校验的点。
  db.exec(`
    CREATE TABLE IF NOT EXISTS checkpoint_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      participant_id INTEGER NOT NULL,
      checkpoint_id INTEGER NOT NULL REFERENCES checkpoints(id),
      event_id INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      method TEXT DEFAULT 'gps',
      lng REAL, lat REAL, raw_lng REAL, raw_lat REAL,
      accuracy_m REAL, dist_m REAL,
      valid INTEGER DEFAULT 0,
      reason TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cp_attempts_run ON checkpoint_attempts(run_id, ts);
    CREATE INDEX IF NOT EXISTS idx_runs_live ON runs(event_id, status, last_point_at);
    CREATE INDEX IF NOT EXISTS idx_track_server_time ON track_points(event_id, server_ts);
  `);

  // 新数据库可用唯一索引防止重传；旧数据库若已有重复 seq 则保留兼容模式，
  // API 仍会在写入前按 (run_id, seq) 去重。
  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_track_run_seq_unique ON track_points(run_id, seq)'); }
  catch (e) { console.warn('[db] 旧轨迹存在重复序号，未建立唯一索引'); }
}

function addColumnIfMissing(table, column, ddl) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (cols.some((c) => c.name === column)) return;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    console.log(`[db] 迁移：${table}.${column} 已添加`);
  } catch (e) {
    console.warn(`[db] 迁移 ${table}.${column} 失败：`, e.message);
  }
}

/* ---------- 便捷查询 ---------- */
function run(sql, params) {
  return db.prepare(sql).run(...(params || []));
}
function get(sql, params) {
  const r = db.prepare(sql).get(...(params || []));
  return r ? Object.assign({}, r) : null;
}
function all(sql, params) {
  return db.prepare(sql).all(...(params || [])).map((r) => Object.assign({}, r));
}
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw e;
  }
}

module.exports = { open, run, get, all, tx, raw: () => db };
