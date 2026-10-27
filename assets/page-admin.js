/* 管理员登录 + 后台首页 */
(function () {
  'use strict';
  var U = window.U;

  /* ================= 登录 ================= */
  function AdminLoginPage() {
    return {
      html: '' +
        '<div class="page">' +
        '<div class="navbar"><div class="back" data-back>‹</div><div class="nav-title">管理员登录</div></div>' +
        '<div class="pad mt16">' +
        '  <div class="card">' +
        '    <div class="title" style="font-size:18px">管理员验证</div>' +
        '    <div class="small muted mt8">路线编辑与赛事数据仅管理员可访问</div>' +
        '    <div class="field mt16"><label>用户名</label>' +
        '      <input class="input" id="al-user" placeholder="admin" autocomplete="username" value="admin">' +
        '    </div>' +
        '    <div class="field"><label>密码</label>' +
        '      <input class="input" id="al-pass" type="password" placeholder="请输入密码" autocomplete="current-password">' +
        '    </div>' +
        '    <button class="btn mt8" id="al-go">登录</button>' +
        '    <div class="small muted mt12" id="al-tip"></div>' +
        '  </div>' +
        '  <div class="card small muted" style="line-height:1.8" id="al-note"></div>' +
        '</div></div>',

      mount: function (el) {
        el.querySelector('[data-back]').onclick = function () { Router.back(); };
        var userEl = el.querySelector('#al-user');
        var passEl = el.querySelector('#al-pass');
        var tipEl = el.querySelector('#al-tip');
        var noteEl = el.querySelector('#al-note');
        var btn = el.querySelector('#al-go');

        function renderNote(online) {
          if (online) {
            tipEl.textContent = '服务端验证 · 会话 8 小时有效';
            noteEl.innerHTML = '<b style="color:var(--ink-2)">安全说明</b><br>' +
              '密码由服务端 scrypt 校验，会话 token 存在 HttpOnly Cookie 里，前端脚本读不到。<br>' +
              '所有写接口都会在服务端二次校验角色，学生伪造请求也会被拒绝。';
          } else {
            tipEl.innerHTML = '<span style="color:var(--danger)">未连接后端，降级为本地口令模式</span>';
            noteEl.innerHTML = '<b style="color:var(--ink-2)">⚠️ 降级模式</b><br>' +
              '当前没连上后端服务，只能用 config.js 里的本地口令登录，<b>不安全</b>。<br>' +
              '请先启动 <code>node server/index.js</code> 再访问本页。';
          }
        }

        if (window.API) window.API.probe().then(renderNote);
        else renderNote(false);

        function go() {
          btn.disabled = true;
          btn.textContent = '登录中…';
          AdminAuth.login(userEl.value.trim(), passEl.value).then(function (r) {
            btn.disabled = false;
            btn.textContent = '登录';
            if (!r.ok) { U.toast(r.msg); passEl.select(); return; }
            U.haptic('ok');
            U.toast('登录成功');
            Router.go('admin-home', { replace: true });
          });
        }
        btn.onclick = go;
        passEl.onkeydown = function (e) { if (e.key === 'Enter') go(); };
        setTimeout(function () { passEl.focus(); }, 300);
      }
    };
  }

  /* ================= 后台首页 ================= */
  function AdminHomePage() {
    if (!AdminAuth.guard(Router)) return { html: '' };

    var course = CourseStore.load();
    var plan = CampusPlanLayer.load();
    var planReady = !!(plan.transform && plan.controlPoints.length >= 2);
    var regs = DB.listRegs();
    var lb = DB.leaderboard('all');
    var evCfg = window.EventStore.get();
    var evLine = (window.EventStore.regOpen() ? '报名中' : '已关闭') +
      ' · ' + window.EventStore.formatDate(evCfg.eventDate);

    return {
      html: '' +
        '<div class="page">' +
        '<div class="navbar"><div class="back" data-back>‹</div><div class="nav-title">管理后台</div>' +
        '  <div class="grow"></div><div class="small" id="ad-logout" style="padding:0 14px;color:var(--ink-3);cursor:pointer">退出</div></div>' +
        '<div class="pad mt12">' +

        '  <div class="card" style="border-left:3px solid var(--brand)">' +
        '    <div class="row between"><div class="strong">比赛路线</div>' +
        '      <span class="badge' + (course ? '' : ' gray') + '">' + (course ? '已配置' : '未配置') + '</span></div>' +
        '    <div class="small muted mt8">' +
        (course
          ? course.route.points.length + ' 个途经点 · ' + U.fmtDist(course.meta.distance) +
            ' · ' + course.checkpoints.filter(function (c) { return c.lnglat; }).length + '/6 打卡点'
          : '尚未绘制比赛路线，学生端地图将只显示校园底图') +
        '    </div>' +
        '    <button class="btn mt12" id="ad-course">' + (course ? '编辑比赛路线' : '绘制比赛路线') + '</button>' +
        '  </div>' +

        '  <div class="action-grid mt12">' +
        '    <div class="action-tile" id="ad-regs"><div class="ic">📋</div>' +
        '      <div class="t">报名名单</div><div class="d">' + regs.length + ' 条</div></div>' +
        '    <div class="action-tile" id="ad-stat"><div class="ic">📊</div>' +
        '      <div class="t">数据统计</div><div class="d">' + lb.length + ' 人完赛</div></div>' +
        '    <div class="action-tile" id="ad-event"><div class="ic">🗓️</div>' +
        '      <div class="t">赛事设置</div><div class="d" id="ad-event-d">' + evLine + '</div></div>' +
        '  </div>' +

        '  <div class="section-title">实地工具</div>' +
        '  <div class="action-grid">' +
        '    <div class="action-tile" id="ad-survey"><div class="ic">🧭</div>' +
        '      <div class="t">实地路线采集</div><div class="d">拿手机走一遍真实路线</div></div>' +
        '    <div class="action-tile" id="ad-gpstest"><div class="ic">📡</div>' +
        '      <div class="t">定位精度测试</div><div class="d">检查 GPS 是否可靠</div></div>' +
        '  </div>' +

        '  <div class="section-title">参考图层</div>' +
        '  <div class="card" style="border-left:3px solid var(--warn)">' +
        '    <div class="row between"><div class="strong">校园规划参考图</div>' +
        '      <span class="badge' + (planReady ? '' : ' gray') + '">' + (planReady ? '已配准（参考级）' : '未配准') + '</span></div>' +
        '    <div class="small muted mt8">实体沙盘模型照片 · 与卫星图偏差约 100–150 米 · <b>不可作为路线依据</b></div>' +
        '    <button class="btn ghost mt12" id="ad-plan">配准参考图</button>' +
        '  </div>' +
        '  <div class="card small muted mt12" style="line-height:1.8">' +
        '    <b style="color:var(--ink-2)">建议流程</b><br>' +
        '    1. 先做「定位精度测试」，确认手机在校园里的精度（最好 ≤10m）<br>' +
        '    2. 用「实地路线采集」沿真实路线走 2–3 次<br>' +
        '    3. 进「比赛路线编辑器」载入采集记录作为参考，逐点核验后发布' +
        '  </div>' +

        '  <div class="section-title">系统状态</div>' +
        '  <div class="card small" style="line-height:2;color:var(--ink-2)">' +
        '    <div class="row between"><span>后端服务</span><b id="ad-backend">检测中…</b></div>' +
        '    <div class="row between"><span>地图引擎</span><b id="ad-engine">检测中…</b></div>' +
        '    <div class="row between"><span>高德 Key</span><b>' + (window.AppConfig.hasAmapKey() ? '已配置' : '<span style="color:var(--warn)">未配置（降级底图）</span>') + '</b></div>' +
        '    <div class="row between"><span>鉴权方式</span><b>' + (AdminAuth.isServerMode() ? '服务端会话' : '本地口令（仅演示）') + '</b></div>' +
        '    <div class="row between"><span>数据持久化</span><b id="ad-store">检测中…</b></div>' +
        '    <div class="row between"><span>当前账号</span><b>' + ((AdminAuth.adminInfo() || {}).username || '-') + '</b></div>' +
        '  </div>' +

        '  <div class="small muted center mt16" style="padding:0 12px 20px">' +
        '    ' + (window.API && window.API.isOnline() ? '路线与赛事数据均保存在服务端 SQLite，多设备同步。' :
          '当前未连接服务端，路线暂存浏览器 localStorage，换设备不会同步。') +
        '  </div>' +
        '</div></div>',

      mount: function (el) {
        el.querySelector('[data-back]').onclick = function () { Router.go('profile'); };
        el.querySelector('#ad-logout').onclick = function () {
          AdminAuth.logout(); U.toast('已退出'); Router.go('profile', { replace: true });
        };
        el.querySelector('#ad-course').onclick = function () { Router.go('admin-course'); };
        el.querySelector('#ad-event').onclick = function () { Router.go('admin-event'); };
        el.querySelector('#ad-regs').onclick = function () { Router.go('admin'); };
        el.querySelector('#ad-stat').onclick = function () { Router.go('night-admin'); };
        el.querySelector('#ad-survey').onclick = function () { Router.go('survey'); };
        el.querySelector('#ad-gpstest').onclick = function () { Router.go('gps-test'); };
        el.querySelector('#ad-plan').onclick = function () { Router.go('plan-register'); };
        window.addEventListener('app:resize', function () {});

        // 赛事设置卡片：拉到最新配置后刷新文案
        window.EventStore.refresh().then(function () {
          if (!el.isConnected) return;
          var d = el.querySelector('#ad-event-d');
          if (!d) return;
          var cfg = window.EventStore.get();
          d.textContent = (window.EventStore.regOpen() ? '报名中' : '已关闭') +
            ' · ' + window.EventStore.formatDate(cfg.eventDate);
        });

        // 后端状态
        if (window.API) {
          window.API.probe().then(function (online) {
            var be = el.querySelector('#ad-backend');
            var st = el.querySelector('#ad-store');
            if (!be) return;
            if (online) {
              be.innerHTML = '<span style="color:var(--brand)">已连接</span>';
              st.textContent = 'SQLite 数据库';
            } else {
              be.innerHTML = '<span style="color:var(--danger)">未连接</span>';
              st.textContent = '浏览器本地（临时）';
            }
          });
        }

        var engineEl = el.querySelector('#ad-engine');
        if (MapEngine.kind()) engineEl.textContent = MapEngine.kind() === 'amap' ? '高德 JSAPI 2.0' : '瓦片降级';
        else {
          MapEngine.loadAMap().then(function () {
            if (engineEl) engineEl.textContent = '高德 JSAPI 2.0';
          }).catch(function () {
            if (engineEl) engineEl.innerHTML = '<span style="color:var(--warn)">瓦片降级</span>';
          });
        }
      }
    };
  }

  window.Pages = window.Pages || {};
  window.Pages['admin-login'] = AdminLoginPage;
  window.Pages['admin-home'] = AdminHomePage;
})();
