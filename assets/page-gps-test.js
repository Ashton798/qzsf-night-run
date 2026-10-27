/* GPS 精度诊断页
 *
 * 用途：实地测试手机 GPS 在校园里的实际表现
 *  - 强制 enableHighAccuracy / maximumAge:0 / timeout:10000
 *  - 实时显示经纬度、精度、更新时间、速度、采样数
 *  - 显示精度圈
 *  - 保留全部原始采样（含被判定为异常的）
 *  - 支持导出 JSON / GPX
 */
(function () {
  'use strict';
  var U = window.U;

  function GpsTestPage() {
    var map = null;
    var me = null, accCircle = null;
    var timer = null;
    var exportName = 'gps-test-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

    return {
      html: '' +
        '<div class="page gps-test-page">' +
        '  <div class="map-topbar">' +
        '    <div class="mt-back" data-back>‹</div>' +
        '    <div class="mt-title">' +
        '      <div class="mt-name">定位精度测试</div>' +
        '      <div class="mt-sub" id="gt-sub">尚未开始</div>' +
        '    </div>' +
        '    <div class="mt-status" id="gt-status"><i></i><span>未开始</span></div>' +
        '  </div>' +

        '  <div class="map-body">' +
        '    <div id="map" class="map-canvas"></div>' +
        '    <div class="map-fabs">' +
        '      <div class="fab" id="gt-locate" title="回到我的位置">◎</div>' +
        '      <div class="fab" id="gt-layer" title="切换图层">◧</div>' +
        '    </div>' +
        '  </div>' +

        '  <div class="gt-panel">' +
        '    <div class="gt-grid">' +
        '      <div class="gt-cell"><div class="k">定位精度</div><div class="v" id="gt-acc">--</div></div>' +
        '      <div class="gt-cell"><div class="k">采样点数</div><div class="v" id="gt-count">0</div></div>' +
        '      <div class="gt-cell"><div class="k">移动速度</div><div class="v" id="gt-speed">--</div></div>' +
        '      <div class="gt-cell"><div class="k">更新时间</div><div class="v small" id="gt-time">--</div></div>' +
        '    </div>' +
        '    <div class="gt-coord" id="gt-coord">点击下方按钮开始测试</div>' +
        '    <div class="gt-flags" id="gt-flags"></div>' +
        '    <div class="gt-actions" id="gt-actions"></div>' +
        '  </div>' +
        '</div>',

      mount: function (el) {
        el.querySelector('[data-back]').onclick = function () { Router.back(); };

        var subEl = el.querySelector('#gt-sub');
        var statusEl = el.querySelector('#gt-status');
        var accEl = el.querySelector('#gt-acc');
        var countEl = el.querySelector('#gt-count');
        var speedEl = el.querySelector('#gt-speed');
        var timeEl = el.querySelector('#gt-time');
        var coordEl = el.querySelector('#gt-coord');
        var flagsEl = el.querySelector('#gt-flags');
        var actEl = el.querySelector('#gt-actions');

        var baseKind = 'normal';

        var mapEl = el.querySelector('#map');
        MapEngine.create(mapEl, { zoom: 18, minZoom: 10, maxZoom: 20 }).then(function (m) {
          if (!el.isConnected) { m.destroy(); return; }
          map = m;
          var c = window.AppConfig.get('event.campusCenter');
          map.setCenter(c[0], c[1], 18);
          render();
        }).catch(function (err) {
          MapEngine.renderError(mapEl, err);
        });

        el.querySelector('#gt-locate').onclick = function () {
          var s = Geo.snapshot();
          if (s.last && map) map.setCenter(s.last.gcj[0], s.last.gcj[1], 19);
          else U.toast('还没有定位数据');
        };

        el.querySelector('#gt-layer').onclick = function () {
          if (!map) return;
          baseKind = baseKind === 'normal' ? 'satellite' : baseKind === 'satellite' ? 'hybrid' : 'normal';
          map.setBase(baseKind);
          U.toast({ normal: '标准地图', satellite: '卫星地图', hybrid: '卫星+路网' }[baseKind]);
        };

        function render() {
          var s = Geo.snapshot();
          var active = Geo.isActive();

          // 状态
          var st = s.status;
          var label = { ok: '定位正常', lowacc: '精度较差', requesting: '定位中', lost: '信号中断',
            denied: '权限被拒', timeout: '超时', unavailable: '不可用', insecure: '需 HTTPS',
            paused: '已暂停', idle: '未开始' }[st] || st;
          var color = { ok: '#0f9d76', lowacc: '#f5a623', lost: '#e5484d', denied: '#e5484d',
            timeout: '#e5484d', unavailable: '#e5484d', insecure: '#e5484d' }[st] || '#8a9a94';
          statusEl.querySelector('i').style.background = color;
          statusEl.querySelector('span').textContent = label;

          // 数据
          if (s.last) {
            var a = s.last.accuracy;
            accEl.textContent = a != null ? '±' + a.toFixed(1) + ' m' : '--';
            accEl.style.color = a > 30 ? 'var(--warn)' : a > 100 ? 'var(--danger)' : 'var(--brand-dark)';

            var t = new Date(s.last.ts);
            timeEl.textContent = U.pad(t.getHours()) + ':' + U.pad(t.getMinutes()) + ':' + U.pad(t.getSeconds());
            speedEl.textContent = (s.last.speed != null && s.last.speed >= 0)
              ? (s.last.speed * 3.6).toFixed(1) + ' km/h' : '--';

            coordEl.innerHTML =
              '<div class="gt-coord-row"><span>WGS84（GPS 原始）</span><b>' +
              s.last.lat.toFixed(7) + ', ' + s.last.lng.toFixed(7) + '</b></div>' +
              '<div class="gt-coord-row"><span>GCJ02（地图显示）</span><b>' +
              s.last.gcjLat.toFixed(7) + ', ' + s.last.gcjLng.toFixed(7) + '</b></div>';

            var fl = s.last.flags || [];
            flagsEl.innerHTML = fl.length
              ? '<div class="gt-flag warn">⚠️ ' + fl.map(function (f) {
                  return { accuracy_poor: '精度差', jitter: '抖动', jump: '跳点', time_reverse: '时间倒序' }[f] || f;
                }).join(' · ') + '</div>'
              : (s.last.trusted ? '<div class="gt-flag ok">✓ 该点可信</div>' : '');

            // 地图
            if (map) {
              var pos = [s.last.gcj[0], s.last.gcj[1]];
              var first = !me;
              if (first) {
                me = map.addMarker({
                  position: pos, html: '<div class="me-pin"><span></span></div>',
                  iconSize: [28, 28], iconAnchor: [14, 14], zIndex: 200
                });
              } else me.setPosition(pos);
              // 首次定位自动居中，之后保持用户视野
              if (first) map.setCenter(pos[0], pos[1], 19);

              if (!accCircle) {
                accCircle = map.addCircle(pos, a || 10, {
                  strokeColor: '#2b7fff', strokeWeight: 1.5, fillColor: '#2b7fff', fillOpacity: .12
                });
              } else {
                accCircle.setCenter(pos);
                accCircle.setRadius(a || 10);
              }
            }
          }

          countEl.textContent = s.samples;
          subEl.textContent = active
            ? (s.paused ? '已暂停 · ' + s.samples + ' 个采样' : '测试中 · ' + s.samples + ' 个采样')
            : (s.samples ? '已停止 · ' + s.samples + ' 个采样' : '尚未开始');

          // 按钮
          if (!active) {
            actEl.innerHTML = '<button class="btn" id="gt-start">开始测试</button>' +
              (s.samples ? '<div class="row gap8 mt8">' +
                '<button class="btn outline sm" id="gt-json" style="flex:1">导出 JSON</button>' +
                '<button class="btn outline sm" id="gt-gpx" style="flex:1">导出 GPX</button></div>' : '');
            var b = el.querySelector('#gt-start');
            if (b) b.onclick = function () { Geo.start(); render(); };
            var jb = el.querySelector('#gt-json');
            if (jb) jb.onclick = exportJson;
            var gb = el.querySelector('#gt-gpx');
            if (gb) gb.onclick = exportGpx;
          } else if (s.paused) {
            actEl.innerHTML = '<div class="row gap8">' +
              '<button class="btn outline" id="gt-stop" style="flex:1">结束</button>' +
              '<button class="btn" id="gt-resume" style="flex:2">继续</button></div>';
            el.querySelector('#gt-resume').onclick = function () { Geo.resume(); render(); };
            el.querySelector('#gt-stop').onclick = function () { Geo.stop(); render(); };
          } else {
            actEl.innerHTML = '<div class="row gap8">' +
              '<button class="btn outline" id="gt-pause" style="flex:1">暂停</button>' +
              '<button class="btn ghost" id="gt-finish" style="flex:1">结束并保存</button></div>';
            el.querySelector('#gt-pause').onclick = function () { Geo.pause(); render(); };
            el.querySelector('#gt-finish').onclick = function () { Geo.stop(); render(); U.toast('已结束，可导出'); };
          }
        }

        function download(name, content, mime) {
          var blob = new Blob([content], { type: mime + ';charset=utf-8' });
          var a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = name;
          a.click();
          setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
        }

        function exportJson() {
          var data = Geo.exportJSON({
            purpose: 'gps-accuracy-test',
            device: navigator.userAgent,
            campus: '泉州师范学院东海主校区'
          });
          download(exportName + '.json', JSON.stringify(data, null, 2), 'application/json');
          U.toast('已导出 JSON');
        }

        function exportGpx() {
          download(exportName + '.gpx', Geo.exportGPX('GPS精度测试'), 'application/gpx+xml');
          U.toast('已导出 GPX（WGS84）');
        }

        // 绑定回调
        Geo.onUpdate = function () { if (el.isConnected) render(); };

        // 定时刷新"更新时间"与中断状态
        timer = setInterval(function () { if (el.isConnected) render(); }, 1000);

        render();
      },

      unmount: function () {
        Geo.onUpdate = null;
        if (timer) { clearInterval(timer); timer = null; }
        if (map) { map.destroy(); map = null; }
      }
    };
  }

  window.Pages = window.Pages || {};
  window.Pages['gps-test'] = GpsTestPage;
})();
