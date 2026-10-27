/* eslint-disable */
/**
 * 荧光夜跑路线紧急修复脚本 — OSM道路 + 策划书校准
 * 用法：node server/update-routes.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const geo = require('./geo');

/* ---- OSM 道路段（校园可通行道路）---- */
const RD_DAXING_E = [[118.668053,24.863018],[118.668833,24.863522],[118.669018,24.863641],[118.669280,24.863807],[118.670816,24.864780],[118.671140,24.864985],[118.671254,24.865055],[118.671534,24.865227],[118.671705,24.865332],[118.673013,24.866136],[118.674666,24.867176],[118.674736,24.867216],[118.674849,24.867282],[118.674955,24.867346]];
const RD_FUXI = [[118.668470,24.876547],[118.669889,24.874611],[118.671363,24.872592],[118.671676,24.872164],[118.672281,24.871335],[118.672316,24.871288],[118.672609,24.870887],[118.672700,24.870772],[118.672965,24.870447],[118.673616,24.869326],[118.673933,24.868729],[118.674677,24.867324],[118.674736,24.867216]];
const RD_INTERNAL_SW = [[118.673535,24.868917],[118.672019,24.868069],[118.671976,24.868045],[118.671932,24.868015],[118.670198,24.867038],[118.670050,24.866951],[118.669449,24.866638],[118.669166,24.866458],[118.668961,24.866216],[118.668718,24.865779],[118.668567,24.865457],[118.668519,24.865139],[118.668555,24.864807],[118.668650,24.864542],[118.668944,24.864022]];
const RD_WEST_NW = [[118.670240,24.872917],[118.670808,24.871941],[118.669590,24.871368],[118.668766,24.870980]];
const RD_WEST_W = [[118.668766,24.870980],[118.669140,24.870433],[118.669161,24.870272],[118.668356,24.869498],[118.668078,24.869226],[118.667820,24.869075]];

/* ---- 关键地标 ---- */
const landmarks = {
  start:       [118.66950, 24.86480], // 荣茂楼正门
  qianshu:     [118.66980, 24.86485], // 千墅楼
  yinwu_cp1:   [118.67320, 24.86680], // 音舞湖尾段 · 荧光套圈
  ligong:      [118.67380, 24.86820], // 理工篮球场
  mingde:      [118.67350, 24.86900], // 明德体育馆
  dqu:         [118.67230, 24.87170], // D区 · 荧光球入筐
  cqu:         [118.67150, 24.87150], // C区
  can3:        [118.67000, 24.87120], // 第三餐厅
  can1:        [118.66900, 24.87020], // 第一餐厅
  library:     [118.66940, 24.86640], // 俊秀图书馆
  chen:        [118.66900, 24.86610], // 陈祖昌大礼堂
  zhonglou:    [118.66870, 24.86590], // 钟楼 · 荧光球入筐
  sun:         [118.66840, 24.86660], // 孙中山纪念堂
  wenke:       [118.66800, 24.86720], // 文科楼
  caochang:    [118.66770, 24.86900], // 第一操场入口 · 荧光猜拳
  finish:      [118.66730, 24.86880], // 侧门终点
};

/* ---- 辅助函数 ---- */
const linterp = (a, b, t) => [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t];

function sample(road, from, to, n) {
  const pts = [], L = road.length;
  for (let i = 0; i <= n; i++) {
    const t = from + (to - from) * i / n;
    const j = Math.floor(t), f = t - j;
    pts.push(linterp(road[Math.min(Math.max(j,0),L-2)], road[Math.min(Math.max(j+1,1),L-1)], f));
  }
  return pts;
}

function buildRoute(segments) {
  const all = [];
  for (const seg of segments) for (const pt of seg) all.push(pt);
  const r = [all[0]];
  for (let i = 1; i < all.length; i++)
    if (geo.distanceLngLat(r[r.length-1], all[i]) > 1.5) r.push(all[i]);
  return r;
}

const pathLen = geo.pathLength;
const dist = geo.distanceLngLat;

/* ---- 竞赛组 A（红线）---- */
function buildComp() {
  const { start, qianshu, yinwu_cp1, ligong, mingde, dqu, cqu, can3, can1, caochang, finish } = landmarks;
  return buildRoute([
    // ① 荣茂楼→千墅楼→接入大兴街
    [start, [118.66960,24.86483], qianshu,
     [118.67000,24.86487],[118.67030,24.86488],[118.67060,24.86485],[118.67080,24.86482]],
    // ② 大兴街向东到湖尾
    sample(RD_DAXING_E, 3.5, 10, 8),
    // ③ 湖边→CP1
    [[118.67300,24.86615],[118.67315,24.86645],[118.67320,24.86680],yinwu_cp1],
    // ④ 府西路南端北行
    [[118.67360,24.86710],[118.67375,24.86740],...sample(RD_FUXI,10,8,4)],
    // ⑤ 理工篮球场→明德
    [ligong,[118.67375,24.86845],[118.67360,24.86875],mingde],
    // ⑥ 府西路中段北行→D区
    [...sample(RD_FUXI,7,4,6)],
    [dqu],
    // ⑦ 西侧路→C区→三餐
    [[118.67200,24.87165],[118.67180,24.87155],cqu,
     [118.67100,24.87140],[118.67050,24.87130],[118.67000,24.87120],can3],
    // ⑧ 西侧路南行→一餐→操场CP3
    [...sample(RD_WEST_W,0,3,5)],
    [[118.66900,24.87030],[118.66890,24.87025],can1,
     ...sample(RD_WEST_W,3,4.5,3)],
    [[118.66820,24.86940],[118.66800,24.86920],[118.66780,24.86905],caochang],
    // ⑨ 终点
    [[118.66755,24.86890],[118.66740,24.86885],finish]
  ]);
}

/* ---- 体验组/同心组 B（蓝线）---- */
function buildExpr() {
  const { start, qianshu, yinwu_cp1, library, chen, zhonglou, sun, wenke, caochang, finish } = landmarks;
  return buildRoute([
    // ① 荣茂楼→千墅楼→向东
    [start,[118.66960,24.86483],qianshu,
     [118.67000,24.86487],[118.67030,24.86488],[118.67060,24.86485],[118.67080,24.86482]],
    // ② 大兴街向东到湖尾CP1
    sample(RD_DAXING_E, 3.5, 8, 7),
    [[118.67230,24.86550],[118.67270,24.86580],[118.67300,24.86620],
     [118.67315,24.86645],yinwu_cp1],
    // ③ 折返——沿内部SW路西行→图书馆方向
    [yinwu_cp1],
    [...sample(RD_INTERNAL_SW, 0, 3, 5)],
    [[118.67100,24.86750],[118.67050,24.86720],[118.67000,24.86690],[118.66960,24.86660]],
    // ④ 俊秀图书馆→陈祖昌→钟楼CP2
    [library,[118.66920,24.86620],[118.66910,24.86615],chen,
     [118.66885,24.86610],[118.66880,24.86595],zhonglou],
    // ⑤ 钟楼→孙中山→向西绕宿舍区→折回→文科楼
    [zhonglou,[118.66865,24.86610],[118.66855,24.86635],[118.66845,24.86655],sun,
     [118.66825,24.86670],[118.66810,24.86690],[118.66790,24.86710],
     [118.66770,24.86735],[118.66755,24.86760],[118.66740,24.86785],
     [118.66730,24.86810],[118.66720,24.86835],
     // 折回
     [118.66735,24.86815],[118.66750,24.86790],[118.66765,24.86765],
     [118.66780,24.86745],[118.66795,24.86725],wenke],
    // ⑥ 文科楼→操场CP3
    [[118.66805,24.86725],[118.66795,24.86750],[118.66785,24.86775],
     [118.66775,24.86805],[118.66770,24.86835],[118.66765,24.86865],caochang],
    // ⑦ 终点
    [finish]
  ]);
}

/* ---- 生成路线 ---- */
const comp = buildComp();
const expr = buildExpr();

console.log('=== 竞赛组A (红线) ===');
console.log(`节点: ${comp.length},  总长: ${Math.round(pathLen(comp))}m`);
console.log('起点:', comp[0], '终点:', comp[comp.length-1]);

console.log('\n=== 体验组/同心组B (蓝线) ===');
console.log(`节点: ${expr.length},  总长: ${Math.round(pathLen(expr))}m`);
console.log('起点:', expr[0], '终点:', expr[expr.length-1]);

// 打卡点
const compCPs = [
  { code:'CP1', name:'音舞湖尾段·荧光套圈', pt:landmarks.yinwu_cp1, order:1 },
  { code:'CP2', name:'D区·荧光球入筐', pt:landmarks.dqu, order:2 },
  { code:'CP3', name:'第一操场入口·荧光猜拳', pt:landmarks.caochang, order:3 },
];
const exprCPs = [
  { code:'CP1', name:'音舞湖尾段·荧光套圈', pt:landmarks.yinwu_cp1, order:1 },
  { code:'CP2', name:'钟楼·荧光球入筐', pt:landmarks.zhonglou, order:2 },
  { code:'CP3', name:'第一操场入口·荧光猜拳', pt:landmarks.caochang, order:3 },
];

function distFromStart(route, idx) {
  let d = 0;
  for (let i = 1; i <= idx; i++) d += dist(route[i-1], route[i]);
  return Math.round(d);
}

function nearestIdx(pt, route) {
  let best = 0, min = Infinity;
  for (let i = 0; i < route.length; i++) {
    const d = dist(pt, route[i]);
    if (d < min) { min = d; best = i; }
  }
  return { idx: best, err: Math.round(min) };
}

console.log('\n=== 打卡点验证 ===');
for (const cp of compCPs) {
  const { idx, err } = nearestIdx(cp.pt, comp);
  console.log(`  竞赛${cp.code}: idx=${idx} 距起点${distFromStart(comp,idx)}m 偏差${err}m`);
}
for (const cp of exprCPs) {
  const { idx, err } = nearestIdx(cp.pt, expr);
  console.log(`  体验${cp.code}: idx=${idx} 距起点${distFromStart(expr,idx)}m 偏差${err}m`);
}

/* ---- 写入 SQLite ---- */
const db = require('./db');
db.open(path.join(__dirname, '..', 'data', 'qzsf.db'));

const now = Date.now();
const eventId = 1;

const r1 = db.run(
  `INSERT INTO courses (event_id,name,route_key,group_key,version,status,points_json,distance_m,start_lng,start_lat,finish_lng,finish_lat,created_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  [eventId, '竞赛组·疾风红线(OSM校准)','A',null,0,'draft',
   JSON.stringify(comp), Math.round(pathLen(comp)),
   comp[0][0],comp[0][1],comp[comp.length-1][0],comp[comp.length-1][1], now]);
const compId = r1.lastInsertRowid;
console.log('\n✅ 竞赛组 DB id=' + compId);

const r2 = db.run(
  `INSERT INTO courses (event_id,name,route_key,group_key,version,status,points_json,distance_m,start_lng,start_lat,finish_lng,finish_lat,created_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  [eventId, '体验组/同心组·友情蓝线(OSM校准)','B',null,0,'draft',
   JSON.stringify(expr), Math.round(pathLen(expr)),
   expr[0][0],expr[0][1],expr[expr.length-1][0],expr[expr.length-1][1], now]);
const exprId = r2.lastInsertRowid;
console.log('✅ 体验组 DB id=' + exprId);

for (const cp of compCPs)
  db.run(`INSERT INTO checkpoints (course_id,code,name,order_index,lng,lat,radius_m,required,created_at,methods_json) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [compId,cp.code,cp.name,cp.order,cp.pt[0],cp.pt[1],30,1,now,'["manual"]']);
for (const cp of exprCPs)
  db.run(`INSERT INTO checkpoints (course_id,code,name,order_index,lng,lat,radius_m,required,created_at,methods_json) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [exprId,cp.code,cp.name,cp.order,cp.pt[0],cp.pt[1],30,1,now,'["manual"]']);

// JSON 导出
fs.writeFileSync(path.join(__dirname,'..','data','verified-courses.json'), JSON.stringify({
  generated: new Date().toISOString(),
  source: 'OSM road network + plan figure calibration',
  crs: 'GCJ-02 (Amap compatible)',
  competition: { id: compId, route_key: 'A', name: '竞赛组·疾风红线(OSM校准)', distance_m: Math.round(pathLen(comp)), points: comp, checkpoints: compCPs },
  experience:  { id: exprId, route_key: 'B', name: '体验组/同心组·友情蓝线(OSM校准)', distance_m: Math.round(pathLen(expr)), points: expr, checkpoints: exprCPs },
}, null, 2));
console.log('✅ data/verified-courses.json');
console.log('\n🎯 路线修复完成！在管理后台选择含"(OSM校准)"的路线即可查看。');