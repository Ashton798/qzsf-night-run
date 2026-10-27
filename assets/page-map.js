/* 地图页（手机端全屏）
 *
 * 顶部：返回 / 标题 / 定位状态
 * 中间：真实校园地图（标准 / 卫星 / 卫星+路网）
 * 右侧：回到我的位置 / 切换图层 / 显示完整路线 / 缩放
 * 底部：总里程、打卡进度、精度、开启定位
 */
(function () {
  'use strict';
  var U = window.U, C = window.CAMPUS;

  var STATUS_STYLE = {
    idle:        { cls: 'idle', dot: '#8a9a94', text: '未定位' },
    requesting:  { cls: 'wait', dot: '#f5a623', text: '定位中' },
    ok:          { cls: 'ok',   dot: '#0f9d76', text: '定位正常' },
    lowacc:      { cls: 'warn', dot: '#f5a623', text: '精度较差' },
    lost:        { cls: 'bad',  dot: '#e5484d', text: '定位中断' },
    paused:      { cls: 'idle', dot: '#8a9a94', text: '已暂停' },
    denied:      { cls: 'bad',  dot: '#e5484d', text: '权限被拒' },
    timeout:     { cls: 'bad',  dot: '#e5484d', text: '定位超时' },
    unavailable: { cls: 'bad',  dot: '#e5484d', text: '无法定位' },
    insecure:    { cls: 'bad',  dot: '#e5484d', text: '需 HTTPS' }
  };

  var BASE_LABEL = { normal: '标准地图', satellite: '卫星地图', hybrid: '卫星+路网' };
  var BASE_ORDER = ['normal', 'satellite', 'hybrid'];

  function MapPage() {
    var course = CourseStore.load();
    var hasCourse = !!(course && course.route && course.route.points && course.route.points.length >= 2);

    var map = null;
    var layers = { route: null, routeCasing: null, cps: [], start: null, finish: null, me: null, meAcc: null, track: null };
    var follow = true;
    var baseKind = (function () {
      var saved = U.load('map_base_kind', 'normal');
      return ['normal', 'satellite', 'hybrid'].indexOf(saved) >= 0 ? saved : 'normal';
    })();

    // 校园规划参考图层
    var plan = CampusPlanLayer.load();
    var planOverlay = null;
    var planOn = !!(plan.enabled && plan.transform);
    var zoom = 16;

    return {
      html: '' +
        '<div class="page map-page">' +
        '  <div class="map-topbar">' +
        '    <div class="mt-back" data-back>‹</div>' +
        '    <div class="mt-title">' +
        '      <div class="mt-name">校园定向跑</div>' +
        '      <div class="mt-sub" id="mt-sub">泉州师范学院东海主校区</div>' +
        '    </div>' +
        '    <div class="mt-status" id="mt-status">' +
        '      <i id="mt-dot"></i><span id="mt-stext">未定位</span>' +
        '    </div>' +
        '  </div>' +

        '  <div class="map-body">' +
        '    <div id="map" class="map-canvas"></div>' +
        '    <div class="map-fabs">' +
        '      <div class="fab" id="fab-zoom-in" title="放大">＋</div>' +
        '      <div class="fab" id="fab-zoom-out" title="缩小">－</div>' +
        '      <div class="fab" id="fab-locate" title="回到我的位置">◎</div>' +
        '      <div class="fab" id="fab-layer" title="切换图层">◧</div>' +
        '      <div class="fab" id="fab-fit" title="显示完整路线">⛶</div>' +
        '      <div class="fab" id="fab-plan" title="规划参考图" style="font-size:15px">图</div>' +
        '    </div>' +
        '    <div class="map-layer-tip" id="layer-tip"></div>' +
        '    <div class="map-hint" id="map-hint"></div>' +
        '  </div>' +

        '  <div class="map-bottom">' +
        '    <div class="mb-row">' +
        '      <div class="mb-stat"><div class="k">总里程</div><div class="v" id="mb-dist">0 m</div></div>' +
        '      <div class="mb-stat"><div class="k">已完成打卡</div><div class="v" id="mb-cp">0 / 6</div></div>' +
        '      <div class="mb-stat"><div class="k">定位精度</div><div class="v" id="mb-acc">--</div></div>' +
        '    </div>' +
        '    <div class="mb-loc" id="mb-loc">尚未获取定位</div>' +
        '    <div class="mb-actions" id="mb-actions"></div>' +
        '  </div>' +
        '</div>',

      mount: function (el) {
        el.querySelector('[data-back]').onclick = function () { Router.back(); };

        var dotEl = el.querySelector('#mt-dot');
        var stextEl = el.querySelector('#mt-stext');
        var hintEl = el.querySelector('#map-hint');
        var layerTipEl = el.querySelector('#layer-tip');
        var distEl = el.querySelector('#mb-dist');
        var cpEl = el.querySelector('#mb-cp');
        var accEl = el.querySelector('#mb-acc');
        var locEl = el.querySelector('#mb-loc');
        var actEl = el.querySelector('#mb-actions');

        /* ---------- 地图初始化 ---------- */
        var mapEl = el.querySelector('#map');
        MapEngine.create(mapEl, {
          zoom: zoom,
          minZoom: 10,
          maxZoom: 20
        }).then(function (m) {
          if (!el.isConnected) { m.destroy(); return; }
          map = m;
          if (baseKind !== 'normal') map.setBase(baseKind);
          initPlanLayer();
          drawCourse();
          map.onZoomEnd(function () {
            zoom = map.getZoom();
            updateZoomTip();
          });
          renderStatus(Geo.snapshot());
          updateZoomTip();

          // 从服务器拉取最新路线
          CourseStore.remoteLoad().then(function (c) {
            if (!el.isConnected || !c) return;
            course = c;
            hasCourse = !!(c.route && c.route.points && c.route.points.length >= 2);
            clearCourseLayers();
            drawCourse();
            renderStatus(Geo.snapshot());
          });
        }).catch(function (err) {
          MapEngine.renderError(mapEl, err);
          hintEl.innerHTML = '地图不可用，但仍可开启定位记录轨迹';
          hintEl.classList.add('show');
        });

        /* 级别指示：明确告知当前是否超出原生分辨率
         * 高德实测原生最高 18 级（见 map-engine.js 注释），
         * 19–20 级是像素放大，必须让用户知道，不能假装高清。
         */
        /* ---------- 校园规划参考图 ---------- */
        function initPlanLayer() {
          if (!plan.transform) {
            el.querySelector('#fab-plan').style.display = 'none';
            return;
          }
          planOverlay = map.addImageOverlay({
            src: plan.image.src,
            width: plan.image.width,
            height: plan.image.height,
            opacity: plan.opacity,
            visible: planOn,
            imageToLngLat: function (x, y) {
              return CampusPlanLayer.applyTransform(plan.transform, x, y);
            }
          });
          el.querySelector('#fab-plan').classList.toggle('on', planOn);
          updatePlanBadge();
        }

        function updatePlanBadge() {
          var fab = el.querySelector('#fab-plan');
          if (fab) {
            fab.style.background = planOn ? 'var(--brand-light)' : '#fff';
            fab.style.color = planOn ? 'var(--brand-dark)' : 'var(--ink-2)';
            fab.style.fontWeight = planOn ? '700' : '400';
          }
          var tip = el.querySelector('#plan-tip');
          if (planOn) {
            if (!tip) {
              tip = document.createElement('div');
              tip.id = 'plan-tip';
              tip.className = 'map-plan-tip';
              tip.textContent = '规划参考图 · 非测绘 · 偏差约 100-150m';
              el.querySelector('.map-body').appendChild(tip);
            }
          } else if (tip) {
            tip.remove();
          }
        }

        function updateZoomTip() {
          if (!map) return;
          var z = map.getZoom();
          var native = map.getSatMaxZoom ? map.getSatMaxZoom() : 18;
          var over = z > native;
          var txt = 'Z' + z + ' · ' + BASE_LABEL[baseKind];
          if (over) txt += ' · 超出原生 ' + native + ' 级（放大显示）';
          layerTipEl.textContent = txt;
          layerTipEl.classList.add('show');
          layerTipEl.classList.toggle('warn', over);
        }

        function clearCourseLayers() {
          ['route', 'routeCasing', 'start', 'finish'].forEach(function (k) {
            if (layers[k]) { layers[k].remove(); layers[k] = null; }
          });
          layers.cps.forEach(function (c) { c.circle.remove(); c.marker.remove(); });
          layers.cps = [];
        }

        function drawCourse() {
          if (!map) return;
          if (!hasCourse) {
            hintEl.innerHTML = '管理员尚未配置比赛路线，<a href="#" id="hint-admin">去设置</a>';
            hintEl.classList.add('show');
            var a = el.querySelector('#hint-admin');
            if (a) a.onclick = function (e) { e.preventDefault(); Router.go('admin-course'); };
            return;
          }
          var pts = course.route.points;
          layers.routeCasing = map.addPolyline(pts, {
            strokeColor: '#ffffff', strokeWeight: 10, strokeOpacity: .9, zIndex: 55
          });
          layers.route = map.addPolyline(pts, {
            strokeColor: '#0f9d76', strokeWeight: 5, strokeOpacity: 1, zIndex: 60
          });

          if (course.route.start) {
            layers.start = map.addMarker({
              position: course.route.start,
              html: '<div class="pin-start">起</div>',
              iconSize: [30, 30], iconAnchor: [15, 15], zIndex: 120
            });
          }
          if (course.route.finish) {
            layers.finish = map.addMarker({
              position: course.route.finish,
              html: '<div class="pin-finish">终</div>',
              iconSize: [30, 30], iconAnchor: [15, 15], zIndex: 120
            });
          }

          (course.checkpoints || []).forEach(function (cp, i) {
            if (!cp.lnglat) return;
            var circle = map.addCircle(cp.lnglat, cp.radius || 30, {
              strokeColor: '#f5a623', fillColor: '#f5a623', fillOpacity: .10, strokeWeight: 1.5
            });
            var mk = map.addMarker({
              position: cp.lnglat,
              html: '<div class="pin-cp">' + (i + 1) + '</div>',
              iconSize: [26, 26], iconAnchor: [13, 13], zIndex: 110
            });
            mk.on('click', function () { U.toast(cp.id + ' ' + cp.name + ' · 半径 ' + cp.radius + 'm'); });
            layers.cps.push({ circle: circle, marker: mk, cp: cp });
          });

          fitRoute();
        }

        function fitRoute() {
          if (!map) return;
          var pts = [];
          if (hasCourse) {
            pts = course.route.points.slice();
            (course.checkpoints || []).forEach(function (cp) { if (cp.lnglat) pts.push(cp.lnglat); });
          }
          if (!pts.length) pts = [window.AppConfig.get('event.campusCenter')];
          map.fitPoints(pts, [40, 40, 150, 40], 18);
        }

        /* ---------- 状态渲染 ---------- */
        function renderStatus(snap) {
          var st = STATUS_STYLE[snap.status] || STATUS_STYLE.idle;
          dotEl.style.background = st.dot;
          stextEl.textContent = st.text;
          el.querySelector('#mt-status').className = 'mt-status ' + st.cls;

          if (snap.last && snap.last.accuracy != null) {
            accEl.textContent = '±' + Math.round(snap.last.accuracy) + ' m';
            accEl.style.color = snap.last.accuracy > 30 ? 'var(--warn)' : 'var(--ink)';
          } else {
            accEl.textContent = '--';
            accEl.style.color = 'var(--ink-3)';
          }

          distEl.textContent = U.fmtDist(snap.distance);

          var done = countCps(snap.last ? [snap.last.gcjLat, snap.last.gcjLng] : null);
          cpEl.textContent = done + ' / ' + (course && course.checkpoints ? course.checkpoints.length : 6);

          if (snap.last) {
            var t = new Date(snap.last.ts);
            var lines = [
              'WGS84 ' + snap.last.lat.toFixed(6) + ', ' + snap.last.lng.toFixed(6),
              'GCJ02 ' + snap.last.gcjLat.toFixed(6) + ', ' + snap.last.gcjLng.toFixed(6),
              '更新于 ' + U.pad(t.getHours()) + ':' + U.pad(t.getMinutes()) + ':' + U.pad(t.getSeconds())
            ];
            if (snap.last.speed != null && snap.last.speed >= 0) {
              lines.push('速度 ' + (snap.last.speed * 3.6).toFixed(1) + ' km/h');
            }
            if (snap.last.flags && snap.last.flags.length) {
              lines.push('标记：' + snap.last.flags.join(', '));
            }
            locEl.innerHTML = lines.join('<br>');
          } else {
            locEl.textContent = snap.message;
          }

          if (snap.status !== 'ok' && snap.status !== 'idle') {
            hintEl.innerHTML = snap.message;
            hintEl.classList.add('show', 'warn');
          } else {
            hintEl.classList.remove('show', 'warn');
          }

          if (snap.last) drawMe(snap.last);
          renderActions(snap);
        }

        function countCps(p) {
          if (!p || !course || !course.checkpoints) return 0;
          var n = 0;
          course.checkpoints.forEach(function (cp) {
            if (cp.lnglat && U.dist([p[1], p[0]], [cp.lnglat[1], cp.lnglat[0]]) <= (cp.radius || 30)) n++;
          });
          return n;
        }

        function drawMe(last) {
          if (!map) return;
          var pos = [last.gcj[0], last.gcj[1]];   // [lng, lat]
          if (!layers.me) {
            layers.me = map.addMarker({
              position: pos,
              html: '<div class="me-pin"><span></span></div>',
              iconSize: [28, 28], iconAnchor: [14, 14], zIndex: 200
            });
          } else {
            layers.me.setPosition(pos);
          }
          if (!layers.meAcc) {
            layers.meAcc = map.addCircle(pos, last.accuracy, {
              strokeColor: '#2b7fff', strokeWeight: 1, fillColor: '#2b7fff', fillOpacity: .10
            });
          } else {
            layers.meAcc.setCenter(pos);
            layers.meAcc.setRadius(last.accuracy);
          }
          if (follow) map.setCenter(pos[0], pos[1]);
        }

        function renderActions(snap) {
          var active = Geo.isActive();
          if (!active) {
            actEl.innerHTML = '<button class="btn" id="b-start">开启定位</button>' +
              (['insecure', 'denied', 'unavailable'].indexOf(snap.status) >= 0
                ? '<div class="small muted center mt8">' + snap.message + '</div>' : '');
            el.querySelector('#b-start').onclick = function () { Geo.start(); };
            return;
          }
          if (snap.paused) {
            actEl.innerHTML = '<div class="row gap8">' +
              '<button class="btn outline" id="b-stop" style="flex:1">停止</button>' +
              '<button class="btn" id="b-resume" style="flex:2">继续记录</button></div>';
            el.querySelector('#b-resume').onclick = function () { Geo.resume(); };
            el.querySelector('#b-stop').onclick = function () { Geo.stop(); };
          } else {
            actEl.innerHTML = '<div class="row gap8">' +
              '<button class="btn outline" id="b-pause" style="flex:1">暂停</button>' +
              '<button class="btn ghost" id="b-reset" style="flex:1">清空轨迹</button></div>';
            el.querySelector('#b-pause').onclick = function () { Geo.pause(); };
            el.querySelector('#b-reset').onclick = function () {
              if (!confirm('清空本次记录的轨迹？')) return;
              Geo.reset();
              if (layers.track) { layers.track.remove(); layers.track = null; }
            };
          }
        }

        /* ---------- 定位回调 ---------- */
        Geo.onUpdate = function (snap) { if (el.isConnected) renderStatus(snap); };

        Geo.onTrackPoint = function (sample) {
          if (!map) return;
          var ll = [sample.display.lng, sample.display.lat];
          if (!layers.track) {
            layers.track = map.addPolyline([], {
              strokeColor: '#2b7fff', strokeWeight: 4, strokeOpacity: .95,
              strokeStyle: 'dashed', strokeDasharray: [8, 6], zIndex: 80
            });
            layers.track._pts = [];
          }
          layers.track._pts.push(ll);
          layers.track.setPath(layers.track._pts);
        };

        // 恢复已有轨迹
        setTimeout(function () {
          if (!map || !Geo.S.track.length) return;
          var pts = Geo.S.track.map(function (s) { return [s.display.lng, s.display.lat]; });
          layers.track = map.addPolyline(pts, {
            strokeColor: '#2b7fff', strokeWeight: 4, strokeOpacity: .95,
            strokeStyle: 'dashed', strokeDasharray: [8, 6], zIndex: 80
          });
          layers.track._pts = pts;
        }, 400);

        /* ---------- 悬浮按钮 ---------- */
        el.querySelector('#fab-zoom-in').onclick = function () {
          if (map) map.zoomIn();
        };
        el.querySelector('#fab-zoom-out').onclick = function () {
          if (map) map.zoomOut();
        };

        el.querySelector('#fab-locate').onclick = function () {
          var snap = Geo.snapshot();
          if (!snap.last) { U.toast('还没有定位，请先开启定位'); return; }
          follow = true;
          if (map) map.setCenter(snap.last.gcj[0], snap.last.gcj[1], Math.max(zoom, 18));
        };

        el.querySelector('#fab-layer').onclick = function () {
          if (!map) return;
          var i = BASE_ORDER.indexOf(baseKind);
          baseKind = BASE_ORDER[(i + 1) % BASE_ORDER.length];
          map.setBase(baseKind);
          U.save('map_base_kind', baseKind);
          updateZoomTip();
          U.toast('已切换：' + BASE_LABEL[baseKind]);
        };

        el.querySelector('#fab-fit').onclick = function () {
          follow = false;
          fitRoute();
        };

        el.querySelector('#fab-plan').onclick = function () {
          if (!planOverlay) { U.toast('管理员尚未配准参考图'); return; }
          planOn = !planOn;
          planOverlay.setVisible(planOn);
          plan.enabled = planOn;
          CampusPlanLayer.save(plan);
          updatePlanBadge();
          U.toast(planOn ? '已叠加规划参考图（参考级）' : '已隐藏参考图');
        };

        renderStatus(Geo.snapshot());
      },

      unmount: function () {
        Geo.onUpdate = null;
        Geo.onTrackPoint = null;
        if (map) { map.destroy(); map = null; }
      }
    };
  }

  window.Pages = window.Pages || {};
  window.Pages.map = MapPage;
})();
