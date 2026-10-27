/* 管理员 · 比赛路线编辑器
 *
 * 功能：
 *  - 地图点击添加途经点，自动连线
 *  - 拖动 / 删除 / 插入 / 撤销 / 重做
 *  - 设置起点、终点
 *  - 6 个打卡点：位置、名称、顺序、打卡半径
 *  - 实时显示路线总长度
 *  - 保存 / 恢复 / 导出 JSON / 导入 JSON / 导出 GPX
 *
 * 桌面端：右侧固定面板 + 鼠标操作
 * 移动端：底部抽屉 + 触控操作
 */
(function () {
  'use strict';
  var U = window.U;

  function CourseEditorPage() {
    if (!AdminAuth.guard(Router)) return { html: '' };

    var course = CourseStore.blank();
    var selectedGroup = 'competition', nightPlan = null;
    course.route.routeKey = 'A';
    function selectNightRoute(group) {
      selectedGroup = group;
      return CourseStore.remoteLoad(group, true).then(function(c) {
        course = c || CourseStore.blank();
        course.route.routeKey = group === 'competition' ? 'A' : 'B';
        course.route.groupKey = null; course.groupKey = null;
        if (nightPlan) {
          var spec = nightPlan.routes[course.route.routeKey];
          course.name = spec.name;
          if (!c) course.checkpoints.forEach(function(cp,i) { cp.name=spec.checkpoints[i]+' · '+nightPlan.games[i].name; });
        }
        undoStack=[]; redoStack=[];
        redrawAll(); renderPanel();
      });
    }
    var undoStack = [];
    var redoStack = [];
    var map = null;
    var mode = 'route';        // route | start | finish | cp
    var activeCp = 0;          // 当前编辑的打卡点索引
    var overlays = {
      casing: null, line: null, handles: [],
      start: null, finish: null, cpCircles: [], cpMarkers: [],
      refLines: [], refMarkers: []
    };
    // GPS 采集参考线（仅作对照，不会自动采用）
    var refTracks = [];
    var showRef = true;

    function snapshotState() {
      return JSON.stringify(course);
    }
    function pushUndo() {
      undoStack.push(snapshotState());
      if (undoStack.length > 60) undoStack.shift();
      redoStack.length = 0;
    }
    function undo() {
      if (!undoStack.length) { U.toast('没有可撤销的操作'); return; }
      redoStack.push(snapshotState());
      course = JSON.parse(undoStack.pop());
      redrawAll();
      renderPanel();
    }
    function redo() {
      if (!redoStack.length) { U.toast('没有可重做的操作'); return; }
      undoStack.push(snapshotState());
      course = JSON.parse(redoStack.pop());
      redrawAll();
      renderPanel();
    }

    /* ---------------- 渲染：地图 ---------------- */
    function clearRouteOverlays() {
      ['casing', 'line', 'start', 'finish'].forEach(function (k) {
        if (overlays[k]) { overlays[k].remove(); overlays[k] = null; }
      });
      overlays.handles.forEach(function (h) { h.remove(); });
      overlays.handles = [];
      overlays.cpCircles.forEach(function (c) { c.remove(); });
      overlays.cpCircles = [];
      overlays.cpMarkers.forEach(function (m) { m.remove(); });
      overlays.cpMarkers = [];
      overlays.refLines.forEach(function (l) { l.remove(); });
      overlays.refLines = [];
      overlays.refMarkers.forEach(function (m) { m.remove(); });
      overlays.refMarkers = [];
    }

    function redrawAll() {
      if (!map) return;
      clearRouteOverlays();
      drawRoute();
      drawEndpoints();
      drawCheckpoints();
      if (showRef) drawRefTracks();
      renderStats();
    }

    /* 绘制 GPS 采集参考线（不同颜色，仅作对照） */
    function drawRefTracks() {
      if (!map || !refTracks.length) return;
      var colors = ['#2b7fff', '#ff7a45', '#a855f7', '#f59e0b'];
      refTracks.forEach(function (t, i) {
        if (!t.points || t.points.length < 2) return;
        var c = colors[i % colors.length];
        var line = map.addPolyline(t.points, {
          strokeColor: c, strokeWeight: 3, strokeOpacity: .75,
          strokeStyle: 'dashed', strokeDasharray: [10, 6], zIndex: 70
        });
        overlays.refLines.push(line);
      });
    }

    function drawRoute() {
      var pts = course.route.points;
      if (!pts.length) return;

      if (pts.length >= 2) {
        overlays.casing = map.addPolyline(pts, {
          strokeColor: '#ffffff', strokeWeight: 10, strokeOpacity: .9, zIndex: 55
        });
        overlays.line = map.addPolyline(pts, {
          strokeColor: course.route.routeKey === 'B' ? '#2563eb' : '#ef4444', showDir: true, strokeWeight: 5, strokeOpacity: 1, zIndex: 60
        });
      }

      // 途经点手柄
      pts.forEach(function (p, i) {
        var isFirst = i === 0, isLast = i === pts.length - 1;
        var h = map.addMarker({
          position: p,
          html: '<div class="pt-handle' + (isFirst || isLast ? ' end' : '') + '">' + (i + 1) + '</div>',
          iconSize: [24, 24], iconAnchor: [12, 12],
          zIndex: 130, draggable: true
        });
        h.on('dragend', function (e) {
          pushUndo();
          var old = pts[i];
          course.route.points[i] = readLatLng(e, h);
          if (i === 0 && same(course.route.start, old)) course.route.start = course.route.points[i].slice();
          if (i === pts.length - 1 && same(course.route.finish, old)) course.route.finish = course.route.points[i].slice();
          redrawAll();
          renderPanel();
        });
        h.on('click', function (e) {
          if (e && e.originEvent && e.originEvent.stopPropagation) e.originEvent.stopPropagation();
          selectPoint(i);
        });
        overlays.handles.push(h);
      });
    }

    function same(a, b) {
      return a && b && Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
    }

    var selectedPoint = -1;
    function selectPoint(i) {
      selectedPoint = i;
      renderPanel();
      var p = course.route.points[i];
      if (!p) return;
      var msg = 'P' + (i + 1) + ' ' + p[1].toFixed(6) + ', ' + p[0].toFixed(6);
      if (i > 0) {
        var prev = course.route.points[i - 1];
        msg += ' · 距上点 ' + Math.round(window.Coord.haversine([prev[1], prev[0]], [p[1], p[0]])) + 'm';
      }
      if (i < course.route.points.length - 1) {
        var next = course.route.points[i + 1];
        msg += ' · 距下点 ' + Math.round(window.Coord.haversine([p[1], p[0]], [next[1], next[0]])) + 'm';
      }
      U.toast(msg, 3000);
    }

    /* 选中点的详细信息（面板显示） */
    function pointDetailHtml() {
      if (selectedPoint < 0 || selectedPoint >= course.route.points.length) return '';
      var p = course.route.points[selectedPoint];
      var rows = [
        '<div class="ce-kv"><span>编号</span><b>P' + (selectedPoint + 1) + '</b></div>',
        '<div class="ce-kv"><span>经度</span><b>' + p[0].toFixed(7) + '</b></div>',
        '<div class="ce-kv"><span>纬度</span><b>' + p[1].toFixed(7) + '</b></div>',
        '<div class="ce-kv"><span>坐标系</span><b>GCJ-02</b></div>'
      ];
      if (selectedPoint > 0) {
        var prev = course.route.points[selectedPoint - 1];
        rows.push('<div class="ce-kv"><span>距上一点</span><b>' +
          Math.round(window.Coord.haversine([prev[1], prev[0]], [p[1], p[0]])) + ' m</b></div>');
      }
      if (selectedPoint < course.route.points.length - 1) {
        var next = course.route.points[selectedPoint + 1];
        rows.push('<div class="ce-kv"><span>距下一点</span><b>' +
          Math.round(window.Coord.haversine([p[1], p[0]], [next[1], next[0]])) + ' m</b></div>');
      }
      return '<div class="ce-point-detail">' + rows.join('') + '</div>';
    }

    function drawEndpoints() {
      if (course.route.start) {
        overlays.start = map.addMarker({
          position: course.route.start,
          html: '<div class="pin-start">起</div>',
          iconSize: [32, 32], iconAnchor: [16, 16], zIndex: 140, draggable: true
        });
        overlays.start.on('dragend', function (e) {
          pushUndo();
          course.route.start = readLatLng(e, overlays.start);
          renderPanel();
        });
      }
      if (course.route.finish) {
        overlays.finish = map.addMarker({
          position: course.route.finish,
          html: '<div class="pin-finish">终</div>',
          iconSize: [32, 32], iconAnchor: [16, 16], zIndex: 140, draggable: true
        });
        overlays.finish.on('dragend', function (e) {
          pushUndo();
          course.route.finish = readLatLng(e, overlays.finish);
          renderPanel();
        });
      }
    }

    function readLatLng(e, marker) {
      if (e && e.lnglat) {
        var lng = e.lnglat.getLng ? e.lnglat.getLng() : e.lnglat.lng;
        var lat = e.lnglat.getLat ? e.lnglat.getLat() : e.lnglat.lat;
        return [lng, lat];
      }
      var p = marker.raw.getPosition ? marker.raw.getPosition() : marker.raw.getLatLng();
      return p.getLng ? [p.getLng(), p.getLat()] : [p.lng, p.lat];
    }

    function drawCheckpoints() {
      course.checkpoints.forEach(function (cp, i) {
        if (!cp.lnglat) return;
        var circle = map.addCircle(cp.lnglat, cp.radius || 30, {
          strokeColor: i === activeCp ? '#0f9d76' : '#f5a623',
          strokeWeight: i === activeCp ? 2.5 : 1.5,
          fillColor: i === activeCp ? '#0f9d76' : '#f5a623',
          fillOpacity: .12
        });
        var mk = map.addMarker({
          position: cp.lnglat,
          html: '<div class="pin-cp' + (i === activeCp ? ' active' : '') + '">' + cp.order + '</div>',
          iconSize: [26, 26], iconAnchor: [13, 13], zIndex: 150, draggable: true
        });
        mk.on('dragend', function (e) {
          pushUndo();
          cp.lnglat = readLatLng(e, mk);
          circle.setCenter(cp.lnglat);
          renderPanel();
        });
        mk.on('click', function (e) {
          if (e && e.originEvent && e.originEvent.stopPropagation) e.originEvent.stopPropagation();
          activeCp = i;
          redrawAll();
          renderPanel();
        });
        overlays.cpCircles.push(circle);
        overlays.cpMarkers.push(mk);
      });
    }

    /* ---------------- 渲染：统计 ---------------- */
    function renderStats() {
      var d = CourseStore.distance(course.route.points);
      if (course.route.closed && course.route.points.length > 1) {
        d += CourseStore.distance([course.route.points[course.route.points.length - 1], course.route.points[0]]);
      }
      course.meta.distance = Math.round(d);
      var el = document.getElementById('ce-stats');
      if (!el) return;
      el.innerHTML =
        '<span><b>' + course.route.points.length + '</b> 途经点</span>' +
        '<span><b>' + U.fmtDist(d) + '</b></span>' +
        '<span><b>' + course.checkpoints.filter(function (c) { return !!c.lnglat; }).length + '/3</b> 打卡点</span>';
    }

    /* ---------------- 渲染：面板 ---------------- */
    function renderPanel() {
      var box = document.getElementById('ce-panel-body');
      if (!box) return;
      box.innerHTML = '<div class="ce-sec"><label>策划书路线<select id="night-route"><option value="competition">A · 竞赛红线</option><option value="experience">B · 体验 / 同心蓝线</option></select></label><p>草稿须逐段核对可通行道路。保存不等于发布。</p><button class="btn outline sm" id="night-review">现场核对与发布 / 实时监控</button>' + (nightPlan ? '<details><summary>原始路线图（仅供核对）</summary><img style="width:100%" src="'+nightPlan.routes[course.route.routeKey].figure+'"><a href="data/assets/government-map-1.png" target="_blank">打开政府校园道路平面图</a><p>'+nightPlan.routes[course.route.routeKey].landmarks.join(' → ')+'</p></details>' : '') + '</div>' + panelHtml();
      box.querySelector('#night-route').value=selectedGroup;
      box.querySelector('#night-route').onchange=function(e){selectNightRoute(e.target.value);};
      box.querySelector('#night-review').onclick=function(){Router.go('night-admin');};
      bindPanel();
    }

    function panelHtml() {
      var r = course.route;
      var v = CourseStore.validate(course);

      var modeBtn = function (k, label, extra) {
        return '<div class="ce-mode' + (mode === k ? ' on' : '') + '" data-mode="' + k + '">' + label +
          (extra ? '<span class="ce-mode-sub">' + extra + '</span>' : '') + '</div>';
      };

      return '' +
        '<div class="ce-sec">' +
        '  <div class="ce-sec-title">编辑模式</div>' +
        '  <div class="ce-modes">' +
        modeBtn('route', '路线', '点击地图加点') +
        modeBtn('start', '起点', r.start ? '已设' : '未设') +
        modeBtn('finish', '终点', r.finish ? '已设' : '未设') +
        modeBtn('cp', '打卡点', '当前 ' + (activeCp + 1)) +
        '  </div>' +
        '</div>' +

        '<div class="ce-sec">' +
        '  <div class="ce-sec-title">途经点（' + r.points.length + '）' +
        '    <div class="ce-inline">' +
        '      <button class="ce-mini" id="ce-undo" title="撤销">↶</button>' +
        '      <button class="ce-mini" id="ce-redo" title="重做">↷</button>' +
        '      <button class="ce-mini danger" id="ce-clear" title="清空">✕</button>' +
        '    </div>' +
        '  </div>' +
        (selectedPoint >= 0 && selectedPoint < r.points.length
          ? pointDetailHtml() +
            '<div class="ce-sel">已选 P' + (selectedPoint + 1) +
            ' <button class="ce-link" id="ce-ins-before">向前插入</button>' +
            ' <button class="ce-link" id="ce-ins-after">向后插入</button>' +
            ' <button class="ce-link" id="ce-densify">段内加密</button>' +
            ' <button class="ce-link danger" id="ce-del-point">删除</button></div>'
          : '<div class="ce-tip">点击地图上的数字点可选中，拖动可移动<br>提示：放大到 18 级以上可以精确贴路</div>') +
        '</div>' +

        '<div class="ce-sec">' +
        '  <div class="ce-sec-title">GPS 采集参考线' +
        (refTracks.length ? '（' + refTracks.length + '）' +
          '    <label class="ce-check" style="margin:0"><input type="checkbox" id="ce-showref"' +
          (showRef ? ' checked' : '') + '> 显示</label>' : '') +
        '  </div>' +
        '  <div class="ce-tip">虚线是实地采集的 GPS 轨迹，仅作对照。<b>不会自动吸附或替换</b>你的路线。</div>' +
        '  <div class="ce-row2 mt8">' +
        '    <button class="btn outline sm" id="ce-ref-from">载入采集记录</button>' +
        '    <button class="btn outline sm" id="ce-ref-clear"' +
        (refTracks.length ? '' : ' disabled') + '>清除参考线</button>' +
        '  </div>' +
        '</div>' +

        '<div class="ce-sec">' +
        '  <div class="ce-sec-title">打卡点</div>' +
        '  <div class="ce-cps">' +
        course.checkpoints.map(function (cp, i) {
          return '<div class="ce-cp' + (i === activeCp ? ' on' : '') + '" data-cp="' + i + '">' +
            '  <div class="ce-cp-head"><span class="ce-cp-id">' + cp.id + '</span>' +
            '    <input class="ce-input ce-cp-name" data-i="' + i + '" value="' + esc(cp.name) + '" placeholder="名称">' +
            '  </div>' +
            '  <div class="ce-cp-row">' +
            '    <label>顺序<input class="ce-input ce-cp-order" type="number" min="1" max="99" data-i="' + i + '" value="' + cp.order + '"></label>' +
            '    <label>半径<input class="ce-input ce-cp-radius" type="number" min="5" max="200" data-i="' + i + '" value="' + cp.radius + '">m</label>' +
            '    <button class="ce-mini' + (cp.lnglat ? '' : ' warn') + '" data-locate="' + i + '">' + (cp.lnglat ? '定位' : '未设') + '</button>' +
            '  </div>' +
            '</div>';
        }).join('') +
        '  </div>' +
        '</div>' +

        '<div class="ce-sec">' +
        '  <div class="ce-sec-title">路线信息</div>' +
        '  <label class="ce-field">名称<input class="ce-input" id="ce-name" value="' + esc(course.name) + '"></label>' +
        '  <label class="ce-check"><input type="checkbox" id="ce-closed"' + (r.closed ? ' checked' : '') + '> 环形路线（终点回到起点）</label>' +
        '  <div class="ce-kv"><span>总长度</span><b>' + U.fmtDist(course.meta.distance) + '</b></div>' +
        '  <div class="ce-kv"><span>最近保存</span><b>' + (course.updatedAt ? U.fmtDate(course.updatedAt) : '未保存') + '</b></div>' +
        '</div>' +

        (v.ok ? '' : '<div class="ce-sec"><div class="ce-warn">' +
          v.errors.slice(0, 5).map(function (e) { return '· ' + e; }).join('<br>') + '</div></div>') +

        '<div class="ce-actions">' +
        '  <button class="btn" id="ce-save"' + (v.ok ? '' : ' disabled') + '>保存路线</button>' +
        '  <div class="ce-row2">' +
        '    <button class="btn outline sm" id="ce-export">导出 JSON</button>' +
        '    <button class="btn outline sm" id="ce-import">导入 JSON</button>' +
        '  </div>' +
        '  <div class="ce-row2">' +
        '    <button class="btn outline sm" id="ce-gpx">导出 GPX</button>' +
        '    <button class="btn outline sm" id="ce-reset">重置全部</button>' +
        '  </div>' +
        '</div>';
    }

    function esc(s) { return String(s == null ? '' : s).replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

    function bindPanel() {
      var box = document.getElementById('ce-panel-body');
      if (!box) return;

      box.querySelectorAll('[data-mode]').forEach(function (n) {
        n.onclick = function () {
          mode = n.dataset.mode;
          if (mode === 'cp' && activeCp == null) activeCp = 0;
          U.toast({ route: '点击地图添加途经点', start: '点击地图设置起点', finish: '点击地图设置终点', cp: '点击地图设置第 ' + (activeCp + 1) + ' 个打卡点' }[mode]);
          renderPanel();
        };
      });

      var undoBtn = box.querySelector('#ce-undo');
      if (undoBtn) undoBtn.onclick = undo;
      var redoBtn = box.querySelector('#ce-redo');
      if (redoBtn) redoBtn.onclick = redo;
      var clearBtn = box.querySelector('#ce-clear');
      if (clearBtn) clearBtn.onclick = function () {
        if (!confirm('清空所有途经点？')) return;
        pushUndo();
        course.route.points = [];
        selectedPoint = -1;
        redrawAll(); renderPanel();
      };

      var del = box.querySelector('#ce-del-point');
      if (del) del.onclick = function () {
        if (selectedPoint < 0) return;
        pushUndo();
        course.route.points.splice(selectedPoint, 1);
        selectedPoint = -1;
        redrawAll(); renderPanel();
      };

      var insB = box.querySelector('#ce-ins-before');
      if (insB) insB.onclick = function () { insertAt(selectedPoint, true); };
      var insA = box.querySelector('#ce-ins-after');
      if (insA) insA.onclick = function () { insertAt(selectedPoint, false); };

      // 段内加密：在当前点和下一点之间按实际距离插入若干个点
      var dens = box.querySelector('#ce-densify');
      if (dens) dens.onclick = function () {
        if (selectedPoint < 0 || selectedPoint >= course.route.points.length - 1) {
          U.toast('请选中一个点，且它后面还有下一个点');
          return;
        }
        var a = course.route.points[selectedPoint];
        var b = course.route.points[selectedPoint + 1];
        var d = window.Coord.haversine([a[1], a[0]], [b[1], b[0]]);
        var n = prompt('这一段约 ' + Math.round(d) + ' 米，插入几个中间点？（1-50）', '3');
        n = parseInt(n, 10);
        if (!n || n < 1 || n > 50) return;
        pushUndo();
        var ins = [];
        for (var k = 1; k <= n; k++) {
          var t = k / (n + 1);
          ins.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
        }
        course.route.points.splice.apply(course.route.points, [selectedPoint + 1, 0].concat(ins));
        redrawAll(); renderPanel();
        U.toast('已插入 ' + n + ' 个点，可逐个拖动贴合道路');
      };

      var showRefEl = box.querySelector('#ce-showref');
      if (showRefEl) showRefEl.onchange = function () {
        showRef = showRefEl.checked;
        redrawAll();
      };
      var refFrom = box.querySelector('#ce-ref-from');
      if (refFrom) refFrom.onclick = pickSurvey;
      var refClear = box.querySelector('#ce-ref-clear');
      if (refClear) refClear.onclick = function () {
        refTracks = [];
        redrawAll(); renderPanel();
      };

      function insertAt(i, before) {
        if (i < 0 || i >= course.route.points.length) return;
        var a = course.route.points[i];
        var b = course.route.points[before ? i - 1 : i + 1] || a;
        var mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        pushUndo();
        course.route.points.splice(before ? i : i + 1, 0, mid);
        selectedPoint = before ? i : i + 1;
        redrawAll(); renderPanel();
      }

      box.querySelectorAll('.ce-cp').forEach(function (n) {
        n.onclick = function (e) {
          if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
          activeCp = +n.dataset.cp;
          redrawAll(); renderPanel();
        };
      });

      box.querySelectorAll('.ce-cp-name').forEach(function (n) {
        n.onchange = function () {
          pushUndo();
          course.checkpoints[+n.dataset.i].name = n.value.trim();
          redrawAll();
        };
      });
      box.querySelectorAll('.ce-cp-order').forEach(function (n) {
        n.onchange = function () {
          pushUndo();
          var i = +n.dataset.i;
          course.checkpoints[i].order = Math.max(1, Math.min(99, +n.value || i + 1));
          course.checkpoints.sort(function (a, b) { return a.order - b.order; });
          redrawAll(); renderPanel();
        };
      });
      box.querySelectorAll('.ce-cp-radius').forEach(function (n) {
        n.onchange = function () {
          pushUndo();
          var i = +n.dataset.i;
          course.checkpoints[i].radius = Math.max(5, Math.min(200, +n.value || 30));
          redrawAll(); renderPanel();
        };
      });
      box.querySelectorAll('[data-locate]').forEach(function (n) {
        n.onclick = function () {
          activeCp = +n.dataset.locate;
          mode = 'cp';
          U.toast('点击地图设置 ' + course.checkpoints[activeCp].id + ' 的位置');
          renderPanel();
        };
      });

      var nameEl = box.querySelector('#ce-name');
      if (nameEl) nameEl.onchange = function () { course.name = nameEl.value.trim() || '校园定向越野'; };
      var closedEl = box.querySelector('#ce-closed');
      if (closedEl) closedEl.onchange = function () {
        pushUndo();
        course.route.closed = closedEl.checked;
        if (closedEl.checked && course.route.points.length) {
          course.route.finish = course.route.points[0].slice();
          redrawAll();
        }
        renderPanel();
      };

      var saveBtn = box.querySelector('#ce-save');
      if (saveBtn) saveBtn.onclick = doSave;
      var expBtn = box.querySelector('#ce-export');
      if (expBtn) expBtn.onclick = doExportJSON;
      var impBtn = box.querySelector('#ce-import');
      if (impBtn) impBtn.onclick = doImportJSON;
      var gpxBtn = box.querySelector('#ce-gpx');
      if (gpxBtn) gpxBtn.onclick = function () {
        download('route-' + Date.now() + '.gpx', CourseStore.toGPX(course), 'application/gpx+xml');
      };
      var resetBtn = box.querySelector('#ce-reset');
      if (resetBtn) resetBtn.onclick = function () {
        if (!confirm('重置所有路线与打卡点？此操作不可撤销。')) return;
        pushUndo();
        course = CourseStore.blank();
        selectedPoint = -1; activeCp = 0;
        redrawAll(); renderPanel();
      };
    }

    /* ---------------- 载入 GPS 采集记录作为参考 ---------------- */
    function pickSurvey() {
      var all = (window.RouteSurvey && window.RouteSurvey.all()) || [];
      if (!all.length) {
        U.toast('还没有采集记录，先去「实地路线采集」');
        return;
      }
      var mask = document.createElement('div');
      mask.className = 'sheet-mask';
      mask.innerHTML = '<div class="sheet"><h3>选择采集记录</h3>' +
        '<div class="small muted">可多选，用于对比多次采集的稳定性</div>' +
        '<div class="mt12" id="pk-list">' +
        all.map(function (r, i) {
          var d = new Date(r.createdAt);
          var q = window.RouteGuard.assessQuality(r.track);
          return '<label class="pk-item">' +
            '<input type="checkbox" value="' + i + '">' +
            '<div class="grow"><div class="strong">' + esc(r.name) + '</div>' +
            '<div class="small muted">' + r.stats.accepted + ' 点 · ' + U.fmtDist(r.stats.distance) +
            ' · 质量 ' + q.grade + ' (' + q.score + '分)' +
            (q.issues.length ? ' · ' + q.issues[0] : '') + '</div></div>' +
            '<span class="badge">' + U.pad(d.getMonth() + 1) + '-' + U.pad(d.getDate()) + '</span>' +
            '</label>';
        }).join('') + '</div>' +
        '<button class="btn mt16" id="pk-ok">载入所选</button></div>';
      document.body.appendChild(mask);
      mask.onclick = function (e) { if (e.target === mask) mask.remove(); };
      mask.querySelector('#pk-ok').onclick = function () {
        var picked = [];
        mask.querySelectorAll('input[type=checkbox]:checked').forEach(function (n) {
          picked.push(all[+n.value]);
        });
        if (!picked.length) { U.toast('请至少选一条'); return; }
        refTracks = picked.map(function (r) {
          return {
            name: r.name,
            points: r.track.map(function (p) { return [p.display.lng, p.display.lat]; })
          };
        });
        showRef = true;
        mask.remove();
        redrawAll(); renderPanel();
        U.toast('已载入 ' + refTracks.length + ' 条参考线');
      };
    }

    function esc(s) {
      return String(s == null ? '' : s).replace(/[<>&]/g, function (c) {
        return { '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c];
      });
    }

    /* ---------------- 保存 / 导入导出 ---------------- */
    function doSave() {
      var v = CourseStore.validate(course);
      if (!v.ok) { U.toast(v.errors[0]); return; }
      course.status='draft'; course.forceNewVersion=true;
      course.surveyEvidence={}; course.surveyedAt=0;
      course.route.routeKey=selectedGroup==='competition'?'A':'B';
      course.route.groupKey=null; course.groupKey=null;
      CourseStore.remoteSave(course).then(function (res) {
        course = res.course;
        if (res.ok && !res.local) U.toast('已保存到服务器');
        else if (res.ok) U.toast('已保存到本机（未配置后端）');
        else U.toast('服务端保存失败，已存本机：' + res.error);
        renderPanel();
      });
    }

    function doExportJSON() {
      var json = CourseStore.toJSON(course);
      download('course-' + Date.now() + '.json', json, 'application/json');
    }

    function doImportJSON() {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.onchange = function () {
        var f = input.files[0];
        if (!f) return;
        var fr = new FileReader();
        fr.onload = function () {
          try {
            var r = CourseStore.fromJSON(fr.result);
            pushUndo();
            course = r.course;
            if (!r.valid) U.toast('已导入，但有问题：' + r.errors[0]);
            else U.toast('导入成功');
            redrawAll(); renderPanel();
          } catch (e) {
            U.toast('JSON 解析失败：' + e.message);
          }
        };
        fr.readAsText(f);
      };
      input.click();
    }

    function download(name, content, mime) {
      var blob = new Blob([content], { type: mime + ';charset=utf-8' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    }

    /* ---------------- 页面 ---------------- */
    return {
      html: '' +
        '<div class="page ce-page">' +
        '  <div class="ce-topbar">' +
        '    <div class="mt-back" data-back>‹</div>' +
        '    <div class="ce-title">比赛路线编辑</div>' +
        '    <div class="ce-zoom" id="ce-zoom"></div>' +
        '    <div class="ce-stats" id="ce-stats"></div>' +
        '    <div class="ce-logout" id="ce-logout">退出</div>' +
        '  </div>' +
        '  <div class="ce-body">' +
        '    <div class="ce-mapwrap"><div id="ce-map"></div>' +
        '      <div class="ce-hintbar" id="ce-hintbar">点击地图添加途经点 · 拖动数字点可调整</div>' +
        '    </div>' +
        '    <div class="ce-panel" id="ce-panel">' +
        '      <div class="ce-panel-body" id="ce-panel-body"></div>' +
        '    </div>' +
        '  </div>' +
        '</div>',

      mount: function (el) {
        el.querySelector('[data-back]').onclick = function () { Router.go('admin-home'); };

        // 从后端拉取最新路线（失败则用本地缓存）
        API.get('/api/night-plan').then(function(j){nightPlan=j.data;return selectNightRoute(selectedGroup);}).catch(function(e){U.toast(e.message);});
        el.querySelector('#ce-logout').onclick = function () {
          AdminAuth.logout();
          U.toast('已退出');
          Router.go('admin-login', { replace: true });
        };

        var mapEl = el.querySelector('#ce-map');
        MapEngine.create(mapEl, { zoom: 18, minZoom: 12, maxZoom: 20 }).then(function (m) {
          if (!el.isConnected) { m.destroy(); return; }
          map = m;
          bindMapClick();
          redrawAll();
          renderPanel();
          fitAll();
          updateZoomBar();
          if (map.onZoomEnd) map.onZoomEnd(updateZoomBar);
        }).catch(function (err) {
          MapEngine.renderError(mapEl, err);
          renderPanel();
        });

        var editorBase = 'normal';
        function updateZoomBar() {
          var el2 = document.getElementById('ce-zoom');
          if (!el2 || !map) return;
          var z = map.getZoom();
          var native = map.getSatMaxZoom ? map.getSatMaxZoom() : 18;
          var over = z > native;
          el2.innerHTML =
            '<button class="ce-zoombtn" id="ce-zi">＋</button>' +
            '<span class="' + (over ? 'ce-zover' : '') + '">Z' + z + '</span>' +
            '<button class="ce-zoombtn" id="ce-zo">－</button>' +
            '<button class="ce-zoombtn" id="ce-zl">' +
            { normal: '标', satellite: '卫', hybrid: '卫+路' }[editorBase] + '</button>' +
            (over ? '<span class="ce-zover-tip">超出原生 ' + native + ' 级</span>' : '');
          var zi = document.getElementById('ce-zi');
          var zo = document.getElementById('ce-zo');
          var zl = document.getElementById('ce-zl');
          if (zi) zi.onclick = function () { map.zoomIn(); };
          if (zo) zo.onclick = function () { map.zoomOut(); };
          if (zl) zl.onclick = function () {
            var order = ['normal', 'satellite', 'hybrid'];
            editorBase = order[(order.indexOf(editorBase) + 1) % order.length];
            map.setBase(editorBase);
            updateZoomBar();
            U.toast({ normal: '标准地图', satellite: '卫星地图', hybrid: '卫星+路网' }[editorBase]);
          };
        }

        function bindMapClick() {
          map.onClick(function (e) {
            var lng = e.lnglat.getLng ? e.lnglat.getLng() : e.lnglat.lng;
            var lat = e.lnglat.getLat ? e.lnglat.getLat() : e.lnglat.lat;
            var p = [lng, lat];
            pushUndo();

            if (mode === 'route') {
              course.route.points.push(p);
              if (!course.route.start) course.route.start = p.slice();
              if (!course.route.finish) course.route.finish = p.slice();
            } else if (mode === 'start') {
              course.route.start = p;
            } else if (mode === 'finish') {
              course.route.finish = p;
            } else if (mode === 'cp') {
              var cp = course.checkpoints[activeCp];
              cp.lnglat = p;
              if (!cp.name || /^打卡点 \d+$/.test(cp.name)) cp.name = '打卡点 ' + (activeCp + 1);
              // 自动跳到下一个未设置的点；全部设完后停在最后一个
              var next = -1;
              for (var k = 1; k <= 6; k++) {
                var idx = (activeCp + k) % 6;
                if (!course.checkpoints[idx].lnglat) { next = idx; break; }
              }
              activeCp = next >= 0 ? next : activeCp;
            }
            redrawAll();
            renderPanel();
          });
        }

        function fitAll() {
          if (!map) return;
          var pts = course.route.points.slice();
          course.checkpoints.forEach(function (c) { if (c.lnglat) pts.push(c.lnglat); });
          if (course.route.start) pts.push(course.route.start);
          if (course.route.finish) pts.push(course.route.finish);
          if (pts.length) map.fitPoints(pts, [60, 60, 60, 60], 18);
        }

        // 手机端抽屉展开/收起
        var panel = el.querySelector('#ce-panel');
        panel.querySelector('.ce-panel-body').addEventListener('click', function (e) {
          if (window.innerWidth <= 820) {
            var head = panel.querySelector('.ce-panel-body');
            // 抽屉由 CSS 控制高度，这里只处理滚动
          }
        });
      },

      unmount: function () {
        if (map) { map.destroy(); map = null; }
      }
    };
  }

  window.Pages = window.Pages || {};
  window.Pages['admin-course'] = CourseEditorPage;
})();
