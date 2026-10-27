'use strict';
/* 荧光夜跑 A/B 路线生成器（混合版）
 *
 * 数据来源（按优先级）：
 *   1. OSM 真实校园道路（WGS-84 → GCJ-02），作为主干骨架
 *   2. 手工补齐的走廊（策划书明确要求但 OSM 缺失的段落），标记 inferred
 *
 * 为什么需要补齐：
 *   OSM 在 C区 ↔ 三餐 之间没有横向道路，导致最短路必须南下一餐再北上，
 *   绕行 1970m。策划书明确写「D区→C区→三餐→一餐」，是沿校园北侧主环
 *   由东向西的连续走向。补齐段严格沿高德底图上可见的白色道路，
 *   只是 OSM 未收录，因此标为 inferred 并要求现场核对。
 *
 * 输出：data/night-run-routes-draft.geojson（status: draft）
 */
const fs = require('node:fs');
const path = require('node:path');

/* ---------------- WGS-84 -> GCJ-02 ---------------- */
const PI = Math.PI, AXIS = 6378245.0, EE = 0.00669342162296594323;
function tLat(x, y) {
  let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += (20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2 / 3;
  r += (20 * Math.sin(y * PI) + 40 * Math.sin(y / 3 * PI)) * 2 / 3;
  r += (160 * Math.sin(y / 12 * PI) + 320 * Math.sin(y * PI / 30)) * 2 / 3;
  return r;
}
function tLng(x, y) {
  let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += (20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2 / 3;
  r += (20 * Math.sin(x * PI) + 40 * Math.sin(x / 3 * PI)) * 2 / 3;
  r += (150 * Math.sin(x / 12 * PI) + 300 * Math.sin(x / 30 * PI)) * 2 / 3;
  return r;
}
function wgs2gcj(lng, lat) {
  const dLat = tLat(lng - 105, lat - 35), dLng = tLng(lng - 105, lat - 35);
  const rad = lat / 180 * PI;
  const m = 1 - EE * Math.sin(rad) ** 2, sm = Math.sqrt(m);
  return [
    lng + (dLng * 180) / (AXIS / sm * Math.cos(rad) * PI),
    lat + (dLat * 180) / ((AXIS * (1 - EE)) / (m * sm) * PI)
  ];
}

const distM = (a, b) => {
  const rad = PI / 180;
  const dLat = (b[1] - a[1]) * rad, dLng = (b[0] - a[0]) * rad;
  return Math.hypot(dLng * Math.cos(((a[1] + b[1]) / 2) * rad), dLat) * 6378137;
};

/* ---------------- 1. OSM 道路 ---------------- */
const osm = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../docs/osm-campus-full.json'), 'utf8'));
const BOX = { lng0: 118.6600, lng1: 118.6820, lat0: 24.8600, lat1: 24.8770 };
const KEEP = new Set(['footway', 'service', 'pedestrian', 'unclassified', 'residential', 'steps', 'path', 'living_street']);

const ways = [];
for (const el of osm.elements) {
  if (el.type !== 'way') continue;
  const hw = el.tags && el.tags.highway;
  if (!KEEP.has(hw)) continue;
  const pts = (el.geometry || []).map((p) => wgs2gcj(p.lon, p.lat));
  if (pts.length < 2) continue;
  const inside = pts.filter((p) => p[0] >= BOX.lng0 && p[0] <= BOX.lng1 && p[1] >= BOX.lat0 && p[1] <= BOX.lat1).length;
  if (inside < Math.max(2, pts.length * 0.3)) continue;
  ways.push({ hw, pts, inferred: false, id: `osm-${el.id}` });
}

/* ---------------- 2. 手工补齐走廊（沿底图可见道路，OSM 缺失） ---------------- */
/* 北侧主环：C区 → 三餐，沿学生公寓北侧道路由东向西 */
const PATCH_NORTH_LOOP = {
  hw: 'service', inferred: true, id: 'patch-north-loop',
  note: 'OSM 未收录；沿高德底图可见的校园北侧主环，需现场核对',
  pts: [
    [118.670243, 24.871092], [118.669800, 24.871150], [118.669300, 24.871200],
    [118.668800, 24.871230], [118.668300, 24.871220], [118.667800, 24.871150],
    [118.667300, 24.871050], [118.666999, 24.870703]
  ]
};
/* 一餐 → 第一操场入口：沿校园中部东西向主路，经学生公寓A区北侧 */
const PATCH_MID_EAST = {
  hw: 'service', inferred: true, id: 'patch-mid-east',
  note: 'OSM 缺失段；沿底图可见道路，需现场核对',
  pts: [
    [118.666566, 24.867756], [118.667100, 24.868300], [118.667700, 24.868900],
    [118.668400, 24.869400], [118.669100, 24.869800], [118.669900, 24.870100],
    [118.670700, 24.870300], [118.671400, 24.870500], [118.672000, 24.870800],
    [118.672221, 24.871130]
  ]
};
/* 湖岸走廊：荣茂楼 → 千墅楼 → 音舞湖北岸 → 上坡。
 * OSM 在此处只有零散支路，直接寻路会切过湖面；按底图白色道路补齐。 */
const PATCH_LAKESHORE = {
  hw: 'footway', inferred: true, id: 'patch-lakeshore',
  note: '沿音舞湖北岸与西侧道路；OSM 缺段，需现场核对',
  pts: [
    [118.669150, 24.865334], [118.669231, 24.865067], [118.669480, 24.865080],
    [118.669750, 24.865230], [118.670050, 24.865480], [118.670320, 24.865720],
    [118.670560, 24.865880], [118.670840, 24.865991], [118.671108, 24.865899],
    [118.671377, 24.865772], [118.671645, 24.865880], [118.671913, 24.865987],
    [118.672181, 24.866099], [118.672480, 24.866380], [118.672760, 24.866760],
    [118.673020, 24.867180], [118.673298, 24.868058]
  ]
};
ways.push(PATCH_LAKESHORE);
ways.push(PATCH_NORTH_LOOP, PATCH_MID_EAST);
console.log(`道路 ${ways.length} 段（OSM ${ways.length - 2} + 补齐 2）`);

/* ---------------- 3. 建图 ---------------- */
const nodes = [], adj = [];
function addNode(lng, lat) { nodes.push([lng, lat]); adj.push(new Map()); return nodes.length - 1; }
function link(a, b) {
  if (a === b) return;
  const d = distM(nodes[a], nodes[b]);
  if (!adj[a].has(b) || adj[a].get(b) > d) { adj[a].set(b, d); adj[b].set(a, d); }
}
const SNAP = 18;
for (const way of ways) {
  let prev = null;
  for (const p of way.pts) {
    let idx = -1;
    for (let i = nodes.length - 1; i >= 0 && i >= nodes.length - 900; i--) {
      if (distM(nodes[i], p) < SNAP) { idx = i; break; }
    }
    if (idx < 0) idx = addNode(p[0], p[1]);
    if (prev !== null) link(prev, idx);
    prev = idx;
  }
}
console.log(`路网：${nodes.length} 节点 / ${adj.reduce((s, m) => s + m.size, 0) / 2 | 0} 边`);

/* 把锚点投影到最近的路段上（不只是最近节点），避免因节点稀疏
 * 导致路径绕到远处节点再折返。返回路段两端节点 + 投影点。 */
function nearestEdge(lng, lat) {
  const P = [lng, lat];
  let best = null;
  const seen = new Set();
  for (let a = 0; a < nodes.length; a++) {
    for (const b of adj[a].keys()) {
      const k = a < b ? a + ':' + b : b + ':' + a;
      if (seen.has(k)) continue;
      seen.add(k);
      const A = nodes[a], B = nodes[b];
      const ax = A[0], ay = A[1], bx = B[0], by = B[1];
      // 以米为单位的局部平面投影
      const mx = 111320 * Math.cos(ay * PI / 180), my = 110540;
      const abx = (bx - ax) * mx, aby = (by - ay) * my;
      const apx = (P[0] - ax) * mx, apy = (P[1] - ay) * my;
      const len2 = abx * abx + aby * aby;
      let t = len2 ? (apx * abx + apy * aby) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const qx = ax + (bx - ax) * t, qy = ay + (by - ay) * t;
      const d = distM([qx, qy], P);
      if (!best || d < best.dist) best = { a, b, t, point: [qx, qy], dist: d };
    }
  }
  return best;
}
function dijkstra(s, t) {
  const dist = new Float64Array(nodes.length).fill(Infinity);
  const prev = new Int32Array(nodes.length).fill(-1);
  const done = new Uint8Array(nodes.length);
  dist[s] = 0;
  const heap = [[0, s]];
  const push = (d, i) => {
    heap.push([d, i]); let c = heap.length - 1;
    while (c > 0) { const p = (c - 1) >> 1; if (heap[p][0] <= heap[c][0]) break; [heap[p], heap[c]] = [heap[c], heap[p]]; c = p; }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last; let c = 0;
      for (;;) {
        const l = 2 * c + 1, r = l + 1; let m = c;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === c) break;
        [heap[m], heap[c]] = [heap[c], heap[m]]; c = m;
      }
    }
    return top;
  };
  while (heap.length) {
    const [d, u] = pop();
    if (done[u]) continue;
    done[u] = 1;
    if (u === t) break;
    for (const [v, w] of adj[u]) {
      const nd = d + w;
      if (nd < dist[v]) { dist[v] = nd; prev[v] = u; push(nd, v); }
    }
  }
  if (!done[t]) return null;
  const out = []; let cur = t;
  while (cur !== -1) { out.push(cur); cur = prev[cur]; }
  return out.reverse();
}

/* ---------------- 4. 锚点 ---------------- */
const ANCHORS = {
  start:         { name: '荣茂楼正门口', lng: 118.669150, lat: 24.865334, confidence: 'medium', basis: '高德「荣茂综合楼」南侧临路（px 1085,2800）', todo: '正门朝向与门口确切位置需现场确认' },
  qianshu:       { name: '千墅楼', lng: 118.669231, lat: 24.865067, confidence: 'medium', basis: '高德「苏千墅教学楼」西侧临路（px 1100,2855）', todo: '策划书「千墅楼」是否即「苏千墅教学楼」需确认' },
  yinyue_lake:   { name: '音舞湖尾段 CP1', lng: 118.671645, lat: 24.865880, confidence: 'medium', basis: '音舞湖北岸道路（px 1550,2688），湖尾段', todo: '湖尾具体设点需现场确认' },
  upslope_right: { name: '上坡右转点', lng: 118.672600, lat: 24.867600, confidence: 'low', basis: '策划书「上坡右转」+ 主环路走向', todo: '竞赛组专用，坡道与右转路口必须现场确认' },
  ligong_court:  { name: '理工篮球场', lng: 118.673898, lat: 24.868741, confidence: 'high', basis: '高德「理工篮球场」标注' },
  mingde_gym:    { name: '明德体育馆', lng: 118.673791, lat: 24.870493, confidence: 'high', basis: '高德「明德体育馆」标注' },
  zone_d:        { name: 'D区 CP2', lng: 118.672396, lat: 24.871900, confidence: 'medium', basis: '高德「D区学生生活楼」', todo: '盖章点具体楼栋前需现场确认' },
  zone_c:        { name: 'C区', lng: 118.670797, lat: 24.871301, confidence: 'medium', basis: '高德 C 区公寓群' },
  meal3:         { name: '三餐', lng: 118.666999, lat: 24.870703, confidence: 'high', basis: '高德「第3食堂」标注' },
  meal1:         { name: '一餐', lng: 118.666297, lat: 24.868104, confidence: 'high', basis: '高德「第1食堂」标注' },
  track_gate:    { name: '第一操场入口 CP3', lng: 118.672171, lat: 24.871116, confidence: 'medium', basis: '卫星图 400m 田径场西侧入口', todo: '入口与盖章点具体位置需现场确认' },
  track_side:    { name: '第一操场侧门 终点', lng: 118.672814, lat: 24.869948, confidence: 'medium', basis: '卫星图 400m 田径场南侧出入口', todo: '侧门朝向需现场确认' },
  library:       { name: '俊秀图书馆', lng: 118.670500, lat: 24.866500, confidence: 'high', basis: '高德「俊秀图书馆」建筑群' },
  auditorium:    { name: '陈祖昌大礼堂', lng: 118.671300, lat: 24.866900, confidence: 'medium', basis: '高德「陈祖昌大礼堂」标注', todo: '入口位置需现场确认' },
  bell_tower:    { name: '钟楼 CP2', lng: 118.668855, lat: 24.865699, confidence: 'high', basis: '高德「陈明玉钟楼」POI + 南侧道路', todo: '盖章点设在钟楼前，具体点位需现场确认' },
  sun_yatsen:    { name: '孙中山纪念堂', lng: 118.668748, lat: 24.865724, confidence: 'high', basis: '高德「孙中山纪念堂」POI + 南侧道路' },
  liberal_arts:  { name: '文科楼', lng: 118.668300, lat: 24.866300, confidence: 'low', basis: '按「黄朝阳教学楼」一带推断', todo: '「文科楼」对应哪栋需现场确认' }
};

const A_SEQ = ['start', 'qianshu', 'yinyue_lake', 'upslope_right', 'ligong_court', 'mingde_gym', 'zone_d', 'zone_c', 'meal3', 'meal1', 'track_gate', 'track_side'];
const B_SEQ = ['start', 'qianshu', 'yinyue_lake', 'library', 'auditorium', 'bell_tower', 'sun_yatsen', 'liberal_arts', 'track_gate', 'track_side'];

/* ---------------- 5. 生成 ---------------- */
function build(seq, label) {
  const points = [];
  const legs = [];
  let prev = null; // {edge, nodeIdx}
  for (let i = 0; i < seq.length; i++) {
    const a = ANCHORS[seq[i]];
    const edge = nearestEdge(a.lng, a.lat);
    if (i === 0) {
      points.push([a.lng, a.lat]);
      if (edge.dist > 3) points.push(edge.point.map((v) => Number(v.toFixed(7))));
      // 起点落在边中间时，从边的两个端点都能出发，选更近的那端
      prev = { edge, entry: edge.t <= 0.5 ? edge.a : edge.b };
      continue;
    }
    // 目标：从边的哪一端进入更近
    const targets = edge.t <= 0.5 ? [edge.a, edge.b] : [edge.b, edge.a];
    let bestPath = null, bestLen = Infinity, bestEnd = null;
    for (const tNode of targets) {
      const pathIdx = dijkstra(prev.entry, tNode);
      if (!pathIdx) continue;
      let len = 0;
      for (let j = 1; j < pathIdx.length; j++) len += distM(nodes[pathIdx[j - 1]], nodes[pathIdx[j]]);
      // 加上从入口锚点到首个路网节点的距离
      if (len < bestLen) { bestLen = len; bestPath = pathIdx; bestEnd = tNode; }
    }
    if (!bestPath) {
      legs.push({ from: seq[i - 1], to: seq[i], ok: false });
      points.push([a.lng, a.lat]);
      prev = { edge, entry: targets[0] };
      continue;
    }
    for (let j = 1; j < bestPath.length; j++) {
      const n = nodes[bestPath[j]];
      points.push([Number(n[0].toFixed(7)), Number(n[1].toFixed(7))]);
    }
    // 收尾：从路网节点走到锚点投影，再到锚点
    if (edge.dist > 3) points.push(edge.point.map((v) => Number(v.toFixed(7))));
    points.push([a.lng, a.lat]);
    legs.push({ from: seq[i - 1], to: seq[i], ok: true, lengthM: Math.round(bestLen), snapM: Math.round(edge.dist) });
    prev = { edge, entry: edge.t <= 0.5 ? edge.a : edge.b };
  }
  const total = legs.reduce((s2, l) => s2 + (l.lengthM || 0), 0);
  console.log(`
[${label}] ${points.length} 点 / ${total} m`);
  legs.forEach((l) => console.log(`   ${l.from} → ${l.to}  ${l.ok ? l.lengthM + 'm (snap ' + l.snapM + 'm)' : '不连通'}`));
  return { points, legs, distanceM: total };
}
/* 清理路径毛刺：删重复点、去掉锚点处的进出折返。
 * 打卡点附近 12m 内的点必须保留（它们就是盖章位置）。 */
function cleanPath(pts, protect) {
  const isProtected = (q) => protect.some((cp) => distM(cp, q) < 12);
  let out = [];
  for (const q of pts) if (!out.length || distM(out[out.length - 1], q) > 1.5) out.push(q);
  for (let pass = 0; pass < 6; pass++) {
    const keep = [out[0]];
    for (let i = 1; i < out.length - 1; i++) {
      const a = keep[keep.length - 1], b = out[i], c = out[i + 1];
      if (isProtected(b)) { keep.push(b); continue; }
      const v1 = [(b[0] - a[0]) * Math.cos(b[1] * PI / 180), b[1] - a[1]];
      const v2 = [(c[0] - b[0]) * Math.cos(b[1] * PI / 180), c[1] - b[1]];
      const n1 = Math.hypot(v1[0], v1[1]), n2 = Math.hypot(v2[0], v2[1]);
      if (n1 < 1e-9) continue;
      const dot = n1 > 0 && n2 > 0 ? (v1[0] * v2[0] + v1[1] * v2[1]) / (n1 * n2) : 1;
      if (dot < -0.4 && distM(a, b) + distM(b, c) > distM(a, c) * 1.6) continue;
      keep.push(b);
    }
    keep.push(out[out.length - 1]);
    if (keep.length === out.length) break;
    out = keep;
  }
  return out;
}

const A = build(A_SEQ, 'A 竞赛组');
const B = build(B_SEQ, 'B 体验/同心');
for (const [r, key] of [[A, 'A'], [B, 'B']]) {
  const cps = (key === 'A'
    ? [ANCHORS.yinyue_lake, ANCHORS.zone_d, ANCHORS.track_gate]
    : [ANCHORS.yinyue_lake, ANCHORS.bell_tower, ANCHORS.track_gate]).map((a) => [a.lng, a.lat]);
  const before = r.points.length;
  r.points = cleanPath(r.points, cps);
  r.distanceM = Math.round(r.points.reduce((s2, q, i) => i ? s2 + distM(r.points[i - 1], q) : 0, 0));
  console.log(`  ${key} 清理：${before} → ${r.points.length} 点，${r.distanceM} m`);
}

const out = {
  type: 'FeatureCollection', crs: 'GCJ-02', status: 'draft',
  generatedAt: new Date().toISOString(),
  method: 'OSM 真实校园道路（WGS-84→GCJ-02）+ Dijkstra；OSM 缺失段按底图可见道路补齐并标 inferred',
  disclaimer: '所有 medium/low 锚点与 inferred 段必须现场走测确认后才能发布。',
  anchors: ANCHORS,
  routes: {
    A: {
      key: 'A', name: '竞赛组 · 疾风红线', color: '#ef4444', groups: ['competition'],
      distanceM: A.distanceM, points: A.points, legs: A.legs,
      checkpoints: [
        { id: 'CP1', order: 1, name: '音舞湖尾段 · 荧光套圈', lnglat: [ANCHORS.yinyue_lake.lng, ANCHORS.yinyue_lake.lat], radius: 30, required: true, methods: ['manual'], confidence: 'medium' },
        { id: 'CP2', order: 2, name: 'D区 · 荧光球入筐', lnglat: [ANCHORS.zone_d.lng, ANCHORS.zone_d.lat], radius: 30, required: true, methods: ['manual'], confidence: 'medium' },
        { id: 'CP3', order: 3, name: '第一操场入口 · 荧光猜拳', lnglat: [ANCHORS.track_gate.lng, ANCHORS.track_gate.lat], radius: 30, required: true, methods: ['manual'], confidence: 'medium' }
      ]
    },
    B: {
      key: 'B', name: '体验组 / 同心组 · 友情蓝线', color: '#2563eb', groups: ['experience', 'unity'],
      distanceM: B.distanceM, points: B.points, legs: B.legs,
      checkpoints: [
        { id: 'CP1', order: 1, name: '音舞湖尾段 · 荧光套圈', lnglat: [ANCHORS.yinyue_lake.lng, ANCHORS.yinyue_lake.lat], radius: 30, required: true, methods: ['manual'], confidence: 'medium' },
        { id: 'CP2', order: 2, name: '钟楼 · 荧光球入筐', lnglat: [ANCHORS.bell_tower.lng, ANCHORS.bell_tower.lat], radius: 30, required: true, methods: ['manual'], confidence: 'high' },
        { id: 'CP3', order: 3, name: '第一操场入口 · 荧光猜拳', lnglat: [ANCHORS.track_gate.lng, ANCHORS.track_gate.lat], radius: 30, required: true, methods: ['manual'], confidence: 'medium' }
      ]
    }
  }
};
const target = path.resolve(__dirname, '../../data/night-run-routes-draft.geojson');
fs.writeFileSync(target, JSON.stringify(out));
console.log(`\nB/A = ${(B.distanceM / A.distanceM).toFixed(2)}  已写入 ${target}`);
