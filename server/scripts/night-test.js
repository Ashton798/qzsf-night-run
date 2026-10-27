'use strict';
// Isolated synthetic fixture; never writes test routes to the real event database.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn,spawnSync}=require('node:child_process');
const folder=fs.mkdtempSync(path.join(os.tmpdir(),'night-test-')),file=path.join(folder,'test.db'),port=18879;
const env={...process.env,DB_PATH:file,PORT:String(port),HOST:'127.0.0.1',ADMIN_USER:'testadmin',ADMIN_PASSWORD:'NightTest-Only-123!'};
spawnSync(process.execPath,['server/scripts/seed.js'],{env,stdio:'ignore'});
const db=require('../db');db.open(file);
db.run("UPDATE events SET reg_deadline=NULL,status='reg_open',start_at=?,close_minutes=120",[new Date(Date.now()-60000).toISOString()]);
const server=spawn(process.execPath,['server/index.js'],{env,stdio:'ignore'});
const base='http://127.0.0.1:'+port;let checks=0,admin;
const check=(name,value)=>{assert.ok(value,name);checks++;console.log('PASS',name);};
async function api(method,url,body,headers={}){const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json',...headers},body:body?JSON.stringify(body):undefined});return {status:r.status,...await r.json()};}
const a=()=>({Authorization:'Bearer '+admin});
(async()=>{
 for(let i=0;i<50;i++){try{await fetch(base+'/api/health');break;}catch{await new Promise(r=>setTimeout(r,100));}}
 admin=(await api('POST','/api/admin/login',{username:env.ADMIN_USER,password:env.ADMIN_PASSWORD})).data.token;
 for(const p of ['/data/qzsf.db','/.env','/server/api.js','/docs/plan-full-text.txt'])check('private static blocked '+p,(await fetch(base+p)).status===403);
 check('monitor private',(await api('GET','/api/admin/live')).status===401);
 const geo=require('../geo'),plan=require('../../data/night-run-plan.json');
 const points=Array.from({length:14},(_,i)=>[118.67+i*.00001,24.87]);
 const c={name:'SYNTHETIC TEST ONLY',crs:'gcj02',status:'draft',route:{routeKey:'A',points,start:points[0],finish:points.at(-1)},checkpoints:[1,2,3].map(i=>({id:'CP'+i,order:i,name:'Game '+i,lnglat:points[i*3],radius:30,required:true}))};
 let saved=(await api('PUT','/api/course',c,a())).data;
 check('unverified cannot publish',(await api('POST','/api/night/course/'+saved.courseId+'/publish',{},a())).status===400);
 /* 草稿不再隐藏：允许选手端预览路线，但必须带 draft 标记且不能开跑。 */
 const draftView=(await api('GET','/api/night/course?group=competition')).data;
 check('draft is preview-only',!!draftView && draftView.draft===true && draftView.status==='draft');
 c.surveyEvidence={reviewer:'automated fixture',surveyDate:'2026-10-26',source:'SYNTHETIC TEST; NOT REAL CAMPUS',roadAligned:true,landmarks:plan.routes.A.landmarks.map((name,i)=>({name,nodeIndex:i,verified:true}))};
 saved=(await api('PUT','/api/course',c,a())).data;
 check('publication works',(await api('POST','/api/night/course/'+saved.courseId+'/publish',{},a())).ok);
 check('group B cannot receive A',(await api('GET','/api/night/course?group=experience')).data===null);
 const reg=(await api('POST','/api/participants',{sid:'987654321',name:'测试选手',college:'测试学院',group:'competition'})).data;
 const ph={'X-Participant-Token':reg.participantToken};
 check('registration token returned',!!reg.participantToken);
 check('identity lookup protected',(await api('GET','/api/participants/987654321')).status===401);
 check('run token cannot be stolen by sid',(await api('POST','/api/runs/start',{sid:reg.sid})).status===401);
 const raw=geo.gcj2wgs(24.87,118.67),fix={rawLat:raw[0],rawLng:raw[1],accuracy:5,ts:Date.now(),crs:'wgs84'};
 const ci=await api('POST','/api/checkins',{sid:reg.sid,...fix},ph);if(!ci.ok)console.log(ci);check('GPS checkin',ci.ok);
 check('event window enforced',(await api('POST','/api/runs/start',{sid:reg.sid},ph)).status===400);
 db.run("UPDATE events SET status='running'");
 const started=await api('POST','/api/runs/start',{sid:reg.sid},ph);check('start published route',started.ok);
 const r=started.data,rh={'X-Run-Token':r.accessToken};
 check('other runner blocked',(await api('GET','/api/runs/'+r.id)).status===401);
 let track=await api('POST','/api/runs/'+r.id+'/track',{points:[{seq:0,...fix,ts:Date.now()}]},rh);
 if(!track.ok)console.log(track);
 check('raw GPS accepted',track.ok && track.data.accepted===1);
 track=await api('POST','/api/runs/'+r.id+'/track',{points:[{seq:0,...fix}]},rh);
 check('retry idempotent',track.data.duplicate===1);
 check('GPS cannot stamp',(await api('POST','/api/runs/'+r.id+'/hit',{code:'CP1',method:'gps'},rh)).status===403);
 let stamp=await api('POST','/api/runs/'+r.id+'/hit',{code:'CP2',method:'manual',gameCompleted:true,note:'fixture'},a());
 check('ordered games',stamp.data.valid===false);
 for(let i=1;i<=3;i++)check('staff game '+i,(await api('POST','/api/runs/'+r.id+'/hit',{code:'CP'+i,method:'manual',gameCompleted:true,note:'fixture'},a())).data.valid);
 track=await api('POST','/api/runs/'+r.id+'/track',{points:[{seq:1,rawLat:raw[0]+.02,rawLng:raw[1]+.02,accuracy:5,ts:Date.now()+1000}]},rh);
 check('GPS jump rejected but retained',track.data.rejected===1 && db.get('SELECT COUNT(*) AS n FROM track_points WHERE run_id=?',[r.id]).n===2);
 check('single jump never disqualifies',db.get('SELECT status FROM runs WHERE id=?',[r.id]).status==='running');
 const invalid=await api('POST','/api/runs/'+r.id+'/track',{points:[{seq:2,rawLat:'bad',rawLng:'bad'}]},rh);
 check('malformed point stored without 500',invalid.ok && invalid.data.rejected===1);
 const old=await api('POST','/api/runs/'+r.id+'/track',{points:[{seq:3,...fix,ts:Date.now()+60000}]},rh);
 check('future timestamp rejected',old.data.rejected===1);
 // 600 independent run tokens, each uploads a batch of 10 raw samples in one burst.
 const loadRuns=[];db.tx(()=>{for(let i=0;i<600;i++){
 const p=db.run('INSERT INTO participants(event_id,sid,name,group_key,created_at,updated_at) VALUES(1,?,?,?,?,?)',['8'+String(i).padStart(8,'0'),'load-'+i,'competition',Date.now(),Date.now()]);
 const token=require('node:crypto').randomBytes(32).toString('hex');
 const rr=db.run("INSERT INTO runs(participant_id,event_id,course_id,started_at,cp_total,status,mode,access_token,created_at,updated_at) VALUES(?,1,?,?,3,'running','gps',?,?,?)",[Number(p.lastInsertRowid),saved.courseId,Date.now()-20000,token,Date.now(),Date.now()]);loadRuns.push({id:Number(rr.lastInsertRowid),token});
 }});
 const begin=performance.now(),latencies=[];
 const responses=await Promise.all(loadRuns.map(async rr=>{const t=performance.now();const response=await api('POST','/api/runs/'+rr.id+'/track',{points:Array.from({length:10},(_,seq)=>({seq,...fix,ts:Date.now()-10000+seq*1000}))},{'X-Run-Token':rr.token});latencies.push(performance.now()-t);return response;}));
 latencies.sort((a,b)=>a-b);
 check('600 clients / 6000 samples',responses.every(x=>x.ok&&x.data.accepted===10));
 const live=(await api('GET','/api/admin/live',null,a())).data;check('live monitor 601 runs',live.running===601);
 const report={checks,clients:600,batchSize:10,totalPoints:6000,wallMs:Math.round(performance.now()-begin),p50Ms:Math.round(latencies[300]),p95Ms:Math.round(latencies[570]),maxMs:Math.round(latencies.at(-1)),errors:responses.filter(x=>!x.ok).length,limitations:'Local HTTP burst using synthetic coordinates; not mobile field testing or sustained production capacity.'};
 fs.writeFileSync('docs/night-test-results.json',JSON.stringify(report,null,2));console.log(report);
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{server.kill();db.raw().close();});
