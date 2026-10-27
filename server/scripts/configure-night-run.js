'use strict';
// One-time metadata migration; retains registrations, accounts and historical routes.
require('./load-env');
const path=require('node:path'),fs=require('node:fs'),db=require('../db'),geo=require('../geo');
const plan=require('../../data/night-run-plan.json');
const file=path.resolve(process.env.DB_PATH||'data/qzsf.db');
db.open(file);
const backup=path.resolve('backups/night-run-'+Date.now()+'.db');fs.mkdirSync(path.dirname(backup),{recursive:true});
db.raw().exec("VACUUM INTO '"+backup.replace(/'/g,"''")+"'");
const e=db.get('SELECT * FROM events WHERE code=?',['qzsf-2025']);if(!e)throw Error('请先初始化现有赛事');
const groups=JSON.parse(e.groups_json||'{}');
for(const [key,name] of Object.entries({competition:'竞赛组',experience:'体验组',unity:'同心组'})){
 const spec=plan.routes[key==='competition'?'A':'B'];
 groups[key]=Object.assign({},groups[key],{key,name,size:key==='unity'?2:1,timed:true,routeKey:key==='competition'?'A':'B',startAt:key==='unity'?spec.unityStartAt:spec.startAt,closeAt:plan.finishDeadline,desc:key==='unity'?'双人牵手共同参赛 · 共同场次计时':'单人参赛 · 现场游戏盖章'});
}
// OSM campus centroid, converted once. Used only for camera, never a building or route point.
const center=geo.wgs2gcj(24.8712079,118.6671925);
db.run('UPDATE events SET name=?,subtitle=?,event_date=?,reg_deadline=?,start_at=?,close_minutes=?,start_name=?,finish_name=?,groups_json=?,campus_lng=?,campus_lat=?,rules_text=?,updated_at=? WHERE id=?',[
 '泉州师范学院第九届校园荧光夜跑','星光伴跑·荧启新程','2026-12-03T18:00:00+08:00',plan.registrationDeadline,plan.routes.A.startAt,110,'荣茂楼正门口','第一操场侧门',JSON.stringify(groups),center[1],center[0],plan.unityRule+'\n三个游戏均需工作人员现场确认，GPS仅用于接近提示。',Date.now(),e.id]);
console.log('Metadata configured; original data backed up:',backup);console.log('No route coordinates created or published.');
