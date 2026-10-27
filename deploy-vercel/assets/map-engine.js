/* 地图引擎抽象层
 *
 * 统一接口，内部自动选择实现：
 *   1) amap  —— 高德 JS API 2.0（需要 Key + 安全密钥/代理）
 *   2) tile  —— 免 Key 的高德栅格瓦片 + Leaflet（降级方案）
 *
 * 坐标约定：所有对外 API 一律使用 **GCJ-02**（高德坐标系），顺序 [lng, lat]。
 *          GPS 的 WGS-84 只在采集入口用 Coord.wgs2gcj 转换一次。
 */
(function () {
  'use strict';

  var Coord = window.Coord;
  var S = {
    kind: null,
    AMap: null,
    error: null,        // { code, title, detail, fixes[] }
    loading: null
  };

  /* ============================================================
   *  错误描述：加载失败时给出明确原因与解决办法，避免白屏
   * ============================================================ */
  function makeError(code, detail) {
    var map = {
      NO_KEY: {
        title: '未配置高德地图 Key',
        detail: '服务端没有读到 AMAP_WEB_KEY，或该变量为空。',
        fixes: [
          '打开项目根目录的 .env 文件',
          '填写 AMAP_WEB_KEY=你的Web端JS API Key',
          '填写 AMAP_SECURITY_JS_CODE=配套安全密钥',
          '重启 Node 服务（npm start）后刷新页面'
        ]
      },
      NO_SECURITY: {
        title: '缺少安全密钥',
        detail: '高德 JS API 2.0 要求 securityJsCode 或服务端代理，否则地图不加载。',
        fixes: [
          '在 .env 填写 AMAP_SECURITY_JS_CODE（与 Key 配套）',
          '重启服务，确认启动日志显示「高德地图：已配置」'
        ]
      },
      INVALID_KEY: {
        title: 'Key 校验失败（INVALID_USER_KEY）',
        detail: 'Key 与安全密钥不匹配，或 Key 未启用 / 域名白名单不含当前地址。',
        fixes: [
          '确认 key 与 securityJsCode 来自同一个 Key',
          '在高德控制台把当前域名加入白名单（本地测试可留空）',
          '确认 Key 类型是「Web端(JS API)」而不是「Web服务」'
        ]
      },
      DOMAIN: {
        title: '域名未授权（USERKEY_PLAT_NOMATCH / INVALID_USER_DOMAIN）',
        detail: '当前访问域名不在 Key 的白名单内。',
        fixes: [
          '高德控制台 → Key 设置 → 域名白名单，加入当前域名',
          '本地开发可暂时留空白名单'
        ]
      },
      QUOTA: {
        title: '配额已用完（DAILY_QUERY_OVER_LIMIT）',
        detail: '该 Key 当日的调用量已达上限。',
        fixes: ['等待次日重置，或在高德控制台提升配额', '临时可先用降级底图']
      },
      NETWORK: {
        title: '地图服务加载失败',
        detail: '无法连接高德服务器，可能是网络中断或被拦截。',
        fixes: ['检查网络连接', '关闭广告拦截插件后刷新', '稍后重试']
      },
      UNKNOWN: {
        title: '地图初始化失败',
        detail: '',
        fixes: ['按 F12 打开控制台查看完整错误', '刷新页面重试']
      }
    };
    var e = map[code] || map.UNKNOWN;
    return {
      code: code,
      title: e.title,
      detail: detail || e.detail,
      fixes: e.fixes
    };
  }

  function classify(msg) {
    var m = String(msg || '').toUpperCase();
    if (m.indexOf('INVALID_USER_KEY') >= 0) return 'INVALID_KEY';
    if (m.indexOf('INVALID_USER_SCODE') >= 0 || m.indexOf('INVALID_USER_SCODE') >= 0) return 'NO_SECURITY';
    if (m.indexOf('USERKEY_PLAT_NOMATCH') >= 0 || m.indexOf('INVALID_USER_DOMAIN') >= 0) return 'DOMAIN';
    if (m.indexOf('OVER_LIMIT') >= 0 || m.indexOf('QUOTA') >= 0) return 'QUOTA';
    if (m.indexOf('NETWORK') >= 0 || m.indexOf('TIMEOUT') >= 0) return 'NETWORK';
    return 'UNKNOWN';
  }

  /* ============================================================
   *  高德 JSAPI 加载
   * ============================================================ */
  function loadAMap() {
    if (S.loading) return S.loading;

    S.loading = new Promise(function (resolve, reject) {
      var cfg = window.AppConfig;

      // 配置由服务端下发；先确保已拉取，避免页面脚本顺序问题
      var ready = cfg.loadMapConfig ? cfg.loadMapConfig() : Promise.resolve();

      ready.then(function () {
        if (!cfg.hasAmapKey()) {
          reject(makeError('NO_KEY', cfg.mapError ? cfg.mapError() : ''));
          return;
        }
        if (!cfg.hasAmapSecurity()) { reject(makeError('NO_SECURITY')); return; }

        /* JS API 2.0 安全配置
         * 生产环境走服务端代理：浏览器只知道 /_AMapService，
         * securityJsCode 由服务端附加，永不下发。
         */
        var sec = {};
        var serviceHost = cfg.get('amap.serviceHost', '');
        if (serviceHost) {
          sec.serviceHost = serviceHost;
        } else {
          sec.securityJsCode = cfg.get('amap.securityJsCode', '');
        }
        window._AMapSecurityConfig = sec;

        function boot() {
          if (!window.AMapLoader) { reject(makeError('NETWORK', 'AMapLoader 未加载，loader.js 可能被拦截')); return; }
          window.AMapLoader.load({
            key: cfg.get('amap.key'),
            version: cfg.get('amap.version', '2.0'),
            plugins: ['AMap.Scale', 'AMap.ToolBar']
          }).then(function (AMap) {
            try { AMap.getConfig().appname = 'qzsf-night-run'; } catch (e) {}
            S.AMap = AMap;
            resolve(AMap);
          }).catch(function (e) {
            reject(makeError(classify(e && (e.message || e)), e && e.message));
          });
        }

        if (window.AMapLoader) { boot(); return; }

        var s = document.createElement('script');
        s.src = 'https://webapi.amap.com/loader.js';
        s.async = true;
        s.onload = boot;
        s.onerror = function () { reject(makeError('NETWORK', 'loader.js 下载失败')); };
        document.head.appendChild(s);
      });
    });

    return S.loading;
  }

  /* ============================================================
   *  适配器：高德
   * ============================================================ */
  function AMapAdapter(el, opts) {
    var AMap = S.AMap;
    var self = this;
    this.kind = 'amap';
    this.AMap = AMap;
    this._layers = { normal: null, sat: null, roadnet: null };
    this._listeners = [];

    var map = new AMap.Map(el, {
      viewMode: opts.viewMode || '2D',
      zoom: opts.zoom || 16,
      center: opts.center,
      zooms: [opts.minZoom || 3, opts.maxZoom || 20],
      resizeEnable: true,
      showLabel: true,
      // 关键：矢量渲染不受设备像素比影响，放大不会糊
      // 只有在 satellite 模式下才叠加栅格影像
      mapStyle: 'amap://styles/normal',
      // 高缩放时仍保持道路/建筑细节
      features: ['bg', 'road', 'building', 'point']
    });
    this.map = map;

    map.addControl(new AMap.Scale({ position: 'LB' }));

    // ---------- 三种图层 ----------
    // 标准底图由 map 自身渲染（矢量，最清晰）
    // 卫星 + 路网用官方 TileLayer
    this._layers.sat = new AMap.TileLayer.Satellite({
      zIndex: 1,
      // 卫星影像原生最高约 18-19 级，超过后高德会自动放大，
      // 这里不额外拉伸，交给官方处理
      zooms: [3, 20]
    });
    this._layers.roadnet = new AMap.TileLayer.RoadNet({
      zIndex: 2,
      zooms: [3, 20]
    });
    this.base = 'normal';

    // 显示参考原生级别，不代表现场分辨率验证结果。
    this.satMaxZoom = 18;

    // 地图错误（Key 失效等会通过 map 事件抛出）
    map.on('error', function (e) {
      if (self.onError) self.onError(makeError(classify(e && e.message), e && e.message));
    });
  }

  AMapAdapter.prototype = {
    /* kind: 'normal' | 'satellite' | 'hybrid'
     *   normal    —— 高德标准矢量图（最清晰，可缩放到 20 级）
     *   satellite —— 纯卫星影像
     *   hybrid    —— 卫星影像 + 路网注记
     */
    setBase: function (kind) {
      var map = this.map;
      if (kind === this.base) return;

      // 先全部移除，再按需添加，避免图层叠加残留
      try { map.remove(this._layers.sat); } catch (e) {}
      try { map.remove(this._layers.roadnet); } catch (e) {}

      if (kind === 'satellite') {
        map.setMapStyle('amap://styles/normal');
        map.add(this._layers.sat);
      } else if (kind === 'hybrid') {
        map.setMapStyle('amap://styles/normal');
        map.add(this._layers.sat);
        map.add(this._layers.roadnet);
      } else {
        map.setMapStyle('amap://styles/normal');
      }
      this.base = kind;
    },

    /* 卫星图有效最高级别（超过后是插值放大，会糊） */
    getSatMaxZoom: function () { return this.satMaxZoom; },

    setCenter: function (lng, lat, zoom) {
      if (zoom != null) this.map.setZoomAndCenter(zoom, [lng, lat]);
      else this.map.setCenter([lng, lat]);
    },

    fitPoints: function (pts, padding, maxZoom) {
      if (!pts || !pts.length) return;
      if (pts.length === 1) {
        this.map.setZoomAndCenter(maxZoom || 18, pts[0]);
        return;
      }
      var AMap = this.AMap;
      var overlays = pts.map(function (p) {
        return new AMap.Marker({ position: p, visible: false, map: this.map });
      }, this);
      this.map.setFitView(overlays, false, padding || [60, 60, 60, 60], maxZoom || 19);
      this.map.remove(overlays);
    },

    addPolyline: function (path, style) {
      var AMap = this.AMap, self = this;
      var opts = Object.assign({
        strokeColor: '#0f9d76',
        strokeWeight: 6,
        strokeOpacity: 1,
        lineJoin: 'round',
        lineCap: 'round',
        showDir: false,
        zIndex: 60,
        bubble: true
      }, style || {});
      /* AMap 不接受空 path（会抛 Invalid Object: Polyline path）。
       * 轨迹线初始为空，延迟到第一次 setPath 再创建。 */
      var line = (path && path.length) ? new AMap.Polyline(Object.assign({ path: path }, opts)) : null;
      if (line) this.map.add(line);
      var ensure = function (p) {
        if (!line) { line = new AMap.Polyline(Object.assign({ path: p }, opts)); self.map.add(line); }
        return line;
      };
      return {
        raw: line,
        setPath: function (p) {
          if (!p || !p.length) { if (line) line.hide(); return; }
          ensure(p).setPath(p); line.show();
        },
        setStyle: function (s) { if (line) line.setOptions(s); },
        show: function () { if (line) line.show(); },
        hide: function () { if (line) line.hide(); },
        remove: function () { if (line) line.setMap(null); }
      };
    },

    addCircle: function (center, radius, style) {
      var AMap = this.AMap;
      var c = new AMap.Circle(Object.assign({
        center: center, radius: radius,
        strokeColor: '#f5a623', strokeWeight: 2, strokeOpacity: .9,
        fillColor: '#f5a623', fillOpacity: .12,
        zIndex: 40, bubble: true
      }, style || {}));
      this.map.add(c);
      return {
        raw: c,
        setCenter: function (p) { c.setCenter(p); },
        setRadius: function (r) { c.setRadius(r); },
        setStyle: function (s) { c.setOptions(s); },
        remove: function () { c.setMap(null); }
      };
    },

    addPolygon: function (path, style) {
      var AMap = this.AMap;
      var p = new AMap.Polygon(Object.assign({
        path: path, strokeColor: '#0f9d76', strokeWeight: 2, strokeOpacity: .6,
        fillColor: '#0f9d76', fillOpacity: .05, strokeStyle: 'dashed',
        zIndex: 30, bubble: true
      }, style || {}));
      this.map.add(p);
      return { raw: p, setPath: function (q) { p.setPath(q); }, remove: function () { p.setMap(null); } };
    },

    /* html 内容标记；draggable 用于路线编辑 */
    addMarker: function (opt) {
      var AMap = this.AMap;
      var mk = new AMap.Marker({
        position: opt.position,
        content: opt.html || null,
        offset: new AMap.Pixel(opt.offsetX || 0, opt.offsetY || 0),
        anchor: opt.anchor || 'center',
        draggable: !!opt.draggable,
        cursor: opt.draggable ? 'move' : 'default',
        zIndex: opt.zIndex || 100,
        bubble: true,
        extData: opt.data || null,
        title: opt.title || ''
      });
      this.map.add(mk);
      return {
        raw: mk,
        setPosition: function (p) { mk.setPosition(p); },
        setContent: function (h) { mk.setContent(h); },
        setZIndex: function (z) { mk.setzIndex(z); },
        on: function (ev, fn) { mk.on(ev, fn); },
        remove: function () { mk.setMap(null); }
      };
    },

    /* ---------- 图像覆盖层（用于校园规划参考图） ----------
     * 用 AMap.ImageLayer 的 bounds 方式不够灵活（只能是轴对齐矩形），
     * 这里改用「4 角点映射」：把图像四角按仿射变换算出经纬度，
     * 再用 AMap.CustomLayer 在屏幕空间做透视绘制。
     *
     * 实现：CustomLayer + Canvas，每次地图变化时重算四角屏幕坐标，
     * 用 setTransform 做仿射绘制 —— 精度足够（相似变换无透视畸变）。
     */
    addImageOverlay: function (opt) {
      var AMap = this.AMap;
      var map = this.map;
      var self = this;
      var canvas = document.createElement('canvas');
      canvas.style.position = 'absolute';
      canvas.style.pointerEvents = 'none';

      var img = new Image();
      img.crossOrigin = 'anonymous';
      var ready = false;
      img.onload = function () { ready = true; draw(); };
      img.src = opt.src;

      var layer = new AMap.CustomLayer(canvas, {
        zIndex: opt.zIndex || 20,
        zooms: [3, 20],
        alwaysRender: true
      });
      map.add(layer);

      var state = {
        opacity: opt.opacity == null ? 0.55 : opt.opacity,
        visible: opt.visible !== false,
        imageToLngLat: opt.imageToLngLat,   // function(x,y) -> [lng,lat]
        imgW: opt.width, imgH: opt.height
      };

      function draw() {
        if (!ready || !state.visible) { clearCanvas(); return; }
        var size = map.getSize();
        var dpr = window.devicePixelRatio || 1;
        canvas.width = size.width * dpr;
        canvas.height = size.height * dpr;
        canvas.style.width = size.width + 'px';
        canvas.style.height = size.height + 'px';

        var ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, size.width, size.height);

        // 图像四角 → 经纬度 → 屏幕像素
        var corners = [
          [0, 0], [state.imgW, 0],
          [state.imgW, state.imgH], [0, state.imgH]
        ].map(function (c) {
          var ll = state.imageToLngLat(c[0], c[1]);
          if (!ll) return null;
          var px = map.lngLatToContainer(new AMap.LngLat(ll[0], ll[1]));
          return [px.x, px.y];
        });
        if (corners.some(function (c) { return !c; })) return;

        // 用左上、右上、左下三点确定仿射变换
        var p0 = corners[0], p1 = corners[1], p3 = corners[3];
        var ux = (p1[0] - p0[0]) / state.imgW, uy = (p1[1] - p0[1]) / state.imgW;
        var vx = (p3[0] - p0[0]) / state.imgH, vy = (p3[1] - p0[1]) / state.imgH;

        ctx.globalAlpha = state.opacity;
        ctx.save();
        ctx.transform(ux, uy, vx, vy, p0[0], p0[1]);
        ctx.drawImage(img, 0, 0);
        ctx.restore();
        ctx.globalAlpha = 1;
      }

      function clearCanvas() {
        var ctx = canvas.getContext('2d');
        if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
      }

      map.on('moveend', draw);
      map.on('zoomend', draw);
      map.on('mapmove', draw);
      map.on('resize', draw);

      return {
        raw: layer,
        setOpacity: function (o) { state.opacity = o; draw(); },
        setVisible: function (v) {
          state.visible = v;
          if (v) { layer.show(); draw(); } else { layer.hide(); clearCanvas(); }
        },
        setTransform: function (fn) { state.imageToLngLat = fn; draw(); },
        redraw: draw,
        remove: function () {
          map.off('moveend', draw); map.off('zoomend', draw);
          map.off('mapmove', draw); map.off('resize', draw);
          try { map.remove(layer); } catch (e) {}
        }
      };
    },

    onClick: function (fn) { this.map.on('click', fn); },
    offClick: function (fn) { this.map.off('click', fn); },
    onMoveEnd: function (fn) { this.map.on('moveend', fn); },
    onZoomEnd: function (fn) { this.map.on('zoomend', fn); },

    getZoom: function () { return this.map.getZoom(); },
    zoomIn: function () { this.map.zoomIn(); },
    zoomOut: function () { this.map.zoomOut(); },
    getCenter: function () {
      var c = this.map.getCenter();
      return c ? [c.getLng ? c.getLng() : c.lng, c.getLat ? c.getLat() : c.lat] : null;
    },
    resize: function () { this.map.resize(); },
    destroy: function () {
      try { this.map.destroy(); } catch (e) {}
      this.map = null;
    }
  };

  /* ============================================================
   *  适配器：Leaflet + 高德栅格瓦片（无 Key 降级）
   * ============================================================ */
  function TileAdapter(el, opts) {
    var self = this;
    this.kind = 'tile';
    this._listeners = [];

    var map = L.map(el, {
      center: [opts.center[1], opts.center[0]],
      zoom: opts.zoom || 16,
      minZoom: opts.minZoom || 12,
      maxZoom: opts.maxZoom || 19,
      zoomControl: false,
      attributionControl: true,
      tap: false
    });
    this.map = map;
    map.attributionControl.addAttribution('地图 © 高德地图 · 坐标 GCJ-02');

    /* 历史记录（本次任务尚未重新验证）：（2026-10 在泉州师范学院坐标采样验证）：
     *   z ≤ 18 —— 高德返回真实瓦片（256×256，8–17KB）
     *   z ≥ 19 —— 返回 179 字节空白占位图 / 重复上一级，属于"假高清"
     *
     * 因此 maxNativeZoom = 18：
     *   允许用户缩放到 20 级（便于精细编辑），但 19–20 级由 Leaflet
     *   做像素级放大，并在 UI 上明确提示"已超出原生分辨率"。
     *   绝不用低分辨率瓦片冒充高清。
     *
     * 另外：高德的 scale 参数（scale=2 高清）实测已失效，
     *   scale=1 与 scale=2 返回完全相同的 256×256 图片，故不再使用。
     */
    var NATIVE_MAX = 18;

    var normal = L.tileLayer(
      'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
      { subdomains: '1234', maxZoom: 20, maxNativeZoom: NATIVE_MAX, minZoom: 3, detectRetina: false }
    );
    var sat = L.tileLayer(
      'https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}',
      { subdomains: '1234', maxZoom: 20, maxNativeZoom: NATIVE_MAX, minZoom: 3, detectRetina: false }
    );
    var road = L.tileLayer(
      'https://webst0{s}.is.autonavi.com/appmaptile?style=8&x={x}&y={y}&z={z}',
      { subdomains: '1234', maxZoom: 20, maxNativeZoom: NATIVE_MAX, minZoom: 3, detectRetina: false }
    );

    this._tiles = { normal: normal, sat: sat, road: road };
    this.satMaxZoom = NATIVE_MAX;
    normal.addTo(map);
    this.base = 'normal';

    normal.on('tileerror', function () {
      if (self.onError) self.onError(makeError('NETWORK', '底图瓦片加载失败，可能是网络问题'));
    });
  }

  TileAdapter.prototype = {
    setBase: function (kind) {
      var m = this.map, t = this._tiles;
      if (kind === this.base) return;
      m.removeLayer(t.normal); m.removeLayer(t.sat); m.removeLayer(t.road);
      if (kind === 'satellite') { t.sat.addTo(m); }
      else if (kind === 'hybrid') { t.sat.addTo(m); t.road.addTo(m); }
      else { t.normal.addTo(m); }
      this.base = kind;
    },
    getSatMaxZoom: function () { return this.satMaxZoom; },
    setCenter: function (lng, lat, zoom) {
      if (zoom != null) this.map.setView([lat, lng], zoom, { animate: true });
      else this.map.panTo([lat, lng]);
    },
    fitPoints: function (pts, padding, maxZoom) {
      if (!pts || !pts.length) return;
      if (pts.length === 1) { this.map.setView([pts[0][1], pts[0][0]], maxZoom || 18); return; }
      var b = L.latLngBounds(pts.map(function (p) { return [p[1], p[0]]; }));
      this.map.fitBounds(b, { padding: padding || [40, 40], maxZoom: maxZoom || 19 });
    },
    addPolyline: function (path, style) {
      var self = this, s = style || {};
      var line = L.polyline(path.map(function (p) { return [p[1], p[0]]; }), {
        color: s.strokeColor || '#0f9d76',
        weight: s.strokeWeight || 6,
        opacity: s.strokeOpacity == null ? 1 : s.strokeOpacity,
        dashArray: s.strokeStyle === 'dashed' ? (s.strokeDasharray || [10, 6]).join(',') : null,
        lineCap: 'round', lineJoin: 'round'
      }).addTo(this.map);
      return {
        raw: line,
        setPath: function (p) { line.setLatLngs(p.map(function (q) { return [q[1], q[0]]; })); },
        setStyle: function (st) {
          if (st.strokeColor) line.setStyle({ color: st.strokeColor });
          if (st.strokeWeight) line.setStyle({ weight: st.strokeWeight });
        },
        show: function () { line.addTo(self.map); },
        hide: function () { self.map.removeLayer(line); },
        remove: function () { if (self.map) self.map.removeLayer(line); }
      };
    },
    addCircle: function (center, radius, style) {
      var self = this, s = style || {};
      var c = L.circle([center[1], center[0]], {
        radius: radius,
        color: s.strokeColor || '#f5a623',
        weight: s.strokeWeight || 2,
        fillColor: s.fillColor || '#f5a623',
        fillOpacity: s.fillOpacity == null ? .12 : s.fillOpacity
      }).addTo(this.map);
      return {
        raw: c,
        setCenter: function (p) { c.setLatLng([p[1], p[0]]); },
        setRadius: function (r) { c.setRadius(r); },
        setStyle: function (st) { c.setStyle(st); },
        remove: function () { if (self.map) self.map.removeLayer(c); }
      };
    },
    addPolygon: function (path, style) {
      var self = this, s = style || {};
      var pg = L.polygon(path.map(function (p) { return [p[1], p[0]]; }), {
        color: s.strokeColor || '#0f9d76',
        weight: s.strokeWeight || 2,
        fillColor: s.fillColor || '#0f9d76',
        fillOpacity: s.fillOpacity == null ? .05 : s.fillOpacity,
        dashArray: '6 6'
      }).addTo(this.map);
      return { raw: pg, setPath: function (p) { pg.setLatLngs(p.map(function (q) { return [q[1], q[0]]; })); }, remove: function () { if (self.map) self.map.removeLayer(pg); } };
    },
    addMarker: function (opt) {
      var map = this.map;
      var anchor = opt.anchor || 'center';
      var ax = 0, ay = 0;
      if (anchor === 'top-left') { ax = 0; ay = 0; }
      else if (anchor === 'bottom-center') { ay = 0; }
      var mk = L.marker([opt.position[1], opt.position[0]], {
        draggable: !!opt.draggable,
        icon: L.divIcon({
          className: '',
          html: opt.html || '',
          iconSize: opt.iconSize || [28, 28],
          iconAnchor: opt.iconAnchor || [14, 14]
        }),
        zIndexOffset: opt.zIndex || 100
      }).addTo(map);
      return {
        raw: mk,
        setPosition: function (p) { mk.setLatLng([p[1], p[0]]); },
        setContent: function (h) {
          mk.setIcon(L.divIcon({ className: '', html: h, iconSize: opt.iconSize || [28, 28], iconAnchor: opt.iconAnchor || [14, 14] }));
        },
        setZIndex: function (z) { mk.setZIndexOffset(z); },
        on: function (ev, fn) { mk.on(ev, fn); },
        remove: function () { map.removeLayer(mk); }
      };
    },
    /* 图像覆盖层（Leaflet 版）
     * 用 canvas overlay：把图像四角映射到经纬度，按仿射变换绘制。
     */
    addImageOverlay: function (opt) {
      var map = this.map;
      var img = new Image();
      img.crossOrigin = 'anonymous';
      var ready = false;
      img.onload = function () { ready = true; redraw(); };
      img.src = opt.src;

      var state = {
        opacity: opt.opacity == null ? 0.55 : opt.opacity,
        visible: opt.visible !== false,
        imageToLngLat: opt.imageToLngLat,
        imgW: opt.width, imgH: opt.height
      };

      // 专用 pane：在瓦片之上、矢量覆盖物之下
      var paneName = 'imageOverlayPane';
      if (!map.getPane(paneName)) {
        var pane = map.createPane(paneName);
        pane.style.zIndex = 350;       // 默认 overlayPane 是 400
        pane.style.pointerEvents = 'none';
      }

      var CanvasLayer = L.Layer.extend({
        onAdd: function () {
          this._c = L.DomUtil.create('canvas', 'leaflet-image-overlay');
          this._c.style.position = 'absolute';
          this._c.style.pointerEvents = 'none';
          map.getPane(paneName).appendChild(this._c);
          map.on('move zoom resize viewreset', this._draw, this);
          this._draw();
        },
        onRemove: function () {
          map.off('move zoom resize viewreset', this._draw, this);
          if (this._c && this._c.parentNode) this._c.parentNode.removeChild(this._c);
        },
        _draw: function () {
          var c = this._c;
          if (!c) return;
          var size = map.getSize();
          var dpr = window.devicePixelRatio || 1;
          c.width = size.x * dpr; c.height = size.y * dpr;
          c.style.width = size.x + 'px'; c.style.height = size.y + 'px';
          L.DomUtil.setPosition(c, map.containerPointToLayerPoint([0, 0]));

          var ctx = c.getContext('2d');
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.clearRect(0, 0, size.x, size.y);
          if (!ready || !state.visible || !state.imageToLngLat) return;

          var corners = [
            [0, 0], [state.imgW, 0],
            [state.imgW, state.imgH], [0, state.imgH]
          ].map(function (q) {
            var ll = state.imageToLngLat(q[0], q[1]);
            if (!ll) return null;
            var pt = map.latLngToContainerPoint([ll[1], ll[0]]);
            return [pt.x, pt.y];
          });
          if (corners.some(function (q) { return !q; })) return;

          var p0 = corners[0], p1 = corners[1], p3 = corners[3];
          var ux = (p1[0] - p0[0]) / state.imgW, uy = (p1[1] - p0[1]) / state.imgW;
          var vx = (p3[0] - p0[0]) / state.imgH, vy = (p3[1] - p0[1]) / state.imgH;

          ctx.globalAlpha = state.opacity;
          ctx.save();
          ctx.transform(ux, uy, vx, vy, p0[0], p0[1]);
          ctx.drawImage(img, 0, 0);
          ctx.restore();
          ctx.globalAlpha = 1;
        }
      });

      var layer = new CanvasLayer();
      layer.addTo(map);
      function redraw() { if (layer._draw) layer._draw(); }

      return {
        raw: layer,
        setOpacity: function (o) { state.opacity = o; redraw(); },
        setVisible: function (v) {
          state.visible = v;
          if (v) { if (!map.hasLayer(layer)) layer.addTo(map); redraw(); }
          else if (map.hasLayer(layer)) map.removeLayer(layer);
        },
        setTransform: function (fn) { state.imageToLngLat = fn; redraw(); },
        redraw: redraw,
        remove: function () { if (map.hasLayer(layer)) map.removeLayer(layer); }
      };
    },

    onClick: function (fn) {
      var h = function (e) { fn({ lnglat: { lng: e.latlng.lng, lat: e.latlng.lat } }); };
      this._clickHandler = h;
      this.map.on('click', h);
    },
    offClick: function () { if (this._clickHandler) this.map.off('click', this._clickHandler); },
    onMoveEnd: function (fn) { this.map.on('moveend', fn); },
    onZoomEnd: function (fn) { this.map.on('zoomend', fn); },
    getZoom: function () { return this.map.getZoom(); },
    zoomIn: function () { this.map.zoomIn(); },
    zoomOut: function () { this.map.zoomOut(); },
    getCenter: function () {
      var c = this.map.getCenter();
      return c ? [c.lng, c.lat] : null;
    },
    resize: function () { this.map.invalidateSize(); },
    destroy: function () { try { this.map.remove(); } catch (e) {} this.map = null; }
  };

  /* ============================================================
   *  对外：创建地图
   * ============================================================ */
  function create(el, opts) {
    opts = opts || {};
    var cfg = window.AppConfig;
    var center = opts.center || cfg.get('event.campusCenter');
    var baseOpts = {
      center: center,
      zoom: opts.zoom || cfg.get('event.campusZoom', 16),
      minZoom: opts.minZoom || cfg.get('event.minZoom', 14),
      maxZoom: opts.maxZoom || cfg.get('event.maxZoom', 20),
      viewMode: opts.viewMode || '2D'
    };

    var useFallback = function (err) {
      if (!cfg.get('amap.fallback', true)) return Promise.reject(err);
      S.kind = 'tile';
      S.error = err;
      return loadLeaflet().then(function () {
        return new TileAdapter(el, baseOpts);
      });
    };

    var expose = function (adapter) {
      window.__mapAdapter = adapter;   // 便于调试与外部控制
      return adapter;
    };

    if (S.kind === 'tile') {
      return Promise.resolve(expose(new TileAdapter(el, baseOpts)));
    }

    return loadAMap()
      .then(function () {
        S.kind = 'amap';
        S.error = null;
        return expose(new AMapAdapter(el, baseOpts));
      })
      .catch(function (err) {
        return useFallback(err).then(expose);
      });
  }

  /* Leaflet 本地托管（vendor/leaflet/），不依赖任何外部 CDN。
   * 原因：国内网络访问 unpkg / jsdelivr 经常超时，
   * 导致降级模式地图直接空白。
   */
  var LEAFLET_BASE = 'vendor/leaflet/';

  function loadLeaflet() {
    if (window.L) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      if (!document.querySelector('link[data-leaflet]')) {
        var css = document.createElement('link');
        css.rel = 'stylesheet';
        css.href = LEAFLET_BASE + 'leaflet.css';
        css.setAttribute('data-leaflet', '1');
        document.head.appendChild(css);
      }
      var s = document.createElement('script');
      s.src = LEAFLET_BASE + 'leaflet.js';
      s.async = true;
      s.onload = function () {
        // 让 Leaflet 从本地加载图标
        if (window.L && window.L.Icon && window.L.Icon.Default) {
          window.L.Icon.Default.imagePath = LEAFLET_BASE + 'images/';
        }
        resolve();
      };
      s.onerror = function () { reject(makeError('NETWORK', '本地 Leaflet 加载失败，请检查 vendor/leaflet 目录')); };
      document.head.appendChild(s);
    });
  }

  /* 地图不可用时的全屏说明（绝不白屏） */
  function renderError(container, err) {
    container.innerHTML =
      '<div class="map-fallback">' +
      '  <div class="mf-ic">🗺️</div>' +
      '  <div class="mf-title">' + err.title + '</div>' +
      '  <div class="mf-detail">' + (err.detail || '') + '</div>' +
      (err.fixes && err.fixes.length
        ? '<ol class="mf-fixes">' + err.fixes.map(function (f) { return '<li>' + f + '</li>'; }).join('') + '</ol>'
        : '') +
      '  <button class="btn sm" onclick="location.reload()">刷新重试</button>' +
      '</div>';
  }

  /* ============================================================
   *  坐标转换：优先用官方 AMap.convertFrom，失败回退本地算法
   *  官方接口会做更精确的纠偏，且与底图完全对齐
   * ============================================================ */
  function convertFromGps(points) {
    // points: [[lng, lat], ...] WGS84
    if (!points || !points.length) return Promise.resolve([]);

    if (S.kind !== 'amap' || !S.AMap || !S.AMap.convertFrom) {
      // 降级：本地算法
      return Promise.resolve(points.map(function (p) {
        var g = Coord.wgs2gcj(p[1], p[0]);
        return [g[1], g[0]];
      }));
    }

    return new Promise(function (resolve) {
      // convertFrom 单次最多 100 个点，分批处理
      var chunks = [];
      for (var i = 0; i < points.length; i += 100) chunks.push(points.slice(i, i + 100));
      var results = [];
      var idx = 0;

      function next() {
        if (idx >= chunks.length) return resolve(results);
        S.AMap.convertFrom(chunks[idx], 'gps', function (status, result) {
          if (status === 'complete' && result && result.locations) {
            result.locations.forEach(function (ll) {
              results.push([ll.getLng ? ll.getLng() : ll.lng, ll.getLat ? ll.getLat() : ll.lat]);
            });
          } else {
            // 失败则本地转换
            chunks[idx].forEach(function (p) {
              var g = Coord.wgs2gcj(p[1], p[0]);
              results.push([g[1], g[0]]);
            });
          }
          idx++;
          next();
        });
      }
      next();
    });
  }

  window.MapEngine = {
    create: create,
    renderError: renderError,
    makeError: makeError,
    kind: function () { return S.kind; },
    lastError: function () { return S.error; },
    loadAMap: loadAMap,
    convertFromGps: convertFromGps
  };
})();
