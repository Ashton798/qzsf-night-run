/* 管理员鉴权（服务端会话版）
 *
 * 现在默认走后端：POST /api/admin/login
 *  - 密码只在请求体里传一次，服务端用 scrypt 校验
 *  - 服务端下发 HttpOnly Cookie（前端 JS 读不到）+ token
 *  - 所有写接口在服务端 requireAdmin，前端隐藏按钮只是体验优化
 *
 * 仅当 config.api.baseUrl 为空且 admin.passcode 有值时，
 * 才退回本地口令模式（纯静态部署的降级方案）。
 */
(function () {
  'use strict';

  var U = window.U;
  var K_TOKEN = 'admin_token';
  var K_TS = 'admin_login_at';
  var K_ADMIN = 'admin_info';
  var TTL = 8 * 3600 * 1000;

  function cfg() { return window.AppConfig; }

  function token() { return U.load(K_TOKEN, ''); }
  function adminInfo() { return U.load(K_ADMIN, null); }

  /* 是否使用后端鉴权
   * 同源部署时 baseUrl 为空，但仍应走后端，所以默认视为 true，
   * 只有显式设置 api.useServer=false 才降级为本地口令模式。
   */
  function isServerMode() {
    if (cfg().get('api.useServer', true) === false) return false;
    return true;
  }

  function loginUrl() {
    return cfg().get('admin.authEndpoint', '') ||
      (cfg().get('api.baseUrl', '') + '/api/admin/login');
  }

  function isLogged() {
    var t = token();
    if (!t) return false;
    var ts = U.load(K_TS, 0);
    if (!ts || Date.now() - ts > TTL) { logout(); return false; }
    return true;
  }

  /* 向服务端确认会话是否仍然有效（可选调用） */
  function verify() {
    if (!isServerMode()) return Promise.resolve(isLogged());
    return fetch(cfg().get('api.baseUrl', '') + '/api/admin/me', {
      headers: authHeaders(), credentials: 'include'
    }).then(function (r) {
      if (!r.ok) { logout(); return false; }
      return r.json().then(function (j) {
        U.save(K_ADMIN, j.data);
        return true;
      });
    }).catch(function () { return isLogged(); });
  }

  function login(usernameOrPasscode, maybePassword) {
    // 兼容两种调用：login(passcode) 或 login(username, password)
    var username = maybePassword === undefined ? '' : String(usernameOrPasscode || '');
    var password = maybePassword === undefined ? String(usernameOrPasscode || '') : String(maybePassword || '');

    if (isServerMode()) {
      return fetch(loginUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username: username || 'admin', password: password })
      }).then(function (r) {
        return r.json().then(function (j) {
          if (!r.ok || !j.ok) {
            return { ok: false, msg: (j && j.error) || '登录失败' };
          }
          U.save(K_TOKEN, j.data.token);
          U.save(K_TS, Date.now());
          U.save(K_ADMIN, j.data.admin);
          return { ok: true, server: true, admin: j.data.admin };
        });
      }).catch(function (e) {
        return { ok: false, msg: '无法连接服务器：' + e.message };
      });
    }

    // ---- 降级：本地口令（仅静态部署可用，不安全） ----
    var expect = cfg().get('admin.passcode', '');
    if (!expect) {
      return Promise.resolve({ ok: false, msg: '未配置后端，也没有本地口令' });
    }
    if (String(password) !== String(expect)) {
      return Promise.resolve({ ok: false, msg: '口令错误' });
    }
    U.save(K_TOKEN, 'local-' + Date.now().toString(36));
    U.save(K_TS, Date.now());
    U.save(K_ADMIN, { username: 'local', role: 'admin', displayName: '本地管理员' });
    return Promise.resolve({ ok: true, server: false });
  }

  function logout() {
    var t = token();
    if (isServerMode() && t) {
      fetch(cfg().get('api.baseUrl', '') + '/api/admin/logout', {
        method: 'POST', headers: authHeaders(), credentials: 'include'
      }).catch(function () {});
    }
    U.remove(K_TOKEN);
    U.remove(K_TS);
    U.remove(K_ADMIN);
  }

  function authHeaders() {
    var t = token();
    return t ? { 'Authorization': 'Bearer ' + t } : {};
  }

  function guard(router) {
    if (isLogged()) return true;
    U.toast('请先登录管理员');
    router.go('admin-login', { replace: true });
    return false;
  }

  window.AdminAuth = {
    isLogged: isLogged,
    login: login,
    logout: logout,
    guard: guard,
    token: token,
    adminInfo: adminInfo,
    authHeaders: authHeaders,
    verify: verify,
    isServerMode: isServerMode
  };
})();
