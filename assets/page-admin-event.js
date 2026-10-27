/* 管理员 · 赛事设置
 *
 * 把首页/报名页用到的配置从静态 data/campus.js 搬到 events 表：
 * 赛事日期、报名截止、状态、起终点名称、关门时间、学院列表、赛事须知。
 *
 * 保存后 EventStore 会刷新，学生端下次打开即为新配置。
 */
(function () {
  'use strict';
  var U = window.U;

  var STATUS_OPTIONS = [
    { key: 'draft', name: '筹备中（不开放报名）' },
    { key: 'reg_open', name: '报名进行中' },
    { key: 'reg_closed', name: '报名已截止' },
    { key: 'running', name: '比赛进行中' },
    { key: 'finished', name: '赛事已结束' },
    { key: 'archived', name: '已归档' }
  ];

  /* ISO 时间 <-> datetime-local 输入值（本地时区） */
  function toLocalInput(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + U.pad(d.getMonth() + 1) + '-' + U.pad(d.getDate()) +
      'T' + U.pad(d.getHours()) + ':' + U.pad(d.getMinutes());
  }
  function fromLocalInput(v) {
    if (!v) return '';
    var d = new Date(v);
    if (isNaN(d.getTime())) return '';
    return d.toISOString();
  }

  function EventSettingsPage() {
    if (!AdminAuth.guard(Router)) return { html: '' };

    var ev = window.EventStore.get();
    var state = {
      name: ev.name || '',
      subtitle: ev.subtitle || '',
      eventDate: ev.eventDate || '',
      regDeadline: ev.regDeadline || '',
      status: ev.status || 'reg_open',
      regOpen: ev.regOpen !== false,
      startName: ev.startName || '',
      finishName: ev.finishName || '',
      closeMinutes: ev.closeMinutes || 90,
      rules: ev.rules || '',
      colleges: (ev.colleges || []).slice()
    };

    function collegeChips() {
      if (!state.colleges.length) {
        return '<div class="small muted">还没有学院，点下面的「添加」</div>';
      }
      return state.colleges.map(function (c, i) {
        return '<span class="ev-chip">' + c +
          '<b data-del="' + i + '" title="删除">×</b></span>';
      }).join('');
    }

    function body() {
      return '' +
        '<div class="card">' +
        '  <div class="section-title" style="padding-top:0">基本信息</div>' +
        '  <div class="field"><label>赛事名称</label>' +
        '    <input class="input" id="ev-name" value="' + esc(state.name) + '" maxlength="40"></div>' +
        '  <div class="field"><label>副标题</label>' +
        '    <input class="input" id="ev-subtitle" value="' + esc(state.subtitle) + '" maxlength="40" placeholder="例如：校园体育文化节 · 定向跑"></div>' +
        '  <div class="field"><label>赛事日期</label>' +
        '    <input class="input" id="ev-date" type="datetime-local" value="' + toLocalInput(state.eventDate) + '"></div>' +
        '  <div class="field"><label>报名截止</label>' +
        '    <input class="input" id="ev-deadline" type="datetime-local" value="' + toLocalInput(state.regDeadline) + '"></div>' +
        '  <div class="field"><label>关门时间（分钟）</label>' +
        '    <input class="input" id="ev-close" type="number" min="10" max="600" value="' + state.closeMinutes + '"></div>' +
        '  <div class="row gap12">' +
        '    <div class="field grow"><label>起点名称</label>' +
        '      <input class="input" id="ev-start" value="' + esc(state.startName) + '" maxlength="20"></div>' +
        '    <div class="field grow"><label>终点名称</label>' +
        '      <input class="input" id="ev-finish" value="' + esc(state.finishName) + '" maxlength="20"></div>' +
        '  </div>' +
        '</div>' +

        '<div class="card">' +
        '  <div class="section-title" style="padding-top:0">报名控制</div>' +
        '  <div class="field"><label>赛事状态</label>' +
        '    <select class="select" id="ev-status">' +
        STATUS_OPTIONS.map(function (s) {
          return '<option value="' + s.key + '"' + (s.key === state.status ? ' selected' : '') + '>' + s.name + '</option>';
        }).join('') + '</select></div>' +
        '  <label class="ev-switch">' +
        '    <input type="checkbox" id="ev-regopen"' + (state.regOpen ? ' checked' : '') + '>' +
        '    <span>开放报名（关闭后学生端无法提交，已报名的仍可查看）</span>' +
        '  </label>' +
        '  <div class="small muted mt12" style="background:#f7f9f8;padding:10px;border-radius:10px;line-height:1.7">' +
        '    报名是否开放 = 上面的开关 <b>且</b> 状态为「报名进行中」 <b>且</b> 未过截止时间。<br>' +
        '    三者任一不满足，学生端都会显示为不可报名。' +
        '  </div>' +
        '</div>' +

        '<div class="card">' +
        '  <div class="section-title" style="padding-top:0">赛事须知</div>' +
        '  <div class="small muted mb8">一行一条，学生端按顺序显示</div>' +
        '  <textarea class="input" id="ev-rules" rows="6" style="height:auto;padding:12px 14px;line-height:1.7">' +
        esc(state.rules) + '</textarea>' +
        '</div>' +

        '<div class="card">' +
        '  <div class="section-title" style="padding-top:0">学院列表（报名下拉）' +
        '    <span class="badge">' + state.colleges.length + ' 个</span></div>' +
        '  <div class="ev-chips" id="ev-chips">' + collegeChips() + '</div>' +
        '  <div class="row gap8 mt12">' +
        '    <input class="input grow" id="ev-newcollege" placeholder="新增学院名称" maxlength="30">' +
        '    <button class="btn ghost" id="ev-addcollege" style="width:auto;padding:0 16px">添加</button>' +
        '  </div>' +
        '  <div class="small muted mt8">删除学院不会影响已报名记录，只影响后续下拉选项。</div>' +
        '</div>' +

        '<button class="btn mt16" id="ev-save">保存赛事设置</button>' +
        '<div class="small muted center mt12" style="padding-bottom:20px">' +
        '保存后立即写入数据库，学生端刷新即可看到</div>';
    }

    function esc(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    return {
      html: '' +
        '<div class="page">' +
        '<div class="navbar"><div class="back" data-back>‹</div><div class="nav-title">赛事设置</div></div>' +
        '<div class="pad mt12" id="ev-body">' + body() + '</div>' +
        '</div>',

      mount: function (el) {
        el.querySelector('[data-back]').onclick = function () { Router.back(); };

        function sync() {
          var g = function (id) { var n = el.querySelector(id); return n ? n.value : ''; };
          state.name = g('#ev-name').trim();
          state.subtitle = g('#ev-subtitle').trim();
          state.eventDate = fromLocalInput(g('#ev-date'));
          state.regDeadline = fromLocalInput(g('#ev-deadline'));
          state.closeMinutes = Number(g('#ev-close')) || 90;
          state.startName = g('#ev-start').trim();
          state.finishName = g('#ev-finish').trim();
          state.status = g('#ev-status');
          state.rules = g('#ev-rules');
          var ro = el.querySelector('#ev-regopen');
          state.regOpen = !!(ro && ro.checked);
        }

        function rerender() {
          sync();
          el.querySelector('#ev-body').innerHTML = body();
          bind();
        }

        function bind() {
          el.querySelectorAll('#ev-chips [data-del]').forEach(function (n) {
            n.onclick = function () {
              sync();
              state.colleges.splice(Number(n.dataset.del), 1);
              rerender();
            };
          });
          var addBtn = el.querySelector('#ev-addcollege');
          if (addBtn) {
            addBtn.onclick = function () {
              var input = el.querySelector('#ev-newcollege');
              var v = (input.value || '').trim();
              if (!v) { U.toast('请输入学院名称'); return; }
              if (state.colleges.indexOf(v) >= 0) { U.toast('该学院已存在'); return; }
              sync();
              state.colleges.push(v);
              rerender();
              U.toast('已添加，记得保存');
            };
            el.querySelector('#ev-newcollege').onkeydown = function (e) {
              if (e.key === 'Enter') { e.preventDefault(); addBtn.click(); }
            };
          }
          el.querySelector('#ev-save').onclick = save;
        }

        function save() {
          sync();
          var errs = [];
          if (state.name.length < 2) errs.push(['#ev-name', '请填写赛事名称']);
          if (!state.eventDate) errs.push(['#ev-date', '请选择赛事日期']);
          if (!state.regDeadline) errs.push(['#ev-deadline', '请选择报名截止时间']);
          if (state.eventDate && state.regDeadline &&
              new Date(state.regDeadline).getTime() > new Date(state.eventDate).getTime()) {
            errs.push(['#ev-deadline', '报名截止不能晚于赛事日期']);
          }
          if (!state.colleges.length) errs.push(['#ev-newcollege', '至少保留一个学院']);

          el.querySelectorAll('.err').forEach(function (n) { n.classList.remove('err'); });
          el.querySelectorAll('.err-msg').forEach(function (n) { n.remove(); });
          if (errs.length) {
            errs.forEach(function (e) {
              var n = el.querySelector(e[0]);
              if (!n) return;
              n.classList.add('err');
              var tip = document.createElement('div');
              tip.className = 'err-msg';
              tip.textContent = e[1];
              n.parentNode.appendChild(tip);
            });
            U.toast(errs[0][1]);
            return;
          }

          var btn = el.querySelector('#ev-save');
          btn.disabled = true;
          btn.textContent = '保存中…';

          window.API.put('/api/event', {
            name: state.name,
            subtitle: state.subtitle,
            eventDate: state.eventDate,
            regDeadline: state.regDeadline,
            closeMinutes: state.closeMinutes,
            startName: state.startName,
            finishName: state.finishName,
            status: state.status,
            regOpen: state.regOpen,
            rules: state.rules,
            colleges: state.colleges
          }).then(function (j) {
            btn.disabled = false;
            btn.textContent = '保存赛事设置';
            U.haptic('ok');
            U.toast('已保存');
            // 让 EventStore 立刻用服务端最新值
            window.EventStore.refresh(true).then(function () {
              var fresh = window.EventStore.get();
              state.eventDate = fresh.eventDate;
              state.regDeadline = fresh.regDeadline;
              state.colleges = (fresh.colleges || []).slice();
              rerender();
            });
          }).catch(function (e) {
            btn.disabled = false;
            btn.textContent = '保存赛事设置';
            if (e.status === 401) {
              U.toast('登录已过期，请重新登录');
              AdminAuth.logout();
              Router.go('admin-login', { replace: true });
              return;
            }
            U.toast('保存失败：' + e.message);
          });
        }

        bind();
      }
    };
  }

  window.Pages = window.Pages || {};
  window.Pages['admin-event'] = EventSettingsPage;
})();
