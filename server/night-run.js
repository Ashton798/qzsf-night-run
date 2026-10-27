'use strict';
const db = require('./db');
const auth = require('./auth');
const geo = require('./geo');
const plan = require('../data/night-run-plan.json');
const comp = require('./competition');
const {ok, fail, readBody, parseQuery} = require('./http');
const routeKey = group => group === 'competition' ? 'A' : 'B';
function selected(eventId, group, published = true) {
  return db.get(`SELECT * FROM courses WHERE event_id=? AND route_key=? ${published ? "AND status='published'" : ''} ORDER BY version DESC,id DESC LIMIT 1`, [eventId, routeKey(group)]);
}
function publicationErrors(c) {
  const errors = comp.validateCourse(c);
  const spec = plan.routes[c.route.routeKey];
  if (!spec) return ['请选择策划书路线 A 或 B'];
  if (c.checkpoints.length !== 3 || c.checkpoints.some((p,i)=>p.id !== 'CP'+(i+1) || p.order !== i+1 || !p.required)) errors.push('必须按顺序设置 CP1、CP2、CP3 三个必经游戏站');
  const proof = c.surveyEvidence || {};
  if (!proof.reviewer || !proof.surveyDate || !proof.source || proof.roadAligned !== true) errors.push('必须填写现场核对人、核对日期、坐标来源，并确认路线逐段贴合可通行道路');
  if (!Array.isArray(proof.landmarks) || spec.landmarks.some(name=>!proof.landmarks.some(p=>p.name===name && p.verified===true && Number.isInteger(p.nodeIndex) && c.route.points[p.nodeIndex]))) errors.push('每个策划必经建筑/转弯须绑定已核对的路线节点');
  if (errors.length) return errors;
  if (c.route.points.length >= 2) {
    if (geo.distanceLngLat(c.route.start,c.route.points[0])>10 || geo.distanceLngLat(c.route.finish,c.route.points.at(-1))>10) errors.push('起终点必须与路线首尾相符（10米内）');
    for (const cp of c.checkpoints) if (geo.distToPath(cp.lnglat,c.route.points).dist>30) errors.push('打卡点必须在路线附近');
  }
  return errors;
}
function register(router) {
  const event = () => db.get('SELECT * FROM events WHERE code=?',['qzsf-2025']);
  router.get('/api/night-plan', (req,res)=>ok(res,plan));
  router.get('/api/night/course', (req,res)=>{
    const q=parseQuery(req), e=event();
    const admin=q.draft==='1' && auth.getSession(req);
    /* 已发布路线优先。若尚未发布，退回最新的草稿/实测版本，
     * 并在响应里标 draft:true —— 选手端只做“路线预览”，
     * 开跑按钮仍然被禁用（不能拿未核对路线开赛）。
     */
    let c=selected(e.id,q.group||'competition',!admin);
    let isDraft=false;
    if(!c && !admin){
      c=selected(e.id,q.group||'competition',false);
      isDraft=!!c;
    }
    ok(res,c ? Object.assign(comp.coursePublic(c,e,comp.courseCheckpoints(c.id)),{
      surveyEvidence:comp.parseJson(c.survey_evidence_json,{}),
      spec:plan.routes[c.route_key],
      draft:isDraft || c.status!=='published'
    }) : null);
  });
  router.post('/api/night/course/:id/publish', async(req,res)=>{
    const a=auth.requireAdmin(req,res,['admin']); if(!a)return;
    const c=db.get('SELECT * FROM courses WHERE id=?',[Number(req.params.id)]);if(!c)return fail(res,404,'路线不存在');
    const pub=comp.coursePublic(c,event(),comp.courseCheckpoints(c.id));pub.surveyEvidence=comp.parseJson(c.survey_evidence_json,{});
    const errors=publicationErrors(pub);if(errors.length)return fail(res,400,errors.join('；'),'SURVEY_REQUIRED');
    db.tx(()=>{
      db.run('UPDATE courses SET is_active=0 WHERE event_id=? AND route_key=?',[c.event_id,c.route_key]);
      db.run("UPDATE courses SET status='published',is_active=1,published_at=?,locked_at=?,locked_by=? WHERE id=?",[Date.now(),Date.now(),a.id,c.id]);
      db.run('INSERT INTO audit_logs(admin_id,action,target,detail_json,created_at) VALUES(?,?,?,?,?)',[a.id,'night.publish',String(c.id),JSON.stringify(pub.surveyEvidence),Date.now()]);
    });ok(res,{published:true,courseId:c.id});
  });
  router.get('/api/night/course/:id/geojson',(req,res)=>{
    const c=db.get('SELECT * FROM courses WHERE id=?',[Number(req.params.id)]);
    if(!c || (c.status!=='published'&&!auth.getSession(req)))return fail(res,404,'路线不存在或未发布');
    // RFC 7946 requires WGS84; never label GCJ-02 as standard GeoJSON.
    const convert=p=>{const v=geo.gcj2wgs(p[1],p[0]);return [v[1],v[0]];};
    ok(res,{type:'FeatureCollection',sourceCRS:'GCJ-02',outputCRS:'WGS84',features:[{type:'Feature',properties:{route:c.route_key,status:c.status,distanceM:c.distance_m},geometry:{type:'LineString',coordinates:comp.parseCoursePoints(c).map(convert)}},...comp.courseCheckpoints(c.id).map(cp=>({type:'Feature',properties:{id:cp.code,name:cp.name},geometry:{type:'Point',coordinates:convert([cp.lng,cp.lat])}}))]});
  });
  router.post('/api/night/restore-participant',async(req,res)=>{
    const a=auth.requireAdmin(req,res,['admin','referee']);if(!a)return;
    const b=await readBody(req);const p=db.get('SELECT * FROM participants WHERE event_id=? AND sid=?',[event().id,String(b.sid||'')]);
    if(!p)return fail(res,404,'报名记录不存在');
    if(!String(b.note||'').trim())return fail(res,400,'请填写现场身份核验依据');
    const token=require('node:crypto').randomBytes(32).toString('hex');
    db.run('UPDATE participants SET access_token=? WHERE id=?',[token,p.id]);
    db.run('INSERT INTO audit_logs(admin_id,action,target,detail_json,created_at) VALUES(?,?,?,?,?)',[a.id,'participant.restore',String(p.id),JSON.stringify({note:String(b.note).slice(0,1000)}),Date.now()]);
    ok(res,{participantToken:token,sid:p.sid});
  });
  router.post('/api/night/field-record',async(req,res)=>{
    const a=auth.requireAdmin(req,res,['admin','referee']);if(!a)return;
    const b=await readBody(req);const r=db.get('SELECT * FROM runs WHERE id=?',[Number(b.runId)]);if(!r)return fail(res,404,'比赛记录不存在');
    if(!String(b.note||'').trim())return fail(res,400,'填写纸质凭证号、现场观察、时间及补录原因');
    comp.addAnomaly(r,'field_evidence','info',{operator:a.id,note:String(b.note).slice(0,2000),observedAt:b.observedAt||null},null,r.event_id);
    ok(res,{recorded:true,message:'补充凭证已留痕，成绩由管理员复核'});
  });
}
module.exports={register,selected,routeKey,publicationErrors,plan};
