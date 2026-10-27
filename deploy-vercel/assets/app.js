/* 极简路由 + 页面外壳 */
(function () {
  'use strict';

  var app = document.getElementById('app');
  var stack = [];
  var current = null;      // { name, page }
  var fullPages = { map: 1, 'admin-course': 1, 'gps-test': 1, survey: 1, 'survey-view': 1, 'plan-register': 1 };

  var TABS = [
    { key: 'home', ic: '🏠', name: '首页' },
    { key: 'rank', ic: '🏆', name: '排行' },
    { key: 'profile', ic: '👤', name: '我的' }
  ];

  function renderTabbar(active) {
    if (!active) return '';
    return '<div class="tabbar">' + TABS.map(function (t) {
      return '<div class="' + (t.key === active ? 'on' : '') + '" data-tab="' + t.key + '">' +
        '<div class="ic">' + t.ic + '</div><div>' + t.name + '</div></div>';
    }).join('') + '</div>';
  }

  function go(name, opts) {
    opts = opts || {};
    var factory = window.Pages[name];
    if (!factory) { console.warn('no page', name); return; }

    if (opts.replace) {
      // 替换栈顶
      if (stack.length) stack.pop();
    } else if (current && current.name !== name) {
      stack.push(current.name);
    }

    // 卸载上一页
    if (current && current.page && current.page.unmount) {
      try { current.page.unmount(); } catch (e) {}
    }

    // 清理上一个页面可能残留的弹层
    document.querySelectorAll('.sheet-mask').forEach(function (n) { n.remove(); });

    // 需要全宽的大屏页面
    var widePages = ['admin-course', 'plan-register', 'night-admin'];
    document.body.classList.toggle('editor-wide', widePages.indexOf(name) >= 0);

    var page = factory(opts.params || {});
    if (!page || !page.html) return;

    var isTab = TABS.some(function (t) { return t.key === name; });
    app.innerHTML = page.html + (isTab ? renderTabbar(name) : '');
    current = { name: name, page: page };

    // 绑定 tabbar
    app.querySelectorAll('[data-tab]').forEach(function (n) {
      n.onclick = function () {
        if (n.dataset.tab === name) return;
        stack = [];
        go(n.dataset.tab, { replace: true });
      };
    });

    // 地图页需要先插入 DOM 并完成一次布局，再初始化地图
    var isFull = !!fullPages[name];
    if (isFull) {
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          if (current && current.page === page && page.mount) page.mount(app);
        });
      });
    } else {
      requestAnimationFrame(function () {
        if (current && current.page === page && page.mount) page.mount(app);
      });
    }
    window.scrollTo(0, 0);
  }

  function back() {
    if (stack.length) {
      var prev = stack.pop();
      go(prev, { replace: true });
    } else {
      go('home', { replace: true });
    }
  }

  window.Router = {
    go: go, back: back, stack: stack,
    currentName: function () { return current && current.name; }
  };

  /* 启动 */
  window.addEventListener('DOMContentLoaded', function () {
    var initial = new URLSearchParams(location.search).get('page');
    go(initial && Pages[initial] ? initial : 'home', { replace: true });
  });

  /* 容器尺寸变化：通知地图重算（高德与 Leaflet 都需要） */
  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      window.dispatchEvent(new CustomEvent('app:resize'));
    }, 200);
  });
})();
