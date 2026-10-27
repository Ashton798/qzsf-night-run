/* 页面 */
(function () {
  'use strict';
  var U = window.U, DB = window.DB, C = window.CAMPUS, G = window.GROUPS;

  /* 组别名：以服务端配置为准，缺失时回退静态表 */
  function gName(key) {
    var groups = (window.EventStore && window.EventStore.groups()) || G || {};
    return (groups[key] && groups[key].name) || key || '-';
  }
  var trackBuffer = [];          // 待上传的轨迹点
  window.__trackBuffer = trackBuffer;

  /* ================= 首页 ================= */
  function HomePage() {
    var reg = DB.getReg();
    var ci = DB.getCheckin();
    var run = DB.getRun();
    var st = DB.stats();
    var EV = window.EventStore;
    var ev = EV.get();
    var open = EV.regOpen();
    var dl = EV.deadlineState(ev.regDeadline);

    var tiles = [
      { ic: '📝', t: reg ? '我的报名' : '立即报名', d: reg ? (ev.groups[reg.group] || {}).name + ' · ' + reg.name : '学号 / 学院 / 姓名', act: 'register', dis: !reg && !open },
      { ic: '📍', t: '现场签到', d: ci ? '已签到 ' + U.fmtClock(ci.ts - new Date().setHours(0, 0, 0, 0)) : '需到达起点 80m 内', act: 'checkin', dis: !reg },
      { ic: '🏃', t: '开始定向跑', d: run ? '已完成 · ' + U.fmtTime(run.elapsedMs) : '6 个打卡点 · 约 3.5km', act: 'run', dis: !ci },
      { ic: '🗺️', t: '校园地图', d: '查看路线与实时定位', act: 'map' },
      { ic: '🏆', t: '成绩排行', d: '实时榜单', act: 'rank' },
      { ic: '📡', t: '定位精度测试', d: '实地测 GPS 表现', act: 'gps-test' }
    ];

    function pillHtml() {
      if (!open) return '<div class="status-pill"><i style="background:#ffb4b4"></i>' + EV.regClosedText() + '</div>';
      return '<div class="status-pill"><i></i>' + (ev.statusText || '报名进行中') +
        ' · 截止 ' + EV.formatDeadline(ev.regDeadline) +
        (dl.text && !dl.closed ? '（' + dl.text + '）' : '') + '</div>';
    }

    return {
      html: '' +
        '<div class="page">' +
        '  <div class="hero">' +
        '    <div class="h-name">校园定向跑</div>' +
        '    <div class="h-sub">' + (ev.campus.name || '') + ' · ' + (ev.subtitle || ev.name) + '</div>' +
        '    <div class="h-meta">' +
        '      <div><b>' + st.total + '</b>报名</div>' +
        '      <div><b>' + st.checked + '</b>签到</div>' +
        '      <div><b>' + st.finished + '</b>完赛</div>' +
        '    </div>' +
        '    <div id="home-pill">' + pillHtml() + '</div>' +
        '  </div>' +
        '  <div class="pad mt16">' +
        '    <div class="card" style="display:flex;align-items:center;gap:12px">' +
        '      <div style="font-size:26px">🗓️</div>' +
        '      <div class="grow">' +
        '        <div class="strong" id="home-date">' + EV.formatDate(ev.eventDate) + '</div>' +
        '        <div class="small muted" id="home-meta">起点：' + (ev.startName || '起点') +
        ' · 关门时间 ' + (ev.closeMinutes || 90) + ' 分钟</div>' +
        '      </div>' +
        '    </div>' +
        '    <div class="action-grid mt12">' +
        tiles.map(function (t) {
          return '<div class="action-tile' + (t.dis ? ' disabled' : '') + '" data-act="' + t.act + '">' +
            '<div class="ic">' + t.ic + '</div>' +
            '<div class="t">' + t.t + '</div>' +
            '<div class="d">' + t.d + '</div></div>';
        }).join('') +
        '    </div>' +
        '    <div class="section-title">赛事须知</div>' +
        '    <div class="card small" style="color:var(--ink-2);line-height:1.8" id="home-rules">' +
        EV.rulesLines().map(function (line) { return '      · ' + line; }).join('<br>') +
        '    </div>' +
        '  </div>' +
        '  <div class="mt24"></div>' +
        '</div>',

      mount: function (el) {
        // 从后端拉真实统计，覆盖初始渲染
        DB.statsAsync().then(function (st2) {
          if (!el.isConnected) return;
          var meta = el.querySelector('.h-meta');
          if (!meta) return;
          meta.innerHTML =
            '<div><b>' + st2.total + '</b>报名</div>' +
            '<div><b>' + st2.checked + '</b>签到</div>' +
            '<div><b>' + st2.finished + '</b>完赛</div>';
        });

        // 赛事配置：先用缓存渲染，拉到服务端后原地刷新
        var off = EV.onChange(function (cfg) {
          if (!el.isConnected) { off(); return; }
          var pill = el.querySelector('#home-pill');
          if (pill) pill.innerHTML = pillHtml();
          var dateEl = el.querySelector('#home-date');
          if (dateEl) dateEl.textContent = EV.formatDate(cfg.eventDate);
          var metaEl = el.querySelector('#home-meta');
          if (metaEl) metaEl.textContent = '起点：' + (cfg.startName || '起点') +
            ' · 关门时间 ' + (cfg.closeMinutes || 90) + ' 分钟';
          var rulesEl = el.querySelector('#home-rules');
          if (rulesEl) {
            rulesEl.innerHTML = EV.rulesLines().map(function (line) { return '      · ' + line; }).join('<br>');
          }
          // 报名关闭时禁用报名入口
          var regTile = el.querySelector('[data-act="register"]');
          if (regTile && !DB.getReg()) regTile.classList.toggle('disabled', !EV.regOpen());
        });
        EV.refresh();
        el._offEvent = off;

        // 首次进入引导（只在首页停留时展示）
        if (!U.load('guide_done', false)) {
          U.save('guide_done', true);
          var guideTimer = setTimeout(function () {
            if (Router.currentName && Router.currentName() !== 'home') return;
            var mask = document.createElement('div');
            mask.className = 'sheet-mask';
            mask.innerHTML = '<div class="sheet">' +
              '<h3>欢迎参加校园定向跑 🏃</h3>' +
              '<div class="small muted">' + C.name + ' · 全程约 3.5km · 6 个打卡点</div>' +
              '<div class="mt16" style="line-height:2;font-size:14px;color:var(--ink-2)">' +
              '<div>1️⃣ 报名：填写学号 / 学院 / 姓名，选择组别</div>' +
              '<div>2️⃣ 签到：活动当天到达起点 80m 内签到</div>' +
              '<div>3️⃣ 起跑：点击开始，GPS 自动记录轨迹与用时</div>' +
              '<div>4️⃣ 打卡：经过 6 个检查点，全部完成后成绩有效</div>' +
              '</div>' +
              '<div class="small muted mt16" style="background:#fff6e8;padding:10px;border-radius:10px;color:#8a5a00">' +
              '⚠️ 跑步中请保持小程序在前台、不要锁屏，否则系统会中断定位。</div>' +
              '<button class="btn mt16" id="guide-ok">知道了</button>' +
              '</div>';
            document.body.appendChild(mask);
            mask.querySelector('#guide-ok').onclick = function () { mask.remove(); };
            mask.onclick = function (e) { if (e.target === mask) mask.remove(); };
          }, 300);
          el._guideTimer = guideTimer;
        }

        el.querySelectorAll('.action-tile').forEach(function (n) {
          n.onclick = function () {
            if (n.classList.contains('disabled')) {
              U.toast(n.dataset.act === 'checkin' ? '请先完成报名' : '请先完成签到');
              return;
            }
            Router.go(n.dataset.act);
          };
        });
      },

      unmount: function () {
        if (this._offEvent) { this._offEvent(); this._offEvent = null; }
        if (this._guideTimer) { clearTimeout(this._guideTimer); this._guideTimer = null; }
      }
    };
  }

  /* ================= 报名 ================= */
  function RegisterPage() {
    var old = DB.getReg();
    var state = {
      group: old ? old.group : 'competition',
      sid: old ? old.sid : '',
      name: old ? old.name : '',
      college: old ? old.college : '',
      phone: old ? (old.phone || '') : '',
      pName: old && old.partner ? old.partner.name : '',
      pSid: old && old.partner ? old.partner.sid : '',
      pCollege: old && old.partner ? old.partner.college : ''
    };

    var EV = window.EventStore;
    var ev = EV.get();

    function collegeOptions(sel) {
      return '<option value="">请选择学院</option>' +
        EV.colleges().map(function (c) {
          return '<option' + (c === sel ? ' selected' : '') + '>' + c + '</option>';
        }).join('');
    }

    function body() {
      var isUnity = state.group === 'unity';
      var groups = EV.groups();
      return '' +
        '<div class="section-title" style="padding-top:4px">选择组别</div>' +
        '<div class="group-list">' +
        Object.keys(groups).map(function (k) {
          var g = groups[k];
          return '<div class="group-item' + (state.group === k ? ' on' : '') + '" data-g="' + k + '">' +
            '<div class="dot"></div><div class="grow">' +
            '<div class="g-name">' + g.name + '</div>' +
            '<div class="g-desc">' + g.desc + '</div></div></div>';
        }).join('') +
        '</div>' +
        '<div class="section-title">本人信息</div>' +
        '<div class="field"><label>学号<span class="req">*</span></label>' +
        '<input class="input" id="f-sid" inputmode="numeric" maxlength="12" placeholder="请输入学号" value="' + state.sid + '"></div>' +
        '<div class="field"><label>姓名<span class="req">*</span></label>' +
        '<input class="input" id="f-name" maxlength="12" placeholder="请输入真实姓名" value="' + state.name + '"></div>' +
        '<div class="field"><label>学院<span class="req">*</span></label>' +
        '<select class="select" id="f-college">' + collegeOptions(state.college) + '</select></div>' +
        '<div class="field"><label>手机号</label>' +
        '<input class="input" id="f-phone" inputmode="numeric" maxlength="11" placeholder="选填，便于赛事联系" value="' + state.phone + '"></div>' +
        (isUnity ? '' +
          '<div class="section-title">队友信息（同心组需 2 人）</div>' +
          '<div class="card" style="background:#fafbfa;box-shadow:none;border:1px dashed #d8e0dc">' +
          '<div class="field"><label>队友学号<span class="req">*</span></label>' +
          '<input class="input" id="f-psid" inputmode="numeric" maxlength="12" placeholder="队友学号" value="' + state.pSid + '"></div>' +
          '<div class="field"><label>队友姓名<span class="req">*</span></label>' +
          '<input class="input" id="f-pname" maxlength="12" placeholder="队友姓名" value="' + state.pName + '"></div>' +
          '<div class="field" style="margin-bottom:0"><label>队友学院<span class="req">*</span></label>' +
          '<select class="select" id="f-pcollege">' + collegeOptions(state.pCollege) + '</select></div>' +
          '</div>' +
          '<div class="small muted mt8">同心组两人同时出发、同时到达，成绩取较慢者。</div>'
          : '') +
        '<div style="height:16px"></div>';
    }

    return {
      html: '<div class="page">' +
        '<div class="navbar"><div class="back" data-back>‹</div><div class="nav-title">赛事报名</div></div>' +
        '<div class="pad mt12">' +
        (EV.regOpen() || old ? '' : '<div class="card" style="background:#fff6f6;border-left:3px solid var(--danger);box-shadow:none">' +
          '<div class="strong" style="color:var(--danger)">' + EV.regClosedText() + '</div>' +
          '<div class="small muted mt8">报名通道已关闭，如已报名可继续查看或修改信息。</div></div>') +
        '<div id="reg-body">' + body() + '</div>' +
        '<button class="btn" id="btn-submit"' + ((EV.regOpen() || old) ? '' : ' disabled') + '>' +
        (old ? '保存修改' : '提交报名') + '</button>' +
        '<div class="small muted center mt12" style="padding-bottom:16px">提交即表示同意赛事规程与定位采集说明</div>' +
        '</div></div>',

      mount: function (el) {
        el.querySelector('[data-back]').onclick = function () { Router.back(); };

        function sync() {
          el.querySelectorAll('#f-sid,#f-name,#f-college,#f-phone,#f-psid,#f-pname,#f-pcollege').forEach(function (n) {
            var m = { 'f-sid': 'sid', 'f-name': 'name', 'f-college': 'college', 'f-phone': 'phone',
              'f-psid': 'pSid', 'f-pname': 'pName', 'f-pcollege': 'pCollege' };
            if (m[n.id]) state[m[n.id]] = n.value;
          });
        }

        el.querySelectorAll('.group-item').forEach(function (n) {
          n.onclick = function () {
            sync();
            state.group = n.dataset.g;
            el.querySelector('#reg-body').innerHTML = body();
            bind();
          };
        });

        function bind() {
          el.querySelectorAll('.group-item').forEach(function (n) {
            n.onclick = function () {
              sync();
              state.group = n.dataset.g;
              el.querySelector('#reg-body').innerHTML = body();
              bind();
            };
          });
          el.querySelectorAll('#f-sid,#f-name,#f-college,#f-phone,#f-psid,#f-pname,#f-pcollege').forEach(function (n) {
            n.addEventListener('change', sync);
            n.addEventListener('blur', sync);
          });
        }
        bind();

        // 学院 / 组别以服务端为准：拉到新配置后重建表单（保留已填内容）
        var offReg = EV.onChange(function () {
          if (!el.isConnected) { offReg(); return; }
          sync();
          var groups = EV.groups();
          if (!groups[state.group]) state.group = Object.keys(groups)[0] || 'competition';
          el.querySelector('#reg-body').innerHTML = body();
          bind();
        });
        EV.refresh();
        el._offEvent = offReg;

        el.querySelector('#btn-submit').onclick = function () {
          sync();
          var errs = [];
          if (!/^\d{6,12}$/.test(state.sid)) errs.push(['f-sid', '学号应为 6-12 位数字']);
          if (state.name.trim().length < 2) errs.push(['f-name', '请填写姓名']);
          if (!state.college) errs.push(['f-college', '请选择学院']);
          if (state.phone && !/^1\d{10}$/.test(state.phone)) errs.push(['f-phone', '手机号格式不正确']);
          if (state.group === 'unity') {
            if (!/^\d{6,12}$/.test(state.pSid)) errs.push(['f-psid', '队友学号应为 6-12 位数字']);
            if (state.pName.trim().length < 2) errs.push(['f-pname', '请填写队友姓名']);
            if (!state.pCollege) errs.push(['f-pcollege', '请选择队友学院']);
            if (state.pSid === state.sid) errs.push(['f-psid', '队友学号不能与自己相同']);
          }
          el.querySelectorAll('.err').forEach(function (n) { n.classList.remove('err'); });
          el.querySelectorAll('.err-msg').forEach(function (n) { n.remove(); });
          if (errs.length) {
            errs.forEach(function (e) {
              var n = el.querySelector('#' + e[0]);
              if (!n) return;
              n.classList.add('err');
              var tip = document.createElement('div');
              tip.className = 'err-msg';
              tip.textContent = e[1];
              n.parentNode.appendChild(tip);
            });
            var f = el.querySelector('#' + errs[0][0]);
            if (f) f.scrollIntoView({ block: 'center', behavior: 'smooth' });
            U.toast(errs[0][1]);
            return;
          }

          var payload = {
            sid: state.sid,
            name: state.name.trim(),
            college: state.college,
            phone: state.phone,
            group: state.group,
            partner: state.group === 'unity' ? {
              sid: state.pSid, name: state.pName.trim(), college: state.pCollege
            } : null
          };

          var btn = el.querySelector('#btn-submit');
          btn.disabled = true;
          btn.textContent = '提交中…';

          DB.submitRegistration(payload).then(function (res) {
            btn.disabled = false;
            btn.textContent = old ? '保存修改' : '提交报名';

            if (!res.ok) {
              U.toast(res.error || '报名失败');
              if (res.code === 'REG_CLOSED') U.toast('报名已截止');
              return;
            }
            U.haptic('ok');
            if (res.existed) U.toast('该学号已报名，已为你找回记录');
            else if (res.offline) U.toast('已保存到本机（未连接服务器）');
            else U.toast(old ? '修改已保存' : '报名成功 🎉');
            setTimeout(function () { Router.go('checkin', { replace: true }); }, 700);
          });
        };
      },

      unmount: function () {
        if (this._offEvent) { this._offEvent(); this._offEvent = null; }
      }
    };
  }

  /* ================= 签到 ================= */
  function CheckinPage() {
    var reg = DB.getReg();
    if (!reg) { setTimeout(function () { Router.go('register', { replace: true }); }, 0); return { html: '' }; }

    var ci = DB.getCheckin();
    var S = C.course.start;
    var map, me = null, watchId = null, curDist = null;

    function distText(d) {
      if (d == null) return '定位中…';
      return d > 1000 ? (d / 1000).toFixed(1) + ' km' : Math.round(d) + ' m';
    }

    return {
      html: '' +
        '<div class="page">' +
        '<div class="navbar"><div class="back" data-back>‹</div><div class="nav-title">现场签到</div></div>' +
        '<div class="map-wrap" style="min-height:300px">' +
        '  <div id="map"></div>' +
        '  <div class="map-float bottom" id="ci-panel">' +
        '    <div class="row between">' +
        '      <div>' +
        '        <div class="strong">' + S.name + '</div>' +
        '        <div class="small muted">签到范围 ' + S.radius + ' 米内</div>' +
        '      </div>' +
        '      <div class="center" style="min-width:78px">' +
        '        <div style="font-size:20px;font-weight:700;font-variant-numeric:tabular-nums" id="ci-dist">--</div>' +
        '        <div class="small muted">距起点</div>' +
        '      </div>' +
        '    </div>' +
        '    <div class="mt12" id="ci-action"></div>' +
        '  </div>' +
        '</div>' +
        '<div class="pad mt12">' +
        '  <div class="card">' +
        '    <div class="row between"><span class="muted small">报名信息</span>' +
        '      <span class="badge">' + gName(reg.group) + '</span></div>' +
        '    <div class="mt8 strong">' + reg.name + ' <span class="muted small">' + reg.sid + '</span></div>' +
        '    <div class="small muted">' + reg.college + '</div>' +
        (reg.partner ? '<div class="small muted mt8">队友：' + reg.partner.name + ' · ' + reg.partner.college + '</div>' : '') +
        '  </div>' +
        '</div></div>',

      mount: function (el) {
        el.querySelector('[data-back]').onclick = function () { Router.back(); };

        var mapEl = document.getElementById('map');
        MapEngine.create(mapEl, { zoom: 17 }).then(function (m) {
          if (!el.isConnected) { m.destroy(); return; }
          map = m;
          drawCheckinMap();
        }).catch(function (err) { MapEngine.renderError(mapEl, err); });

        function drawCheckinMap() {
          if (!map) return;
          var c = CourseStore.load();
          var startPt = (c && c.route && c.route.start) ? c.route.start : null;
          // 优先用管理员配置的起点
          if (startPt) {
            S = { name: '起点', lat: startPt[1], lng: startPt[0], radius: (c.route.startRadius || 80) };
          }
          // 路线
          if (c && c.route.points && c.route.points.length >= 2) {
            map.addPolyline(c.route.points, { strokeColor: '#ffffff', strokeWeight: 9, zIndex: 55 });
            map.addPolyline(c.route.points, { strokeColor: '#0f9d76', strokeWeight: 4.5, zIndex: 60 });
          }
          // 起点
          map.addCircle([S.lng, S.lat], S.radius, {
            strokeColor: '#0f9d76', strokeWeight: 2, fillColor: '#0f9d76', fillOpacity: .12
          });
          map.addMarker({
            position: [S.lng, S.lat],
            html: '<div class="pin-start">起</div>',
            iconSize: [32, 32], iconAnchor: [16, 16], zIndex: 120
          });
          map.setCenter(S.lng, S.lat, 17);
        }

        var actionBox = el.querySelector('#ci-action');

        function renderAction() {
          if (ci) {
            actionBox.innerHTML = '<div class="row gap12" style="background:var(--brand-light);border-radius:12px;padding:12px">' +
              '<div style="font-size:22px">✅</div>' +
              '<div class="grow"><div class="strong" style="color:var(--brand-dark)">签到成功</div>' +
              '<div class="small" style="color:var(--brand-dark);opacity:.8">' + U.fmtDate(ci.ts) + ' · 距起点 ' + Math.round(ci.distToStart) + 'm</div></div>' +
              '</div>' +
              '<button class="btn mt12" id="btn-go-run">进入起跑页</button>';
            el.querySelector('#btn-go-run').onclick = function () { Router.go('run'); };
            return;
          }
          var inRange = curDist != null && curDist <= S.radius;
          actionBox.innerHTML = '<button class="btn" id="btn-ci" ' + (inRange ? '' : 'disabled') + '>' +
            (inRange ? '点击签到' : '请前往起点（' + distText(curDist) + '）') + '</button>' +
            '<div class="small muted center mt8">演示环境可点「模拟到达起点」</div>' +
            '<button class="btn outline sm mt8" id="btn-fake">模拟到达起点</button>';
          var b = el.querySelector('#btn-ci');
          if (b && inRange) {
            b.onclick = function () {
              b.disabled = true;
              b.textContent = '签到中…';
              var geo = Geo.snapshot();
              DB.submitCheckin({
                lat: geo.last ? geo.last.gcj[0] : S.lng,
                lng: geo.last ? geo.last.gcj[1] : S.lat,
                accuracy: geo.last ? geo.last.accuracy : null,
                distToStart: curDist || 0,
                method: 'gps'
              }).then(function (res) {
                if (!res.ok) {
                  U.toast(res.error || '签到失败');
                  b.disabled = false;
                  b.textContent = '点击签到';
                  return;
                }
                ci = res.data;
                U.haptic('ok');
                U.toast(res.offline ? '已签到（本机记录）' : '签到成功');
                renderAction();
              });
            };
          }
          el.querySelector('#btn-fake').onclick = function () {
            curDist = 12;
            el.querySelector('#ci-dist').textContent = distText(curDist);
            renderAction();
            U.toast('已模拟到达起点');
          };
        }

        renderAction();

        // 复用统一的定位模块（含 WGS84→GCJ02 转换与状态提示）
        Geo.onUpdate = function (snap) {
          if (!el.isConnected) return;
          if (snap.last) {
            var gcjPt = [snap.last.gcj[1], snap.last.gcj[0]];   // [lat,lng]
            curDist = U.dist(gcjPt, [S.lat, S.lng]);
            if (map) {
              if (!me) {
                me = map.addMarker({
                  position: [snap.last.gcj[0], snap.last.gcj[1]],
                  html: '<div class="me-pin"><span></span></div>',
                  iconSize: [28, 28], iconAnchor: [14, 14], zIndex: 200
                });
              } else me.setPosition([snap.last.gcj[0], snap.last.gcj[1]]);
            }
            var dEl = el.querySelector('#ci-dist');
            if (dEl) dEl.textContent = distText(curDist);
            renderAction();
          }
        };
        Geo.start();
      },

      unmount: function () {
        Geo.onUpdate = null;
        Geo.stop();
        if (map) { map.destroy(); map = null; }
      }
    };
  }

  /* ================= 起跑 / 计时 ================= */
  function RunPage() {
    var reg = DB.getReg();
    if (!reg) { setTimeout(function () { Router.go('register', { replace: true }); }, 0); return { html: '' }; }
    var ci = DB.getCheckin();
    if (!ci) { setTimeout(function () { Router.go('checkin', { replace: true }); }, 0); return { html: '' }; }

    var map, me = null, track = null, started = false;
    var demo = !navigator.geolocation || !window.isSecureContext;
    var wakeLock = null;

    // 屏幕常亮：避免锁屏导致定位中断
    function keepAwake(on) {
      try {
        if (on && navigator.wakeLock && navigator.wakeLock.request) {
          navigator.wakeLock.request('screen').then(function (w) {
            wakeLock = w;
            w.addEventListener('release', function () { wakeLock = null; });
          }).catch(function () {});
        } else if (wakeLock) {
          wakeLock.release(); wakeLock = null;
        }
      } catch (e) {}
    }

    return {
      html: '' +
        '<div class="page">' +
        '<div class="map-wrap">' +
        '  <div id="map"></div>' +
        '  <div class="map-fab" style="top:12px" id="fab-loc">◎</div>' +
        '  <div class="map-float top" id="run-top">' +
        '    <div class="mode-switch" id="mode-sw">' +
        '      <div data-m="demo">模拟跑（演示）</div>' +
        '      <div data-m="real">真实 GPS</div>' +
        '    </div>' +
        '    <div class="row between" style="align-items:flex-start">' +
        '      <div>' +
        '        <div class="small muted">用时</div>' +
        '        <div class="timer-big" id="t-time">00:00.0</div>' +
        '      </div>' +
        '      <div class="center">' +
        '        <div class="small muted">已完成</div>' +
        '        <div style="font-size:22px;font-weight:700;color:var(--brand)" id="t-cp">0/6</div>' +
        '      </div>' +
        '    </div>' +
        '    <div class="stat-row">' +
        '      <div class="stat"><div class="k">距离</div><div class="v" id="t-dist">0 m</div></div>' +
        '      <div class="stat"><div class="k">配速</div><div class="v" id="t-pace">--\'--"</div></div>' +
        '      <div class="stat"><div class="k">下一打卡</div><div class="v" id="t-next" style="font-size:14px">--</div></div>' +
        '    </div>' +
        '    <div class="cp-list" id="t-cps"></div>' +
        '  </div>' +
        '  <div class="map-float bottom">' +
        '    <div id="run-actions"></div>' +
        '  </div>' +
        '</div></div>',

      mount: function (el) {
        var mapEl = document.getElementById('map');
        MapEngine.create(mapEl, { zoom: 16 }).then(function (m) {
          if (!el.isConnected) { m.destroy(); return; }
          map = m;
          drawRunMap();
        }).catch(function (err) { MapEngine.renderError(mapEl, err); });

        function drawRunMap() {
          var c = CourseStore.load();
          if (c && c.route.points && c.route.points.length >= 2) {
            map.addPolyline(c.route.points, { strokeColor: '#ffffff', strokeWeight: 9, zIndex: 55 });
            map.addPolyline(c.route.points, { strokeColor: '#0f9d76', strokeWeight: 4.5, zIndex: 60 });
            map.fitPoints(c.route.points, [30, 30, 140, 30], 18);
          }
          (c ? c.checkpoints : []).forEach(function (cp, i) {
            if (!cp.lnglat) return;
            map.addCircle(cp.lnglat, cp.radius || 30, {
              strokeColor: '#f5a623', strokeWeight: 1.5, fillColor: '#f5a623', fillOpacity: .12
            });
            map.addMarker({
              position: cp.lnglat,
              html: '<div class="pin-cp">' + (i + 1) + '</div>',
              iconSize: [26, 26], iconAnchor: [13, 13], zIndex: 110
            });
          });
        }

        var cpsEl = el.querySelector('#t-cps');
        function renderCps(snap) {
          var cfg = CourseStore.load();
          var list = (cfg && cfg.checkpoints.length) ? cfg.checkpoints : C.course.cps;
          cpsEl.innerHTML = list.map(function (cp) {
            var st = Runner.S.cps[cp.id] ? 'on' : (snap.nextCp && snap.nextCp.id === cp.id ? 'next' : '');
            return '<div class="cp-dot ' + st + '" title="' + cp.name + '"></div>';
          }).join('');
        }

        var mode = demo ? 'demo' : 'demo';   // 默认演示，可手动切真实定位
        function renderMode() {
          el.querySelectorAll('#mode-sw > div').forEach(function (n) {
            n.classList.toggle('on', n.dataset.m === mode);
            n.onclick = function () {
              if (Runner.isRunning()) { U.toast('请先结束当前跑步'); return; }
              mode = n.dataset.m;
              renderMode();
              U.toast(mode === 'real' ? '真实 GPS：需要授权定位' : '演示模式：沿路线自动行进');
            };
          });
        }
        renderMode();

        function renderActions() {
          var box = el.querySelector('#run-actions');
          var S = Runner.S;
          if (!S.running) {
            var ended = started || S.finishedAt;
            box.innerHTML = '<button class="btn" id="b-start" ' + (ended ? 'disabled' : '') + '>' +
              (ended ? '已结束' : '开始跑步') + '</button>' +
              '<div class="small muted center mt8">' +
              (mode === 'demo' ? '演示模式：沿预设路线模拟行进' : '开始后请保持屏幕常亮、勿锁屏') + '</div>';
            var b = el.querySelector('#b-start');
            if (ended) return;
            b.onclick = function () {
              started = true;
              keepAwake(true);
              b.disabled = true;
              b.textContent = '同步中…';
              DB.startRun(mode).then(function (res) {
                if (!res.ok) { U.toast(res.error || '无法开始比赛'); b.disabled = false; b.textContent = '开始跑步'; return; }
                Runner.start({ mode: mode });
                renderActions();
                U.toast(res.offline ? '计时开始（未连接服务器）' : '计时开始');
              });
            };
          } else if (S.paused) {
            box.innerHTML = '<div class="row gap8">' +
              '<button class="btn outline" id="b-stop" style="flex:1">结束</button>' +
              '<button class="btn" id="b-resume" style="flex:2">继续跑步</button></div>';
            el.querySelector('#b-resume').onclick = function () { Runner.resume(); renderActions(); };
            el.querySelector('#b-stop').onclick = function () { doFinish(el); };
          } else {
            box.innerHTML = '<div class="row gap8">' +
              '<button class="btn outline" id="b-pause" style="flex:1">暂停</button>' +
              '<button class="btn" id="b-finish" style="flex:2">结束跑步</button></div>';
            el.querySelector('#b-pause').onclick = function () { Runner.pause(); renderActions(); };
            el.querySelector('#b-finish').onclick = function () { doFinish(el); };
          }
        }

        Runner.onTick = function (snap, p, acc) {
          el.querySelector('#t-time').textContent = U.fmtTime(snap.elapsed);
          el.querySelector('#t-dist').textContent = U.fmtDist(snap.distance);
          el.querySelector('#t-pace').textContent = U.fmtPace(snap.elapsed, snap.distance);
          el.querySelector('#t-cp').textContent = snap.cpDone + '/' + snap.cpTotal;
          el.querySelector('#t-next').textContent = snap.nextCp ? snap.nextCp.name : '全部完成';
          renderCps(snap);
        };
        Runner.onPoint = function (p) {
          if (!map) return;
          var g = Coord.wgs2gcj(p[0], p[1]);      // [lat,lng]
          var ll = [g[1], g[0]];                  // [lng,lat]
          if (!track) {
            track = map.addPolyline([], { strokeColor: '#2b7fff', strokeWeight: 4, zIndex: 80 });
            track._pts = [];
          }
          track._pts.push(ll);
          track.setPath(track._pts);
          if (!me) {
            me = map.addMarker({
              position: ll, html: '<div class="me-pin"><span></span></div>',
              iconSize: [28, 28], iconAnchor: [14, 14], zIndex: 200
            });
          } else me.setPosition(ll);
          if (mode === 'demo' && Runner.S.points.length % 6 === 0) {
            map.setCenter(ll[0], ll[1]);
          }
          // 每 10 个点上传一次（失败静默，本地已存）
          trackBuffer.push({
            seq: Runner.S.points.length - 1,
            lng: ll[0], lat: ll[1],
            accuracy: 15, ts: Date.now(), source: 'gps'
          });
          if (trackBuffer.length >= 10) {
            var batch = trackBuffer.splice(0, trackBuffer.length);
            DB.pushTrack(batch);
          }
        };
        Runner.onCps = function (cp, n) {
          var cfg = CourseStore.load();
          var total = (cfg && cfg.checkpoints.length) ? cfg.checkpoints.length : C.course.cps.length;
          U.toast('打卡成功：' + cp.name + ' (' + n + '/' + total + ')');
          // 上报当前 GCJ-02 坐标（配置里的打卡点也是 GCJ-02，同一坐标系）
          var pos = Runner.S.points[Runner.S.points.length - 1];
          var g = pos ? Coord.wgs2gcj(pos[0], pos[1]) : null;   // [lat,lng]
          if (g) DB.pushHit(cp.id, g[1], g[0]);                 // pushHit(code, lng, lat)
        };
        Runner.onFinish = function (rec) {
          saveRun(rec);
        };

        renderActions();
        renderCps(Runner.snapshot());

        el.querySelector('#fab-loc').onclick = function () {
          if (!map) return;
          var last = Runner.S.points[Runner.S.points.length - 1];
          if (last) {
            var g = Coord.wgs2gcj(last[0], last[1]);
            map.setCenter(g[1], g[0], 18);
          } else {
            var c = CourseStore.load();
            if (c && c.route.points.length) map.fitPoints(c.route.points, [30, 30, 140, 30], 18);
          }
        };
      },

      unmount: function () {
        Runner.onTick = null; Runner.onPoint = null; Runner.onCps = null; Runner.onFinish = null;
        keepAwake(false);
        if (map) { map.destroy(); map = null; }
      }
    };
  }

  /* 保存成绩并跳转 */
  function saveRun(rec) {
    var reg = DB.getReg();
    if (!reg || !rec) return;
    var done = Object.keys(rec.cps || {}).length;
    var cfg = CourseStore.load();
    var total = (cfg && cfg.checkpoints.length) ? cfg.checkpoints.length : C.course.cps.length;
    rec.sid = reg.sid; rec.name = reg.name; rec.college = reg.college; rec.group = reg.group;
    rec.partner = reg.partner;
    rec.completed = done >= total;

    // 上传剩余轨迹
    var pending = (window.__trackBuffer || []).splice(0);
    var p1 = pending.length ? DB.pushTrack(pending) : Promise.resolve();

    p1.then(function () { return DB.finishRun(rec); }).then(function (res) {
      if (res && res.ok && !res.offline && res.data) {
        rec._server = res.data;
        DB.setRun(rec);
      }
      U.haptic('ok');
      Router.go('result', { replace: true });
    });
  }

  function doFinish(el) {
    var S = Runner.S;
    if (!S.running) return;
    var done = Object.keys(S.cps).length;
    var total = C.course.cps.length;
    if (done < total) {
      if (!confirm('还有 ' + (total - done) + ' 个打卡点未完成，成绩将记为「未完成」，确定结束？')) return;
    }
    var rec = Runner.finish();
    if (!rec) return;
    saveRun(rec);
  }

  /* ================= 成绩 ================= */
  function ResultPage() {
    var run = DB.getRun();
    var reg = DB.getReg();
    if (!run) { setTimeout(function () { Router.go('home', { replace: true }); }, 0); return { html: '' }; }
    var rank = DB.myRank();
    var total = C.course.cps.length;
    var done = Object.keys(run.cps || {}).length;

    return {
      html: '' +
        '<div class="page">' +
        '<div class="result-hero">' +
        '  <div style="font-size:13px;opacity:.85">' + (run.completed ? '完赛成绩' : '未完成') + '</div>' +
        '  <div class="big mt8">' + U.fmtTime(run.elapsedMs) + '</div>' +
        '  <div style="font-size:13px;opacity:.9;margin-top:6px">' +
        '    ' + gName(reg.group) + ' · ' + (rank ? '第 ' + rank.rank + ' 名 / 共 ' + rank.total + ' 人' : '') +
        '  </div>' +
        '</div>' +
        '<div class="pad mt16">' +
        '  <div class="card">' +
        '    <div class="row between" style="padding:6px 0"><span class="muted">总距离</span><b>' + U.fmtDist(run.distance) + '</b></div>' +
        '    <div class="row between" style="padding:6px 0"><span class="muted">平均配速</span><b>' + U.fmtPace(run.elapsedMs, run.distance) + '</b></div>' +
        '    <div class="row between" style="padding:6px 0"><span class="muted">打卡点</span><b>' + done + ' / ' + total + '</b></div>' +
        '    <div class="row between" style="padding:6px 0"><span class="muted">开始时间</span><b class="small">' + U.fmtDate(run.startedAt) + '</b></div>' +
        '  </div>' +
        '  <div class="card">' +
        '    <div class="strong mb8">打卡记录</div>' +
        C.course.cps.map(function (cp) {
          var t = run.cps && run.cps[cp.id];
          return '<div class="row between" style="padding:7px 0;border-top:1px solid var(--line)">' +
            '<span>' + (t ? '✅' : '⬜️') + ' ' + cp.id + ' ' + cp.name + '</span>' +
            '<span class="small muted">' + (t ? U.fmtTime(t) : '未打卡') + '</span></div>';
        }).join('') +
        '  </div>' +
        '  <button class="btn mt16" id="b-track">查看我的轨迹</button>' +
        '  <button class="btn ghost mt12" id="b-rank">查看排行榜</button>' +
        '  <button class="btn outline mt12" id="b-home">返回首页</button>' +
        '  <div style="height:20px"></div>' +
        '</div></div>',

      mount: function (el) {
        el.querySelector('#b-track').onclick = function () { Router.go('track'); };
        el.querySelector('#b-rank').onclick = function () { Router.go('rank'); };
        el.querySelector('#b-home').onclick = function () { Router.go('home', { replace: true }); };
      }
    };
  }

  /* ================= 轨迹回放 ================= */
  function TrackPage() {
    var run = DB.getRun();
    if (!run || !run.points || run.points.length < 2) {
      setTimeout(function () { Router.go('home', { replace: true }); }, 0);
      return { html: '' };
    }
    var map, track, me, i = 0, playing = true, timer = null;

    return {
      html: '' +
        '<div class="page">' +
        '<div class="navbar"><div class="back" data-back>‹</div><div class="nav-title">轨迹回放</div></div>' +
        '<div class="map-wrap">' +
        '  <div id="map"></div>' +
        '  <div class="map-float bottom">' +
        '    <div class="row between">' +
        '      <div><div class="small muted">用时</div>' +
        '        <div style="font-size:24px;font-weight:700;font-variant-numeric:tabular-nums" id="tk-time">00:00.0</div></div>' +
        '      <div class="center"><div class="small muted">距离</div>' +
        '        <div style="font-size:20px;font-weight:700" id="tk-dist">0 m</div></div>' +
        '      <div class="center"><div class="small muted">进度</div>' +
        '        <div style="font-size:20px;font-weight:700" id="tk-pct">0%</div></div>' +
        '    </div>' +
        '    <div style="height:5px;background:#eef1f0;border-radius:3px;margin-top:12px;overflow:hidden">' +
        '      <div id="tk-bar" style="height:100%;width:0;background:var(--brand);border-radius:3px"></div></div>' +
        '    <button class="btn ghost sm mt12" id="tk-play">暂停回放</button>' +
        '  </div>' +
        '</div></div>',

      mount: function (el) {
        el.querySelector('[data-back]').onclick = function () { Router.back(); };
        var mapEl = document.getElementById('map');
        var pts = run.points;
        var totalMs = run.elapsedMs || 1;

        MapEngine.create(mapEl, { zoom: 16 }).then(function (m) {
          if (!el.isConnected) { m.destroy(); return; }
          map = m;
          var c = CourseStore.load();
          if (c && c.route.points && c.route.points.length >= 2) {
            map.addPolyline(c.route.points, { strokeColor: '#0f9d76', strokeWeight: 4, strokeOpacity: .5, zIndex: 50 });
          }
          track = map.addPolyline([], { strokeColor: '#2b7fff', strokeWeight: 5, zIndex: 80 });
          var g0 = Coord.wgs2gcj(pts[0][0], pts[0][1]);
          me = map.addMarker({
            position: [g0[1], g0[0]], html: '<div class="me-pin"><span></span></div>',
            iconSize: [28, 28], iconAnchor: [14, 14], zIndex: 200
          });
          map.fitPoints(pts.map(function (p) { var g = Coord.wgs2gcj(p[0], p[1]); return [g[1], g[0]]; }),
            [30, 30, 140, 30], 18);
        }).catch(function (err) { MapEngine.renderError(mapEl, err); });

        function step() {
          if (!playing) return;
          i++;
          if (i >= pts.length) { i = pts.length - 1; playing = false; el.querySelector('#tk-play').textContent = '重新回放'; return; }
          var p = pts[i];
          var gp = Coord.wgs2gcj(p[0], p[1]);
          if (track) {
            track.setPath(pts.slice(0, i + 1).map(function (q) {
              var g = Coord.wgs2gcj(q[0], q[1]); return [g[1], g[0]];
            }));
          }
          if (me) me.setPosition([gp[1], gp[0]]);
          var t = p[2] != null ? p[2] : totalMs * (i / pts.length);
          el.querySelector('#tk-time').textContent = U.fmtTime(t);
          el.querySelector('#tk-dist').textContent = U.fmtDist(U.pathLength(pts.slice(0, i + 1).map(function (x) { return [x[0], x[1]]; })));
          el.querySelector('#tk-pct').textContent = Math.round((i / (pts.length - 1)) * 100) + '%';
          el.querySelector('#tk-bar').style.width = (i / (pts.length - 1) * 100) + '%';
        }
        timer = setInterval(step, 90);

        el.querySelector('#tk-play').onclick = function () {
          if (!playing && i >= pts.length - 1) {
            i = 0; track.clear(); playing = true;
            el.querySelector('#tk-play').textContent = '暂停回放';
            return;
          }
          playing = !playing;
          el.querySelector('#tk-play').textContent = playing ? '暂停回放' : '继续回放';
        };
      },

      unmount: function () {
        if (timer) { clearInterval(timer); timer = null; }
        if (map) { map.destroy(); map = null; }
      }
    };
  }

  /* ================= 排行榜 ================= */
  function RankPage() {
    var tab = 'competition';

    function rowsHtml(list) {
      if (!list.length) return '<div class="empty"><div class="ic">🏁</div><div class="mt8">暂无成绩</div></div>';
      return list.map(function (r, i) {
        var rc = i === 0 ? 'top1' : i === 1 ? 'top2' : i === 2 ? 'top3' : '';
        return '<div class="list-item" style="' + (r.isMe ? 'background:var(--brand-light)' : '') + '">' +
          '<div class="rank ' + rc + '">' + (i + 1) + '</div>' +
          '<div class="grow">' +
          '  <div class="strong">' + r.name + (r.isMe ? ' <span class="badge">我</span>' : '') +
          (r.partner ? ' <span class="small muted">+ ' + r.partner + '</span>' : '') + '</div>' +
          '  <div class="small muted">' + r.college + '</div>' +
          '</div>' +
          '<div class="center"><div class="strong" style="font-variant-numeric:tabular-nums">' + U.fmtTime(r.elapsedMs) + '</div>' +
          '<div class="small muted">' + U.fmtDist(r.distance) + '</div></div>' +
          '</div>';
      }).join('');
    }

    function loadInto(el, t) {
      var box = el.querySelector('#rk-list');
      if (!box) return;
      box.innerHTML = '<div class="empty small">加载中…</div>';
      DB.leaderboardAsync(t).then(function (res) {
        if (!el.isConnected) return;
        box.innerHTML = rowsHtml(res.rows);
        var tag = el.querySelector('#rk-src');
        if (tag) tag.textContent = res.offline ? '本机数据' : '实时数据';
      });
    }

    return {
      html: '' +
        '<div class="page">' +
        '<div class="navbar"><div class="back" data-back>‹</div><div class="nav-title">成绩排行</div>' +
        '  <div class="grow"></div><div class="small" id="rk-src" style="padding:0 14px;color:var(--ink-3)"></div></div>' +
        '<div class="pad mt12">' +
        '  <div class="segmented" id="rk-tabs">' +
        '    <div class="on" data-t="competition">竞赛组</div>' +
        '    <div data-t="unity">同心组</div>' +
        '    <div data-t="all">全部</div>' +
        '  </div>' +
        '</div>' +
        '<div class="card mt12" style="margin:12px 16px;padding:0;overflow:hidden" id="rk-list">' +
        '  <div class="empty small">加载中…</div></div>' +
        '<div class="small muted center">成绩由系统计时生成，如有异议请联系裁判组</div>' +
        '<div style="height:20px"></div>' +
        '</div>',

      mount: function (el) {
        el.querySelector('[data-back]').onclick = function () { Router.back(); };
        el.querySelectorAll('#rk-tabs > div').forEach(function (n) {
          n.onclick = function () {
            el.querySelectorAll('#rk-tabs > div').forEach(function (x) { x.classList.remove('on'); });
            n.classList.add('on');
            tab = n.dataset.t;
            loadInto(el, tab);
          };
        });
        loadInto(el, tab);
      }
    };
  }

  /* ================= 我的 ================= */
  function ProfilePage() {
    var reg = DB.getReg();
    var run = DB.getRun();

    return {
      html: '' +
        '<div class="page">' +
        '<div class="navbar"><div class="back" data-back>‹</div><div class="nav-title">我的</div></div>' +
        '<div class="pad mt12">' +
        (reg ? '' +
          '<div class="card">' +
          '  <div class="row gap12">' +
          '    <div style="width:52px;height:52px;border-radius:50%;background:var(--brand-light);display:flex;align-items:center;justify-content:center;font-size:22px">' + reg.name.slice(0, 1) + '</div>' +
          '    <div class="grow"><div class="title" style="font-size:17px">' + reg.name + '</div>' +
          '    <div class="small muted">' + reg.sid + ' · ' + reg.college + '</div></div>' +
          '    <span class="badge">' + gName(reg.group) + '</span>' +
          '  </div>' +
          (reg.partner ? '<div class="small muted mt12" style="border-top:1px solid var(--line);padding-top:10px">队友：' + reg.partner.name + ' · ' + reg.partner.sid + '</div>' : '') +
          '</div>'
          : '<div class="empty"><div class="ic">👤</div><div class="mt8">还没有报名</div></div>') +
        (run ? '<div class="card"><div class="row between"><span class="muted">我的成绩</span>' +
          '<span class="strong" style="color:var(--brand)">' + U.fmtTime(run.elapsedMs) + '</span></div>' +
          '<div class="small muted mt8">' + U.fmtDist(run.distance) + ' · 配速 ' + U.fmtPace(run.elapsedMs, run.distance) + '</div></div>' : '') +
        '  <div class="card" style="padding:0;overflow:hidden">' +
        '    <div class="list-item" id="p-reg"><span style="font-size:18px">📝</span><div class="grow">报名信息</div><span class="muted">›</span></div>' +
        '    <div class="list-item" id="p-rank"><span style="font-size:18px">🏆</span><div class="grow">成绩排行</div><span class="muted">›</span></div>' +
        '    <div class="list-item" id="p-map"><span style="font-size:18px">🗺️</span><div class="grow">校园地图与定位</div><span class="muted">›</span></div>' +
        '    <div class="list-item" id="p-gps"><span style="font-size:18px">📡</span><div class="grow">定位精度测试</div><span class="muted">›</span></div>' +
        '    <div class="list-item" id="p-survey"><span style="font-size:18px">🧭</span><div class="grow">实地路线采集</div><span class="muted">›</span></div>' +
        '    <div class="list-item" id="p-admin"><span style="font-size:18px">🛠️</span><div class="grow">管理后台</div>' +
        '      <span class="muted small">' + (AdminAuth.isLogged() ? '已登录 ›' : '需登录 ›') + '</span></div>' +
        '    <div class="list-item" id="p-reset"><span style="font-size:18px">♻️</span><div class="grow">清空本机数据</div><span class="muted">›</span></div>' +
        '  </div>' +
        '</div></div>',

      mount: function (el) {
        el.querySelector('[data-back]').onclick = function () { Router.back(); };
        el.querySelector('#p-reg').onclick = function () { Router.go('register'); };
        el.querySelector('#p-rank').onclick = function () { Router.go('rank'); };
        el.querySelector('#p-map').onclick = function () { Router.go('map'); };
        el.querySelector('#p-gps').onclick = function () { Router.go('gps-test'); };
        el.querySelector('#p-survey').onclick = function () { Router.go('survey'); };
        el.querySelector('#p-admin').onclick = function () {
          if (AdminAuth.isLogged()) Router.go('admin-home');
          else Router.go('admin-login');
        };
        el.querySelector('#p-reset').onclick = function () {
          if (!confirm('清空后需要重新报名，确定？')) return;
          DB.clearUser(); DB.clearRun();
          U.toast('已清空');
          setTimeout(function () { Router.go('home', { replace: true }); }, 400);
        };
      }
    };
  }

  /* ================= 管理后台 ================= */
  function AdminPage() {
    var tab = 'regs';
    var regs = DB.listRegs();      // 先用本地缓存渲染，随后被后端数据替换
    var offline = true;

    function regList() {
      return regs.map(function (r) {
        return '<div class="list-item" style="cursor:default">' +
          '<div class="grow"><div class="strong">' + r.name +
          (r.partner ? ' <span class="small muted">+ ' + r.partner.name + '</span>' : '') + '</div>' +
          '<div class="small muted">' + r.sid + ' · ' + r.college + '</div></div>' +
          '<div class="center"><span class="badge' + (r.group === 'experience' ? ' gray' : r.group === 'unity' ? ' orange' : '') + '">' +
          gName(r.group) + '</span>' +
          '<div class="small muted mt8">' + (r.status === 'checked' ? '已签到' : '待签到') + '</div></div>' +
          '</div>';
      }).join('');
    }

    function statView() {
      var lb = DB.leaderboard('all');
      var byCollege = {};
      regs.forEach(function (r) { byCollege[r.college] = (byCollege[r.college] || 0) + 1; });
      var top = Object.keys(byCollege).sort(function (a, b) { return byCollege[b] - byCollege[a]; }).slice(0, 6);
      var max = Math.max.apply(null, top.map(function (k) { return byCollege[k]; }).concat([1]));
      return '<div class="card"><div class="strong mb8">报名分布（学院）</div>' +
        top.map(function (k) {
          return '<div class="mt8"><div class="row between small"><span>' + k + '</span><b>' + byCollege[k] + '</b></div>' +
            '<div style="height:6px;background:#eef1f0;border-radius:3px;margin-top:4px;overflow:hidden">' +
            '<div style="height:100%;width:' + (byCollege[k] / max * 100) + '%;background:var(--brand)"></div></div></div>';
        }).join('') + '</div>' +
        '<div class="card"><div class="strong mb8">完赛统计</div>' +
        '<div class="row between" style="padding:6px 0"><span class="muted">完赛人数</span><b>' + lb.length + '</b></div>' +
        '<div class="row between" style="padding:6px 0"><span class="muted">最快成绩</span><b>' + (lb[0] ? U.fmtTime(lb[0].elapsedMs) : '--') + '</b></div>' +
        '<div class="row between" style="padding:6px 0"><span class="muted">平均成绩</span><b>' +
        (lb.length ? U.fmtTime(lb.reduce(function (s, r) { return s + r.elapsedMs; }, 0) / lb.length) : '--') + '</b></div>' +
        '</div>' +
        '<button class="btn outline mt12" id="b-export">导出报名表 CSV</button>';
    }

    return {
      html: '' +
        '<div class="page">' +
        '<div class="navbar"><div class="back" data-back>‹</div><div class="nav-title">管理后台</div></div>' +
        '<div class="pad mt12">' +
        '  <div class="segmented" id="ad-tabs"><div class="on" data-t="regs">报名名单</div><div data-t="stat">数据统计</div></div>' +
        '</div>' +
        '<div id="ad-body" style="padding:12px 16px 0">' +
        '  <div class="card" style="padding:0;overflow:hidden" id="ad-list">' +
        '    <div class="empty small">加载中…</div></div>' +
        '</div></div>',

      mount: function (el) {
        el.querySelector('[data-back]').onclick = function () { Router.back(); };

        function refresh() {
          DB.listRegsAsync().then(function (res) {
            if (!el.isConnected) return;
            regs = res.rows;
            offline = res.offline;
            var box = el.querySelector('#ad-body');
            if (tab === 'regs') {
              box.innerHTML = '<div class="card" style="padding:0;overflow:hidden">' + regList() + '</div>' +
                (offline ? '<div class="small muted center mt12">当前显示本机缓存数据（未连接服务器）</div>' : '');
            } else {
              box.innerHTML = statView();
              var b = el.querySelector('#b-export');
              if (b) b.onclick = exportCsv;
            }
          });
        }

        el.querySelectorAll('#ad-tabs > div').forEach(function (n) {
          n.onclick = function () {
            el.querySelectorAll('#ad-tabs > div').forEach(function (x) { x.classList.remove('on'); });
            n.classList.add('on');
            tab = n.dataset.t;
            refresh();
          };
        });
        refresh();
      }
    };
  }

  function exportCsv() {
    // 优先后端导出（带完整字段），失败则本地生成
    if (DB.isOnline && DB.isOnline()) {
      window.API.download('/api/participants/export.csv', '泉州师范学院-定向跑报名表.csv')
        .then(function () { U.toast('已导出'); })
        .catch(function () { exportCsvLocal(); });
      return;
    }
    exportCsvLocal();
  }

  function exportCsvLocal() {
    var regs = DB.listRegs();
    var head = ['学号', '姓名', '学院', '组别', '队友学号', '队友姓名', '队友学院', '状态', '报名时间'];
    var lines = [head.join(',')];
    regs.forEach(function (r) {
      lines.push([
        r.sid, r.name, r.college, gName(r.group),
        r.partner ? r.partner.sid : '', r.partner ? r.partner.name : '', r.partner ? r.partner.college : '',
        r.status === 'checked' ? '已签到' : '待签到', U.fmtDate(r.createdAt)
      ].map(function (v) { return '"' + String(v || '').replace(/"/g, '""') + '"'; }).join(','));
    });
    var blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '泉州师范学院-定向跑报名表.csv';
    a.click();
    U.toast('已导出');
  }

  window.Pages = window.Pages || {};
  Object.assign(window.Pages, {
    home: HomePage, register: RegisterPage, checkin: CheckinPage,
    run: RunPage, result: ResultPage, rank: RankPage, track: TrackPage,
    profile: ProfilePage, admin: AdminPage
  });
})();
