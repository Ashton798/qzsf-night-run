/* 高德地图运行时配置接口
 *
 * 只向浏览器下发「可以公开」的信息：
 *   - Web端 JS API Key（JS API 的固有设计，靠域名白名单保护）
 *   - serviceHost（指向本服务端的 /_AMapService 代理）
 *
 * 绝不下发 securityJsCode。安全密钥只由 server/amap-proxy.js 在转发时附加。
 */
'use strict';

const amap = require('./amap-proxy');
const { ok, fail } = require('./http');

function register(router) {
  router.get('/api/map/config', (req, res) => {
    const cfg = amap.readConfig();
    if (!cfg.configured) {
      return ok(res, {
        configured: false,
        reason: 'missing_credentials',
        message: '尚未在 .env 中填写 AMAP_WEB_KEY 与 AMAP_SECURITY_JS_CODE',
        version: cfg.version,
        servicePath: cfg.servicePath
      });
    }
    /* serviceHost 必须是浏览器能直接访问的绝对地址。
     * 同源部署（本地开发）用相对路径即可；
     * 前端托管在别处（如 Vercel）时，必须返回本服务的完整 HTTPS 源，
     * 否则浏览器会去请求 Vercel 域名下的 /_AMapService 而 404。
     *
     * 优先取显式配置 PUBLIC_ORIGIN；否则按请求的 Host 推断。
     */
    const envOrigin = String(process.env.PUBLIC_ORIGIN || '').trim().replace(/\/+$/, '');
    let origin = envOrigin;
    if (!origin) {
      const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
      const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
      if (host) origin = `${proto}://${host}`;
    }
    ok(res, {
      configured: true,
      key: cfg.key,
      serviceHost: origin ? origin + cfg.servicePath : cfg.servicePath,
      version: cfg.version,
      // 供前端提示用，不含任何密钥
      securityMode: 'server-proxy',
      campus: {
        name: '泉州师范学院东海主校区',
        address: '福建省泉州市丰泽区东海大街398号'
      }
    });
  });

  /* 供运维自查：不含密钥，只报告是否配置齐全 */
  router.get('/api/map/status', (req, res) => {
    ok(res, amap.status());
  });
}

module.exports = register;
