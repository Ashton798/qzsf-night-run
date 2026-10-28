'use strict';
const {STATES,state,csvCell,evaluate}=require('./admin-domain');

// A single current run per registration. Counts never depend on page size or search.
const rosterSQL=`SELECT s.id,s.student_id,s.name,s.college,s.class_name,s.phone,r.id AS registration_id,r.registered_at,
  rs.id AS run_id,rs.status AS run_status,rs.review_status,rs.review_version,rs.start_time,rs.end_time,
  rs.distance_meters,rs.duration_seconds,rs.accepted_count,rs.rejected_count,rs.gap_count,
  CASE WHEN rs.id IS NULL THEN 'registered' WHEN rs.status IN ('running','paused') THEN 'running'
  WHEN rs.status='uploading' THEN 'uploading' WHEN rs.review_status IN ('approved','rejected') THEN rs.review_status ELSE 'pending' END AS participation
  FROM qz_registrations r JOIN qz_students s ON s.id=r.student_id
  LEFT JOIN LATERAL (SELECT * FROM qz_run_sessions x WHERE x.student_id=s.id AND x.event_id=r.event_id ORDER BY created_at DESC,id DESC LIMIT 1) rs ON TRUE
  WHERE r.event_id=$1`;
function studentRow(r){return {id:r.id,studentId:r.student_id,name:r.name,college:r.college,className:r.class_name,phone:r.phone,registeredAt:r.registered_at,state:r.participation,stateLabel:STATES[r.participation],runId:r.run_id,distance:Number(r.distance_meters||0),duration:Number(r.duration_seconds||0)};}
module.exports=async function adminService(req,res,url,ctx){
  const {db,requireAdmin,ok,body,coded,uid,reportFor,EVENT_ID}=ctx;
  const p=url.pathname;
  if(!p.startsWith('/api/v2/admin/')) return false;
  if(['/api/v2/admin/login','/api/v2/admin/logout','/api/v2/admin/config/colleges'].includes(p)) return false;
  const admin=requireAdmin(req);
  const eventId=String(url.searchParams.get('eventId')||EVENT_ID).slice(0,80);
  if(req.method==='GET' && p==='/api/v2/admin/me'){ok(res,{username:admin.u});return true;}
  if(req.method==='GET' && p==='/api/v2/admin/dashboard'){
    const counts=(await db.unsafe(`WITH roster AS (${rosterSQL}) SELECT count(*)::int AS total,
      count(*) FILTER (WHERE (registered_at AT TIME ZONE 'Asia/Shanghai')::date=(NOW() AT TIME ZONE 'Asia/Shanghai')::date)::int AS today,
      count(*) FILTER (WHERE participation='registered')::int AS registered,
      count(*) FILTER (WHERE participation='running')::int AS running,
      count(*) FILTER (WHERE participation='uploading')::int AS uploading,
      count(*) FILTER (WHERE participation='pending')::int AS pending,
      count(*) FILTER (WHERE participation='approved')::int AS approved,
      count(*) FILTER (WHERE participation='rejected')::int AS rejected,
      count(*) FILTER (WHERE rejected_count>0 OR gap_count>0 OR participation='rejected')::int AS anomalies FROM roster`,[eventId]))[0];
    const colleges=await db.unsafe(`WITH roster AS (${rosterSQL}) SELECT college,count(*)::int AS total,count(*) FILTER (WHERE participation='approved')::int AS approved FROM roster GROUP BY college ORDER BY total DESC,college`,[eventId]);
    counts.incomplete=counts.total-counts.approved;
    counts.completionRate=counts.total?counts.approved/counts.total:0;
    ok(res,{counts,colleges:colleges.map(c=>({...c,completionRate:c.total?c.approved/c.total:0})),updatedAt:new Date().toISOString(),eventId});return true;
  }
  if(req.method==='GET' && ['/api/v2/admin/students','/api/v2/admin/export.csv'].includes(p)){
    const q=String(url.searchParams.get('q')||'').slice(0,80),college=String(url.searchParams.get('college')||'').slice(0,80),className=String(url.searchParams.get('className')||'').slice(0,60),status=String(url.searchParams.get('state')||'').slice(0,30);
    const params=[eventId,'%'+q+'%',college,className,status];
    const filtered=`WITH roster AS (${rosterSQL}) SELECT * FROM roster WHERE (name ILIKE $2 OR student_id ILIKE $2) AND ($3='' OR college=$3) AND ($4='' OR class_name=$4) AND ($5='' OR participation=$5)`;
    if(p.endsWith('.csv')){
      const rows=await db.unsafe(filtered+' ORDER BY registered_at DESC',params);
      res.setHeader('Content-Type','text/csv; charset=utf-8');res.setHeader('Content-Disposition','attachment; filename="qzsf-registrations.csv"');
      res.end('\ufeff'+[['姓名','学号','学院','班级','手机号','报名时间','参与状态','完成情况'],...rows.map(r=>[r.name,r.student_id,r.college,r.class_name,r.phone,r.registered_at,STATES[r.participation],r.participation==='approved'?'已确认完成':'未确认完成'])].map(r=>r.map(csvCell).join(',')).join('\r\n'));return true;
    }
    const page=Math.max(1,Math.min(100000,parseInt(url.searchParams.get('page'),10)||1)),size=30;
    const total=(await db.unsafe(`SELECT count(*)::int AS n FROM (${filtered}) x`,params))[0].n;
    const rows=await db.unsafe(filtered+' ORDER BY registered_at DESC,id LIMIT $6 OFFSET $7',[...params,size,(page-1)*size]);
    const filters=await db`SELECT DISTINCT s.college,s.class_name FROM qz_students s JOIN qz_registrations r ON r.student_id=s.id WHERE r.event_id=${eventId} ORDER BY s.college,s.class_name`;
    ok(res,{students:rows.map(studentRow),total,page,pageSize:size,filters});return true;
  }
  let match=p.match(/^\/api\/v2\/admin\/students\/([^/]+)$/);
  if(req.method==='GET'&&match){
    const rows=await db.unsafe(rosterSQL+' AND s.id=$2',[eventId,match[1]]);
    if(!rows[0])throw coded('NOT_FOUND','报名学生不存在',404);
    const runs=await db`SELECT * FROM qz_run_sessions WHERE student_id=${match[1]} AND event_id=${eventId} ORDER BY created_at DESC`;
    ok(res,{student:studentRow(rows[0]),runs:runs.map(r=>({id:r.id,state:state(r),startTime:r.start_time,distance:Number(r.distance_meters),version:r.review_version}))});return true;
  }
  match=p.match(/^\/api\/v2\/admin\/runs\/([^/]+)(?:\/(review))?$/);
  if(match){
    const runId=match[1];
    if(req.method==='GET'&&!match[2]){
      const rows=await db`SELECT rs.*,e.review_rules FROM qz_run_sessions rs JOIN qz_events e ON e.id=rs.event_id WHERE rs.id=${runId}`;
      if(!rows[0])throw coded('NOT_FOUND','运动记录不存在',404);
      const report=await reportFor(rows[0],true),assessment=evaluate(report,rows[0].review_rules);
      const reviews=await db`SELECT administrator,decision,reason,evidence_json,created_at FROM qz_run_reviews WHERE session_id=${runId} ORDER BY created_at DESC`;
      ok(res,{report,assessment,reviews,version:rows[0].review_version,state:state(rows[0])});return true;
    }
    if(req.method==='POST'&&match[2]){
      const b=await body(req),reason=String(b.reason||'').trim().slice(0,2000);
      if(!['approved','rejected'].includes(b.decision)||reason.length<4||!Number.isInteger(b.version))throw coded('VALIDATION','请选择审核结果并填写至少 4 字的依据');
      await db.begin(async tx=>{
        const rows=await tx`SELECT rs.*,e.review_rules FROM qz_run_sessions rs JOIN qz_events e ON e.id=rs.event_id WHERE rs.id=${runId} FOR UPDATE OF rs`;
        const run=rows[0];if(!run)throw coded('NOT_FOUND','运动记录不存在',404);
        if(run.status!=='finished')throw coded('NOT_SUBMITTED','数据尚未提交，不能审核',409);
        if(run.review_version!==b.version)throw coded('REVIEW_CONFLICT','记录已被其他管理员审核，请刷新',409);
        const report=await reportFor(run,true,tx),assessment=evaluate(report,run.review_rules);
        if(b.decision==='approved'&&!assessment.hasEvidence)throw coded('NO_EVIDENCE','没有足够有效轨迹，不能确认完成',409);
        if(b.decision==='approved'&&assessment.reasons.length&&b.acknowledge!==true)throw coded('REVIEW_ACK_REQUIRED','请确认已核查路线和异常提示',409);
        if(b.decision==='approved'&&((run.review_rules.minDistance>0&&report.distance<run.review_rules.minDistance)||(run.review_rules.minDuration>0&&report.duration<run.review_rules.minDuration)||assessment.checkpoints.some(c=>!c.passed)))throw coded('RULES_NOT_MET','有效数据未达到已配置的距离、时长或检查点要求',409);
        await tx`INSERT INTO qz_run_reviews(id,session_id,administrator,decision,reason,evidence_json) VALUES(${uid('review')},${runId},${admin.u},${b.decision},${reason},${tx.json({assessment,report:{distance:report.distance,duration:report.duration,acceptedCount:report.acceptedCount,gapCount:report.gapCount},acknowledge:!!b.acknowledge})})`;
        await tx`UPDATE qz_run_sessions SET review_status=${b.decision},review_version=review_version+1,updated_at=NOW() WHERE id=${runId}`;
      });ok(res,{saved:true});return true;
    }
  }
  if(req.method==='GET'&&p==='/api/v2/admin/rules'){
    const rows=await db`SELECT review_rules FROM qz_events WHERE id=${eventId}`;
    ok(res,{rules:rows[0]?.review_rules||{}});return true;
  }
  if(req.method==='PUT'&&p==='/api/v2/admin/rules'){
    const b=await body(req);const rules=b.rules||{};
    if(!Array.isArray(rules.route)||rules.route.length>5000||rules.route.some(x=>!Array.isArray(x)||x.length!==2||!Number.isFinite(x[0])||!Number.isFinite(x[1])||Math.abs(x[0])>180||Math.abs(x[1])>90)||![rules.minDistance,rules.minDuration,rules.tolerance].every(n=>Number.isFinite(n)&&n>=0)||rules.tolerance<5||rules.tolerance>500)throw coded('VALIDATION','活动规则格式不正确');
    if(rules.checkpoints && (!Array.isArray(rules.checkpoints)||rules.checkpoints.length>100||rules.checkpoints.some(c=>!Array.isArray(c.position)||c.position.length!==2||!c.position.every(Number.isFinite)||!Number.isFinite(c.radius)||c.radius<=0||c.radius>500)))throw coded('VALIDATION','检查点格式不正确');
    await db`UPDATE qz_events SET review_rules=${db.json(rules)},updated_at=NOW() WHERE id=${eventId}`;
    ok(res,{saved:true});return true;
  }
  return false;
};
