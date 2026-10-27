/* 定位与计时引擎
 * - 真实模式：navigator.geolocation.watchPosition
 * - 演示模式：沿预设路线模拟移动（电脑上没法真跑，用来演示全流程）
 */
(function () {
  'use strict';
  var C = window.CAMPUS;
  var U = window.U;

  var S = {
    mode: 'demo',          // demo | real
    running: false,
    paused: false,
    startedAt: 0,
    elapsedBefore: 0,      // 暂停累计
    points: [],            // [lat,lng,ts]
    distance: 0,
    cps: {},               // { CP1: ts }
    offRouteCount: 0,
    watchId: null,
    timerId: null,
    demoIdx: 0,
    demoTimer: null,
    speed: 4.2,            // 演示配速 m/s（约 4'00"/km）
    onTick: null,
    onPoint: null,
    onCps: null
  };

  function now() { return Date.now(); }

  function elapsed() {
    if (!S.startedAt && !S.demoDone) return 0;
    if (S.paused) return S.elapsedBefore;
    if (S.mode === 'demo') {
      // 演示：按「距离 / 配速」推算虚拟用时，让成绩看起来像真跑出来的
      var t = S.distance / S.speed * 1000;
      return S.elapsedBefore + t;
    }
    return S.elapsedBefore + (now() - S.startedAt);
  }

  /* ---------- 演示：沿路线走 ---------- */
  function demoStep() {
    var path = C.course.path;
    if (S.demoIdx >= path.length - 1) { return; }
    S.demoIdx++;
    // 每步插值 3 个中间点，让轨迹更顺
    var a = path[S.demoIdx - 1], b = path[S.demoIdx];
    var seg = U.dist(a, b);
    var sub = Math.max(1, Math.round(seg / 25));
    for (var i = 1; i <= sub; i++) {
      var t = i / sub;
      var lat = a[0] + (b[0] - a[0]) * t + (Math.random() - .5) * 0.00006;
      var lng = a[1] + (b[1] - a[1]) * t + (Math.random() - .5) * 0.00006;
      pushPoint([lat, lng]);
    }
    if (S.onTick) S.onTick(snapshot());
    if (S.demoIdx >= path.length - 1) {
      var rec = finish();
      if (S.onFinish) S.onFinish(rec);
    }
  }

  function pushPoint(p) {
    var last = S.points[S.points.length - 1];
    if (last) {
      var d = U.dist([last[0], last[1]], p);
      if (d < 1.5) return;              // 抖动过滤
      S.distance += d;
    }
    S.points.push([p[0], p[1], elapsed()]);
    checkCps(p);
    if (S.onPoint) S.onPoint(p, S.points.length);
  }

  /* 当前生效的打卡点
   * 统一输出 GCJ-02 坐标 [lat, lng]，与地图底图、管理员配置保持一致。
   * （管理员配置存的就是 GCJ-02；内置演示点是 WGS-84，这里转换一次）
   */
  function activeCps() {
    var cfg = window.CourseStore && window.CourseStore.load();
    if (cfg && cfg.checkpoints && cfg.checkpoints.length) {
      return cfg.checkpoints
        .filter(function (cp) { return cp.lnglat && cp.lnglat.length === 2; })
        .map(function (cp, i) {
          return {
            id: cp.id || ('CP' + (i + 1)),
            name: cp.name,
            lat: cp.lnglat[1],      // 已是 GCJ-02
            lng: cp.lnglat[0],
            radius: cp.radius || 30
          };
        });
    }
    // 内置演示点（WGS-84）→ 转 GCJ-02
    return C.course.cps.map(function (cp) {
      var g = window.Coord ? window.Coord.wgs2gcj(cp.lat, cp.lng) : [cp.lat, cp.lng];
      return { id: cp.id, name: cp.name, lat: g[0], lng: g[1], radius: cp.radius };
    });
  }

  /* ---------- CP 检查 ----------
   * 传入 p 是 WGS-84（来自 GPS 或演示路线），先转 GCJ-02 再与打卡点比较，
   * 否则会有约 500 米的系统性偏移。
   */
  function checkCps(p) {
    var g = window.Coord ? window.Coord.wgs2gcj(p[0], p[1]) : [p[0], p[1]];
    activeCps().forEach(function (cp) {
      if (S.cps[cp.id]) return;
      if (U.dist(g, [cp.lat, cp.lng]) <= cp.radius) {
        S.cps[cp.id] = elapsed();   // 记录相对起跑的时刻（毫秒）
        U.haptic('ok');
        if (S.onCps) S.onCps(cp, Object.keys(S.cps).length);
      }
    });
  }

  function snapshot() {
    var list = activeCps();
    var total = list.length;
    var got = Object.keys(S.cps).length;
    return {
      running: S.running, paused: S.paused,
      elapsed: elapsed(), distance: S.distance,
      points: S.points.length, cpDone: got, cpTotal: total,
      offRoute: S.offRouteCount,
      nextCp: list.filter(function (c) { return !S.cps[c.id]; })[0] || null
    };
  }

  /* ---------- 真实定位 ---------- */
  function startReal() {
    if (!navigator.geolocation) {
      U.toast('当前环境不支持定位，已切换演示模式');
      S.mode = 'demo';
      return false;
    }
    S.watchId = navigator.geolocation.watchPosition(function (pos) {
      var p = [pos.coords.latitude, pos.coords.longitude];
      if (S.running && !S.paused) {
        pushPoint(p);
        var cfgPath = (window.CourseStore && window.CourseStore.load());
        var path = (cfgPath && cfgPath.route && cfgPath.route.points.length > 1)
          ? cfgPath.route.points.map(function (q) { return [q[1], q[0]]; })
          : C.course.path;
        var off = U.distToPath(p, path);
        if (off > 80) S.offRouteCount++;
      }
      if (S.onTick) S.onTick(snapshot(), p, pos.coords.accuracy);
    }, function (err) {
      U.toast('定位失败：' + (err.message || '请检查权限'));
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 2000 });
    return true;
  }

  function stopReal() {
    if (S.watchId != null) {
      navigator.geolocation.clearWatch(S.watchId);
      S.watchId = null;
    }
  }

  /* ---------- 对外 API ---------- */
  function start(opts) {
    opts = opts || {};
    S.mode = opts.mode || 'demo';
    S.running = true; S.paused = false;
    S.startedAt = now(); S.elapsedBefore = 0;
    S.points = []; S.distance = 0; S.cps = {}; S.offRouteCount = 0;
    S.demoIdx = 0;

    if (S.mode === 'demo') {
      pushPoint(C.course.path[0]);
      S.demoTimer = setInterval(demoStep, 520);
    } else {
      if (!startReal()) {
        S.mode = 'demo';
        pushPoint(C.course.path[0]);
        S.demoTimer = setInterval(demoStep, 520);
      }
    }
    S.timerId = setInterval(function () { if (S.onTick) S.onTick(snapshot()); }, 100);
    if (S.onTick) S.onTick(snapshot());
    return true;
  }

  function pause() {
    if (!S.running || S.paused) return;
    S.elapsedBefore = elapsed();
    S.paused = true;
    S.pausedAt = now();
    if (S.demoTimer) { clearInterval(S.demoTimer); S.demoTimer = null; }
    if (S.onTick) S.onTick(snapshot());
  }

  function resume() {
    if (!S.running || !S.paused) return;
    if (S.mode === 'demo') S.startedAt = now();   // 演示模式虚拟时钟不依赖 startedAt
    else S.startedAt = now();
    S.paused = false;
    if (S.mode === 'demo') S.demoTimer = setInterval(demoStep, 520);
    if (S.onTick) S.onTick(snapshot());
  }

  function finish() {
    if (!S.running) return null;
    var total = elapsed();
    S.running = false; S.paused = false;
    if (S.demoTimer) { clearInterval(S.demoTimer); S.demoTimer = null; }
    if (S.timerId) { clearInterval(S.timerId); S.timerId = null; }
    stopReal();
    S.finishedAt = now();

    var rec = {
      _id: U.uid('run_'),
      startedAt: S.startedAt,
      endedAt: now(),
      elapsedMs: total,
      distance: S.distance,
      points: S.points,
      cps: S.cps,
      offRouteCount: S.offRouteCount,
      mode: S.mode
    };
    S.startedAt = 0; S.elapsedBefore = 0; S.demoDone = true;
    return rec;
  }

  function abort() {
    S.running = false; S.paused = false;
    if (S.demoTimer) { clearInterval(S.demoTimer); S.demoTimer = null; }
    if (S.timerId) { clearInterval(S.timerId); S.timerId = null; }
    stopReal();
    S.startedAt = 0; S.elapsedBefore = 0; S.points = []; S.distance = 0; S.cps = {};
  }

  window.Runner = {
    S: S,
    start: start, pause: pause, resume: resume, finish: finish, abort: abort,
    snapshot: snapshot, elapsed: elapsed,
    isRunning: function () { return S.running; },
    setMode: function (m) { S.mode = m; }
  };

  // 回调代理到内部状态，页面可直接 Runner.onTick = fn
  ['onTick', 'onPoint', 'onCps', 'onFinish'].forEach(function (k) {
    Object.defineProperty(window.Runner, k, {
      get: function () { return S[k]; },
      set: function (v) { S[k] = v; }
    });
  });
})();
