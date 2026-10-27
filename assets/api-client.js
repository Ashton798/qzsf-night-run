/* 后端 API 客户端
 *
 * 设计：所有请求走这里，统一处理 baseUrl、鉴权、错误。
 * 后端不可用时（纯静态部署）返回 { ok:false, offline:true }，
 * 上层自动回退到 localStorage，页面功能不受影响。
 */
(function () {
  'use strict';

  function cfg() { return window.AppConfig; }
  function base() { return cfg().get('api.baseUrl', ''); }

  var S = {
    online: null,          // null=未知, true=在线, false=离线
    checkedAt: 0,
    lastError: ''
  };

  function url(path) {
    if (/^https?:\/\//.test(path)) return path;
    return base() + path;
  }

  function headers(extra) {
    var h = Object.assign({}, extra || {});
    var t = window.AdminAuth && window.AdminAuth.token();
    if (t) h['Authorization'] = 'Bearer ' + t;
    var reg = window.DB && DB.getReg();
    if (reg && reg.participantToken) h['X-Participant-Token'] = reg.participantToken;
    var run = window.U && U.load('night_run', null);
    if (run && run.accessToken) h['X-Run-Token'] = run.accessToken;
    return h;
  }

  function request(method, path, body, opts) {
    opts = opts || {};
    var init = {
      method: method,
      headers: headers(body ? { 'Content-Type': 'application/json' } : null),
      credentials: 'include'
    };
    if (body !== undefined && body !== null) init.body = JSON.stringify(body);

    return fetch(url(path), init)
      .then(function (r) {
        return r.json().catch(function () { return { ok: false, error: '响应不是 JSON' }; })
          .then(function (j) {
            if (!r.ok || !j.ok) {
              var err = new Error(j.error || ('HTTP ' + r.status));
              err.status = r.status;
              err.code = j.code;
              err.payload = j;
              throw err;
            }
            S.online = true; S.checkedAt = Date.now(); S.lastError = '';
            return j;
          });
      })
      .catch(function (e) {
        if (e.status) { throw e; }          // 业务错误：正常抛给上层
        // 网络错误：标记离线，让上层回退
        S.online = false; S.checkedAt = Date.now(); S.lastError = e.message;
        var err = new Error('后端不可用：' + e.message);
        err.offline = true;
        throw err;
      });
  }

  function get(path, params) {
    var q = params ? '?' + new URLSearchParams(params).toString() : '';
    return request('GET', path + q);
  }
  function post(path, body) { return request('POST', path, body); }
  function put(path, body) { return request('PUT', path, body); }
  function patch(path, body) { return request('PATCH', path, body); }
  function del(path) { return request('DELETE', path); }

  /* 探测后端是否可用 */
  function probe() {
    if (S.online !== null && Date.now() - S.checkedAt < 30000) {
      return Promise.resolve(S.online);
    }
    return fetch(url('/api/health'), { credentials: 'include' })
      .then(function (r) {
        return r.json().then(function (j) {
          S.online = !!(r.ok && j.ok);
          S.checkedAt = Date.now();
          return S.online;
        });
      })
      .catch(function () {
        S.online = false; S.checkedAt = Date.now();
        return false;
      });
  }

  /* 下载文件（CSV 等），带鉴权 */
  function download(path, filename) {
    return fetch(url(path), { headers: headers(), credentials: 'include' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.blob();
      })
      .then(function (blob) {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
      });
  }

  window.API = {
    get: get, post: post, put: put, patch: patch, del: del,
    probe: probe, download: download,
    state: S,
    isOnline: function () { return S.online === true; },
    base: base
  };
})();
