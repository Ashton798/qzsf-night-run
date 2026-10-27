/* 比赛路线数据层
 *
 * 数据结构（v1）—— 刻意设计成可扩展，后续加计时/裁判/多赛道都不用改根结构
 *
 * {
 *   version: 1,
 *   eventId: 'qzsf-2025',
 *   name: '泉州师范学院校园定向越野',
 *   updatedAt: 1699999999999,
 *   updatedBy: 'admin',
 *   campus: { name, center:[lng,lat], zoom },
 *   route: {
 *     points: [[lng,lat], ...],     // 折线路径（GCJ-02）
 *     start:  [lng,lat],
 *     finish: [lng,lat],
 *     closed: false                 // 是否为环形（终点=起点）
 *   },
 *   checkpoints: [
 *     { id:'CP1', name:'图书馆', order:1, lnglat:[lng,lat], radius:30, required:true }
 *   ],
 *   meta: { distance: 3520, source:'manual' }   // distance 单位米，保存时自动算
 * }
 */
(function () {
  'use strict';

  var U = window.U;
  var STORE_KEY = 'course_v1';
  var EVENT_ID = 'qzsf-2025';

  var DEFAULTS = {
    version: 2,
    eventId: EVENT_ID,
    name: '泉州师范学院校园定向越野',
    updatedAt: 0,
    updatedBy: '',
    // 坐标系统一声明：本项目路线/打卡点全部为 GCJ-02
    crs: 'gcj02',
    campus: { name: '泉州师范学院东海主校区', center: [118.671028, 24.868274], zoom: 16 },
    route: { points: [], start: null, finish: null, closed: false, crs: 'gcj02' },
    checkpoints: [],
    // draft 草稿 | surveyed 已实地勘测 | published 已发布
    status: 'draft',
    surveyedAt: 0,
    surveyedBy: '',
    meta: { distance: 0, source: 'manual' }
  };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /* ---------- 校验 ---------- */
  function validate(c) {
    var errs = [];
    if (!c || typeof c !== 'object') return { ok: false, errors: ['数据为空'] };

    var r = c.route || {};
    if (!Array.isArray(r.points)) errs.push('route.points 必须是数组');
    else if (r.points.length < 2) errs.push('比赛路线至少需要 2 个途经点');
    else {
      r.points.forEach(function (p, i) {
        if (!isLngLat(p)) errs.push('第 ' + (i + 1) + ' 个途经点坐标无效');
      });
    }
    if (!isLngLat(r.start)) errs.push('未设置起点');
    if (!isLngLat(r.finish)) errs.push('未设置终点');

    var cps = c.checkpoints || [];
    if (cps.length !== 3) errs.push('打卡点必须为 3 个，当前 ' + cps.length + ' 个');
    var seen = {};
    cps.forEach(function (cp, i) {
      if (!cp.name || !String(cp.name).trim()) errs.push('第 ' + (i + 1) + ' 个打卡点缺少名称');
      if (!isLngLat(cp.lnglat)) errs.push('第 ' + (i + 1) + ' 个打卡点坐标无效');
      if (!(cp.radius > 0 && cp.radius <= 500)) errs.push('第 ' + (i + 1) + ' 个打卡点半径应在 1–500 米之间');
      if (seen[cp.order]) errs.push('打卡点顺序重复：' + cp.order);
      seen[cp.order] = true;
    });

    return { ok: errs.length === 0, errors: errs };
  }

  function isLngLat(p) {
    return Array.isArray(p) && p.length === 2 &&
      isFinite(p[0]) && isFinite(p[1]) &&
      p[0] > 70 && p[0] < 140 && p[1] > 3 && p[1] < 55;
  }

  /* ---------- 计算 ---------- */
  /* 折线长度（米），GCJ-02 下用等距近似足够精确（校园尺度误差 < 0.3%） */
  function distance(path) {
    if (!path || path.length < 2) return 0;
    var R = 6378137, rad = Math.PI / 180, sum = 0;
    for (var i = 1; i < path.length; i++) {
      var a = path[i - 1], b = path[i];
      var dLat = (b[1] - a[1]) * rad;
      var dLng = (b[0] - a[0]) * rad;
      var mLat = ((a[1] + b[1]) / 2) * rad;
      var x = dLng * Math.cos(mLat);
      sum += Math.sqrt(x * x + dLat * dLat) * R;
    }
    return sum;
  }

  function recomputeMeta(c) {
    if (!c || !c.route) return c;
    var pts = c.route.points || [];
    var d = distance(pts);
    if (c.route.closed && pts.length > 1) d += distance([pts[pts.length - 1], pts[0]]);
    c.meta = c.meta || {};
    c.meta.distance = Math.round(d);
    return c;
  }

  /* ---------- 读写 ---------- */
  function normalize(c) {
    var out = clone(DEFAULTS);
    if (!c) return out;
    out = Object.assign(out, c);
    out.route = Object.assign(clone(DEFAULTS.route), c.route || {});
    out.campus = Object.assign(clone(DEFAULTS.campus), c.campus || {});
    out.meta = Object.assign(clone(DEFAULTS.meta), c.meta || {});
    out.checkpoints = (c.checkpoints || []).map(function (cp, i) {
      return {
        id: cp.id || ('CP' + (i + 1)),
        name: cp.name || '',
        order: cp.order || (i + 1),
        lnglat: cp.lnglat || null,
        radius: cp.radius || 30,
        required: cp.required !== false,
        methods: ['manual']
      };
    }).sort(function (a, b) { return a.order - b.order; });
    return out;
  }

  function load() {
    var raw = U.load(STORE_KEY, null);
    if (!raw) return null;
    try { return normalize(raw); } catch (e) { return null; }
  }

  function save(course) {
    var c = normalize(course);
    c.updatedAt = Date.now();
    c.updatedBy = c.updatedBy || 'admin';
    recomputeMeta(c);
    U.save(STORE_KEY, c);
    return c;
  }

  function clear() { U.remove(STORE_KEY); }

  function blank() {
    var c = clone(DEFAULTS);
    c.checkpoints = [1, 2, 3].map(function (i) {
      return { id: 'CP' + i, name: '打卡点 ' + i, order: i, lnglat: null, radius: 30, required: true };
    });
    return c;
  }

  /* ---------- 导出 / 导入 ---------- */
  function toJSON(course) {
    var c = normalize(course);
    recomputeMeta(c);
    return JSON.stringify(c, null, 2);
  }

  function fromJSON(text) {
    var obj = JSON.parse(text);
    var c = normalize(obj);
    var v = validate(c);
    return { course: c, valid: v.ok, errors: v.errors };
  }

  /* 导出为 GPX，便于导入其他工具或实地采集设备 */
  /* 导出 GPX
   * GPX 1.1 标准要求坐标是 WGS84，
   * 所以必须把内部的 GCJ-02 转回 WGS84，否则导入其他软件会偏移约 500m。
   */
  function toGPX(course) {
    var c = normalize(course);
    var Coord = window.Coord;
    var srcCrs = c.crs || 'gcj02';

    function toWgs(p) {
      var r = Coord.convert(p[1], p[0], srcCrs, 'wgs84');
      return [r[1], r[0]];
    }

    var pts = (c.route.points || []).map(toWgs);
    var body = pts.map(function (p, i) {
      return '      <trkpt lat="' + p[1].toFixed(8) + '" lon="' + p[0].toFixed(8) + '">' +
        '<name>P' + (i + 1) + '</name></trkpt>';
    }).join('\n');

    var wpts = (c.checkpoints || []).filter(function (cp) { return cp.lnglat; })
      .map(function (cp) {
        var w = toWgs(cp.lnglat);
        return '  <wpt lat="' + w[1].toFixed(8) + '" lon="' + w[0].toFixed(8) + '">' +
          '<name>' + esc(cp.id + ' ' + cp.name) + '</name>' +
          '<desc>半径 ' + (cp.radius || 30) + ' 米</desc></wpt>';
      }).join('\n');

    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<gpx version="1.1" creator="qzsf-orienteering" xmlns="http://www.topografix.com/GPX/1/1">\n' +
      '  <metadata><name>' + esc(c.name) + '</name>' +
      '<desc>坐标系：WGS84（已从 GCJ-02 转换）</desc></metadata>\n' +
      wpts + '\n  <trk><name>' + esc(c.name) + '</name><trkseg>\n' + body + '\n  </trkseg></trk>\n</gpx>';
  }

  /* 导入 GPX（标准 WGS84）→ 内部 GCJ-02 */
  function fromGPX(xml) {
    var Coord = window.Coord;
    var doc = new DOMParser().parseFromString(xml, 'text/xml');
    if (doc.querySelector('parsererror')) throw new Error('GPX 格式错误');

    function num(el, name) { return parseFloat(el.getAttribute(name)); }

    var pts = [];
    var nodes = doc.querySelectorAll('trkpt');
    if (!nodes.length) nodes = doc.querySelectorAll('rtept');
    Array.prototype.forEach.call(nodes, function (n) {
      var lat = num(n, 'lat'), lng = num(n, 'lon');
      if (!isFinite(lat) || !isFinite(lng)) return;
      var g = Coord.convert(lat, lng, 'wgs84', 'gcj02');
      pts.push([g[1], g[0]]);
    });

    var wpts = [];
    Array.prototype.forEach.call(doc.querySelectorAll('wpt'), function (n) {
      var lat = num(n, 'lat'), lng = num(n, 'lon');
      if (!isFinite(lat) || !isFinite(lng)) return;
      var g = Coord.convert(lat, lng, 'wgs84', 'gcj02');
      var nameEl = n.querySelector('name');
      var descEl = n.querySelector('desc');
      var radius = 30;
      if (descEl) {
        var m = /半径\s*(\d+)/.exec(descEl.textContent || '');
        if (m) radius = parseInt(m[1], 10);
      }
      wpts.push({
        name: nameEl ? nameEl.textContent.trim() : '',
        lnglat: [g[1], g[0]],
        radius: radius
      });
    });

    return { points: pts, waypoints: wpts };
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /* ---------- 后端持久化（预留接口） ----------
   * 现在只操作 localStorage；配置了 api.baseUrl 后自动切换为服务端。
   * 服务端约定：
   *   GET  {baseUrl}{courseEndpoint}  -> { ok:true, data: <course> }
   *   PUT  {baseUrl}{courseEndpoint}  -> body <course>, 返回 { ok:true }
   *   需带 Authorization: Bearer <token>
   */
  function apiAvailable() {
    return !!window.AppConfig.get('api.baseUrl', '');
  }

  function authHeaders() {
    var t = window.AdminAuth && window.AdminAuth.token();
    return t ? { 'Authorization': 'Bearer ' + t } : {};
  }

  function remoteLoad(group, draft) {
    if (!window.API) return Promise.resolve(null);
    group = group || ((window.DB && DB.getReg()) || {}).group || 'competition';
    return window.API.get('/api/night/course', {group:group,draft:draft?'1':'0'})
      .then(function (j) {
        if (!j.data) return null;
        var c = normalize(j.data);
        save(c);                       // 缓存到本地，断网时可用
        return c;
      })
      .catch(function (e) {
        console.warn('[course] 远端加载失败，回退本地：', e.message);
        return null;
      });
  }

  function remoteSave(course) {
    var c = save(course);              // 先存本地，保证不丢
    if (!window.API) return Promise.resolve({ ok: true, local: true, course: c });
    return window.API.put(window.AppConfig.get('api.courseEndpoint', '/api/course'), c)
      .then(function (j) {
        return { ok: true, local: false, course: c, server: j.data };
      })
      .catch(function (e) {
        return {
          ok: false, local: true, course: c, error: e.message,
          unauthorized: e.status === 401, offline: !!e.offline
        };
      });
  }

  window.CourseStore = {
    DEFAULTS: DEFAULTS,
    EVENT_ID: EVENT_ID,
    blank: blank,
    load: load,
    save: save,
    clear: clear,
    normalize: normalize,
    validate: validate,
    distance: distance,
    recomputeMeta: recomputeMeta,
    toJSON: toJSON,
    fromJSON: fromJSON,
    toGPX: toGPX,
    fromGPX: fromGPX,
    remoteLoad: remoteLoad,
    remoteSave: remoteSave,
    apiAvailable: apiAvailable
  };
})();
