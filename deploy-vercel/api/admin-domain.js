'use strict';

const STATES = { registered:'已报名，未开始', running:'正在跑步', uploading:'已结束，等待数据上传', pending:'已提交，待审核', approved:'已确认完成', rejected:'异常或未通过' };
function state(run) {
  if (!run || !run.id) return 'registered';
  if (['running','paused'].includes(run.status)) return 'running';
  if (run.status === 'uploading') return 'uploading';
  return ['approved','rejected'].includes(run.review_status) ? run.review_status : 'pending';
}
function csvCell(value) {
  let s = value instanceof Date ? value.toISOString() : String(value == null ? '' : value);
  if (/^[\s]*[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g,'""') + '"';
}
function meters(a,b) {
  const rad=Math.PI/180, x=(a[0]-b[0])*rad*Math.cos((a[1]+b[1])/2*rad), y=(a[1]-b[1])*rad;
  return Math.hypot(x,y)*6371008.8;
}
function segmentDistance(p,a,b) {
  const cos=Math.cos(p[1]*Math.PI/180), scale=111195;
  const ax=(a[0]-p[0])*cos*scale, ay=(a[1]-p[1])*scale;
  const bx=(b[0]-p[0])*cos*scale, by=(b[1]-p[1])*scale;
  const dx=bx-ax,dy=by-ay, t=Math.max(0,Math.min(1,-(ax*dx+ay*dy)/(dx*dx+dy*dy||1)));
  return Math.hypot(ax+t*dx,ay+t*dy);
}
function evaluate(report,rules={}) {
  const good=(report.points||[]).filter(p=>p.validityStatus==='accepted');
  const reasons=[];
  if(good.length<2) reasons.push('有效 GPS 采样点不足，禁止认定完成');
  const hasEvidence=good.length>=2 && report.distance>0 && report.duration>0;
  if(good.length>=2&&!hasEvidence) reasons.push('未记录到有效运动距离或时长，禁止认定完成');
  if(report.gapCount>0) reasons.push('存在 GPS 中断；可能由锁屏或后台限制引起，需人工核查');
  if(report.rejectedCount>0) reasons.push('存在低精度、跳点或时间异常采样，请核查原始点');
  if(rules.minDistance>0 && report.distance<rules.minDistance) reasons.push('有效距离未达到活动要求');
  if(rules.minDuration>0 && report.duration<rules.minDuration) reasons.push('运动时长未达到活动要求');
  const route=Array.isArray(rules.route)?rules.route:[];
  const mapped=good.filter(p=>p.displayLongitude!=null&&p.displayLatitude!=null);
  const deviating=route.length>1?mapped.filter(p=>route.slice(1).every((b,i)=>segmentDistance([p.displayLongitude,p.displayLatitude],route[i],b)>(rules.tolerance||50))).map(p=>p.seq):[];
  if(deviating.length) reasons.push('采样点偏离指定路线，请人工检查');
  const checkpoints=(rules.checkpoints||[]).map(c=>({ ...c,passed:mapped.some(p=>meters([p.displayLongitude,p.displayLatitude],c.position)<=(c.radius||50)) }));
  if(checkpoints.some(c=>!c.passed)) reasons.push('存在未经过的检查点');
  if(route.length<2) reasons.push('活动尚未绑定标准路线；路线完成情况待人工审核');
  return { reasons,deviating,checkpoints,routeConfigured:route.length>1,hasEvidence,eligible:hasEvidence && !reasons.length,route, rules };
}
module.exports={STATES,state,csvCell,evaluate,segmentDistance};
