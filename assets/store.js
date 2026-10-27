/* 数据层
 *
 * 双模式：
 *   online  —— 走后端 /api/*，数据存 SQLite，多设备共享
 *   offline —— 后端不可用时回退 localStorage（纯静态部署 / 断网演示）
 *
 * 页面调用方式完全不变（DB.xxx），只在本文件内部分流。
 */
(function () {
  'use strict';
  var U = window.U;
  var K = {
    user: 'user',
    reg: 'registration',
    checkin: 'checkin',
    run: 'run',
    runId: 'run_id',
    seed: 'seed_v1',
    regs: 'demo_regs'
  };

  /* 离线模式的演示数据（仅当后端不可用时使用） */
  var SEED_RECORDS = [
    { sid: '2023011201', name: '林晓楠', college: '数学与计算机科学学院', group: 'competition', elapsedMs: 15 * 60000 + 42000, distance: 3520 },
    { sid: '2022030415', name: '陈子豪', college: '体育学院', group: 'competition', elapsedMs: 16 * 60000 + 9000, distance: 3480 },
    { sid: '2023110233', name: '黄雅雯', college: '外国语学院', group: 'competition', elapsedMs: 17 * 60000 + 55000, distance: 3560 },
    { sid: '2021050122', name: '吴嘉诚', college: '陈守仁商学院', group: 'unity', partner: '郑宇轩', elapsedMs: 18 * 60000 + 12000, distance: 3600 },
    { sid: '2023090877', name: '蔡欣怡', college: '教育科学学院', group: 'competition', elapsedMs: 18 * 60000 + 40000, distance: 3450 },
    { sid: '2022070631', name: '王梓涵', college: '物理与信息工程学院', group: 'unity', partner: '李思远', elapsedMs: 19 * 60000 + 8000, distance: 3620 },
    { sid: '2023041009', name: '曾俊杰', college: '资源与环境科学学院', group: 'competition', elapsedMs: 19 * 60000 + 33000, distance: 3510 },
    { sid: '2022120442', name: '苏梦琳', college: '文学与传播学院', group: 'unity', partner: '周晓彤', elapsedMs: 20 * 60000 + 15000, distance: 3580 },
    { sid: '2023080518', name: '李振宇', college: '化学与材料学院', group: 'competition', elapsedMs: 20 * 60000 + 51000, distance: 3540 },
    { sid: '2021090926', name: '张若彤', college: '美术与设计学院', group: 'experience', elapsedMs: null, distance: 3400 }
  ];

  var S = {
    online: false,          // 是否连上后端
    probePromise: null,
    statsCache: null,
    statsAt: 0
  };

  function api() { return window.API; }

  /* ---------- 探测后端 ---------- */
  function probe() {
    if (!api()) return Promise.resolve(false);
    if (S.probePromise) return S.probePromise;
    S.probePromise = api().probe().then(function (online) {
      S.online = online;
      S.probePromise = null;
      return online;
    });
    return S.probePromise;
  }

  /* ---------- 设备标识（用于找回报名） ---------- */
  function deviceId() {
    var id = U.load('device_id', '');
    if (!id) { id = 'dev_' + U.uid(''); U.save('device_id', id); }
    return id;
  }

  /* ============================================================
   *  本地（离线）
   * ============================================================ */
  function getUser() { return U.load(K.user, null); }
  function setUser(u) { U.save(K.user, u); }
  function clearUser() {
    U.remove(K.user); U.remove(K.reg); U.remove(K.checkin);
    U.remove(K.run); U.remove(K.runId);
  }

  function getReg() { return U.load(K.reg, null); }
  function setReg(r) {
    U.save(K.reg, r);
    var list = U.load(K.regs, []);
    list = list.filter(function (x) { return x._id !== r._id; });
    list.push(r);
    U.save(K.regs, list);
  }

  function listRegs() {
    var mine = U.load(K.regs, []);
    var seed = U.load(K.seed, null);
    if (!seed) { seed = buildSeed(); U.save(K.seed, seed); }
    return mine.concat(seed);
  }

  function buildSeed() {
    var names = ['林晓楠', '陈子豪', '黄雅雯', '吴嘉诚', '蔡欣怡', '王梓涵', '曾俊杰', '苏梦琳',
      '李振宇', '张若彤', '刘思远', '周晓彤', '郑宇轩', '杨浩然', '何静怡', '谢承恩',
      '洪嘉怡', '庄铭辉', '许乐怡', '康凯翔', '施雨萱', '林则宇', '戴欣妍', '黄志伟'];
    var groups = ['competition', 'competition', 'competition', 'unity', 'competition',
      'unity', 'competition', 'unity', 'competition', 'experience'];
    var out = [];
    for (var i = 0; i < 24; i++) {
      var g = groups[i % groups.length];
      var co = window.COLLEGES[i % window.COLLEGES.length];
      out.push({
        _id: 'seed_' + i,
        sid: '2023' + U.pad((i * 7) % 100) + U.pad(1000 + i * 13),
        name: names[i], college: co, group: g,
        partner: g === 'unity' ? { name: names[(i + 3) % names.length], sid: '2023' + U.pad((i * 5) % 100) + U.pad(2000 + i), college: window.COLLEGES[(i + 4) % window.COLLEGES.length] } : null,
        status: i < 18 ? 'checked' : 'registered',
        createdAt: Date.now() - (30 - i) * 60000
      });
    }
    return out;
  }

  function getCheckin() { return U.load(K.checkin, null); }
  function setCheckin(c) { U.save(K.checkin, c); }

  function getRun() { return U.load(K.run, null); }
  function setRun(r) { U.save(K.run, r); }
  function clearRun() { U.remove(K.run); U.remove(K.runId); }

  function getRunId() { return U.load(K.runId, null); }
  function setRunId(id) { U.save(K.runId, id); }

  function leaderboardLocal(groupKey) {
    var rows = [];
    SEED_RECORDS.forEach(function (r) {
      rows.push({ sid: r.sid, name: r.name, partner: r.partner || null, college: r.college,
        group: r.group, elapsedMs: r.elapsedMs, distance: r.distance, isDemo: true });
    });
    var mine = getRun();
    var reg = getReg();
    if (mine && mine.endedAt && reg) {
      rows.push({
        sid: reg.sid, name: reg.name,
        partner: reg.partner ? reg.partner.name : null,
        college: reg.college, group: reg.group,
        elapsedMs: mine.elapsedMs, distance: mine.distance, isMe: true
      });
    }
    if (groupKey && groupKey !== 'all') {
      rows = rows.filter(function (r) { return r.group === groupKey; });
    }
    rows = rows.filter(function (r) { return r.elapsedMs != null; });
    rows.sort(function (a, b) { return a.elapsedMs - b.elapsedMs; });
    return rows;
  }

  function statsLocal() {
    var regs = listRegs();
    var checked = regs.filter(function (r) { return r.status === 'checked'; }).length;
    return {
      total: regs.length + 176,
      checked: checked + 141,
      finished: leaderboardLocal('all').length + 132,
      online: false
    };
  }

  /* ============================================================
   *  异步接口（优先后端，失败回退本地）
   * ============================================================ */

  /* 报名 */
  function submitRegistration(form) {
    return probe().then(function (online) {
      if (!online) {
        var rec = {
          _id: U.uid('reg_'), sid: form.sid, name: form.name, college: form.college,
          phone: form.phone, group: form.group, partner: form.partner || null,
          status: 'registered', createdAt: Date.now(), _offline: true
        };
        setUser({ sid: rec.sid, name: rec.name, college: rec.college });
        setReg(rec);
        return { ok: true, offline: true, data: rec };
      }
      return api().post('/api/participants', Object.assign({}, form, { deviceId: deviceId(), participantToken: (getReg() || {}).participantToken }))
        .then(function (j) {
          var d = j.data;
          var rec = {
            _id: String(d.id), id: d.id, sid: d.sid, name: d.name, college: d.college,
            phone: d.phone, group: d.group, partner: d.partner, participantToken: d.participantToken,
            status: d.status, createdAt: d.createdAt
          };
          setUser({ sid: rec.sid, name: rec.name, college: rec.college });
          setReg(rec);
          return { ok: true, offline: false, data: rec, existed: !!j.existed };
        })
        .catch(function (e) {
          if (e.offline) return submitRegistration(form);   // 网络断了，回退
          return { ok: false, offline: false, error: e.message, code: e.code };
        });
    });
  }

  /* 签到 */
  function submitCheckin(payload) {
    var reg = getReg();
    return probe().then(function (online) {
      if (!online || !reg || !reg.id) {
        var c = { ts: Date.now(), lat: payload.lat, lng: payload.lng,
          accuracy: payload.accuracy, distToStart: payload.distToStart };
        setCheckin(c);
        return { ok: true, offline: true, data: c };
      }
      return api().post('/api/checkins', Object.assign({ sid: reg.sid }, payload))
        .then(function (j) {
          var d = j.data;
          var c = { ts: d.ts, lat: d.lat, lng: d.lng, accuracy: d.accuracy,
            distToStart: d.distToStart, _id: d.id };
          setCheckin(c);
          return { ok: true, offline: false, data: c };
        })
        .catch(function (e) {
          if (e.offline) return submitCheckin(payload);
          return { ok: false, error: e.message, code: e.code };
        });
    });
  }

  /* 开始比赛 */
  function startRun(mode) {
    var reg = getReg();
    return probe().then(function (online) {
      if (!online || !reg || !reg.id) {
        return { ok: true, offline: true, runId: null };
      }
      return api().post('/api/runs/start', { sid: reg.sid, mode: mode || 'gps' })
        .then(function (j) {
          setRunId(j.data.id);
          return { ok: true, offline: false, runId: j.data.id, cpTotal: j.data.cpTotal };
        })
        .catch(function (e) {
          if (e.offline) return { ok: true, offline: true, runId: null };
          return { ok: false, error: e.message };
        });
    });
  }

  /* 批量上传轨迹（失败静默，前端已本地保存） */
  function pushTrack(points) {
    var runId = getRunId();
    if (!S.online || !runId || !points || !points.length) return Promise.resolve({ ok: true, skipped: true });
    return api().post('/api/runs/' + runId + '/track', { points: points })
      .then(function (j) { return { ok: true, inserted: j.data.inserted }; })
      .catch(function (e) { return { ok: false, error: e.message }; });
  }

  /* 打卡 */
  function pushHit(code, lng, lat) {
    var runId = getRunId();
    if (!S.online || !runId) return Promise.resolve({ ok: true, skipped: true });
    return api().post('/api/runs/' + runId + '/hit', { code: code, lng: lng, lat: lat })
      .then(function (j) { return { ok: true, data: j.data }; })
      .catch(function (e) { return { ok: false, error: e.message }; });
  }

  /* 结束比赛 */
  function finishRun(localRec) {
    var runId = getRunId();
    setRun(localRec);
    return probe().then(function (online) {
      if (!online || !runId) return { ok: true, offline: true, data: localRec };
      return api().post('/api/runs/' + runId + '/finish', {})
        .then(function (j) {
          return { ok: true, offline: false, data: j.data };
        })
        .catch(function (e) {
          return { ok: false, error: e.message, data: localRec };
        });
    });
  }

  /* 排行榜 */
  function leaderboardAsync(groupKey) {
    return probe().then(function (online) {
      if (!online) return { ok: true, offline: true, rows: leaderboardLocal(groupKey) };
      return api().get('/api/leaderboard', { group: groupKey || 'all' })
        .then(function (j) {
          var reg = getReg();
          var rows = j.data.map(function (r) {
            return {
              sid: r.sid, name: r.name, partner: r.partner || null,
              college: r.college, group: r.group,
              elapsedMs: r.elapsedMs, distance: r.distance,
              isMe: !!(reg && reg.sid === r.sid)
            };
          });
          return { ok: true, offline: false, rows: rows };
        })
        .catch(function (e) {
          return { ok: true, offline: true, rows: leaderboardLocal(groupKey), error: e.message };
        });
    });
  }

  /* 统计（首页 / 后台） */
  function statsAsync() {
    return probe().then(function (online) {
      if (!online) return statsLocal();
      if (S.statsCache && Date.now() - S.statsAt < 15000) return S.statsCache;
      return api().get('/api/public/stats')
        .then(function (j) {
          var d = j.data;
          var s = {
            total: d.total || 0,
            checked: d.checked || 0,
            finished: d.finished || 0,
            online: true
          };
          S.statsCache = s; S.statsAt = Date.now();
          return s;
        })
        .catch(function () { return statsLocal(); });
    });
  }

  /* 报名名单（管理后台） */
  function listRegsAsync() {
    return probe().then(function (online) {
      if (!online) return { ok: true, offline: true, rows: listRegs() };
      return api().get('/api/participants', { limit: 2000 })
        .then(function (j) {
          var rows = j.data.map(function (d) {
            return {
              _id: String(d.id), id: d.id, sid: d.sid, name: d.name, college: d.college,
              group: d.group, partner: d.partner, status: d.status,
              createdAt: d.createdAt, bib: d.bib
            };
          });
          return { ok: true, offline: false, rows: rows };
        })
        .catch(function () { return { ok: true, offline: true, rows: listRegs() }; });
    });
  }

  /* 我的成绩（后端） */
  function myRunAsync() {
    var runId = getRunId();
    if (!S.online || !runId) return Promise.resolve(getRun());
    return api().get('/api/runs/' + runId)
      .then(function (j) { return j.data; })
      .catch(function () { return getRun(); });
  }

  function myRank() {
    var rows = leaderboardLocal('all');
    for (var i = 0; i < rows.length; i++) if (rows[i].isMe) return { rank: i + 1, total: rows.length };
    return null;
  }

  window.DB = {
    // 同步（本地缓存）
    getUser: getUser, setUser: setUser, clearUser: clearUser,
    getReg: getReg, setReg: setReg, listRegs: listRegs,
    getCheckin: getCheckin, setCheckin: setCheckin,
    getRun: getRun, setRun: setRun, clearRun: clearRun,
    getRunId: getRunId, setRunId: setRunId,
    leaderboard: leaderboardLocal, myRank: myRank, stats: statsLocal,

    // 异步（优先后端）
    probe: probe,
    submitRegistration: submitRegistration,
    submitCheckin: submitCheckin,
    startRun: startRun, pushTrack: pushTrack, pushHit: pushHit, finishRun: finishRun,
    leaderboardAsync: leaderboardAsync,
    statsAsync: statsAsync,
    listRegsAsync: listRegsAsync,
    myRunAsync: myRunAsync,
    deviceId: deviceId,
    isOnline: function () { return S.online; },
    SEED_RECORDS: SEED_RECORDS
  };
})();
