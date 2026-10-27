/* 冒烟测试：验证后端核心链路
 * 用法：node server/scripts/smoke-test.js
 * 需要一个正在运行的服务（默认 http://127.0.0.1:8777）
 */
'use strict';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8777';
const USER = process.env.ADMIN_USER || 'admin';
const PASS = process.env.ADMIN_PASSWORD || 'Qzsf@2025';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
}

async function api(method, path, body, token) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  return { status: r.status, data };
}

(async () => {
  console.log('\n【1】健康检查');
  const h = await api('GET', '/api/health');
  check('服务在线', h.status === 200 && h.data.ok);
  check('数据库为 sqlite', h.data.data && h.data.data.database === 'sqlite');

  console.log('\n【2】赛事信息');
  const ev = await api('GET', '/api/event');
  check('赛事存在', ev.status === 200 && ev.data.data && !!ev.data.data.code, ev.status);

  const evc = await api('GET', '/api/event/config');
  const cfg = evc.data.data || {};
  check('配置接口可访问', evc.status === 200 && !!cfg.code);
  check('返回学院列表', Array.isArray(cfg.colleges) && cfg.colleges.length > 0, cfg.colleges && cfg.colleges.length);
  check('返回组别配置', !!cfg.groups && !!cfg.groups.competition);
  check('返回状态文案', typeof cfg.statusText === 'string' && cfg.statusText.length > 0);
  check('返回报名开关', typeof cfg.regOpen === 'boolean');

  console.log('\n【3】未授权拦截');
  for (const [m, p, b] of [
    ['PUT', '/api/course', { route: { points: [] } }],
    ['GET', '/api/participants', null],
    ['GET', '/api/stats', null],
    ['GET', '/api/audit', null]
  ]) {
    const r = await api(m, p, b);
    check(`${m} ${p} 返回 401`, r.status === 401, r.status);
  }

  console.log('\n【4】管理员登录');
  const login = await api('POST', '/api/admin/login', { username: USER, password: PASS });
  check('登录成功', login.status === 200 && login.data.ok, login.data.error);
  const token = login.data.data && login.data.data.token;
  check('返回 token', !!token);

  const me = await api('GET', '/api/admin/me', null, token);
  check('会话有效', me.status === 200 && me.data.data.username === USER);

  console.log('\n【5】路线读写');
  const testCourse = {
    name: '冒烟测试路线',
    route: {
      points: [[118.671, 24.868], [118.672, 24.869], [118.673, 24.868]],
      start: [118.671, 24.868], finish: [118.671, 24.868], closed: false
    },
    checkpoints: [1, 2, 3, 4, 5, 6].map((i) => ({
      id: 'CP' + i, name: '冒烟打卡点' + i,
      lnglat: [118.671 + i * 0.0002, 24.868], radius: 30
    }))
  };
  const save = await api('PUT', '/api/course', testCourse, token);
  check('保存路线', save.status === 200 && save.data.ok, save.data.error);
  const read = await api('GET', '/api/course');
  check('读取路线', read.status === 200 && !!read.data.data);
  check('途经点数量正确', read.data.data.route.points.length === 3);
  check('打卡点为 6 个', read.data.data.checkpoints.length === 6);
  check('总长度已计算', read.data.data.meta.distance > 0);
  check('中文未乱码', read.data.data.checkpoints[0].name === '冒烟打卡点1');

  console.log('\n【6】报名流程');
  const sid = '9' + String(Date.now()).slice(-9);   // 10 位纯数字，符合校验规则
  const reg = await api('POST', '/api/participants', {
    sid, name: '冒烟测试', college: '数学与计算机科学学院', group: 'competition'
  });
  check('报名成功', reg.status === 200 && reg.data.ok, reg.data.error);
  const pid = reg.data.data && reg.data.data.id;

  const dup = await api('POST', '/api/participants', {
    sid, name: '冒烟测试', college: '数学与计算机科学学院', group: 'competition'
  });
  check('重复报名返回已有记录', dup.status === 200 && dup.data.existed === true);

  const badReg = await api('POST', '/api/participants', { sid: 'abc', name: 'x', college: '', group: 'zzz' });
  check('参数校验生效', badReg.status === 400);

  console.log('\n【7】签到');
  const ci = await api('POST', '/api/checkins', { sid, lng: 118.671, lat: 24.868, accuracy: 10 });
  check('签到成功', ci.status === 200 && ci.data.ok, ci.data.error);

  console.log('\n【8】比赛与打卡');
  const run = await api('POST', '/api/runs/start', { sid, mode: 'gps' });
  check('开始比赛', run.status === 200 && run.data.ok, run.data.error);
  const runId = run.data.data && run.data.data.id;
  check('打卡点总数正确', run.data.data.cpTotal === 6);

  const track = await api('POST', `/api/runs/${runId}/track`, {
    points: Array.from({ length: 10 }, (_, i) => ({
      seq: i, lng: 118.671 + i * 0.0001, lat: 24.868, accuracy: 10, ts: Date.now()
    }))
  });
  check('上传轨迹', track.status === 200 && track.data.data.inserted === 10);

  const cps = read.data.data.checkpoints;
  for (const cp of cps) {
    const hit = await api('POST', `/api/runs/${runId}/hit`, {
      code: cp.id, lng: cp.lnglat[0], lat: cp.lnglat[1]
    });
    check(`打卡 ${cp.id}`, hit.status === 200 && hit.data.data.valid === true, JSON.stringify(hit.data));
  }

  const dupHit = await api('POST', `/api/runs/${runId}/hit`, { code: 'CP1', lng: cps[0].lnglat[0], lat: cps[0].lnglat[1] });
  check('重复打卡被拦截', dupHit.data.data && dupHit.data.data.duplicate === true);

  const fin = await api('POST', `/api/runs/${runId}/finish`, {});
  check('结束比赛', fin.status === 200 && fin.data.data.completed === true, JSON.stringify(fin.data.data));

  console.log('\n【9】排行榜与统计');
  const lb = await api('GET', '/api/leaderboard');
  check('排行榜有数据', lb.status === 200 && lb.data.data.length > 0);
  const st = await api('GET', '/api/public/stats');
  check('公开统计可访问', st.status === 200 && st.data.data.total > 0);

  const astat = await api('GET', '/api/stats', null, token);
  check('管理统计需登录且可访问', astat.status === 200 && astat.data.data.total > 0);

  console.log('\n【10】导出与审计');
  const csv = await api('GET', '/api/participants/export.csv', null, token);
  check('CSV 导出', csv.status === 200 && String(csv.data).includes('学号'));

  const audit = await api('GET', '/api/audit', null, token);
  check('审计日志有记录', audit.status === 200 && audit.data.data.length > 0);

  console.log('\n【11】权限边界');
  const logout = await api('POST', '/api/admin/logout', {}, token);
  check('登出成功', logout.status === 200);
  const after = await api('GET', '/api/participants', null, token);
  check('登出后 token 失效', after.status === 401);

  console.log('\n【12】赛事配置写入');
  const l3 = await api('POST', '/api/admin/login', { username: USER, password: PASS });
  const t3 = l3.data.data.token;

  const badStatus = await api('PUT', '/api/event', { status: 'nonsense' }, t3);
  check('非法状态被拒绝', badStatus.status === 400, badStatus.status);

  const badDate = await api('PUT', '/api/event', { eventDate: 'not-a-date' }, t3);
  check('非法日期被拒绝', badDate.status === 400, badDate.status);

  const emptyColleges = await api('PUT', '/api/event', { colleges: [] }, t3);
  check('空学院列表被拒绝', emptyColleges.status === 400, emptyColleges.status);

  const origCfg = (await api('GET', '/api/event/config')).data.data;
  const newDeadline = '2027-03-01T18:00:00.000Z';
  const upd = await api('PUT', '/api/event', {
    regDeadline: newDeadline,
    colleges: ['测试学院A', '测试学院B'],
    rules: '测试须知。第二句。'
  }, t3);
  check('更新赛事配置', upd.status === 200 && upd.data.ok, upd.data.error);

  const after2 = (await api('GET', '/api/event/config')).data.data;
  check('截止时间已生效', new Date(after2.regDeadline).getTime() === new Date(newDeadline).getTime(), after2.regDeadline);
  check('学院列表已生效', after2.colleges.length === 2 && after2.colleges[0] === '测试学院A', JSON.stringify(after2.colleges));
  check('须知已生效', after2.rules === '测试须知。第二句。', after2.rules);

  // 报名关闭：开关关掉后应拒绝新报名
  await api('PUT', '/api/event', { regOpen: false }, t3);
  const closedReg = await api('POST', '/api/participants', {
    sid: '9' + String(Date.now()).slice(-9), name: '关闭测试', college: '测试学院A', group: 'competition'
  });
  check('关闭报名后拒绝新报名', closedReg.status === 400 && closedReg.data.code === 'REG_CLOSED', JSON.stringify(closedReg.data));

  // 恢复
  await api('PUT', '/api/event', {
    regDeadline: origCfg.regDeadline,
    colleges: origCfg.colleges,
    rules: origCfg.rules,
    regOpen: true
  }, t3);
  const restored = (await api('GET', '/api/event/config')).data.data;
  check('配置已恢复', restored.colleges.length === origCfg.colleges.length, restored.colleges.length);

  console.log('\n【13】权限边界（补充）');
  const viewerPut = await api('PUT', '/api/event', { name: 'x' });
  check('未登录不能改赛事配置', viewerPut.status === 401, viewerPut.status);

  await api('POST', '/api/admin/logout', {}, t3);

  // 清理测试数据
  const login2 = await api('POST', '/api/admin/login', { username: USER, password: PASS });
  const t2 = login2.data.data.token;
  if (pid) await api('DELETE', `/api/participants/${pid}`, null, t2);
  console.log('\n（已清理本次测试数据）');

  console.log(`\n${'='.repeat(46)}`);
  console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
  console.log(`${'='.repeat(46)}\n`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('\n测试异常：', e.message);
  process.exit(1);
});
