/* 实地路线采集
 *
 * 拿手机沿真实比赛路线走，持续采集 GPS。
 *  - 采集结果保存在本机（localStorage），可导出 JSON/GPX
 *  - 支持同一路段多次采集，用于判断轨迹稳定性
 *  - 采集结果不直接成为正式路线，必须进编辑器人工核验
 */
(function () {
  'use strict';
  var U = window.U;
  var KEY = 'route_surveys';

  /* ---------- 采集记录存储 ---------- */
  var Survey = {
    all: function () { return U.load(KEY, []); },
    save: function (rec) {
      var list = Survey.all();
      var i = -1;
      list.forEach(function (x, k) { if (x.id === rec.id) i = k; });
      if (i >= 0) list[i] = rec; else list.unshift(rec);
      U.save(KEY, list.slice(0, 50));
      return rec;
    },
    get: function (id) {
      var list = Survey.all();
      for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
      return null;
    },
    remove: function (id) {
      U.save(KEY, Survey.all().filter(function (x) { return x.id !== id; }));
    }
  };

  /* ---------- 采集页 ---------- */
  function SurveyPage() {
    var map = null;
    var line = null, me = null, accCircle = null;
    var baseKind = 'normal';
    var currentName = '';
    var savedId = null;
    var timer = null;

    function drawTrack() {
      if (!map) return;
      var pts = Geo.S.track.map(function (s) { return [s.display.lng, s.display.lat]; });
      if (pts.length < 2) return;
      if (!line) {
        line = map.addPolyline(pts, {
          strokeColor: '#2b7fff', strokeWeight: 5, strokeOpacity: .95, zIndex: 80
        });
      } else {
        line.setPath(pts);
      }
    }

    return {
      html: '' +
        '<div class="page survey-page">' +
        '  <div class="map-topbar">' +
        '    <div class="mt-back" data-back>‹</div>' +
        '    <div class="mt-title">' +
        '      <div class="mt-name">实地路线采集</div>' +
        '      <div class="mt-sub" id="sv-sub">沿真实路线行走，自动记录 GPS</div>' +
        '    </div>' +
        '    <div class="mt-status" id="sv-status"><i></i><span>未开始</span></div>' +
        '  </div>' +

        '  <div class="map-body">' +
        '    <div id="map" class="map-canvas"></div>' +
        '    <div class="map-fabs">' +
        '      <div class="fab" id="sv-locate" title="回到我的位置">◎</div>' +
        '      <div class="fab" id="sv-layer" title="切换图层">◧</div>' +
        '      <div class="fab" id="sv-fit" title="显示全部">⛶</div>' +
        '    </div>' +
        '    <div class="map-hint" id="sv-hint"></div>' +
        '  </div>' +

        '  <div class="gt-panel">' +
        '    <div class="gt-grid">' +
        '      <div class="gt-cell"><div class="k">已采集点</div><div class="v" id="sv-count">0</div></div>' +
        '      <div class="gt-cell"><div class="k">有效距离</div><div class="v" id="sv-dist">0 m</div></div>' +
        '      <div class="gt-cell"><div class="k">当前精度</div><div class="v" id="sv-acc">--</div></div>' +
        '      <div class="gt-cell"><div class="k">用时</div><div class="v small" id="sv-elapsed">00:00</div></div>' +
        '    </div>' +
        '    <div class="gt-coord" id="sv-coord">点击「开始采集」</div>' +
        '    <div class="gt-actions" id="sv-actions"></div>' +
        '  </div>' +
        '</div>',

      mount: function (el) {
        el.querySelector('[data-back]').onclick = function () { Router.back(); };

        var subEl = el.querySelector('#sv-sub');
        var statusEl = el.querySelector('#sv-status');
        var countEl = el.querySelector('#sv-count');
        var distEl = el.querySelector('#sv-dist');
        var accEl = el.querySelector('#sv-acc');
        var elapsedEl = el.querySelector('#sv-elapsed');
        var coordEl = el.querySelector('#sv-coord');
        var actEl = el.querySelector('#sv-actions');
        var hintEl = el.querySelector('#sv-hint');

        var mapEl = el.querySelector('#map');
        MapEngine.create(mapEl, { zoom: 18, minZoom: 10, maxZoom: 20 }).then(function (m) {
          if (!el.isConnected) { m.destroy(); return; }
          map = m;
          // 显示已有正式路线作为参考
          CourseStore.remoteLoad().then(function (c) {
            if (!c || !map) return;
            if (c.route.points && c.route.points.length >= 2) {
              map.addPolyline(c.route.points, {
                strokeColor: '#0f9d76', strokeWeight: 3, strokeOpacity: .45, zIndex: 50
              });
            }
            map.fitPoints(c.route.points, [40, 40, 150, 40], 18);
          });
          var center = window.AppConfig.get('event.campusCenter');
          map.setCenter(center[0], center[1], 18);
          render();
        }).catch(function (err) { MapEngine.renderError(mapEl, err); });

        el.querySelector('#sv-locate').onclick = function () {
          var s = Geo.snapshot();
          if (s.last && map) map.setCenter(s.last.gcj[0], s.last.gcj[1], 19);
          else U.toast('还没有定位');
        };
        el.querySelector('#sv-layer').onclick = function () {
          if (!map) return;
          baseKind = baseKind === 'normal' ? 'satellite' : baseKind === 'satellite' ? 'hybrid' : 'normal';
          map.setBase(baseKind);
          U.toast({ normal: '标准地图', satellite: '卫星地图', hybrid: '卫星+路网' }[baseKind]);
        };
        el.querySelector('#sv-fit').onclick = function () {
          var pts = Geo.S.track.map(function (s) { return [s.display.lng, s.display.lat]; });
          if (map && pts.length) map.fitPoints(pts, [40, 40, 150, 40], 19);
        };

        function fmtElapsed(ms) {
          var t = Math.floor(ms / 1000);
          return U.pad(Math.floor(t / 60)) + ':' + U.pad(t % 60);
        }

        function render() {
          var s = Geo.snapshot();
          var active = Geo.isActive();

          var st = s.status;
          var label = { ok: '采集中', lowacc: '精度差', requesting: '定位中', lost: '信号中断',
            denied: '权限被拒', timeout: '超时', unavailable: '不可用', insecure: '需 HTTPS',
            paused: '已暂停', idle: '未开始' }[st] || st;
          var color = { ok: '#0f9d76', lowacc: '#f5a623', lost: '#e5484d', denied: '#e5484d' }[st] || '#8a9a94';
          statusEl.querySelector('i').style.background = color;
          statusEl.querySelector('span').textContent = label;

          countEl.textContent = s.points;
          distEl.textContent = U.fmtDist(s.distance);
          accEl.textContent = s.last && s.last.accuracy != null ? '±' + s.last.accuracy.toFixed(1) + 'm' : '--';
          elapsedEl.textContent = s.startedAt ? fmtElapsed(Date.now() - s.startedAt) : '00:00';

          if (s.last) {
            coordEl.innerHTML =
              '<div class="gt-coord-row"><span>WGS84</span><b>' + s.last.lat.toFixed(7) + ', ' + s.last.lng.toFixed(7) + '</b></div>' +
              '<div class="gt-coord-row"><span>采样 / 拒绝</span><b>' + s.samples + ' / ' + s.rejected + '</b></div>';
          } else {
            coordEl.textContent = '点击「开始采集」';
          }

          if (s.status === 'lost') {
            hintEl.textContent = s.message;
            hintEl.classList.add('show', 'warn');
          } else {
            hintEl.classList.remove('show', 'warn');
          }

          if (!active) {
            actEl.innerHTML =
              '<button class="btn" id="sv-start">开始采集</button>' +
              (s.points > 1 ? '<div class="row gap8 mt8">' +
                '<button class="btn outline sm" id="sv-save" style="flex:1">保存采集</button>' +
                '<button class="btn outline sm" id="sv-json" style="flex:1">导出 JSON</button></div>' : '');
            var b = el.querySelector('#sv-start');
            if (b) b.onclick = function () {
              Geo.reset();
              if (line) { line.remove(); line = null; }
              if (me) { me.remove(); me = null; }
              if (accCircle) { accCircle.remove(); accCircle = null; }
              Geo.start({ enableHighAccuracy: true, maximumAge: 0, timeout: 10000 });
              render();
            };
            var sb = el.querySelector('#sv-save');
            if (sb) sb.onclick = doSave;
            var jb = el.querySelector('#sv-json');
            if (jb) jb.onclick = function () {
              var data = Geo.exportJSON({ purpose: 'route-survey' });
              var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
              var a = document.createElement('a');
              a.href = URL.createObjectURL(blob);
              a.download = 'survey-' + Date.now() + '.json';
              a.click();
            };
          } else if (s.paused) {
            actEl.innerHTML = '<div class="row gap8">' +
              '<button class="btn outline" id="sv-stop" style="flex:1">结束</button>' +
              '<button class="btn" id="sv-resume" style="flex:2">继续采集</button></div>';
            el.querySelector('#sv-resume').onclick = function () { Geo.resume(); render(); };
            el.querySelector('#sv-stop').onclick = function () { Geo.stop(); render(); };
          } else {
            actEl.innerHTML = '<div class="row gap8">' +
              '<button class="btn outline" id="sv-pause" style="flex:1">暂停</button>' +
              '<button class="btn" id="sv-finish" style="flex:1">结束采集</button></div>';
            el.querySelector('#sv-pause').onclick = function () { Geo.pause(); render(); };
            el.querySelector('#sv-finish').onclick = function () { Geo.stop(); render(); };
          }
        }

        function doSave() {
          var s = Geo.snapshot();
          if (s.points < 2) { U.toast('采集点太少，无法保存'); return; }
          var name = prompt('给这次采集起个名字', '采集 ' + new Date().toLocaleString('zh-CN'));
          if (!name) return;
          var data = Geo.exportJSON({ purpose: 'route-survey', name: name });
          var rec = {
            id: U.uid('sv_'),
            name: name,
            createdAt: Date.now(),
            durationMs: s.startedAt ? Date.now() - s.startedAt : 0,
            stats: data.stats,
            track: data.track,
            rawSamples: data.rawSamples
          };
          Survey.save(rec);
          savedId = rec.id;
          U.toast('已保存，可进编辑器核验');
          render();
        }

        Geo.onUpdate = function () {
          if (!el.isConnected) return;
          drawTrack();
          drawMe();
          render();
        };

        function drawMe() {
          if (!map) return;
          var s = Geo.snapshot();
          if (!s.last) return;
          var pos = [s.last.gcj[0], s.last.gcj[1]];
          var first = !me;
          if (first) {
            me = map.addMarker({
              position: pos, html: '<div class="me-pin"><span></span></div>',
              iconSize: [28, 28], iconAnchor: [14, 14], zIndex: 200
            });
          } else me.setPosition(pos);

          if (!accCircle) {
            accCircle = map.addCircle(pos, s.last.accuracy || 10, {
              strokeColor: '#2b7fff', strokeWeight: 1, fillColor: '#2b7fff', fillOpacity: .1
            });
          } else {
            accCircle.setCenter(pos);
            accCircle.setRadius(s.last.accuracy || 10);
          }
          if (first) map.setCenter(pos[0], pos[1], 19);
        }

        timer = setInterval(function () {
          if (!el.isConnected) return;
          if (Geo.isActive() && !Geo.S.paused) {
            var s = Geo.snapshot();
            elapsedEl.textContent = s.startedAt ? fmtElapsed(Date.now() - s.startedAt) : '00:00';
          }
        }, 1000);

        render();
      },

      unmount: function () {
        Geo.onUpdate = null;
        if (timer) { clearInterval(timer); timer = null; }
        if (map) { map.destroy(); map = null; }
      }
    };
  }

  /* ---------- 采集列表 + 多次对比 ---------- */
  function SurveyListPage() {
    return {
      html: '' +
        '<div class="page">' +
        '<div class="navbar"><div class="back" data-back>‹</div><div class="nav-title">采集记录</div></div>' +
        '<div class="pad mt12">' +
        '  <div class="card small muted" style="line-height:1.8">' +
        '    同一路段采集多次后，可对比轨迹一致性。' +
        '    <b>采集结果不会自动成为正式路线</b>，需管理员在编辑器中人工核验。' +
        '  </div>' +
        '  <div id="sv-list" class="mt12"></div>' +
        '</div></div>',

      mount: function (el) {
        el.querySelector('[data-back]').onclick = function () { Router.back(); };

        function render() {
          var list = Survey.all();
          var box = el.querySelector('#sv-list');
          if (!list.length) {
            box.innerHTML = '<div class="empty"><div class="ic">📡</div><div class="mt8">还没有采集记录</div>' +
              '<button class="btn sm mt16" id="go-survey" style="max-width:200px;margin:16px auto 0">去采集</button></div>';
            el.querySelector('#go-survey').onclick = function () { Router.go('survey'); };
            return;
          }
          box.innerHTML = list.map(function (r) {
            var d = new Date(r.createdAt);
            return '<div class="card" style="padding:14px">' +
              '<div class="row between"><div class="strong">' + esc(r.name) + '</div>' +
              '<span class="badge">' + r.stats.accepted + ' 点</span></div>' +
              '<div class="small muted mt8">' +
              U.fmtDist(r.stats.distance) + ' · 拒绝 ' + r.stats.rejected + ' 点 · ' +
              U.pad(d.getMonth() + 1) + '-' + U.pad(d.getDate()) + ' ' +
              U.pad(d.getHours()) + ':' + U.pad(d.getMinutes()) + '</div>' +
              '<div class="row gap8 mt12">' +
              '<button class="btn outline sm" data-view="' + r.id + '" style="flex:1">查看</button>' +
              '<button class="btn outline sm" data-gpx="' + r.id + '" style="flex:1">导出 GPX</button>' +
              '<button class="btn outline sm" data-del="' + r.id + '" style="flex:1;color:var(--danger)">删除</button>' +
              '</div></div>';
          }).join('');

          box.querySelectorAll('[data-view]').forEach(function (n) {
            n.onclick = function () { Router.go('survey-view', { id: n.dataset.view }); };
          });
          box.querySelectorAll('[data-gpx]').forEach(function (n) {
            n.onclick = function () {
              var r = Survey.get(n.dataset.gpx);
              if (!r) return;
              var gpx = buildGPX(r);
              var blob = new Blob([gpx], { type: 'application/gpx+xml;charset=utf-8' });
              var a = document.createElement('a');
              a.href = URL.createObjectURL(blob);
              a.download = r.name.replace(/[\\/:*?"<>|]/g, '_') + '.gpx';
              a.click();
            };
          });
          box.querySelectorAll('[data-del]').forEach(function (n) {
            n.onclick = function () {
              if (!confirm('删除这条采集记录？')) return;
              Survey.remove(n.dataset.del);
              render();
            };
          });
        }

        function esc(s) { return String(s).replace(/[<>&]/g, function (c) { return { '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]; }); }

        function buildGPX(r) {
          var body = r.track.map(function (p) {
            return '      <trkpt lat="' + p.raw.lat.toFixed(8) + '" lon="' + p.raw.lng.toFixed(8) + '">' +
              '<time>' + new Date(p.ts).toISOString() + '</time></trkpt>';
          }).join('\n');
          return '<?xml version="1.0" encoding="UTF-8"?>\n' +
            '<gpx version="1.1" creator="qzsf-orienteering" xmlns="http://www.topografix.com/GPX/1/1">\n' +
            '  <metadata><name>' + r.name + '</name></metadata>\n' +
            '  <trk><name>' + r.name + '</name><trkseg>\n' + body + '\n  </trkseg></trk>\n</gpx>';
        }

        render();
      }
    };
  }

  /* ---------- 单条采集查看 ---------- */
  function SurveyViewPage(params) {
    var id = params && params.id;
    var rec = id ? Survey.get(id) : null;

    if (!rec) {
      setTimeout(function () { Router.go('survey-list', { replace: true }); }, 0);
      return { html: '' };
    }

    var map = null;

    return {
      html: '' +
        '<div class="page survey-view-page">' +
        '  <div class="map-topbar">' +
        '    <div class="mt-back" data-back>‹</div>' +
        '    <div class="mt-title">' +
        '      <div class="mt-name">' + rec.name + '</div>' +
        '      <div class="mt-sub">' + rec.stats.accepted + ' 点 · ' + U.fmtDist(rec.stats.distance) + '</div>' +
        '    </div>' +
        '  </div>' +
        '  <div class="map-body"><div id="map" class="map-canvas"></div>' +
        '    <div class="map-fabs"><div class="fab" id="sv-layer">◧</div></div>' +
        '  </div>' +
        '  <div class="gt-panel">' +
        '    <div class="gt-grid">' +
        '      <div class="gt-cell"><div class="k">采集点</div><div class="v">' + rec.stats.accepted + '</div></div>' +
        '      <div class="gt-cell"><div class="k">原始采样</div><div class="v">' + rec.stats.total + '</div></div>' +
        '      <div class="gt-cell"><div class="k">被拒点</div><div class="v">' + rec.stats.rejected + '</div></div>' +
        '      <div class="gt-cell"><div class="k">距离</div><div class="v small">' + U.fmtDist(rec.stats.distance) + '</div></div>' +
        '    </div>' +
        '    <div class="gt-actions">' +
        '      <button class="btn" id="sv-to-editor">导入路线编辑器核验</button>' +
        '      <button class="btn outline sm mt8" id="sv-export">导出 GPX</button>' +
        '    </div>' +
        '  </div>' +
        '</div>',

      mount: function (el) {
        el.querySelector('[data-back]').onclick = function () { Router.go('survey-list'); };

        var baseKind = 'normal';
        var mapEl = el.querySelector('#map');
        MapEngine.create(mapEl, { zoom: 18, minZoom: 10, maxZoom: 20 }).then(function (m) {
          if (!el.isConnected) { m.destroy(); return; }
          map = m;
          var pts = rec.track.map(function (p) { return [p.display.lng, p.display.lat]; });
          if (pts.length >= 2) {
            map.addPolyline(pts, { strokeColor: '#2b7fff', strokeWeight: 5, zIndex: 80 });
            map.fitPoints(pts, [40, 40, 150, 40], 19);
          }
        });

        el.querySelector('#sv-layer').onclick = function () {
          if (!map) return;
          baseKind = baseKind === 'normal' ? 'satellite' : baseKind === 'satellite' ? 'hybrid' : 'normal';
          map.setBase(baseKind);
        };

        el.querySelector('#sv-to-editor').onclick = function () {
          // 把采集点作为「参考轨迹」传给编辑器，由管理员人工决定是否采用
          sessionStorage.setItem('survey_to_editor', JSON.stringify({
            id: rec.id, name: rec.name,
            points: rec.track.map(function (p) { return [p.display.lng, p.display.lat]; })
          }));
          U.toast('已载入编辑器作为参考线');
          Router.go('admin-course');
        };

        el.querySelector('#sv-export').onclick = function () {
          var body = rec.track.map(function (p) {
            return '      <trkpt lat="' + p.raw.lat.toFixed(8) + '" lon="' + p.raw.lng.toFixed(8) + '">' +
              '<time>' + new Date(p.ts).toISOString() + '</time></trkpt>';
          }).join('\n');
          var gpx = '<?xml version="1.0" encoding="UTF-8"?>\n' +
            '<gpx version="1.1" creator="qzsf-orienteering" xmlns="http://www.topografix.com/GPX/1/1">\n' +
            '<trk><name>' + rec.name + '</name><trkseg>\n' + body + '\n</trkseg></trk>\n</gpx>';
          var blob = new Blob([gpx], { type: 'application/gpx+xml;charset=utf-8' });
          var a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = rec.name + '.gpx';
          a.click();
        };
      },

      unmount: function () { if (map) { map.destroy(); map = null; } }
    };
  }

  window.RouteSurvey = Survey;
  window.Pages = window.Pages || {};
  window.Pages.survey = SurveyPage;
  window.Pages['survey-list'] = SurveyListPage;
  window.Pages['survey-view'] = SurveyViewPage;
})();
