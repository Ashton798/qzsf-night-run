/* 偏航识别基础
 *
 * 只做「计算 + 分级提示」，不做任何处罚动作。
 *
 * 核心原则（对应任务六）：
 *   1. 距离必须结合 GPS 精度 —— 精度 ±50m 时，偏离 60m 毫无意义
 *   2. 需要连续多个有效点才算偏离，单点抖动不算
 *   3. 需要持续足够时间
 *   4. 精度差时显示「定位不可靠」，不认定作弊
 *   5. 只记录、只提示，不踢出、不取消成绩
 */
(function () {
  'use strict';

  var Coord = window.Coord;

  var DEFAULTS = {
    // 超过路线多少米算偏离（会再叠加 GPS 精度）
    baseTolerance: 25,
    // 精度倍数：允许误差 = baseTolerance + accuracy * factor
    accuracyFactor: 1.5,
    // 连续多少个有效点才算偏离
    minConsecutive: 3,
    // 持续多少毫秒才算偏离
    minDurationMs: 8000,
    // 精度超过此值，直接标记「定位不可靠」
    unreliableAccuracy: 60
  };

  /* 点到线段的最短距离（米），全部用 GCJ02 [lat,lng] */
  function distToSegment(p, a, b) {
    var rad = Math.PI / 180;
    var kx = Math.cos(p[0] * rad) * 111320;
    var ky = 110540;
    var px = p[1] * kx, py = p[0] * ky;
    var ax = a[1] * kx, ay = a[0] * ky;
    var bx = b[1] * kx, by = b[0] * ky;
    var dx = bx - ax, dy = by - ay;
    var len2 = dx * dx + dy * dy;
    var t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    var cx = ax + t * dx, cy = ay + t * dy;
    return Math.hypot(px - cx, py - cy);
  }

  /* 点到折线的最短距离（米），返回 { dist, segIndex, ratio } */
  function distToPath(p, path) {
    if (!path || path.length < 2) return { dist: Infinity, segIndex: -1, ratio: 0 };
    var best = { dist: Infinity, segIndex: -1, ratio: 0 };
    for (var i = 1; i < path.length; i++) {
      var d = distToSegment(p, path[i - 1], path[i]);
      if (d < best.dist) {
        best.dist = d;
        best.segIndex = i - 1;
      }
    }
    return best;
  }

  /* ---------- 偏航状态机 ---------- */
  function createTracker(coursePoints, options) {
    var opt = Object.assign({}, DEFAULTS, options || {});
    var path = (coursePoints || []).map(function (p) {
      // 统一成 [lat, lng]
      return Array.isArray(p) ? [p[1], p[0]] : [p.lat, p.lng];
    });

    var S = {
      consecutiveOff: 0,     // 连续偏离计数
      firstOffAt: 0,         // 首次偏离时间
      offSince: 0,
      isOffRoute: false,
      events: [],            // 偏离事件记录
      lastResult: null,
      maxDist: 0
    };

    /* 输入：{ lat, lng, accuracy, ts, crs }
     * lat/lng 必须是 GCJ02（与 coursePoints 同坐标系）
     */
    function update(sample) {
      if (!path.length) {
        return { state: 'no_route', message: '未配置比赛路线' };
      }

      var acc = sample.accuracy != null ? sample.accuracy : 999;
      var r = distToPath([sample.lat, sample.lng], path);
      var dist = r.dist;

      // 允许误差随精度放大
      var tolerance = opt.baseTolerance + acc * opt.accuracyFactor;
      var reliable = acc <= opt.unreliableAccuracy;
      var off = dist > tolerance;

      var result = {
        dist: dist,
        tolerance: tolerance,
        accuracy: acc,
        reliable: reliable,
        off: off,
        segIndex: r.segIndex,
        state: 'ok',
        message: ''
      };

      if (!reliable) {
        result.state = 'unreliable';
        result.message = '定位精度 ±' + Math.round(acc) + 'm，无法判断是否偏离';
        // 不可靠时重置计数，避免误判
        S.consecutiveOff = 0;
        S.firstOffAt = 0;
        S.isOffRoute = false;
        S.lastResult = result;
        return result;
      }

      if (off) {
        S.consecutiveOff++;
        if (!S.firstOffAt) S.firstOffAt = sample.ts || Date.now();
        var duration = (sample.ts || Date.now()) - S.firstOffAt;

        if (S.consecutiveOff >= opt.minConsecutive && duration >= opt.minDurationMs) {
          if (!S.isOffRoute) {
            S.isOffRoute = true;
            S.offSince = S.firstOffAt;
            S.events.push({
              type: 'off_route',
              at: S.firstOffAt,
              dist: Math.round(dist),
              accuracy: Math.round(acc),
              lat: sample.lat, lng: sample.lng,
              segIndex: r.segIndex
            });
          }
          result.state = 'off_route';
          result.message = '已偏离路线 ' + Math.round(dist) + 'm，持续 ' + Math.round(duration / 1000) + 's';
        } else {
          result.state = 'off_pending';
          result.message = '偏离 ' + Math.round(dist) + 'm（' + S.consecutiveOff + '/' + opt.minConsecutive + '）';
        }
      } else {
        if (S.isOffRoute) {
          S.events.push({
            type: 'back_on_route',
            at: sample.ts || Date.now(),
            duration: (sample.ts || Date.now()) - S.offSince,
            lat: sample.lat, lng: sample.lng
          });
        }
        S.consecutiveOff = 0;
        S.firstOffAt = 0;
        S.isOffRoute = false;
        result.state = 'ok';
      }

      S.maxDist = Math.max(S.maxDist, dist);
      S.lastResult = result;
      return result;
    }

    function reset() {
      S.consecutiveOff = 0;
      S.firstOffAt = 0;
      S.isOffRoute = false;
      S.events = [];
      S.lastResult = null;
      S.maxDist = 0;
    }

    function stats() {
      return {
        events: S.events.slice(),
        offRouteCount: S.events.filter(function (e) { return e.type === 'off_route'; }).length,
        maxDist: Math.round(S.maxDist),
        isOffRoute: S.isOffRoute
      };
    }

    return {
      update: update,
      reset: reset,
      stats: stats,
      pathLength: function () { return Coord.pathLength(path); }
    };
  }

  /* ---------- 轨迹质量评估 ----------
   * 用于判断一次采集是否稳定、是否值得作为路线参考
   */
  function assessQuality(track) {
    if (!track || track.length < 2) {
      return { score: 0, grade: 'D', issues: ['轨迹点太少'] };
    }
    var issues = [];
    var accs = track.map(function (p) { return p.accuracy || p.raw && p.raw.accuracy || 999; })
      .filter(function (a) { return isFinite(a); });
    var avgAcc = accs.reduce(function (s, a) { return s + a; }, 0) / Math.max(accs.length, 1);
    var maxAcc = Math.max.apply(null, accs);

    // 速度突变检测
    var jumps = 0;
    for (var i = 1; i < track.length; i++) {
      var p0 = track[i - 1], p1 = track[i];
      var la0 = p0.display ? p0.display.lat : p0.raw.lat;
      var ln0 = p0.display ? p0.display.lng : p0.raw.lng;
      var la1 = p1.display ? p1.display.lat : p1.raw.lat;
      var ln1 = p1.display ? p1.display.lng : p1.raw.lng;
      var d = Coord.haversine([la0, ln0], [la1, ln1]);
      var dt = ((p1.ts || 0) - (p0.ts || 0)) / 1000;
      if (dt > 0 && d / dt > 8) jumps++;
    }

    if (avgAcc > 30) issues.push('平均精度 ' + avgAcc.toFixed(0) + 'm 偏弱');
    if (maxAcc > 100) issues.push('存在精度极差的点');
    if (jumps > track.length * 0.05) issues.push('检测到 ' + jumps + ' 处速度突变');

    var score = 100;
    score -= Math.min(40, Math.max(0, avgAcc - 10) * 1.5);
    score -= Math.min(30, jumps * 5);
    if (track.length < 20) score -= 20;

    score = Math.max(0, Math.min(100, Math.round(score)));
    var grade = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 50 ? 'C' : 'D';

    return {
      score: score, grade: grade, issues: issues,
      avgAccuracy: Math.round(avgAcc),
      maxAccuracy: Math.round(maxAcc),
      jumps: jumps,
      points: track.length
    };
  }

  window.RouteGuard = {
    DEFAULTS: DEFAULTS,
    distToSegment: distToSegment,
    distToPath: distToPath,
    createTracker: createTracker,
    assessQuality: assessQuality
  };
})();
