/* 赛事配置层
 *
 * 目标：把首页日期、报名截止、学院下拉、组别、须知从 data/campus.js
 *      的静态常量，改为「后端为准 + 本地缓存 + 断网回退」。
 *
 * 优先级：
 *   1. 后端 GET /api/event/config（管理员改了立刻全站生效）
 *   2. localStorage 缓存（断网 / 纯静态部署时用上次拉到的）
 *   3. window.CAMPUS 静态默认值（首次打开且后端不可用）
 *
 * 对外 API：
 *   EventStore.get()            同步取当前配置（渲染时用，永不返回 null）
 *   EventStore.refresh()        异步刷新，返回 Promise<config>
 *   EventStore.colleges()       学院列表
 *   EventStore.groups()         组别对象
 *   EventStore.regOpen()        报名是否开放
 *   EventStore.formatDate()     赛事日期文案
 *   EventStore.onChange(fn)     配置变化回调（页面可据此重渲染）
 */
(function () {
  'use strict';

  var U = window.U;
  var CACHE_KEY = 'event_config_v1';

  var S = {
    data: null,
    loaded: false,
    fromServer: false,
    lastError: '',
    fetching: null,
    listeners: []
  };

  /* ---------- 静态兜底（data/campus.js） ---------- */
  function staticConfig() {
    var C = window.CAMPUS || {};
    var ev = C.event || {};
    return {
      code: 'qzsf-2025',
      name: (C.name || '泉州师范学院') + ' · 校园定向越野',
      subtitle: ev.name || '校园体育文化节 · 定向跑',
      campus: {
        name: C.name || '泉州师范学院',
        center: (C.center || [24.8712, 118.6665]).slice().reverse(),
        zoom: C.zoom || 16
      },
      eventDate: ev.date || '',
      regDeadline: ev.regDeadline || '',
      closeMinutes: ev.closeMinutes || 90,
      status: 'reg_open',
      statusText: '报名进行中',
      regOpen: true,
      startName: (C.course && C.course.start && C.course.start.name) || '起点',
      finishName: (C.course && C.course.finish && C.course.finish.name) || '终点',
      groups: window.GROUPS || {},
      rules: '',
      colleges: window.COLLEGES || [],
      _static: true
    };
  }

  /* ---------- 归一化 ---------- */
  function normalize(raw) {
    if (!raw || typeof raw !== 'object') return staticConfig();
    var base = staticConfig();
    var out = Object.assign({}, base, raw);

    out.groups = (raw.groups && Object.keys(raw.groups).length) ? raw.groups : base.groups;
    out.colleges = (raw.colleges && raw.colleges.length) ? raw.colleges : base.colleges;
    out.campus = Object.assign({}, base.campus, raw.campus || {});
    out.regOpen = raw.regOpen !== false;
    out.statusText = raw.statusText || base.statusText;
    out.startName = raw.startName || base.startName;
    out.finishName = raw.finishName || base.finishName;
    return out;
  }

  /* ---------- 缓存 ---------- */
  function readCache() {
    var c = U.load(CACHE_KEY, null);
    return c ? normalize(c) : null;
  }
  function writeCache(cfg) {
    try { U.save(CACHE_KEY, cfg); } catch (e) {}
  }

  function get() {
    if (!S.data) {
      S.data = readCache() || staticConfig();
      S.loaded = true;
    }
    return S.data;
  }

  /* ---------- 文案 ---------- */
  var WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  /* '2026-11-16T09:00:00+08:00' -> '11月16日 周日 09:00' */
  function formatDate(iso) {
    if (!iso) return '待定';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + WEEK[d.getDay()] +
      ' ' + U.pad(d.getHours()) + ':' + U.pad(d.getMinutes());
  }

  /* 截止时间：今天内显示「今天 18:00」，否则「11月10日 18:00」 */
  function formatDeadline(iso) {
    if (!iso) return '待定';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    var now = new Date();
    var sameDay = d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    var hm = U.pad(d.getHours()) + ':' + U.pad(d.getMinutes());
    return sameDay ? ('今天 ' + hm) : ((d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm);
  }

  /* 距截止还有多久，用于首页提示 */
  function deadlineState(iso) {
    if (!iso) return { closed: false, text: '' };
    var t = new Date(iso).getTime();
    if (isNaN(t)) return { closed: false, text: '' };
    var diff = t - Date.now();
    if (diff <= 0) return { closed: true, text: '已截止' };
    var days = Math.floor(diff / 86400000);
    var hours = Math.floor((diff % 86400000) / 3600000);
    return {
      closed: false,
      text: days > 0 ? ('还剩 ' + days + ' 天') : ('还剩 ' + hours + ' 小时')
    };
  }

  function regOpen() {
    var c = get();
    if (!c.regOpen) return false;
    if (['reg_closed', 'running', 'finished', 'archived'].indexOf(c.status) >= 0) return false;
    if (c.regDeadline && new Date(c.regDeadline).getTime() < Date.now()) return false;
    return true;
  }

  function regClosedText() {
    var c = get();
    if (!c.regOpen) return '报名通道已关闭';
    if (['reg_closed', 'running', 'finished', 'archived'].indexOf(c.status) >= 0) {
      return c.statusText || '报名已结束';
    }
    return '报名已截止';
  }

  /* 须知文本 → 行数组（后端存的是一段话，按句号/换行切开） */
  var DEFAULT_RULES = [
    '竞赛组单人计时排名，体验组不计时，同心组两人同行取较慢成绩',
    '全程 6 个打卡点，须全部经过成绩方有效',
    '请保持小程序在前台、勿锁屏，后台定位会被系统限制',
    '禁止骑行、代跑，系统记录轨迹与配速供裁判复核'
  ];

  function rulesLines() {
    var raw = get().rules;
    if (!raw) return DEFAULT_RULES.slice();
    var lines = String(raw).split(/[\n。；;]+/)
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 1; });
    return lines.length ? lines : DEFAULT_RULES.slice();
  }

  /* ---------- 刷新 ---------- */
  function refresh(force) {
    if (S.fetching) return S.fetching;
    if (!force && S.fromServer && S.data && Date.now() - (S.data._fetchedAt || 0) < 60000) {
      return Promise.resolve(S.data);
    }
    if (!window.API) {
      S.data = get();
      return Promise.resolve(S.data);
    }

    S.fetching = window.API.get('/api/event/config')
      .then(function (j) {
        var cfg = normalize(j.data);
        cfg._fetchedAt = Date.now();
        cfg._static = false;
        S.data = cfg;
        S.loaded = true;
        S.fromServer = true;
        S.lastError = '';
        writeCache(cfg);
        emit(cfg);
        return cfg;
      })
      .catch(function (e) {
        S.lastError = e.message;
        S.fromServer = false;
        S.data = get();     // 用缓存 / 静态值
        return S.data;
      })
      .then(function (v) {
        S.fetching = null;
        return v;
      });

    return S.fetching;
  }

  function emit(cfg) {
    S.listeners.forEach(function (fn) {
      try { fn(cfg); } catch (e) { console.warn('[event] listener error', e); }
    });
  }

  function onChange(fn) {
    if (typeof fn !== 'function') return function () {};
    S.listeners.push(fn);
    return function () {
      var i = S.listeners.indexOf(fn);
      if (i >= 0) S.listeners.splice(i, 1);
    };
  }

  /* 事件版本号：写入后递增，让其他标签页/设备知道该刷新
   * （同源 localStorage 无法跨设备，但能解决「同一浏览器开了两个标签」的问题）
   */
  var VERSION_KEY = 'event_version';

  function bumpVersion() {
    var v = Number(U.load(VERSION_KEY, 0)) + 1;
    U.save(VERSION_KEY, v);
    return v;
  }

  function currentVersion() {
    return Number(U.load(VERSION_KEY, 0));
  }

  window.EventStore = {
    get: get,
    refresh: refresh,
    colleges: function () { return get().colleges || []; },
    groups: function () { return get().groups || {}; },
    regOpen: regOpen,
    regClosedText: regClosedText,
    formatDate: formatDate,
    formatDeadline: formatDeadline,
    deadlineState: deadlineState,
    rulesLines: rulesLines,
    DEFAULT_RULES: DEFAULT_RULES,
    onChange: onChange,
    staticConfig: staticConfig,
    bumpVersion: bumpVersion,
    currentVersion: currentVersion,
    VERSION_KEY: VERSION_KEY,
    isFromServer: function () { return S.fromServer; },
    lastError: function () { return S.lastError; }
  };
})();
