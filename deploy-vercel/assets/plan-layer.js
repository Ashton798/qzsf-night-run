/* 校园规划参考图 —— 数据层
 *
 * ⚠️ 重要定位说明（务必阅读）
 *
 * 这张图是「实体沙盘模型的照片」，不是测绘成果。经实测比对：
 *   - 与真实高德卫星图做相似变换拟合，RMS 残差 124 米，最大 148 米
 *   - 沙盘是规划方案，与现状有出入（绿地/道路大量不符）
 *   - 斜拍导致建筑有立体侧面，透视校正无法消除
 *
 * 因此本模块的定位是：
 *   「参考图层」—— 用来辅助理解校园布局，绝不能当作测绘底图
 *
 * 强制约束：
 *   1. 配准精度等级固定标记为 'reference'（参考级），不提供 'survey' 选项
 *   2. 正式路线必须来自 GPS 实测 + 现场核验，与参考图无关
 *   3. UI 上始终显示醒目提示
 *
 * 数据模型：
 * {
 *   version: 1,
 *   enabled: true,
 *   image: { src, width, height, source: 'model-board', capturedAt },
 *   // 图像像素坐标 → GCJ-02 经纬度的仿射变换
 *   // 用 4 个控制点求解（相似变换：缩放+旋转+平移+可选切变）
 *   transform: { a, b, tx, ty },   // [lng,lat] = [a*x - b*y + tx, b*x + a*y + ty]
 *   controlPoints: [
 *     { id, imageX, imageY, lng, lat, label, errorM }
 *   ],
 *   precision: 'reference',        // 固定值，不可改为 survey
 *   rmsErrorM: 0,                  // 拟合残差（米）
 *   opacity: 0.55,
 *   updatedAt: 0
 * }
 */
(function () {
  'use strict';

  var U = window.U;
  var KEY = 'campus_plan_layer_v1';

  var DEFAULTS = {
    version: 1,
    enabled: false,
    image: {
      src: 'data/assets/campus-plan.jpg',
      width: 1247,
      height: 1161,
      source: 'model-board',
      note: '实体沙盘模型照片，经透视校正与裁剪'
    },
    transform: null,
    controlPoints: [],
    precision: 'reference',
    rmsErrorM: 0,
    maxErrorM: 0,
    opacity: 0.55,
    updatedAt: 0
  };

  /* ---------- 读写 ---------- */
  function load() {
    var raw = U.load(KEY, null);
    if (!raw) return JSON.parse(JSON.stringify(DEFAULTS));
    var c = Object.assign({}, DEFAULTS, raw);
    c.image = Object.assign({}, DEFAULTS.image, raw.image || {});
    c.controlPoints = raw.controlPoints || [];
    // 强制：精度等级只能是 reference
    c.precision = 'reference';
    return c;
  }

  function save(state) {
    var c = Object.assign({}, state);
    c.precision = 'reference';          // 强制
    c.updatedAt = Date.now();
    U.save(KEY, c);
    return c;
  }

  function reset() {
    U.remove(KEY);
    return load();
  }

  /* ---------- 相似变换求解 ----------
   * 已知 N 个控制点 (u,v) 图像像素 → (lng,lat) 经纬度
   * 求 a,b,tx,ty 使：
   *   lng = a*u - b*v + tx
   *   lat = b*u + a*v + ty
   *
   * 这是 4 参数相似变换（等比缩放 + 旋转 + 平移），不引入切变，
   * 避免用过度自由的变换强行"贴合"而造成局部严重扭曲。
   */
  function solveTransform(points) {
    var valid = (points || []).filter(function (p) {
      return isFinite(p.imageX) && isFinite(p.imageY) && isFinite(p.lng) && isFinite(p.lat);
    });
    if (valid.length < 2) return { ok: false, error: '至少需要 2 个控制点' };

    // 最小二乘：A * [a,b,tx,ty]^T = B
    // 每点两行：
    //   [ u, -v, 1, 0 ] [a]   [lng]
    //   [ v,  u, 0, 1 ] [b] = [lat]
    //                  [tx]
    //                  [ty]
    var A = [], B = [];
    valid.forEach(function (p) {
      A.push([p.imageX, -p.imageY, 1, 0]); B.push(p.lng);
      A.push([p.imageY,  p.imageX, 0, 1]); B.push(p.lat);
    });

    var sol = lstsq(A, B);
    if (!sol) return { ok: false, error: '控制点分布过于集中，无法求解' };

    var a = sol[0], b = sol[1], tx = sol[2], ty = sol[3];
    var k = Math.hypot(a, b);
    var rotDeg = Math.atan2(b, a) * 180 / Math.PI;

    // 残差（米）
    var R = 6378137, rad = Math.PI / 180;
    function toMeters(dLng, dLat, lat) {
      var x = dLng * rad * Math.cos(lat * rad) * R;
      var y = dLat * rad * R;
      return Math.hypot(x, y);
    }

    var errs = [];
    valid.forEach(function (p) {
      var pred = applyTransform({ a: a, b: b, tx: tx, ty: ty }, p.imageX, p.imageY);
      var e = toMeters(pred[0] - p.lng, pred[1] - p.lat, p.lat);
      errs.push({ id: p.id, label: p.label, errorM: e });
      p.errorM = e;
    });

    var rms = Math.sqrt(errs.reduce(function (s, e) { return s + e.errorM * e.errorM; }, 0) / errs.length);
    var maxE = Math.max.apply(null, errs.map(function (e) { return e.errorM; }));

    return {
      ok: true,
      transform: { a: a, b: b, tx: tx, ty: ty },
      scale: k,
      rotationDeg: rotDeg,
      rmsErrorM: rms,
      maxErrorM: maxE,
      residuals: errs,
      count: valid.length
    };
  }

  /* 最小二乘（正规方程 + 高斯消元） */
  function lstsq(A, B) {
    var n = A[0].length;
    // AtA = A^T A, AtB = A^T B
    var AtA = [], AtB = [];
    for (var i = 0; i < n; i++) {
      AtA.push(new Array(n).fill(0));
      AtB.push(0);
    }
    for (var r = 0; r < A.length; r++) {
      for (var i = 0; i < n; i++) {
        AtB[i] += A[r][i] * B[r];
        for (var j = 0; j < n; j++) AtA[i][j] += A[r][i] * A[r][j];
      }
    }
    return gauss(AtA, AtB);
  }

  function gauss(M, v) {
    var n = v.length;
    var m = M.map(function (row, i) { return row.concat([v[i]]); });
    for (var c = 0; c < n; c++) {
      // 选主元
      var piv = c;
      for (var r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[piv][c])) piv = r;
      if (Math.abs(m[piv][c]) < 1e-12) return null;
      var t = m[c]; m[c] = m[piv]; m[piv] = t;
      // 消元
      for (var r2 = 0; r2 < n; r2++) {
        if (r2 === c) continue;
        var f = m[r2][c] / m[c][c];
        for (var k = c; k <= n; k++) m[r2][k] -= f * m[c][k];
      }
    }
    var out = [];
    for (var i = 0; i < n; i++) out.push(m[i][n] / m[i][i]);
    return out;
  }

  /* 图像像素 → 经纬度 */
  function applyTransform(tf, x, y) {
    if (!tf) return null;
    return [
      tf.a * x - tf.b * y + tf.tx,
      tf.b * x + tf.a * y + tf.ty
    ];
  }

  /* 经纬度 → 图像像素（逆变换） */
  function inverseTransform(tf, lng, lat) {
    if (!tf) return null;
    var k2 = tf.a * tf.a + tf.b * tf.b;
    if (k2 < 1e-20) return null;
    var dx = lng - tf.tx;
    var dy = lat - tf.ty;
    return [
      (tf.a * dx + tf.b * dy) / k2,
      (-tf.b * dx + tf.a * dy) / k2
    ];
  }

  /* ---------- 配准质量评估 ---------- */
  function gradeRegistration(rms) {
    // 注意：即使 rms 很小，也只是"图像自身拟合得好"，
    // 不代表沙盘与现状一致。这里只评估拟合质量，不代表测绘精度。
    if (!isFinite(rms)) return { level: 'none', text: '未配准', cls: 'bad' };
    if (rms <= 15) return { level: 'good', text: '拟合良好（' + rms.toFixed(0) + 'm）', cls: 'ok' };
    if (rms <= 40) return { level: 'fair', text: '拟合一般（' + rms.toFixed(0) + 'm）', cls: 'warn' };
    if (rms <= 100) return { level: 'poor', text: '拟合较差（' + rms.toFixed(0) + 'm）', cls: 'warn' };
    return { level: 'bad', text: '拟合很差（' + rms.toFixed(0) + 'm）', cls: 'bad' };
  }

  /* 对外统一的精度声明（无论拟合多好，都不改这句话） */
  var DISCLAIMER =
    '本图层是实体沙盘模型照片，属于规划示意，不是测绘成果。' +
    '实测与高德卫星图比对，整体偏差约 100–150 米。' +
    '仅可用于辅助理解校园布局，禁止作为比赛路线依据。' +
    '正式路线必须使用 GPS 实测坐标并经管理员现场核验。';

  window.CampusPlanLayer = {
    DEFAULTS: DEFAULTS,
    DISCLAIMER: DISCLAIMER,
    load: load,
    save: save,
    reset: reset,
    solveTransform: solveTransform,
    applyTransform: applyTransform,
    inverseTransform: inverseTransform,
    gradeRegistration: gradeRegistration
  };
})();
