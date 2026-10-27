/* Vercel Serverless 反向代理：把 /api/* 与 /_AMapService/* 转发到本机后端隧道
 *
 * 为什么需要它：
 *   后端跑在本地电脑上，通过 serveo 隧道暴露，URL 会变。
 *   前端固定请求 Vercel 自己的域名，由这个函数去取「当前隧道地址」，
 *   前端就不必随隧道换地址重新部署。
 *
 * 隧道地址来源（按优先级）：
 *   1. 环境变量 BACKEND_ORIGIN（部署时设定）
 *   2. https://<vercel-host>/backend-url.txt 不行（静态），
 *      所以用环境变量 + 可选的 KV 配置
 */
const BACKEND = (process.env.BACKEND_ORIGIN || '').replace(/\/+$/, '');

module.exports = async (req, res) => {
  if (!BACKEND) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({
      ok: false,
      error: '后端地址未配置（Vercel 环境变量 BACKEND_ORIGIN）',
      code: 'NO_BACKEND'
    }));
  }
  const url = BACKEND + req.url;
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (['host', 'connection', 'content-length'].includes(k.toLowerCase())) continue;
    headers[k] = v;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;

  try {
    const upstream = await fetch(url, {
      method: req.method,
      headers,
      body,
      redirect: 'manual'
    });
    res.statusCode = upstream.status;
    upstream.headers.forEach((v, k) => {
      if (['content-encoding', 'content-length', 'transfer-encoding'].includes(k)) return;
      try { res.setHeader(k, v); } catch (_) {}
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.end(buf);
  } catch (e) {
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: false, error: '后端不可达：' + e.message, code: 'BACKEND_DOWN' }));
  }
};
