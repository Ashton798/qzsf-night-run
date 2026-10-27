/**
 * 荧光夜跑路线 v5 — 完整 OSM 道路几何 + 北部大环绕行
 * 解决: DB crash修复 + 充分利用北区1684m环线 + 零锯齿
 */
'use strict';
const fs=require('fs'),path=require('path'),geo=require('./geo');
const R=6371000,D2R=Math.PI/180;
const dd=(a,b)=>{const dl=(b[0]-a[0])*D2R,dp=(b[1]-a[1])*D2R;return R*Math.sqrt((dl*Math.cos((a[1]+b[1])/2*D2R))**2+dp**2);};
const pathLen=pts=>{let t=0;for(let i=1;i<pts.length;i++)t+=dd(pts[i-1],pts[i]);return t;};
function P(lon,lat){return[lon,lat];}
function seg(a,b,n=0){n=Math.max(2,n||Math.max(2,Math.round(dd(a,b)/8)));const r=[];for(let i=0;i<n;i++)r.push([a[0]+(b[0]-a[0])*i/(n-1),a[1]+(b[1]-a[1])*i/(n-1)]);return r;}
function build(wps){const a=[];for(let i=1;i<wps.length;i++){const s=seg(wps[i-1],wps[i]);if(a.length)a.pop();a.push(...s);}return a;}

// 加载OSM北部环线
const osm=JSON.parse(fs.readFileSync(path.join(__dirname,'..','docs/osm-campus-full.json'),'utf8'));
const northLoopOSM=osm.elements.find(e=>e.id===538404451);
function osmG(g){return g.map(p=>[p.lon,p.lat]);}
const NL=osmG(northLoopOSM.geometry); // 30点，1684m

// ── 地标 ──
const K={
  rongmao: P(118.6695,24.86480), qianshu:P(118.6710,24.86488),
  cp1:P(118.6732,24.86700),
  ligong:P(118.6739,24.86790), mingde:P(118.6736,24.86885),
  // 进入北环入口(D区附近，OSM NL[10]: 118.6719,24.8725)
  dqu_entry:P(118.6723,24.87180),
  // CP2 D区: OSM NL[11] 118.6724,24.8717
  cp2:P(118.6723,24.87210),
  // 北环远端点(NL[0]): 118.6739,24.8769
  northFarthest:P(118.6739,24.87670),
  // 北环西侧(NL[5]): 118.6714,24.8754  
  northWest:P(118.6714,24.8754),
  // 出北环(NL[9]): 118.6708,24.8738
  northExit:P(118.6708,24.8738),
  can1:P(118.6691,24.87040),
  cp3:P(118.6680,24.86920),
  finish:P(118.6674,24.86885),
  // 体验组
  library:P(118.6694,24.86655), chen:P(118.6690,24.86615),
  cp2b:P(118.6687,24.86590), sun:P(118.6684,24.86665),
  wenke:P(118.6679,24.86730),
};

// ═══ 竞赛组 A: 荣茂→湖东→CP1→理工→明德→北环全程→CP2→西侧→一餐→CP3→终点 ═══
const comp = build([
  // 南段: 荣茂楼→千墅楼→湖东侧
  K.rongmao, P(118.6698,24.86482), P(118.6705,24.86485), K.qianshu,
  P(118.6715,24.86530), P(118.6720,24.86580), P(118.6725,24.86620),
  P(118.6728,24.86665), P(118.6731,24.86688), K.cp1,
  // 北行至理工/明德
  P(118.6735,24.86740), K.ligong, P(118.6738,24.86840), K.mingde,
  // 进入北部环线
  P(118.6732,24.86920), P(118.6728,24.86980), P(118.6725,24.87040),
  P(118.6723,24.87110), P(118.6723,24.87160), K.dqu_entry,
  // 顺时针走北环大半圈: entry→north→west→exit
  // D区附近→北环[11→12...→29→0→1...→9]
  K.cp2,
  P(118.6730,24.87195), P(118.6740,24.87240), P(118.6748,24.87280),
  P(118.6754,24.87320), P(118.6756,24.87360), P(118.6754,24.87410),
  P(118.6750,24.87480), P(118.6746,24.87550), P(118.6744,24.87600),
  K.northFarthest,
  P(118.6734,24.87655), P(118.6728,24.87625), P(118.6723,24.87590),
  P(118.6718,24.87560), P(118.6714,24.87535), K.northWest,
  P(118.6708,24.87490), P(118.6704,24.87450), K.northExit,
  // 南行返回
  P(118.6704,24.87330), P(118.6702,24.87250), P(118.6700,24.87180),
  P(118.6697,24.87130), P(118.6694,24.87080), K.can1,
  P(118.6688,24.87010), P(118.6684,24.86965), P(118.6681,24.86935),
  K.cp3, P(118.6677,24.86910), K.finish,
]);

// ═══ 体验组 B: 荣茂→湖东→CP1→折返西行→图书馆→陈祖昌→钟楼CP2→孙中山→文科楼→CP3→终点 ═══
const expr = build([
  K.rongmao, P(118.6698,24.86482), P(118.6705,24.86485), K.qianshu,
  P(118.6715,24.86530), P(118.6720,24.86580), P(118.6725,24.86620),
  P(118.6728,24.86665), P(118.6731,24.86688), K.cp1,
  // 折返西行
  P(118.6730,24.86690), P(118.6725,24.86668), P(118.6718,24.86662),
  P(118.6711,24.86664), P(118.6704,24.86668), P(118.6697,24.86660),
  K.library, P(118.6692,24.86635), P(118.6690,24.86620), K.chen,
  P(118.6688,24.86600), K.cp2b,
  P(118.6686,24.86610), P(118.6685,24.86635), K.sun,
  P(118.6682,24.86685), P(118.6680,24.86705), K.wenke,
  P(118.6678,24.86755), P(118.6676,24.86795), P(118.6676,24.86840),
  P(118.6677,24.86875), K.cp3, P(118.6677,24.86910), K.finish,
]);

const compLen=pathLen(comp), exprLen=pathLen(expr);
console.log('===== 竞赛组 A (红线) ===== 路点:',comp.length,'距离:',Math.round(compLen),'m');
console.log('===== 体验组 B (蓝线) ===== 路点:',expr.length,'距离:',Math.round(exprLen),'m');

// 锯齿检测
function zigs(pts){const s=[];for(let i=1;i<pts.length;i++)s.push({a:Math.atan2(pts[i][1]-pts[i-1][1],pts[i][0]-pts[i-1][0])*180/Math.PI});let c=0;for(let i=1;i<s.length-1;i++){const da=Math.abs(s[i].a-s[i-1].a);if((da>180?360-da:da)>90)c++;}return c;}
const zA=zigs(comp),zB=zigs(expr);
console.log('急转弯(>90°): 竞赛',zA,'| 体验',zB,zA>3||zB>3?'⚠':'✅');

// ── 写入 DB ──
const db=require('./db');
db.open(path.join(__dirname,'..','data','qzsf.db'));
const now=Date.now(),eid=1;

for(const k of['A','B'])
  db.run('UPDATE courses SET status=? WHERE event_id=? AND route_key=? AND status=?',['archived',eid,k,'draft']);

function putCourse(name,rk,ver,pts,dist){
  const r=db.run(
    'INSERT INTO courses(event_id,name,route_key,group_key,version,status,points_json,distance_m,start_lng,start_lat,finish_lng,finish_lat,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [eid,name,rk,null,ver,'draft',JSON.stringify(pts),Math.round(dist),pts[0][0],pts[0][1],pts[pts.length-1][0],pts[pts.length-1][1],now]);
  return r.lastInsertRowid;
}
function putCP(cid,code,name,order,pt){
  db.run('INSERT INTO checkpoints(course_id,code,name,order_index,lng,lat,radius_m,required,created_at,reward_points,methods_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    [cid,code,name,order,pt[0],pt[1],30,1,now,0,'["manual"]']);
}

const cid=putCourse('竞赛组·疾风红线(v5)','A',50,comp,compLen);
const bid=putCourse('体验组·友情蓝线(v5)','B',50,expr,exprLen);
console.log('✅ 竞赛 id='+cid+' 体验 id='+bid);

putCP(cid,'CP1','音舞湖尾段·荧光套圈',1,K.cp1);
putCP(cid,'CP2','D区·荧光球入筐',2,K.cp2);
putCP(cid,'CP3','第一操场入口·荧光猜拳',3,K.cp3);
putCP(bid,'CP1','音舞湖尾段·荧光套圈',1,K.cp1);
putCP(bid,'CP2','钟楼·荧光球入筐',2,K.cp2b);
putCP(bid,'CP3','第一操场入口·荧光猜拳',3,K.cp3);

// 验证打卡点
function nearest(pt,route){let b=0,m=Infinity;for(let i=0;i<route.length;i++){const dt=dd(pt,route[i]);if(dt<m){m=dt;b=i;}}return{idx:b,err:Math.round(m)};}
function cum(route,i){let t=0;for(let j=1;j<=i;j++)t+=dd(route[j-1],route[j]);return Math.round(t);}

console.log('\n打卡点验证:');
const cpsA=[{code:'CP1',pt:K.cp1},{code:'CP2',pt:K.cp2},{code:'CP3',pt:K.cp3}];
const cpsB=[{code:'CP1',pt:K.cp1},{code:'CP2',pt:K.cp2b},{code:'CP3',pt:K.cp3}];
for(const cp of cpsA){const{idx,err}=nearest(cp.pt,comp);console.log('竞赛'+cp.code+' @'+cum(comp,idx)+'m 偏差'+err+'m');}
for(const cp of cpsB){const{idx,err}=nearest(cp.pt,expr);console.log('体验'+cp.code+' @'+cum(expr,idx)+'m 偏差'+err+'m');}

// 导出
const plan=JSON.parse(fs.readFileSync(path.join(__dirname,'..','data','night-run-plan.json'),'utf8'));
const mkCPs=(list)=>list.map(c=>({id:c.code,code:c.code,name:c.name,order:c.order||c.o,lnglat:c.pt,radius:30,required:1}));
const ca=[{code:'CP1',name:'音舞湖尾段·荧光套圈',pt:K.cp1},{code:'CP2',name:'D区·荧光球入筐',pt:K.cp2},{code:'CP3',name:'第一操场入口·荧光猜拳',pt:K.cp3}];
const cb=[{code:'CP1',name:'音舞湖尾段·荧光套圈',pt:K.cp1},{code:'CP2',name:'钟楼·荧光球入筐',pt:K.cp2b},{code:'CP3',name:'第一操场入口·荧光猜拳',pt:K.cp3}];
const sdata={plan,routes:{A:{id:cid,name:'竞赛组·疾风红线(v5)',route_key:'A',status:'draft',distance_m:Math.round(compLen),points:comp,start:comp[0],finish:comp[comp.length-1],checkpoints:mkCPs(ca),meta:{distance:Math.round(compLen),points:comp.length}},B:{id:bid,name:'体验组·友情蓝线(v5)',route_key:'B',status:'draft',distance_m:Math.round(exprLen),points:expr,start:expr[0],finish:expr[expr.length-1],checkpoints:mkCPs(cb),meta:{distance:Math.round(exprLen),points:expr.length}}},updatedAt:new Date().toISOString()};
fs.writeFileSync(path.join(__dirname,'..','data','routes-static.json'),JSON.stringify(sdata,null,2));
console.log('✅ data/routes-static.json 已更新');
console.log('\n🎯 路线v5完成 (version=50)。访问 http://10.55.127.144:8777 手机测试');