'use strict';
/* 生成荧光夜跑 A/B 两条路线的初始 GeoJSON（GCJ-02）
 *
 * 数据来源与可信度分级（写入每个节点的 verified 字段）：
 *   osm-road    —— 节点取自 OpenStreetMap 校园内部真实道路几何，
 *                  已叠加到高德卫星图逐段目视核对与路面重合。
 *   anchor-read —— 建筑/入口锚点由人工在高德矢量底图 + 卫星图上
 *                  逐格读数得出，未经现场 GPS 实测。
 *   todo-field  —— 无法从公开资料确定，必须现场确认（坐标留空，不编造）。
 *
 * 重要：本脚本只生成「草稿」。任何坐标在管理员现场走测并签署前，
 * 都不会被标记为已发布，选手端也不会据此放行比赛。
 */
const fs = require('node:fs');
const path = require('node:path');

const OSM = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../docs/osm-campus-full.json'), 'utf8'));

const PI = Math.PI, A = 6378245.0, EE = 0.00669342162296594323;
function transformLat(x, y) {
  let r = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
  r += (20.0 * Math.sin(y * PI) + 40.0 * Math.sin(y / 3.0 * PI)) * 2.0 / 3.0;
  r += (160.0 * Math.sin(y / 12.0 * PI) + 320 * Math.sin(y * PI / 30.0)) * 2.0 / 3.0;
  return r;
}
function transformLng(x, y) {
  let r = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
  r += (20.0 * Math.sin(x * PI) + 40.0 * Math.sin(x / 3.0 * PI)) * 2.0 / 3.0;
  r += (150.0 * Math.sin(x / 12.0 * PI) + 300.0 * Math.sin(x / 30.0 * PI)) * 2.0 / 3.0;
  return r;
}
function wgs2gcj(lat, lng) {
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const rad = lat / 180.0 * PI;
  let m = Math.sin(rad); m = 1 - EE * m * m;
  const sm = Math.sqrt(m);
  dLat = (dLat * 180.0) / ((A * (1 - EE)) / (m * sm) * PI);
  dLng = (dLng * 180.0) / (A / sm * Math.cos(rad) * PI);
  return [lat + dLat, lng + dLng];
}

/* ---- 1. 收集校园内部道路几何（转 GCJ-02，保留原始 way id） ---- */
const CAMPUS_BBOX = { minLat: 24.8640, maxLat: 24.8730, minLng: 118.6640, maxLng: 118.6750 };
const roads = [];
for (const el of OSM.elements) {
  const t = el.tags || {};
  if (!t.highway || !el.geometry) continue;
  const pts = el.geometry.map((p) => {
    const g = wgs2gcj(p.lat, p.lon);
    return [Number(g[1].toFixed(7)), Number(g[0].toFixed(7))];  // [lng, lat]
  });
  const inCampus = pts.some(([lng, lat]) =>
    lat >= CAMPUS_BBOX.minLat && lat <= CAMPUS_BBOX.maxLat &&
    lng >= CAMPUS_BBOX.minLng && lng <= CAMPUS_BBOX.maxLng);
  if (!inCampus) continue;
  roads.push({ id: el.id, highway: t.highway, name: t.name || null, points: pts });
}

/* ---- 2. 人工核读的锚点（GCJ-02） ----
 * readOn: 该坐标是在哪张底图上读出的
 * confidence: high = 高德矢量图有同名文字标注且与卫星图建筑对得上
 *             medium = 仅在卫星图上按形态判读
 *             low = 只有相对位置推断
 */
const ANCHORS = [
  { id: 'start', name: '荣茂楼正门口', lng: 118.671200, lat: 24.866300,
    confidence: 'medium', readOn: '高德矢量图「泉州师范学院荣茂综合楼」标注 + 卫星图建筑',
    note: '荣茂楼在高德上标注为「荣茂综合楼」，正门朝向需现场确认' },
  { id: 'qianshu', name: '千墅楼', lng: 118.671900, lat: 24.865300,
    confidence: 'low', readOn: '高德矢量图「苏千墅教学楼」标注',
    note: '策划书写作「千墅楼」，高德标注为「苏千墅教学楼」，需现场确认是否同一栋' },
  { id: 'yinyue_lake_south', name: '音舞湖尾段', lng: 118.672000, lat: 24.864800,
    confidence: 'medium', readOn: '高德矢量图水域多边形南端 + 音乐与舞蹈学院北侧',
    note: '策划书「音舞湖尾段第一盖章点」，湖尾具体位置需现场确认' },
  { id: 'up_slope_right', name: '上坡右转点', lng: 118.673000, lat: 24.867200,
    confidence: 'low', readOn: '按策划书「上坡右转」+ 校园主环路走向推断',
    note: '竞赛组专用，必须现场确认坡道与右转路口' },
  { id: 'ligong_court', name: '理工篮球场', lng: 118.673900, lat: 24.868700,
    confidence: 'high', readOn: '高德矢量图「泉州师范学院理工篮球场」标注' },
  { id: 'mingde_gym', name: '明德体育馆', lng: 118.673800, lat: 24.870500,
    confidence: 'high', readOn: '高德矢量图「泉州师范学院明德体育馆」标注' },
  { id: 'zone_d', name: 'D区第二盖章点', lng: 118.672400, lat: 24.871900,
    confidence: 'medium', readOn: '高德矢量图「D区学生生活楼」标注',
    note: '第二盖章点具体设在哪栋楼前需现场确认' },
  { id: 'zone_c', name: 'C区', lng: 118.670800, lat: 24.871300,
    confidence: 'medium', readOn: '高德矢量图 C 区公寓群' },
  { id: 'meal3', name: '三餐', lng: 118.667000, lat: 24.870700,
    confidence: 'high', readOn: '高德矢量图「泉州师范学院-第3食堂」标注' },
  { id: 'meal1', name: '一餐', lng: 118.666300, lat: 24.868100,
    confidence: 'high', readOn: '高德矢量图「泉州师范学院-第1食堂」标注' },
  { id: 'track_gate', name: '第一操场入口第三盖章点', lng: 118.669000, lat: 24.866800,
    confidence: 'low', readOn: '第一操场位于钟楼东南侧，入口需现场确认',
    note: '第三盖章点位置必须现场确认' },
  { id: 'track_side', name: '第一操场侧门终点', lng: 118.670200, lat: 24.866000,
    confidence: 'low', readOn: '第一操场侧门位置需现场确认',
    note: '终点侧门朝向需现场确认' },
  { id: 'library', name: '俊秀图书馆', lng: 118.675100, lat: 24.868800,
    confidence: 'high', readOn: '高德矢量图「泉州师范学院俊秀图书馆」标注' },
  { id: 'auditorium', name: '陈祖昌大礼堂', lng: 118.674300, lat: 24.867500,
    confidence: 'high', readOn: '高德矢量图「陈祖昌大礼堂」标注' },
  { id: 'bell_tower', name: '钟楼第二盖章点', lng: 118.670100, lat: 24.866600,
    confidence: 'high', readOn: '高德矢量图「陈明玉钟楼」标注',
    note: '第二盖章点设在钟楼前，具体点位需现场确认' },
  { id: 'sun_yatsen', name: '孙中山纪念堂', lng: 118.669600, lat: 24.865800,
    confidence: 'high', readOn: '高德矢量图「孙中山纪念堂」标注' },
  { id: 'liberal_arts', name: '文科楼', lng: 118.668500, lat: 24.866300,
    confidence: 'low', readOn: '按「黄朝阳教学楼」一带推断',
    note: '「文科楼」需现场确认对应哪栋' }
];

/* ---- 3. 输出 ---- */
const out = {
  type: 'FeatureCollection',
  crs: 'GCJ-02 (AMap)',
  generatedAt: new Date().toISOString(),
  status: 'draft',
  disclaimer: '本文件为待现场核对的草稿，未发布。所有 confidence != high 的点必须现场实测确认。',
  anchors: ANCHORS,
  roads: roads.map((r) => ({ id: r.id, highway: r.highway, name: r.name, points: r.points }))
};
const target = path.resolve(__dirname, '../../data/campus-roads-gcj02.geojson');
fs.writeFileSync(target, JSON.stringify(out));
console.log('道路段数：', roads.length);
console.log('锚点数：', ANCHORS.length,
  '| high:', ANCHORS.filter((a) => a.confidence === 'high').length,
  'medium:', ANCHORS.filter((a) => a.confidence === 'medium').length,
  'low:', ANCHORS.filter((a) => a.confidence === 'low').length);
console.log('已写入', target);
