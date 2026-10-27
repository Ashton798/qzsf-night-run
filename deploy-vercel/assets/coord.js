/* 坐标系统
 *
 * 三种坐标系：
 *   WGS84  —— GPS 原始数据、GPX 标准、国际通用
 *   GCJ02  —— 高德地图、腾讯地图（国测局加密）
 *   BD09   —— 百度地图
 *
 * 铁律：
 *   1. 每份数据必须自带 crs 标记，不能靠"约定俗成"
 *   2. 转换必须幂等可判断 —— 已转换的不能再转（否则偏移约 500m）
 *   3. 原始坐标必须保留，转换结果另存
 *
 * 本项目约定：
 *   - GPS 采集 → 原始 WGS84 存 raw，转换后 GCJ02 存 display
 *   - 管理员在地图上画的 → 本身就是 GCJ02，标记 crs:'gcj02'
 *   - GPX 导出 → 必须转回 WGS84
 */
(function () {
  'use strict';

  var PI = Math.PI;
  var A = 6378245.0;                 // 克拉索夫斯基椭球长半轴
  var EE = 0.00669342162296594323;   // 偏心率平方
  var X_PI = PI * 3000.0 / 180.0;

  function outOfChina(lat, lng) {
    return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
  }

  function transformLat(x, y) {
    var ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(y * PI) + 40.0 * Math.sin(y / 3.0 * PI)) * 2.0 / 3.0;
    ret += (160.0 * Math.sin(y / 12.0 * PI) + 320 * Math.sin(y * PI / 30.0)) * 2.0 / 3.0;
    return ret;
  }

  function transformLng(x, y) {
    var ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(x * PI) + 40.0 * Math.sin(x / 3.0 * PI)) * 2.0 / 3.0;
    ret += (150.0 * Math.sin(x / 12.0 * PI) + 300.0 * Math.sin(x / 30.0 * PI)) * 2.0 / 3.0;
    return ret;
  }

  /* WGS84 → GCJ02，返回 [lat, lng] */
  function wgs2gcj(lat, lng) {
    if (outOfChina(lat, lng)) return [lat, lng];
    var dLat = transformLat(lng - 105.0, lat - 35.0);
    var dLng = transformLng(lng - 105.0, lat - 35.0);
    var radLat = lat / 180.0 * PI;
    var magic = Math.sin(radLat);
    magic = 1 - EE * magic * magic;
    var sqrtMagic = Math.sqrt(magic);
    dLat = (dLat * 180.0) / ((A * (1 - EE)) / (magic * sqrtMagic) * PI);
    dLng = (dLng * 180.0) / (A / sqrtMagic * Math.cos(radLat) * PI);
    return [lat + dLat, lng + dLng];
  }

  /* GCJ02 → WGS84，迭代逼近（精度 < 0.5m），返回 [lat, lng]
   * 注意：不能简单减去偏移量，必须迭代，否则误差可达 5-10m
   */
  function gcj2wgs(lat, lng) {
    if (outOfChina(lat, lng)) return [lat, lng];
    var wLat = lat, wLng = lng;
    for (var i = 0; i < 12; i++) {
      var g = wgs2gcj(wLat, wLng);
      var dLat = g[0] - lat;
      var dLng = g[1] - lng;
      wLat -= dLat;
      wLng -= dLng;
      if (Math.abs(dLat) < 1e-10 && Math.abs(dLng) < 1e-10) break;
    }
    return [wLat, wLng];
  }

  /* GCJ02 → BD09 */
  function gcj2bd(lat, lng) {
    var z = Math.sqrt(lng * lng + lat * lat) + 0.00002 * Math.sin(lat * X_PI);
    var theta = Math.atan2(lat, lng) + 0.000003 * Math.cos(lng * X_PI);
    return [z * Math.sin(theta) + 0.006, z * Math.cos(theta) + 0.0065];
  }

  /* BD09 → GCJ02 */
  function bd2gcj(lat, lng) {
    var x = lng - 0.0065, y = lat - 0.006;
    var z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin(y * X_PI);
    var theta = Math.atan2(y, x) - 0.000003 * Math.cos(x * X_PI);
    return [z * Math.sin(theta), z * Math.cos(theta)];
  }

  /* ---------- 通用转换 ---------- */

  var ALIAS = {
    wgs84: 'wgs84', wgs: 'wgs84', gps: 'wgs84', epsg4326: 'wgs84',
    gcj02: 'gcj02', gcj: 'gcj02', amap: 'gcj02', mars: 'gcj02',
    bd09: 'bd09', bd: 'bd09', baidu: 'bd09'
  };

  function normalizeCrs(crs) {
    return ALIAS[String(crs || '').toLowerCase()] || 'gcj02';
  }

  /* 单点转换，输入输出都是 [lat, lng] */
  function convert(lat, lng, from, to) {
    var f = normalizeCrs(from), t = normalizeCrs(to);
    if (f === t) return [lat, lng];          // 同坐标系绝不重复转换

    // 先归一到 GCJ02
    var g;
    if (f === 'wgs84') g = wgs2gcj(lat, lng);
    else if (f === 'bd09') g = bd2gcj(lat, lng);
    else g = [lat, lng];

    // 再从 GCJ02 转到目标
    if (t === 'wgs84') return gcj2wgs(g[0], g[1]);
    if (t === 'bd09') return gcj2bd(g[0], g[1]);
    return g;
  }

  /* 数组批量转换，元素 [lat, lng] */
  function convertAll(pts, from, to) {
    if (normalizeCrs(from) === normalizeCrs(to)) return pts.slice();
    return pts.map(function (p) { return convert(p[0], p[1], from, to); });
  }

  /* [lng, lat] ↔ [lat, lng] */
  function flip(p) { return [p[1], p[0]]; }

  /* 给点附加坐标系标记：{ lat, lng, crs, accuracy, ts, ... } */
  function tagged(lat, lng, crs, extra) {
    return Object.assign({
      lat: lat, lng: lng, crs: normalizeCrs(crs)
    }, extra || {});
  }

  /* 判断一个坐标是否"看起来像"已被 GCJ02 加密过
   * 原理：WGS→GCJ 的偏移量在中国境内约 0.002~0.006 度，且方向固定（东北）
   * 用途：导入外部数据时给出提示，不做自动修改
   */
  function detectCrs(lat, lng, referenceGcj) {
    if (!referenceGcj) return { crs: 'unknown', confidence: 0 };
    var asGcj = [lat, lng];
    var dGcj = haversine(asGcj, referenceGcj);
    var asWgs = wgs2gcj(lat, lng);
    var dWgs = haversine(asWgs, referenceGcj);
    if (dWgs < dGcj * 0.5) return { crs: 'wgs84', confidence: 1 - dWgs / Math.max(dGcj, 1) };
    return { crs: 'gcj02', confidence: 1 - dGcj / Math.max(dWgs, 1) };
  }

  /* 球面距离（米），输入 [lat, lng] */
  var R = 6378137;
  function haversine(a, b) {
    var rad = PI / 180;
    var dLat = (b[0] - a[0]) * rad;
    var dLng = (b[1] - a[1]) * rad;
    var mLat = ((a[0] + b[0]) / 2) * rad;
    var x = dLng * Math.cos(mLat);
    return Math.sqrt(x * x + dLat * dLat) * R;
  }

  /* 折线长度（米） */
  function pathLength(pts) {
    var s = 0;
    for (var i = 1; i < pts.length; i++) s += haversine(pts[i - 1], pts[i]);
    return s;
  }

  window.Coord = {
    // 单点转换
    wgs2gcj: wgs2gcj,
    gcj2wgs: gcj2wgs,
    gcj2bd: gcj2bd,
    bd2gcj: bd2gcj,
    convert: convert,
    convertAll: convertAll,

    // 工具
    normalizeCrs: normalizeCrs,
    detectCrs: detectCrs,
    flip: flip,
    tagged: tagged,
    haversine: haversine,
    pathLength: pathLength,
    outOfChina: outOfChina,

    // 兼容旧代码
    arr: function (pts) { return convertAll(pts, 'wgs84', 'gcj02'); }
  };
})();
