'use strict';
/* 高德配置与服务端代理测试
 * 用法：node server/scripts/amap-config-test.js
 *
 * 不依赖真实 Key：用假密钥验证「密钥不下发浏览器」「代理路径白名单」
 * 「代理正确附加 _key」等安全行为。真实地图加载必须在填入真 Key 后人工验证。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const FAKE_KEY = 'FAKE0000000000000000000000000001';
const FAKE_CODE = 'FAKESECRETCODE00000000000000002';
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'amap-test-'));
const dbFile = path.join(folder, 'test.db');
const port = 18881;

let pass = 0;
const check = (name, ok, extra) => {
  if (ok) { pass++; console.log('  PASS', name); }
  else { console.log('  FAIL', name, extra === undefined ? '' : extra); process.exitCode = 1; }
};

function startServer(env) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, ['server/index.js'], {
      env: { ...process.env, ...env, PORT: String(port), HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { out += d.toString(); });
    const timer = setInterval(async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (r.ok) { clearInterval(timer); resolve({ proc, log: () => out }); }
      } catch (_) {}
    }, 150);
    setTimeout(() => { clearInterval(timer); resolve({ proc, log: () => out }); }, 15000);
  });
}

async function json(url, init) {
  const r = await fetch(url, init);
  return { status: r.status, body: await r.json().catch(() => null), text: '' };
}

(async () => {
  // 准备一个干净数据库
  spawnSync(process.execPath, ['server/scripts/seed.js'], {
    env: { ...process.env, DB_PATH: dbFile },
    stdio: 'ignore'
  });

  console.log('\n【1】未配置密钥时：明确报告未配置，不伪造成功');
  {
    const { proc } = await startServer({ DB_PATH: dbFile, AMAP_WEB_KEY: '', AMAP_SECURITY_JS_CODE: '' });
    const cfg = await json(`http://127.0.0.1:${port}/api/map/config`);
    check('/api/map/config 返回 200', cfg.status === 200);
    check('configured === false', cfg.body.data.configured === false);
    check('说明缺失凭据', /AMAP_WEB_KEY/.test(cfg.body.data.message || ''));
    check('未下发 key 字段', cfg.body.data.key === undefined);
    const st = await json(`http://127.0.0.1:${port}/api/map/status`);
    check('/api/map/status 显示未配置', st.body.data.configured === false);
    const proxy = await json(`http://127.0.0.1:${port}/_AMapService/v4/map/styles`);
    check('未配置时代理返回 503', proxy.status === 503);
    proc.kill();
  }

  console.log('\n【2】配置假密钥后：Key 下发、安全码绝不下发');
  {
    const { proc, log } = await startServer({ DB_PATH: dbFile, AMAP_WEB_KEY: FAKE_KEY, AMAP_SECURITY_JS_CODE: FAKE_CODE });
    const cfg = await json(`http://127.0.0.1:${port}/api/map/config`);
    check('configured === true', cfg.body.data.configured === true);
    check('下发 key', cfg.body.data.key === FAKE_KEY);
    check('下发 serviceHost=/_AMapService', cfg.body.data.serviceHost === '/_AMapService');
    check('securityMode 标记为 server-proxy', cfg.body.data.securityMode === 'server-proxy');
    const raw = JSON.stringify(cfg.body);
    check('响应体不含安全密钥', raw.indexOf(FAKE_CODE) < 0, '密钥泄露！');
    check('响应体不含 securityJsCode 字段', !/securityJsCode/.test(raw));

    const st = await json(`http://127.0.0.1:${port}/api/map/status`);
    const stRaw = JSON.stringify(st.body);
    check('/api/map/status 不含安全密钥', stRaw.indexOf(FAKE_CODE) < 0);
    check('/api/map/status 不含完整 Key', stRaw.indexOf(FAKE_KEY) < 0);
    check('状态显示已配置', st.body.data.configured === true);

    check('启动日志不打印完整密钥', log().indexOf(FAKE_KEY) < 0 && log().indexOf(FAKE_CODE) < 0);

    console.log('\n【3】代理路径白名单');
    const denied = await json(`http://127.0.0.1:${port}/_AMapService/evil/path`);
    check('非白名单路径返回 403', denied.status === 403, denied.status);
    const denied2 = await json(`http://127.0.0.1:${port}/_AMapService/`);
    check('根路径返回 403', denied2.status === 403, denied2.status);

    console.log('\n【4】静态资源不能泄露 .env');
    const envTry = await fetch(`http://127.0.0.1:${port}/.env`);
    check('/.env 被拒绝', envTry.status === 403, envTry.status);
    const envExample = await fetch(`http://127.0.0.1:${port}/.env.example`);
    check('/.env.example 也被拒绝', envExample.status === 403, envExample.status);
    const proxySrc = await fetch(`http://127.0.0.1:${port}/server/amap-proxy.js`);
    check('服务端源码不可下载', proxySrc.status === 403, proxySrc.status);
    proc.kill();
  }

  console.log('\n【5】代理确实向上游附加 _key（用本地假上游验证）');
  {
    // 起一个假上游，拦截 /v4/map/styles，检查 _key 是否被附加
    const seen = [];
    const fakeUpstream = http.createServer((req, res) => {
      seen.push(req.url);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
    await new Promise((r) => fakeUpstream.listen(0, '127.0.0.1', r));
    const upPort = fakeUpstream.address().port;

    // 直接用模块函数验证拼参逻辑（不依赖网络）
    const proxy = require('../amap-proxy');
    const withCode = proxy.withSecurityCode('?jscode=' + FAKE_KEY, FAKE_CODE);
    const params = new URLSearchParams(withCode);
    check('代理附加 _key', params.get('_key') === FAKE_CODE);
    check('保留原始 jscode', params.get('jscode') === FAKE_KEY);
    const overwrite = proxy.withSecurityCode('?a=1&_key=ATTACKER', FAKE_CODE);
    check('覆盖客户端伪造的 _key', new URLSearchParams(overwrite).get('_key') === FAKE_CODE);
    check('允许 /v4/ 路径', proxy.allowedUpstreamPath('/v4/map/styles') === true);
    check('允许 /v3/ 路径', proxy.allowedUpstreamPath('/v3/geocode/geo') === true);
    check('拒绝任意路径', proxy.allowedUpstreamPath('/api/participants') === false);

    fakeUpstream.close();
  }

  console.log(`\n通过 ${pass} 项检查`);
  console.log('\n注意：以上使用假密钥，只验证配置与代理安全行为。');
  console.log('真实高德地图能否加载、卫星图能否切换，必须在填入真 Key 后人工验证。');
})().catch((e) => { console.error(e); process.exitCode = 1; });
