/* 校园定位跑 · 通用工具库 */
(function () {
  'use strict';

  var R = 6371000;

  function rad(d) { return d * Math.PI / 180; }

  /** 两点间距离（米） */
  function dist(a, b) {
    var la1 = rad(a[0]), la2 = rad(b[0]);
    var dla = la2 - la1, dlo = rad(b[1] - a[1]);
    var h = Math.sin(dla / 2) * Math.sin(dla / 2) +
            Math.cos(la1) * Math.cos(la2) * Math.sin(dlo / 2) * Math.sin(dlo / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  /** 折线总长（米） */
  function pathLength(pts) {
    var s = 0;
    for (var i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]);
    return s;
  }

  /** 点是否在多边形内（射线法） */
  function inPolygon(p, poly) {
    var x = p[1], y = p[0], inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var xi = poly[i][1], yi = poly[i][0], xj = poly[j][1], yj = poly[j][0];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  /** 点到线段的距离（米，小范围近似投影） */
  function distToSegment(p, a, b) {
    var kx = Math.cos(rad(p[0])) * 111320;
    var ky = 110540;
    var px = (p[1]) * kx, py = (p[0]) * ky;
    var ax = (a[1]) * kx, ay = (a[0]) * ky;
    var bx = (b[1]) * kx, by = (b[0]) * ky;
    var dx = bx - ax, dy = by - ay;
    var len2 = dx * dx + dy * dy;
    var t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    var cx = ax + t * dx, cy = ay + t * dy;
    return Math.hypot(px - cx, py - cy);
  }

  /** 点到折线的最短距离 */
  function distToPath(p, path) {
    var m = Infinity;
    for (var i = 1; i < path.length; i++) {
      var d = distToSegment(p, path[i - 1], path[i]);
      if (d < m) m = d;
    }
    return m;
  }

  /** 在折线上按比例插值取点 */
  function pointAtRatio(path, ratio) {
    var total = pathLength(path), target = total * Math.max(0, Math.min(1, ratio));
    var acc = 0;
    for (var i = 1; i < path.length; i++) {
      var seg = dist(path[i - 1], path[i]);
      if (acc + seg >= target) {
        var t = seg === 0 ? 0 : (target - acc) / seg;
        return [path[i - 1][0] + (path[i][0] - path[i - 1][0]) * t,
                path[i - 1][1] + (path[i][1] - path[i - 1][1]) * t];
      }
      acc += seg;
    }
    return path[path.length - 1];
  }

  /** 毫米秒 -> 00:00.0 */
  function fmtTime(ms) {
    if (ms == null || isNaN(ms)) return '--:--';
    var t = Math.max(0, ms) / 1000;
    var m = Math.floor(t / 60);
    var s = t - m * 60;
    return pad(m) + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
  }

  /** 毫米秒 -> 1:02:03 */
  function fmtClock(ms) {
    var t = Math.floor(Math.max(0, ms) / 1000);
    var h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : pad(m) + ':' + pad(s);
  }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function fmtDist(m) {
    if (m == null) return '--';
    return m >= 1000 ? (m / 1000).toFixed(2) + ' km' : Math.round(m) + ' m';
  }

  function fmtPace(ms, meters) {
    if (!ms || !meters) return "--'--\"";
    var secPerKm = ms / 1000 / meters * 1000;
    if (secPerKm < 60) return "<1'00\"";   // 演示模拟速度过快时不显示无意义的配速

    var m = Math.floor(secPerKm / 60), s = Math.round(secPerKm % 60);
    if (s === 60) { m++; s = 0; }
    return m + "'" + pad(s) + '"';
  }

  function fmtDate(ts) {
    var d = new Date(ts);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
           ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  /* ---------- 本地存储 ---------- */
  var NS = 'qzsf_run_';
  function save(k, v) {
    try { localStorage.setItem(NS + k, JSON.stringify(v)); } catch (e) {}
  }
  function load(k, def) {
    try {
      var s = localStorage.getItem(NS + k);
      return s ? JSON.parse(s) : def;
    } catch (e) { return def; }
  }
  function remove(k) { try { localStorage.removeItem(NS + k); } catch (e) {} }

  /* ---------- UI ---------- */
  function toast(msg, ms) {
    var el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.classList.remove('show'); }, ms || 1800);
  }

  function haptic(type) {
    if (navigator.vibrate) navigator.vibrate(type === 'ok' ? [40] : [30, 60, 30]);
  }

  function uid(prefix) {
    return (prefix || '') + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  window.U = {
    dist: dist, pathLength: pathLength, inPolygon: inPolygon, distToPath: distToPath,
    pointAtRatio: pointAtRatio, fmtTime: fmtTime, fmtClock: fmtClock, fmtDist: fmtDist,
    fmtPace: fmtPace, fmtDate: fmtDate, save: save, load: load, remove: remove,
    toast: toast, haptic: haptic, uid: uid, pad: pad
  };
})();
