(function () {
  'use strict';

  var DEFAULT = {
    amap: { key: '', serviceHost: '', version: '2.0', fallback: true, loaded: false, configured: false, error: '' },
    admin: { passcode: '', authEndpoint: '' },
    api: { baseUrl: '', courseEndpoint: '/api/course', useServer: true },
    event: {
      campusCenter: [118.670035, 24.868012],
      campusZoom: 17, minZoom: 14, maxZoom: 20,
      name: '泉州师范学院 · 校园荧光夜跑'
    }
  };

  function merge(base, over) {
    var out = {};
    Object.keys(base).forEach(function (k) {
      out[k] = over && typeof over[k] === 'object' && over[k] !== null && !Array.isArray(over[k])
        ? merge(base[k], over[k])
        : (over && over[k] !== undefined ? over[k] : base[k]);
    });
    if (over) Object.keys(over).forEach(function (k) { if (out[k] === undefined) out[k] = over[k]; });
    return out;
  }

  var cfg = merge(DEFAULT, window.APP_CONFIG || {});
  window.APP_CONFIG = cfg;
  var configPromise = null;

  function apiBase() {
    return (cfg.api && cfg.api.baseUrl ? String(cfg.api.baseUrl) : '').replace(/\/+$/, '');
  }

  function loadMapConfig() {
    if (configPromise) return configPromise;
    configPromise = fetch(apiBase() + '/api/map/config', {
      credentials: 'include', headers: { Accept: 'application/json' }
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      var d = (j && j.data) || {};
      cfg.amap.loaded = true;
      cfg.amap.configured = !!d.configured;
      if (d.configured) {
        cfg.amap.key = d.key || '';
        cfg.amap.serviceHost = d.serviceHost || '';
        cfg.amap.version = d.version || '2.0';
        if (d.campus && d.campus.name) cfg.event.campusName = d.campus.name;
      } else {
        cfg.amap.error = d.message || '地图服务尚未配置';
      }
      return cfg.amap;
    }).catch(function (e) {
      cfg.amap.loaded = true;
      cfg.amap.configured = false;
      cfg.amap.error = '无法获取地图配置：' + (e.message || e);
      return cfg.amap;
    });
    return configPromise;
  }

  window.AppConfig = {
    get: function (path, def) {
      var cur = cfg;
      path.split('.').forEach(function (part) { cur = cur == null ? undefined : cur[part]; });
      return cur === undefined || cur === '' ? def : cur;
    },
    all: cfg,
    loadMapConfig: loadMapConfig,
    hasAmapKey: function () { return !!(cfg.amap.key && String(cfg.amap.key).trim().length >= 16); },
    hasAmapSecurity: function () { return !!(cfg.amap.serviceHost || cfg.amap.securityJsCode); },
    mapConfigured: function () { return !!cfg.amap.configured; },
    mapError: function () { return cfg.amap.error || ''; }
  };
})();
