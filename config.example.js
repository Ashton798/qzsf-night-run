/* 复制本文件为 config.js 使用（可选）。
 *
 * 高德地图密钥不在这里配置！请改在项目根目录的 .env 中填写：
 *   AMAP_WEB_KEY=...
 *   AMAP_SECURITY_JS_CODE=...
 * 服务端通过 /api/map/config 下发 Key 与代理地址，
 * securityJsCode 永远不下发浏览器。
 *
 * 申请地址：https://console.amap.com/dev/key/app
 *   「创建新应用」→「添加 Key」→ 服务平台选「Web端(JS API)」
 */
window.APP_CONFIG = {
  /* ---------- 管理员（降级方案，后端可用时不生效） ---------- */
  admin: {
    passcode: '',
    authEndpoint: ''
  },

  /* ---------- 后端 ---------- */
  api: {
    baseUrl: '',             // 前后端分离时填后端地址，同源留空
    courseEndpoint: '/api/course',
    useServer: true
  },

  /* ---------- 赛事 ---------- */
  event: {
    // 泉州师范学院东海主校区（高德 GCJ-02 坐标）
    campusCenter: [118.670035, 24.868012],
    campusZoom: 17,
    minZoom: 14,
    maxZoom: 20,
    name: '泉州师范学院 · 校园荧光夜跑'
  }
};
