'use strict';
/* 路线贴合优化：把每个途经点吸附到高德底图上最近的“白色道路像素”中心线
 *
 * 为什么需要：
 *   OSM 节点稀疏，Dijkstra 走的是节点间的直线，在弯道会切角、
 *   在建筑密集处会压到楼边。本脚本按底图道路像素做一次精细吸附，
 *   把每个点拉到道路中心线上。
 *
 * 保护：起点、终点、三个盖章点位置不移动（它们是业务锚点）。
 *
 * 用法：node server/scripts/snap-routes.js [--dry]
 */
const fs = require('node:fs');
const path = require('node:path');
const { PNG } = (() => { try { return require('pngjs'); } catch (_) { return {}; } })();

const DRY = process.argv.includes('--dry');
const CAL = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../docs/campus-wide-cal.json'), 'utf8'));
const PNG_PATH = path.resolve(__dirname, '../../docs/campus-wide-z18.png');
const SRC = path.resolve(__dirname, '../../data/night-run-routes-draft.geojson');

/* 纯 Node 读 PNG 需要解码；这里改用最简单可靠的方式：
 * 直接调用系统 python 生成道路掩膜的采样网格（见 ensureMask），
 * 避免引入新依赖。若 pngjs 不可用则跳过吸附并提示。 */
function ll2px(lng, lat) {
  const n = 2 ** CAL.z;
  const x = (lng + 180) / 360 * n;
  const la = (lat * Math.PI) / 180;
  const y = (1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2 * n;
  return [(x - CAL.x0) * 256, (y - CAL.y0) * 256];
}
function px2ll(px, py) {
  const n = 2 ** CAL.z;
  const x = CAL.x0 + px / 256, y = CAL.y0 + py / 256;
  return [
    Number((x / n * 360 - 180).toFixed(7)),
    Number((Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI).toFixed(7))
  ];
}

const MASK_PATH = path.resolve(__dirname, '../../docs/road-mask.bin');
const META_PATH = path.resolve(__dirname, '../../docs/road-mask-meta.json');
if (!fs.existsSync(MASK_PATH) || !fs.existsSync(META_PATH)) {
  console.error('缺少道路掩膜，请先运行：python tools/make-road-mask.py');
  process.exit(1);
}
const meta = JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
const mask = fs.readFileSync(MASK_PATH);
const W = meta.w, H = meta.h;
const at = (x, y) => (x >= 0 && y >= 0 && x < W && y < H) ? mask[y * W + x] : 0;

/* 在半径 r 内找最近的“粗道路”像素（道路宽度>=5px，避开文字） */
function snapPoint(lng, lat, r) {
  const [px, py] = ll2px(lng, lat);
  const cx = Math.round(px), cy = Math.round(py);
  let best = null;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const d2 = dx * dx + dy * dy;
      if (d2 > r * r) continue;
      if (!at(cx + dx, cy + dy)) continue;
      if (!best || d2 < best.d2) best = { d2, x: cx + dx, y: cy + dy };
    }
  }
  if (!best) return null;
  return px2ll(best.x, best.y);
}

const geo = JSON.parse(fs.readFileSync(SRC, 'utf8'));
let moved = 0, kept = 0, missed = 0;

for (const key of ['A', 'B']) {
  const r = geo.routes[key];
  const protect = [r.points[0], r.points[r.points.length - 1], ...r.checkpoints.map((c) => c.lnglat)];
  const near = (p, list, tol) => list.some((q) => {
    const [ax, ay] = ll2px(p[0], p[1]), [bx, by] = ll2px(q[0], q[1]);
    return Math.hypot(ax - bx, ay - by) <= tol;
  });
  const out = r.points.map((p, i) => {
    if (near(p, protect, 6)) { kept++; return p; }
    const s = snapPoint(p[0], p[1], 14);
    if (!s) { missed++; return p; }
    const [ax, ay] = ll2px(p[0], p[1]), [bx, by] = ll2px(s[0], s[1]);
    if (Math.hypot(ax - bx, ay - by) > 0.3) moved++;
    return s;
  });
  r.points = out;
  // 重算距离
  const rad = Math.PI / 180;
  let sum = 0;
  for (let i = 1; i < out.length; i++) {
    const a = out[i - 1], b = out[i];
    const dLat = (b[1] - a[1]) * rad, dLng = (b[0] - a[0]) * rad;
    sum += Math.hypot(dLng * Math.cos(((a[1] + b[1]) / 2) * rad), dLat) * 6378137;
  }
  r.distanceM = Math.round(sum);
  console.log(`${key}: ${out.length} 点，吸附后 ${r.distanceM} m`);
}
console.log(`移动 ${moved} 点，保护 ${kept} 点，未找到道路 ${missed} 点`);
if (!DRY) {
  fs.writeFileSync(SRC, JSON.stringify(geo));
  console.log('已写入', SRC);
}
