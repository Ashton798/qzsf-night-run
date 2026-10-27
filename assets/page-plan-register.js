/* 管理员 · 校园规划参考图配准
 *
 * 流程：
 *   1. 左侧显示规划图，右侧是高德地图
 *   2. 在图上点一个特征点（如田径场中心），再到地图上点同一个位置
 *   3. 至少 4 个控制点，分布要散开（不要挤在一角）
 *   4. 系统解算相似变换，显示残差
 *   5. 叠加显示，调透明度对照
 *
 * 强制约束：精度等级固定为「参考级」，不允许宣称测绘精度。
 */
(function () {
  'use strict';
  var U = window.U;

  function PlanRegisterPage() {
    if (!AdminAuth.guard(Router)) return { html: '' };

    var state = CampusPlanLayer.load();
    var map = null;
    var overlay = null;
    var previewOverlay = null;

    // 当前操作
    var pending = null;          // { imageX, imageY } 等待在地图上点对应位置
    var cps = state.controlPoints.slice();
    var solving = null;          // solveTransform 结果

    var img = new Image();
    var imgReady = false;
    img.onload = function () { imgReady = true; renderImage(); };
    img.src = state.image.src;

    /* ---------- 图像 → 经纬度（基于当前 transform） ---------- */
    function imageToLngLat(x, y) {
      var tf = state.transform || (solving && solving.transform);
      if (!tf) return null;
      return CampusPlanLayer.applyTransform(tf, x, y);
    }

    /* ---------- 渲染左图 ---------- */
    function renderImage() {
      var canvas = document.getElementById('pr-canvas');
      if (!canvas || !imgReady) return;
      var box = canvas.parentNode.getBoundingClientRect();
      // 容器还没布局完成时跳过，等下一次 resize/重试
      if (box.width < 50 || box.height < 50) {
        setTimeout(renderImage, 200);
        return;
      }
      var scale = Math.min(box.width / img.width, box.height / img.height);
      var w = img.width * scale, h = img.height * scale;
      var dpr = window.devicePixelRatio || 1;
      canvas.width = w * dpr; canvas.height = h * dpr;
      canvas.style.width = w + 'px'; canvas.style.height = h + 'px';

      var ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);

      // 画已有点
      cps.forEach(function (cp, i) {
        var px = cp.imageX * scale, py = cp.imageY * scale;
        ctx.beginPath();
        ctx.arc(px, py, 9, 0, Math.PI * 2);
        ctx.fillStyle = cp.lng != null ? '#0f9d76' : '#f5a623';
        ctx.fill();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(String(i + 1), px, py);
      });

      // 待配准点（已选图点，等地图点）
      if (pending) {
        var qx = pending.imageX * scale, qy = pending.imageY * scale;
        ctx.beginPath();
        ctx.arc(qx, qy, 12, 0, Math.PI * 2);
        ctx.strokeStyle = '#e5484d'; ctx.lineWidth = 3; ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(qx - 18, qy); ctx.lineTo(qx + 18, qy);
        ctx.moveTo(qx, qy - 18); ctx.lineTo(qx, qy + 18);
        ctx.stroke();
      }

      canvas._scale = scale;
    }

    /* ---------- 渲染右侧控制点列表 ---------- */
    function renderList() {
      var box = document.getElementById('pr-list');
      if (!box) return;
      if (!cps.length) {
        box.innerHTML = '<div class="pr-empty">还没有控制点<br><span class="small">先在左图点一个明显的地物，再到右边地图点同一位置</span></div>';
        return;
      }
      box.innerHTML = cps.map(function (cp, i) {
        var g = cp.errorM != null ? CampusPlanLayer.gradeRegistration(cp.errorM) : null;
        return '<div class="pr-item" data-i="' + i + '">' +
          '<div class="pr-item-h"><span class="pr-num">' + (i + 1) + '</span>' +
          '<b>' + (cp.label || '控制点 ' + (i + 1)) + '</b>' +
          '<button class="ce-mini danger" data-del="' + i + '">✕</button></div>' +
          '<div class="small muted">' +
          '图像 ' + Math.round(cp.imageX) + ',' + Math.round(cp.imageY) +
          ' → ' + (cp.lng != null ? cp.lng.toFixed(6) + ', ' + cp.lat.toFixed(6) : '未设坐标') +
          '</div>' +
          (g ? '<div class="small ' + (g.cls === 'ok' ? 'pr-ok' : g.cls === 'warn' ? 'pr-warn' : 'pr-bad') + '">' +
            '残差 ' + cp.errorM.toFixed(1) + ' m</div>' : '') +
          '</div>';
      }).join('');

      box.querySelectorAll('[data-del]').forEach(function (n) {
        n.onclick = function (e) {
          e.stopPropagation();
          cps.splice(+n.dataset.del, 1);
          recalc();
          renderList(); renderImage();
        };
      });
    }

    /* ---------- 解算 ---------- */
    function recalc() {
      var res = CampusPlanLayer.solveTransform(cps);
      if (!res.ok) {
        solving = null;
        state.transform = null;
        updateStatus(null, res.error);
      } else {
        solving = res;
        state.transform = res.transform;
        state.rmsErrorM = res.rmsErrorM;
        state.maxErrorM = res.maxErrorM;
        updateStatus(res, null);
      }
      refreshOverlay();
    }

    function updateStatus(res, err) {
      var box = document.getElementById('pr-status');
      if (!box) return;
      if (err) {
        box.innerHTML = '<span class="pr-bad">' + err + '</span>';
        return;
      }
      if (!res) {
        box.innerHTML = '<span class="muted">未配准</span>';
        return;
      }
      var g = CampusPlanLayer.gradeRegistration(res.rmsErrorM);
      box.innerHTML =
        '<span class="' + (g.cls === 'ok' ? 'pr-ok' : g.cls === 'warn' ? 'pr-warn' : 'pr-bad') + '">' +
        g.text + '</span>' +
        '<span class="muted small"> · 最大 ' + res.maxErrorM.toFixed(0) + 'm · ' +
        res.count + ' 点 · 缩放 ' + res.scale.toExponential(2) + ' · 旋转 ' + res.rotationDeg.toFixed(1) + '°</span>';
    }

    /* ---------- 地图覆盖层 ---------- */
    function refreshOverlay() {
      if (!map) return;
      if (!overlay) {
        overlay = map.addImageOverlay({
          src: state.image.src,
          width: state.image.width,
          height: state.image.height,
          opacity: state.opacity,
          visible: state.enabled,
          imageToLngLat: imageToLngLat
        });
      } else {
        overlay.setTransform(imageToLngLat);
        overlay.setOpacity(state.opacity);
        overlay.setVisible(state.enabled);
      }
      // 在地图上标记控制点位置
      drawCpMarkers();
    }

    var cpMarkers = [];
    function drawCpMarkers() {
      if (!map) return;
      cpMarkers.forEach(function (m) { m.remove(); });
      cpMarkers = [];
      cps.forEach(function (cp, i) {
        if (cp.lng == null) return;
        var m = map.addMarker({
          position: [cp.lng, cp.lat],
          html: '<div class="pr-pin">' + (i + 1) + '</div>',
          iconSize: [24, 24], iconAnchor: [12, 12], zIndex: 300
        });
        cpMarkers.push(m);
      });
    }

    return {
      html: '' +
        '<div class="page pr-page">' +
        '  <div class="ce-topbar">' +
        '    <div class="mt-back" data-back>‹</div>' +
        '    <div class="ce-title">校园规划参考图 · 配准</div>' +
        '    <div class="ce-stats" id="pr-status">未配准</div>' +
        '    <div class="ce-logout" id="pr-help">说明</div>' +
        '  </div>' +

        '  <div class="pr-banner">' +
        '    ⚠️ 本图为<b>实体沙盘模型照片</b>（规划示意），实测与卫星图偏差约 <b>100–150 米</b>。' +
        '    仅作布局参考，<b>禁止作为比赛路线依据</b>。正式路线须用 GPS 实测并经现场核验。' +
        '  </div>' +

        '  <div class="pr-body">' +
        '    <div class="pr-left">' +
        '      <div class="pr-left-h">' +
        '        <span>① 在规划图上点击特征点</span>' +
        '        <span class="small muted" id="pr-hint">选 4 个以上、分布散开的点</span>' +
        '      </div>' +
        '      <div class="pr-imgbox"><canvas id="pr-canvas"></canvas></div>' +
        '    </div>' +

        '    <div class="pr-right">' +
        '      <div class="pr-left-h"><span>② 在高德地图上点同一位置</span>' +
        '        <span class="small muted" id="pr-pending"></span></div>' +
        '      <div class="pr-mapwrap"><div id="pr-map"></div></div>' +
        '    </div>' +

        '    <div class="pr-panel">' +
        '      <div class="ce-sec">' +
        '        <div class="ce-sec-title">控制点（' + 0 + '）</div>' +
        '        <div id="pr-list"></div>' +
        '      </div>' +

        '      <div class="ce-sec">' +
        '        <div class="ce-sec-title">显示</div>' +
        '        <label class="ce-check"><input type="checkbox" id="pr-enabled"> 在地图上显示参考图</label>' +
        '        <div class="ce-field">透明度 <b id="pr-op">' + Math.round(state.opacity * 100) + '%</b>' +
        '          <input type="range" id="pr-opacity" min="0" max="100" value="' + Math.round(state.opacity * 100) + '" style="width:100%">' +
        '        </div>' +
        '        <button class="btn outline sm" id="pr-fit">缩放到配准区域</button>' +
        '      </div>' +

        '      <div class="ce-sec">' +
        '        <div class="ce-sec-title">操作</div>' +
        '        <button class="btn" id="pr-save">保存配准</button>' +
        '        <div class="ce-row2 mt8">' +
        '          <button class="btn outline sm" id="pr-export">导出 JSON</button>' +
        '          <button class="btn outline sm" id="pr-import">导入 JSON</button>' +
        '        </div>' +
        '        <button class="btn outline sm mt8" id="pr-reset" style="color:var(--danger)">清空全部控制点</button>' +
        '      </div>' +

        '      <div class="ce-sec">' +
        '        <div class="ce-warn small" style="line-height:1.8">' +
        '          <b>精度说明</b><br>' +
        '          相似变换只能对齐"整体形状"，无法修正沙盘与现状的差异。' +
        '          即使残差显示 10 米，也不代表地图位置准确 10 米。' +
        '          本图精度等级固定为「参考级」。' +
        '        </div>' +
        '      </div>' +
        '    </div>' +
        '  </div>' +
        '</div>',

      mount: function (el) {
        el.querySelector('[data-back]').onclick = function () { Router.go('admin-home'); };
        el.querySelector('#pr-help').onclick = function () {
          alert('配准步骤：\n\n' +
            '1. 在左侧规划图上点击一个容易辨认的地物（如田径场中心、湖泊边缘、圆形建筑）\n' +
            '2. 右侧高德地图会自动进入待选状态，点同一位置的准确坐标\n' +
            '3. 重复 4 次以上，点要尽量分散（覆盖图像四角）\n' +
            '4. 系统自动解算，查看残差\n\n' +
            '注意：本图是沙盘照片，即使残差很小，也不代表与现状一致。');
        };

        // 地图
        var mapEl = el.querySelector('#pr-map');
        MapEngine.create(mapEl, { zoom: 16, minZoom: 10, maxZoom: 20 }).then(function (m) {
          if (!el.isConnected) { m.destroy(); return; }
          map = m;
          map.onClick(function (e) {
            if (!pending) {
              U.toast('请先在左侧规划图上点一个特征点');
              return;
            }
            var lng = e.lnglat.getLng ? e.lnglat.getLng() : e.lnglat.lng;
            var lat = e.lnglat.getLat ? e.lnglat.getLat() : e.lnglat.lat;
            cps.push({
              id: U.uid('cp_'),
              imageX: pending.imageX,
              imageY: pending.imageY,
              lng: lng, lat: lat,
              label: pending.label || ('控制点 ' + (cps.length + 1))
            });
            pending = null;
            recalc();
            renderList(); renderImage(); updatePending();
            U.toast('已添加控制点 ' + cps.length);
          });
          refreshOverlay();
          if (state.transform) fitToPlan();
        }).catch(function (err) {
          MapEngine.renderError(mapEl, err);
        });

        // 左图画布点击
        var canvas = el.querySelector('#pr-canvas');
        canvas.style.cursor = 'crosshair';
        canvas.onclick = function (e) {
          if (!imgReady) return;
          var rect = canvas.getBoundingClientRect();
          var scale = canvas._scale || 1;
          var x = (e.clientX - rect.left) / scale;
          var y = (e.clientY - rect.top) / scale;
          if (x < 0 || y < 0 || x > img.width || y > img.height) return;

          pending = { imageX: x, imageY: y };
          updatePending();
          renderImage();
          U.toast('已选图点，请到右侧地图点同一位置');
        };

        function updatePending() {
          var p = el.querySelector('#pr-pending');
          if (!p) return;
          p.textContent = pending
            ? '待选：图像 ' + Math.round(pending.imageX) + ',' + Math.round(pending.imageY)
            : '';
        }

        // 透明度
        var opEl = el.querySelector('#pr-opacity');
        opEl.oninput = function () {
          state.opacity = +opEl.value / 100;
          el.querySelector('#pr-op').textContent = opEl.value + '%';
          if (overlay) overlay.setOpacity(state.opacity);
        };

        // 显示开关
        var enEl = el.querySelector('#pr-enabled');
        enEl.checked = state.enabled;
        enEl.onchange = function () {
          state.enabled = enEl.checked;
          if (overlay) overlay.setVisible(state.enabled);
          // 立即持久化，学生端地图页才能读到
          CampusPlanLayer.save(state);
        };

        el.querySelector('#pr-fit').onclick = fitToPlan;

        function fitToPlan() {
          if (!map || !state.transform) { U.toast('先完成配准'); return; }
          var tf = state.transform;
          var corners = [[0,0],[state.image.width,0],[state.image.width,state.image.height],[0,state.image.height]]
            .map(function (c) {
              var ll = CampusPlanLayer.applyTransform(tf, c[0], c[1]);
              return [ll[0], ll[1]];
            });
          map.fitPoints(corners, [60,60,60,60], 18);
        }

        // 保存
        el.querySelector('#pr-save').onclick = function () {
          if (!solving) { U.toast('至少需要 2 个控制点才能保存'); return; }
          state.controlPoints = cps.map(function (c) {
            return { id: c.id, imageX: c.imageX, imageY: c.imageY, lng: c.lng, lat: c.lat, label: c.label, errorM: c.errorM };
          });
          state.transform = solving.transform;
          state.rmsErrorM = solving.rmsErrorM;
          state.maxErrorM = solving.maxErrorM;
          state.precision = 'reference';
          // 保存后默认启用图层，方便立即在地图页查看
          if (state.enabled === undefined) state.enabled = true;
          CampusPlanLayer.save(state);
          U.toast('已保存配准（参考级）');
        };

        // 导出 / 导入
        el.querySelector('#pr-export').onclick = function () {
          var data = Object.assign({}, state, {
            controlPoints: cps, transform: solving && solving.transform,
            rmsErrorM: solving && solving.rmsErrorM
          });
          var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
          var a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'campus-plan-registration.json';
          a.click();
        };

        el.querySelector('#pr-import').onclick = function () {
          var input = document.createElement('input');
          input.type = 'file'; input.accept = '.json';
          input.onchange = function () {
            var f = input.files[0]; if (!f) return;
            var fr = new FileReader();
            fr.onload = function () {
              try {
                var d = JSON.parse(fr.result);
                cps = d.controlPoints || [];
                recalc();
                renderList(); renderImage();
                U.toast('已导入');
              } catch (e) { U.toast('JSON 解析失败'); }
            };
            fr.readAsText(f);
          };
          input.click();
        };

        el.querySelector('#pr-reset').onclick = function () {
          if (!confirm('清空所有控制点？')) return;
          cps = []; solving = null; state.transform = null;
          recalc(); renderList(); renderImage();
        };

        // 初始化
        recalc();
        renderList();
        // 布局完成后多次尝试渲染（图片加载 + 容器尺寸都需要就绪）
        [50, 200, 500, 1000].forEach(function (t) { setTimeout(renderImage, t); });
        window.addEventListener('resize', renderImage);
      },

      unmount: function () {
        window.removeEventListener('resize', renderImage);
        if (map) { map.destroy(); map = null; }
      }
    };
  }

  window.Pages = window.Pages || {};
  window.Pages['plan-register'] = PlanRegisterPage;
})();
