# 泉州师范学院 · 校园定向越野赛事系统

手机 H5 + Node.js 后端 + SQLite，学生扫码即用，管理员在电脑上编辑路线。

- 报名 → 签到 → 定向跑 → 打卡 → 成绩排行
- 真实校园地图（高德 JS API 2.0，未配 Key 自动降级）
- 管理员路线编辑器（画线、起终点、6 个打卡点）
- 真实 GPS 定位与轨迹记录
- **服务端管理员认证 + SQLite 持久化**（本次新增）

---

## 一、快速开始

### 环境要求

- Node.js **≥ 22.5**（用到内置的 `node:sqlite`）
- 零 npm 依赖，不需要 `npm install`

```bash
# 1. 复制环境变量
cp .env.example .env

# 2. 编辑 .env，改掉 ADMIN_PASSWORD
#    ADMIN_PASSWORD=你的强密码（至少 8 位）

# 3. 初始化赛事数据（幂等，重复执行不会覆盖）
node server/scripts/seed.js

# 4. 启动
npm start
```

已有旧数据库时，补一次配置字段（幂等，不覆盖已改内容）：

```bash
node server/scripts/migrate-event-config.js
```

Windows 直接双击 `start.bat`。

**本地地址：http://localhost:8777**

| 入口 | 路径 |
|---|---|
| 学生端 | `/` |
| 校园地图 | 首页 →「校园地图」 |
| 管理员 | 我的 →「管理后台」→ 用户名 `admin` + `.env` 里的密码 |

---

## 二、后端架构

### 技术选型

| 项 | 选择 | 原因 |
|---|---|---|
| 运行时 | Node.js 22.5+ | 现有项目就是 JS，无需换语言 |
| 数据库 | **SQLite**（`node:sqlite` 内置） | 单文件、零依赖、WAL 模式并发读 |
| HTTP | `node:http` 手写路由 | 零依赖，国内服务器不用 npm install |
| 密码 | `scrypt`（N=16384） | Node 内置，抗暴力破解 |
| 会话 | 服务端 session + HttpOnly Cookie | 前端 JS 读不到 token |

**为什么不用 MySQL/Redis？**
500 人 1–2 小时的活动，峰值写入约 50–100 次/秒，SQLite WAL 模式完全够用。
真要换，只需替换 `server/db.js` 里的 `query` 实现，路由层不用动。

### 目录结构

```
server/
  index.js              服务入口（HTTP 服务器、静态资源、路由挂载）
  defaults.js           学院/组别/状态默认值（唯一来源）
  db.js                 SQLite 连接、建表、迁移
  http.js               路由、JSON 解析、Cookie、静态文件
  auth.js               scrypt 密码、会话、限流、权限中间件
  api.js                所有 API 路由
  scripts/
    load-env.js         .env 加载器
    init-admin.js       创建/重置管理员
    seed.js             初始化赛事数据
    backup.js           备份/恢复数据库
    smoke-test.js       冒烟测试（38 项）
```

### 数据表（10 张）

| 表 | 用途 | 预留字段 |
|---|---|---|
| `events` | 赛事信息 | status、groups_json、rules_text |
| `admins` | 管理员 | role（admin/referee/viewer）、last_login_at |
| `sessions` | 会话 | ip、user_agent、revoked_at |
| `courses` | 比赛路线（**版本化**） | version、is_active、source、created_by |
| `checkpoints` | 打卡点 | order_index、radius_m、required |
| `participants` | 参赛选手/报名 | bib、team_code、device_id、status |
| `checkins` | 签到记录 | method（gps/qrcode/manual）、operator_id |
| `runs` | 比赛场次/成绩 | max_speed、avg_speed、off_route_cnt |
| `track_points` | GPS 轨迹点 | seq、accuracy、speed、client_ts、server_ts、source |
| `cp_hits` | 打卡记录 | elapsed_ms、dist_m、valid |
| `anomalies` | 异常/偏航（预留） | type、severity、reviewed、reviewed_by |
| `audit_logs` | 管理员操作审计 | action、target、ip |

**为 500 人实时监控预留的字段：**
- `track_points.seq` —— 客户端递增序号，用于去重和排序
- `track_points.server_ts` —— 服务器接收时间，防篡改
- `track_points.source` —— gps / network / fused
- `runs.max_speed` / `avg_speed` —— 反作弊（骑行检测）
- `anomalies` —— 偏航、超速、GPS 丢失、打卡乱序
- `participants.bib` —— 号码布
- `sessions.ip` / `audit_logs.ip` —— 溯源

---

## 三、API 一览

### 公开（无需登录）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| GET | `/api/event` | 赛事信息 |
| GET | `/api/event/config` | 赛事配置（含学院列表/组别/状态文案） |
| GET | `/api/course` | 比赛路线 |
| GET | `/api/public/stats` | 首页统计（人数/签到/完赛） |
| GET | `/api/leaderboard?group=all` | 排行榜 |
| POST | `/api/participants` | 报名 |
| GET | `/api/participants/:sid` | 按学号查报名 |
| POST | `/api/checkins` | 签到 |
| POST | `/api/runs/start` | 开始比赛 |
| POST | `/api/runs/:id/track` | 上传轨迹（≤200 点/次） |
| POST | `/api/runs/:id/hit` | 打卡 |
| POST | `/api/runs/:id/finish` | 结束比赛 |
| GET | `/api/runs/:id` | 我的成绩 |

### 需要管理员（`Authorization: Bearer <token>` 或 Cookie）

| 方法 | 路径 | 角色 |
|---|---|---|
| POST | `/api/admin/login` | — |
| POST | `/api/admin/logout` | 任意 |
| GET | `/api/admin/me` | 任意 |
| POST | `/api/admin/password` | 任意（改自己） |
| PUT | `/api/course` | admin |
| GET | `/api/course/history` | 任意 |
| POST | `/api/course/:id/activate` | admin |
| PUT | `/api/event` | admin |
| GET | `/api/participants` | 任意 |
| PATCH | `/api/participants/:id` | admin / referee |
| DELETE | `/api/participants/:id` | admin |
| GET | `/api/participants/export.csv` | 任意 |
| GET | `/api/stats` | 任意 |
| GET | `/api/anomalies` | admin / referee |
| GET | `/api/audit` | admin |

### 示例

```bash
# 登录
curl -X POST http://localhost:8777/api/admin/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"你的密码"}'

# 用返回的 token 保存路线
curl -X PUT http://localhost:8777/api/course \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <token>' \
  -d '{"name":"测试","route":{"points":[[118.671,24.868],[118.672,24.869]],"start":[118.671,24.868],"finish":[118.671,24.868]},"checkpoints":[...]}'
```

---

## 四、安全设计

### 已实现

| 措施 | 实现 |
|---|---|
| 密码存储 | `scrypt(N=16384, 64字节)`，盐随机 16 字节 |
| 会话 | 32 字节随机 token，存 `sessions` 表，8 小时过期 |
| Cookie | `HttpOnly` + `SameSite=Lax` + HTTPS 时 `Secure` |
| 权限校验 | 每个写接口在**服务端**调 `requireAdmin`，前端隐藏按钮只是体验 |
| 暴力破解 | 按 `IP+用户名` 限流，5 次失败锁定 15 分钟 |
| 登出 | 服务端吊销 token，立即失效 |
| 改密 | 吊销该管理员其它所有会话 |
| 审计 | 所有管理员写操作写入 `audit_logs` |
| 参数校验 | 服务端校验学号、坐标范围、打卡点数量/半径 |
| 路径穿越 | 静态文件服务做了 `path.normalize` + 前缀校验 |

### 验证结果

```
未授权访问 7 个受保护接口 → 全部 401 ✓
伪造 token                → 401 ✓
登出后旧 token            → 401 ✓
连续 6 次错误密码         → 429 锁定 15 分钟 ✓
```

### 仍需注意

- **HTTP 明文传输**：生产必须上 HTTPS，否则密码在网络中可被截获
- **限流是内存的**：多进程部署需换 Redis
- **SQLite 单写者**：并发写极高时（>500 写/秒）需换 PostgreSQL
- **管理员密码**：`.env` 里的 `ADMIN_PASSWORD` 只在首次创建时生效，之后用 `init-admin.js` 改

---

## 五、部署 HTTPS（手机真机测试）

Geolocation 只在 HTTPS 或 localhost 下可用。

### 方案 A：Cloudflare Tunnel（推荐，免费、不需要公网 IP）

```bash
# 安装 cloudflared 后
npx cloudflared tunnel --url http://localhost:8777
# 输出 https://xxx.trycloudflare.com
```

### 方案 B：ngrok

```bash
npx ngrok http 8777
# 输出 https://xxx.ngrok-free.app
```

### 方案 C：localtunnel

```bash
npx localtunnel --port 8777
# 输出 https://xxx.loca.lt
```

### 真机测试步骤

1. 电脑启动 `npm start`
2. 另开终端跑隧道命令，拿到 HTTPS 地址
3. 手机浏览器打开该地址
4. 首页 →「校园地图」→「开启定位」→ 允许权限
5. 走到户外空旷处，观察蓝色点、虚线轨迹、精度数值

> 室内 GPS 会漂移或收不到信号，**必须到室外**。
> 手机锁屏或切后台时，浏览器会暂停定位，页面会显示「定位中断」，这是正常的。

### 正式部署（阿里云/腾讯云轻量）

```bash
# 1. 服务器装 Node 22+
# 2. 上传项目，npm start（或用 pm2 守护）
npm i -g pm2
pm2 start server/index.js --name qzsf
pm2 save && pm2 startup

# 3. Nginx 反代 + Let's Encrypt 证书
```

```nginx
server {
    listen 443 ssl http2;
    server_name run.yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/run.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/run.yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8777;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # 高德安全密钥代理（可选，见下）
    location /_AMapService/ {
        set $args "$args&jscode=你的安全密钥";
        proxy_pass https://restapi.amap.com/;
    }
}
```

### 二维码

部署后把链接生成二维码，打印或贴在起点即可：

```bash
npx qrcode-terminal "https://run.yourdomain.com"
```

---

## 六、高德地图 Key

```bash
cp config.example.js config.js
```

编辑 `config.js`：

```javascript
window.APP_CONFIG = {
  amap: {
    key: '你的32位Key',              // 控制台选「Web端(JS API)」
    securityJsCode: '配套安全密钥',   // 必须与 key 成对
    serviceHost: '',                 // 生产环境填代理地址
    fallback: true                   // Key 失效自动降级瓦片底图
  }
};
```

**申请**：<https://console.amap.com/> → 应用管理 → 创建应用 → 添加 Key → 服务平台选 **「Web端(JS API)」**

**生产环境**：前端明文 `securityJsCode` 会被 F12 看到，应改用 `serviceHost` 指向 Nginx 代理（配置见上）。

---

## 七、运维

### 备份

```bash
node server/scripts/backup.js                 # 备份到 backups/
node server/scripts/backup.js restore <文件>   # 恢复
```

数据库是单文件 `data/qzsf.db`，直接复制也算备份（WAL 模式下建议先停服务或用脚本）。

### 创建/重置管理员

```bash
node server/scripts/init-admin.js admin "新密码" admin
node server/scripts/init-admin.js referee1 "密码" referee   # 裁判，只能看+改选手
node server/scripts/init-admin.js viewer1 "密码" viewer     # 只读
```

### 冒烟测试

```bash
npm test        # 38 项检查
```

### 清理测试数据

```bash
node -e "
const db=require('./server/db'); db.open('data/qzsf.db');
db.run('DELETE FROM cp_hits'); db.run('DELETE FROM track_points');
db.run('DELETE FROM runs'); db.run('DELETE FROM checkins');
db.run('DELETE FROM participants');
"
```

---

## 八、前端结构

```
index.html
config.js                本地密钥（不入库）
config.example.js        模板
assets/
  config.js              配置加载器
  api-client.js          后端 API 客户端（统一鉴权/错误）
  event-store.js         赛事配置层（后端 > 缓存 > 静态兜底）
  coord.js               WGS-84 ↔ GCJ-02
  util.js                距离、格式化、存储
  store.js               数据层（优先后端，断网回退本地）
  course-store.js        路线数据层（版本化、JSON/GPX 导入导出）
  admin-auth.js          服务端会话鉴权
  map-engine.js          地图引擎抽象（高德 / 瓦片降级）
  geo.js                 定位与轨迹采集
  run.js                 计时引擎
  pages.js               首页/报名/签到/跑步/成绩/排行/我的/名单后台
  page-map.js            地图页
  page-admin.js          管理员登录 + 后台首页
  page-admin-event.js    赛事设置（日期/截止/学院/须知）
  page-admin-course.js   路线编辑器
  app.js                 路由
  style.css
data/
  campus.js              旧版演示数据
  qzsf.db                SQLite 数据库（不入库）
```

---

## 九、本阶段完成情况

### ✅ 已接入真实后端

| 功能 | 状态 |
|---|---|
| 学生报名 | 写入 `participants` 表，学号唯一，支持同心组双人 |
| 管理员登录 | 服务端 scrypt 校验 + 会话，密码不在前端 |
| 路线保存 | 写入 `courses` + `checkpoints`，**版本化**（保留历史） |
| 路线读取 | 多设备一致，断网回退本地缓存 |
| 打卡点 | 6 个，含坐标、名称、顺序、半径 |
| 签到 | 写入 `checkins`，更新选手状态 |
| 比赛场次 | `runs` 表记录开始/结束/用时 |
| GPS 轨迹 | 批量上传到 `track_points`（每 10 点一次） |
| 打卡记录 | `cp_hits`，含距离校验（超出半径判无效） |
| 成绩排行 | 从 `runs` + `participants` 实时查询 |
| 首页统计 | `/api/public/stats` 真实数据 |
| 报名名单 | 管理后台从后端拉取 |
| CSV 导出 | 后端生成，带 BOM 防 Excel 乱码 |
| 数据持久化 | 重启服务不丢数据（已验证） |

### ⚠️ 仍是假数据 / 未完成

| 项 | 说明 |
|---|---|
| ~~首页「赛事日期」~~ | ✅ 第五阶段已接 `events.event_date` |
| ~~报名页「学院下拉」~~ | ✅ 第五阶段已改读 `events.colleges_json` |
| 演示跑模式 | 沿内置路线模拟，不写真实 GPS（用于无 GPS 环境演示） |
| 500 人实时监控 | 数据库字段已预留，接口未开发 |
| 自动判罚 | 偏航/超速检测字段已预留（`anomalies`、`runs.max_speed`），逻辑未实现 |
| 同心组取较慢成绩 | 排行榜目前按个人用时排序，组队规则未实现 |
| 二维码签到 | `checkins.method` 字段已预留，扫码流程未开发 |
| 服务端高德代理 | Nginx 配置已给出，未实际部署 |

### 下一步建议

1. ~~接 `events` 表~~：✅ 第五阶段已完成
2. **实地测路线**：用手机在校园走一圈，导出 GPX，导入编辑器校正坐标
3. **开发实时监控**：WebSocket + `track_points` 增量查询
4. **实现判罚规则**：读 `anomalies` 表，裁判端复核界面
5. **压测**：用 `artillery` 或 `k6` 模拟 500 人并发上传轨迹

---

# 第二阶段：地图精细度 · 路线精度 · 实测能力

## 一、地图升级

### 三种图层

| 图层 | 实现 | 说明 |
|---|---|---|
| 标准地图 | 高德矢量底图（map 自身渲染） | 最清晰，缩放不失真 |
| 卫星地图 | `AMap.TileLayer.Satellite` | 纯影像 |
| 卫星+路网 | `Satellite` + `RoadNet` 叠加 | 影像上叠路网注记 |

手机地图页右侧悬浮按钮循环切换，选择会记住（`localStorage`）。

### 关于「高清」的实测结论（重要）

我在泉州师范学院坐标（24.8683, 118.6674）逐级抓取瓦片做了验证：

| 级别 | 标准图瓦片 | 卫星瓦片 | 结论 |
|---|---|---|---|
| z=16 | 12587 B | 16835 B JPEG | 真实数据 |
| z=17 | 13291 B | 12992 B JPEG | 真实数据 |
| **z=18** | **8838 B** | **11869 B JPEG** | **原生最高级** |
| z=19 | **179 B（空白占位）** | 4235 B（重复） | **假高清** |
| z=20 | 179 B | 4235 B | 假高清 |

**结论：高德在校园区域的原生瓦片上限是 18 级。**

另外我验证了 `scale=2`（高德宣称的高清参数）：
```
scale=1 -> 256x256, 8838 bytes
scale=2 -> 256x256, 8838 bytes   ← 完全相同，参数已失效
```

所以本项目：
- `maxNativeZoom = 18`，允许缩放到 20 级用于精细编辑
- 19–20 级由 Leaflet 像素放大，**UI 上明确标注「超出原生 18 级（放大显示）」**
- 绝不用低分辨率瓦片冒充高清

### 如果 18 级仍不够清晰，合法替代方案

1. **高德官方卫星/影像服务** —— 联系高德商务开通「高精地图」或「影像图」商用服务（收费，需授权）
2. **天地图（国家地理信息公共服务平台）** —— 官方免费，提供 18–19 级影像，需申请 key，遵循其服务条款
3. **学校自采** —— 用无人机航拍正射影像，自行切片（需学校批准空域）
4. **矢量底图 + 实地测绘** —— 用 GPS 采集道路中心线，叠加在高德矢量底图上（本项目已支持）

⚠️ **不要抓取 Google/Bing/百度 的瓦片**，违反其服务条款。

## 二、坐标系治理（本阶段核心）

### 问题排查结果

发现并修复了 3 个真实缺陷：

| # | 位置 | 问题 | 后果 |
|---|---|---|---|
| 1 | `course-store.js` `toGPX()` | 直接把 GCJ-02 当 WGS84 写入 GPX | 导出文件在其他软件打开偏移 **561 米** |
| 2 | `geo.js` `pushPoint()` | 只存转换后的 GCJ，丢弃原始 WGS | 无法复核、无法正确导出 GPX |
| 3 | `run.js` `checkCps()` | WGS 的 GPS 点与 GCJ 的打卡点直接比距离 | 打卡全部判无效（偏移 561m） |

### 现在的坐标规则

```
GPS 采集 ──┬─> raw:     { lat, lng, crs:'wgs84' }  ← 原始，永不修改
           └─> display: { lat, lng, crs:'gcj02' }  ← 转换后，用于地图

管理员绘制 ──> { lng, lat, crs:'gcj02' }            ← 本身就是高德坐标
GPX 导出  ──> 必须 gcj02 → wgs84 转换
GPX 导入  ──> 必须 wgs84 → gcj02 转换
```

**防重复转换**：`Coord.convert(lat, lng, from, to)` 在 `from === to` 时直接返回原值，偏移 0 米。

### 验证结果

```
WGS→GCJ→WGS 往返误差:        0.0000 m   ✓
gcj02→gcj02 转换:            0.000000 m ✓
wgs84→wgs84 转换:            0.000000 m ✓
GPX 导出→导入 往返:          0.0000 m   ✓
重复转换两次的额外偏移:       561.7 m   ← 证明为什么必须防重复
距离计算 GCJ vs WGS 差异:    0.21%     ✓ 可接受
```

### 数据表新增字段

```sql
courses.crs          -- 'gcj02'，坐标系声明
courses.status       -- draft | surveyed | published
courses.surveyed_at  -- 实地勘测确认时间
courses.surveyed_by  -- 确认人

track_points.raw_lng -- WGS-84 原始经度（永不覆盖）
track_points.raw_lat -- WGS-84 原始纬度
track_points.crs     -- lng/lat 的坐标系
```

已有数据库自动迁移（`addColumnIfMissing`）。

## 三、路线精度提升

### 编辑器新增能力

| 功能 | 说明 |
|---|---|
| 高缩放编辑 | 支持到 20 级，顶栏显示 `Z18` / `Z19（超出原生）` |
| 逐点详情 | 点击任意点，显示经纬度、坐标系、距上/下点距离 |
| 段内加密 | 选中一段，一键插入 N 个中间点，再逐个拖动贴路 |
| GPS 参考线 | 载入实地采集记录，蓝色虚线叠加显示，**仅作对照** |
| 图层切换 | 编辑器内也能切标准/卫星/卫星+路网 |

### 关于「自动吸附」的明确取舍

**没有实现自动吸附。** 原因：
- 高德公开道路数据在校园内不完整（实测：校内小路缺失严重）
- 自动吸附会把路线拉到错误的道路上，比不吸附更糟
- 需求明确要求「不能为了美观自动把路线吸附到错误道路」

替代方案：管理员在高缩放级别下（18–20 级）对照卫星影像手动逐点调整。

### 路线状态流转

```
draft（草稿）→ surveyed（已实地勘测）→ published（已发布）
```

数据表已支持，UI 上的"发布"流程留待后续阶段。

## 四、GPS 精度诊断页

入口：我的 →「定位精度测试」/ 首页 →「定位精度测试」

使用 `watchPosition` 参数：
```js
{ enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
```

实时显示：
- WGS84 与 GCJ02 双坐标
- 精度（±米）
- 更新时间
- 移动速度
- 采样点数
- 精度圈
- 异常标记（精度差 / 跳点 / 时间倒序）

### 异常点检测策略

| 标记 | 判定 | 处理 |
|---|---|---|
| `accuracy_poor` | 精度 > 100m | 不加入有效轨迹 |
| `jump` | 速度 > 12 m/s 且位移 > 30m | 不加入有效轨迹 |
| `time_reverse` | 时间戳倒退 | 不加入有效轨迹 |
| `still` | 位移 < 精度圈一半 | 不算异常，只是不重复记录 |

**关键：被拒的点仍完整保留在 `rawSamples` 里**，可导出复核。不做平滑、不伪造轨迹。

导出：JSON（含全部原始采样 + 有效轨迹）和 GPX（WGS84）。

## 五、实地路线采集

入口：我的 →「实地路线采集」/ 管理后台 →「实地路线采集」

流程：
1. 点「开始采集」→ 沿真实路线走
2. 可暂停/恢复
3. 点「结束采集」→ 保存（起名字）
4. 在「采集记录」里查看、导出 GPX、删除
5. 进编辑器 →「载入采集记录」→ 作为参考线人工核验

**同一路段可采集多次**，在编辑器里同时载入多条对比，用不同颜色虚线显示。

质量评估（`RouteGuard.assessQuality`）：
- 平均精度、最大精度
- 速度突变次数
- 评分 A/B/C/D

采集结果**不会自动成为正式路线**，必须管理员在编辑器中逐点确认。

## 六、偏航识别基础

模块：`assets/route-guard.js`

```js
var tracker = RouteGuard.createTracker(coursePoints);
var result = tracker.update({ lat, lng, accuracy, ts });
// result.state: 'ok' | 'off_pending' | 'off_route' | 'unreliable'
```

### 判定逻辑（三条件同时满足才算偏离）

1. **距离超容差**：`dist > 25m + accuracy × 1.5`
   —— 精度 ±50m 时容差自动放宽到 100m
2. **连续 N 个有效点**：默认 3 个
3. **持续 M 毫秒**：默认 8000ms

### 精度差时不判罚

```js
if (accuracy > 60) {
  state = 'unreliable';
  message = '定位精度 ±80m，无法判断是否偏离';
  // 计数清零，不认定为偏离
}
```

### 已验证的行为

```
路线上的点（±8m）→ ok，容差 37m
偏 20m          → ok（在容差内）
偏 60m 第1次    → off_pending (1/3)
偏 60m 第2次    → off_pending (2/3)
偏 60m 第3次(9s) → off_route，记录事件
精度 ±80m       → unreliable，不判罚
回到路线        → ok，记录 back_on_route 事件
```

**本阶段不实现自动踢出或取消成绩**，只记录事件供裁判复核。

## 七、新增文件

| 文件 | 作用 |
|---|---|
| `assets/route-guard.js` | 偏航距离计算、状态机、轨迹质量评估 |
| `assets/page-gps-test.js` | GPS 精度诊断页 |
| `assets/page-survey.js` | 实地采集页 + 采集列表 + 单条查看 |

## 八、浏览器环境限制（必须了解）

| 场景 | 表现 | 原因 |
|---|---|---|
| **锁屏** | 定位暂停 | iOS/Android 都会挂起后台网页的 Geolocation |
| **切到后台** | 定位暂停，页面显示「定位中断」 | 浏览器主动降频，省电 |
| **弱网** | 定位仍可继续（GPS 不依赖网络），但轨迹上传失败 | 轨迹本地缓存，恢复后重传 |
| **室内** | 精度 30–200m，或完全无信号 | GPS 需要天空视野 |
| **高楼间** | 多径反射，精度 20–50m，可能出现"漂移" | 物理限制，无法软件解决 |
| **首次定位** | 需 5–30 秒 | 冷启动要下载星历 |
| **HTTPS** | 必须 | 非 HTTPS 浏览器直接禁用 Geolocation |

### 实战建议

1. 赛前用「定位精度测试」在起点、各打卡点各测 2 分钟，记录平均精度
2. 若某点精度持续 > 30m，把该打卡点半径调大到 50–80m
3. 路线采集时走 2–3 遍，取平均线，不要只走一次
4. 比赛时提醒选手：**不要锁屏、不要切后台**

## 九、真机测试步骤

```bash
# 1. 启动
npm start

# 2. 开 HTTPS 隧道（三选一）
npx cloudflared tunnel --url http://localhost:8777
npx ngrok http 8777
npx localtunnel --port 8777
```

拿到 `https://xxx.trycloudflare.com` 后：

**A. 测 GPS 精度**
1. 手机打开链接 → 我的 →「定位精度测试」
2. 允许定位权限
3. 走到校园空旷处，站 30 秒看精度稳定值
4. 走 100 米，看轨迹是否连续、有无跳点
5. 导出 JSON，用电脑打开检查 `rawSamples` 里的 `accuracy` 分布

**B. 采集路线**
1. 我的 →「实地路线采集」→ 开始
2. 沿真实比赛路线走一遍（速度接近比赛）
3. 结束保存，重复 2–3 次
4. 「采集记录」→ 查看 → 对比多次轨迹是否重合

**C. 核验路线**
1. 电脑登录管理后台 →「比赛路线」
2. 切到卫星图层，放大到 18 级
3. 「载入采集记录」选多条
4. 对照卫星影像，逐点调整绿色路线
5. 保存

## 十、本阶段未完成

| 项 | 说明 |
|---|---|
| 路线发布审核流 | `status` 字段已支持，UI 上的"发布/撤回"未做 |
| 偏航事件入库 | `anomalies` 表已建，前端未上报 |
| 轨迹平滑 | 刻意不做（避免伪造精度），只做标记 |
| 19–20 级真高清 | 高德不提供，需另购服务（见第一节） |
| 地图旋转/俯仰 | 未启用，2D 视角足够编辑 |

---

# 第三阶段：校园规划参考图层

## 一、先说结论：这张图不适合做精确配准

你提供的是一张**实体沙盘模型的照片**（1707×1280），不是平面规划图，也不是测绘成果。

我做完了完整的处理与验证，结论如下：

### 1.1 图像处理

| 步骤 | 结果 |
|---|---|
| 定位沙盘边框四角 | TL(108,92) TR(1504,40) BR(1452,1200) BL(60,1196) |
| 透视校正 | ✅ 梯形拉正为 1397×1161 矩形 |
| 去除相框与背景 | ✅ 已裁掉黑色边框和墙面 |
| 去除文字带 | ✅ 裁掉左侧"校园规划(主校区)" |
| 最终成品 | `data/assets/campus-plan.jpg`，1247×1161，455 KB |

### 1.2 与真实卫星图比对（关键）

用高德卫星图（z=17）作为参照，识别出 4 个共同地标：

| 地标 | 沙盘像素 | 卫星像素 |
|---|---|---|
| 主田径场 | (790, 455) | (1600, 830) |
| 小田径场 | (447, 660) | (1015, 1125) |
| 湖泊中心 | (770, 730) | (1620, 1300) |
| 圆形建筑 | (620, 755) | (1330, 1275) |

**用 4 个控制点做相似变换最小二乘拟合：**

```
RMS 残差:  114.7 px = 124 米
最大残差:  136.7 px = 148 米
```

**三角形形状一致性检验**（判断是否只是旋转+缩放）：

| 三点组 | 沙盘归一化边长 | 卫星归一化边长 | 差异 |
|---|---|---|---|
| 主田径场-小田径场-湖泊 | 1.000 / 0.827 / 0.690 | 1.000 / 0.961 / 0.718 | 13.4% / 2.8% |
| 主田径场-小田径场-圆形建筑 | 1.000 / 0.494 / 0.863 | 1.000 / 0.533 / 0.794 | 3.9% / 6.8% |

→ **不是严格的相似变换**，说明沙盘本身的比例与真实地理有偏差。

### 1.3 三个根本原因

1. **沙盘是规划方案，不是现状**
   沙盘上大片"绿地"在卫星图里是山林、村落、荒地；沙盘画了完整方格路网，实际很多路不存在。

2. **斜拍导致立体视差**
   模型建筑有高度，斜拍后建筑侧面可见。透视校正只能校正平面，无法消除物体自身的视差——越高的物体偏移越大。

3. **比例不一致**
   见上表，三个地标构成的三角形边长比例差了 3–13%。

### 1.4 结论

**这张图最高只能做到"参考级"精度（约 100–150 米偏差），不能作为测绘底图，更不能作为比赛路线依据。**

按你的要求「不能根据图片像素直接推算真实经纬度，也不能把规划模型当成测绘底图」，本模块做了强制约束（见第三节）。

## 二、实现的「校园规划参考图」模式

### 2.1 功能

| 功能 | 实现 |
|---|---|
| 独立图层 | `CampusPlanLayer`，叠加在高德地图之上，**不替换底图** |
| 透视校正 | 已离线完成，成品图直接使用 |
| 缩放/移动 | 跟随地图，用仿射变换实时绘制 |
| 多控制点配准 | 管理员在图上点 → 地图上点，≥2 点即可解算 |
| 透明度调节 | 0–100% 实时滑块 |
| 对照检查 | 可切标准/卫星/卫星+路网，叠加查看差异 |
| 保存/导入导出 | localStorage + JSON |

### 2.2 配准数学

用**4 参数相似变换**（等比缩放 + 旋转 + 平移），不用 8 参数仿射或单应变换：

```
lng = a·x − b·y + tx
lat = b·x + a·y + ty
```

原因：相似变换只有 4 个自由度，不会为了"贴合"而局部扭曲图像，避免制造虚假精度。

最小二乘求解，用正规方程 + 高斯消元（选主元），无外部依赖。

**验证结果：**
```
已知变换反解（4 点，无噪声）：RMS = 2.2e-9 m，旋转角误差 0.000°  ✓
正逆变换往返：误差 2.5e-11 px  ✓
加入 30m 噪声：RMS 38.7m，符合预期  ✓
```

### 2.3 强制约束（代码层面）

```javascript
// plan-layer.js
function save(state) {
  var c = Object.assign({}, state);
  c.precision = 'reference';   // 强制，不可改为 'survey'
  ...
}
```

精度等级**只能是 `reference`**，代码里没有任何路径能改成 `survey`。

UI 上：
- 顶部橙色横幅常驻：「本图为实体沙盘模型照片（规划示意），实测与卫星图偏差约 100–150 米。仅作布局参考，**禁止作为比赛路线依据**」
- 地图页叠加时右下角红标：「规划参考图 · 非测绘 · 偏差约 100-150m」
- 配准页底部说明：「即使残差显示 10 米，也不代表地图位置准确 10 米」

## 三、使用流程

### 管理员配准

1. 管理后台 →「配准参考图」
2. 左侧点一个明显地物（田径场中心、湖泊边缘、圆形建筑）
3. 右侧地图点同一位置的准确坐标
4. 重复 ≥4 次，点要分散（覆盖四角）
5. 查看残差（本图实测约 224m）
6. 勾选「在地图上显示参考图」→ 保存

### 学生端

地图页右侧新增「图」按钮，点击开关参考图层。开关状态会记住。

### 对照检查

在配准页把透明度调到 90%，可以清楚看到沙盘的道路/建筑与真实卫星图的错位。

## 四、新增/修改文件

**新增**
- `data/assets/campus-plan.jpg` — 校正后的沙盘图（1247×1161）
- `data/assets/campus-plan-original.jpg` — 原始照片（备查）
- `assets/plan-layer.js` — 图层数据层 + 相似变换求解
- `assets/page-plan-register.js` — 配准页面
- `vendor/leaflet/` — 本地托管 Leaflet（178 KB）

**修改**
- `assets/map-engine.js` — 两个适配器都加 `addImageOverlay`；Leaflet 改本地加载
- `assets/page-map.js` — 参考图开关按钮 + 红标提示
- `assets/page-admin.js` — 管理后台入口
- `assets/app.js` — `plan-register` 全宽
- `assets/style.css` — 配准页样式
- `index.html` — 脚本引入

## 五、顺带修复的问题

**Leaflet CDN 不可达导致降级模式地图空白**

原来 `unpkg.com` 和 `jsdelivr` 在国内经常超时（实测全部返回 000），降级模式下地图完全无法初始化，且不报错。

现在改为本地托管 `vendor/leaflet/`，从 npm 包提取，不依赖任何外网 CDN。

## 六、验证结果

```
【原有功能】
  ✓ 首页 / 报名 / 排行榜
  ✓ 报名写入数据库
  ✓ 签到
  ✓ 跑步计时与成绩

【地图】
  ✓ 标准 / 卫星 / 卫星+路网 三图层切换
  ✓ 地图正常渲染（Leaflet 本地加载）
  ✓ 高缩放至 20 级 + 超原生提示

【定位】
  ✓ 真实定位
  ✓ WGS84 与 GCJ02 双坐标

【规划参考图】
  ✓ 透视校正成品图
  ✓ 4 点配准求解（RMS 224m，如实反映偏差）
  ✓ 透明度调节
  ✓ 叠加显示（在矢量覆盖物下层）
  ✓ 精度等级强制 reference
  ✓ 免责声明常驻
  ✓ 学生端开关 + 状态记忆

【后端】38 项冒烟测试全部通过
```

## 七、如果需要更高精度的规划图

如果学校有真正的**平面规划 CAD / PDF 图纸**（正交投影、无立体高度），配准精度可以做到 5–15 米，那时这个模块可以直接用——只需替换 `data/assets/campus-plan.jpg` 并重新配准。

其他合法替代方案：
1. **天地图** 官方 18–19 级影像（免费，需申请 key）
2. **高德商务** 高精地图服务（收费授权）
3. **学校无人机航拍** 正射影像（需空域批准）
4. **GPS 实地采集** 道路中心线（本项目已支持，见「实地路线采集」）

⚠️ 不要抓取 Google/Bing/百度 瓦片，违反服务条款。

## 八、本阶段未做

| 项 | 说明 |
|---|---|
| 从沙盘提取道路矢量 | 技术可行（图像分割+骨架化），但提取出的道路**仍是规划数据**，不能用于比赛，故未做 |
| 多张参考图 | 当前只支持一张，扩展只需改 `plan-layer.js` 的存储为数组 |
| 透视变换配准 | 刻意只做相似变换，避免用过度自由度强行贴合 |

---

# 第四阶段：统一全站布局

## 问题

桌面端所有页面都变成屏幕中间一条 480px 的窄缝，两边大片留白：

- `#app { max-width: 480px }` 写死，是给手机设计的
- 地图页被压扁，底部统计条 `0 / 6` 换行成两行
- 底部面板贴到屏幕最底，被浏览器窗口裁掉
- 编辑器、配准页虽然单独放宽，但和其余页面风格割裂

## 修复方案

建立一套统一的响应式布局规则，**所有页面共用**：

| 断点 | `#app` 宽度 | 表现 |
|---|---|---|
| < 768px（手机） | 100% | 全宽，无圆角无阴影，像原生 App |
| 768–1279（平板） | 560px | 居中卡片，圆角 20px，四周留白 20px |
| ≥ 1280（桌面） | 620px | 同上，稍宽 |

`body` 改为 flex 居中，`#app` 用 `height: 100%` 填满可用高度，四周统一 20px 留白。

只有明确标记 `wide` 的两个页面占满宽度：
- `admin-course`（路线编辑器）
- `plan-register`（参考图配准）

## 同时修复

**1. 底部统计条换行**
`.mb-row` / `.stat-row` / `.gt-grid` 从 `flex: 1` 改为 `grid + minmax(0,1fr)`，并给文字加 `nowrap + ellipsis`，窄屏也不会换行。

**2. 全屏页高度溢出**
`.map-page` / `.ce-page` / `.pr-page` 等原来写死 `height: 100dvh`，在桌面端带留白时会溢出。改为 `100%` 跟随 `#app`。

**3. 内容被拉散**
普通页面（首页、报名、排行）在宽屏时内容不拉伸，`justify-content: flex-start`，避免大片空白。

## 验证结果

```
【布局一致性 @1920x1080】
  ✓ 所有页面宽度一致（620px）
  ✓ 无横向滚动
  ✓ 桌面端为居中圆角卡片

【桌面端地图页】
  ✓ 地图正常渲染
  ✓ 底部面板完整显示（不再被裁）
  ✓ 参考图按钮可见
  ✓ 叠加层存在

【手机端 390x844】
  ✓ 全宽 390px
  ✓ 底部完整
  ✓ 无横向滚动

【多尺寸回归】
  375×667 / 390×844 / 412×915 / 768×1024 / 1920×1080
  全部无横向滚动、无溢出

【后端】38 项冒烟测试通过
```

## 修改文件

- `assets/style.css` — 布局体系重写（`#app`、媒体查询、grid 统计条、全屏页高度）

只改了一个文件，所有页面同时生效。

---

# 第五阶段：赛事配置接入数据库

## 问题

前四个阶段里，首页日期、报名截止、学院下拉、组别、赛事须知都写死在
`data/campus.js` 的静态常量里：

```js
event: { date: '2025-11-16T09:00:00', dateText: '11月16日 周日 09:00', ... }
window.COLLEGES = ['数学与计算机科学学院', ...]
window.GROUPS = { competition: {...}, ... }
```

后果：

- 换一年办赛要改代码、重新发版
- 学院合并/更名，前端改了后端没改，学生提交时被服务端校验拦下
- 管理员看不到也改不了报名截止时间，只能改数据库
- `events` 表早就建好、`PUT /api/event` 也早就写好，但前端从没调用过

## 方案

新增一层 `EventStore`，优先级 **后端 > 本地缓存 > 静态兜底**：

```
EventStore.get()        同步取值，永不返回 null（渲染时直接用）
EventStore.refresh()    异步拉 /api/event/config，成功后写缓存并通知页面
EventStore.onChange(fn) 配置变化回调，页面原地更新而不整页重刷
```

页面渲染时先用缓存（首屏不等待网络），拿到服务端配置后由 `onChange`
局部更新。断网、纯静态部署时自动退回 `data/campus.js`，行为与之前一致。

## 数据层

`events` 表新增 4 个字段（`db.js` 里用 `addColumnIfMissing` 做幂等迁移）：

| 字段 | 用途 |
|---|---|
| `colleges_json` | 学院列表，报名页下拉的数据源 |
| `start_name` / `finish_name` | 起终点名称，首页展示 |
| `reg_open` | 报名开关，独立于截止时间 |

报名是否开放，改成三个条件同时满足：

```js
reg_open = 1                     // 管理员开关
&& status 属于 reg_open 阶段      // 赛事状态
&& now < reg_deadline            // 未过截止
```

任一不满足，学生端报名按钮置灰并提示具体原因；服务端 `POST /api/participants`
用同一套 `regClosedReason()` 再判一次，防止绕过前端。

## 新增 / 修改

| 文件 | 说明 |
|---|---|
| `server/defaults.js` | **新增**。学院列表、组别、状态、状态文案的唯一来源 |
| `server/scripts/migrate-event-config.js` | **新增**。给已有数据库补字段，幂等、不覆盖 |
| `assets/event-store.js` | **新增**。配置层（缓存 + 刷新 + 订阅 + 日期格式化） |
| `assets/page-admin-event.js` | **新增**。管理员「赛事设置」页 |
| `server/api.js` | `/api/event` 补字段；新增 `/api/event/config`；`PUT` 加校验；报名改用数据库组别与开关 |
| `server/db.js` | `events` 表补 4 列 |
| `server/scripts/seed.js` | 引用 `defaults.js`，写入学院列表 |
| `assets/pages.js` | 首页日期/截止/起点/须知、报名页学院与组别、排行榜组别名全部改读 `EventStore` |
| `assets/page-admin.js` | 后台首页加「赛事设置」入口，底部文案按在线状态切换 |
| `assets/style.css` | 学院标签、报名开关样式 |
| `index.html` | 引入两个新脚本 |

## 管理员新页面：赛事设置

`我的 → 管理后台 → 赛事设置`，可改：

- 赛事名称、副标题
- 赛事日期、报名截止（`datetime-local`，按本地时区）
- 关门时间、起点名称、终点名称
- 赛事状态（6 种：筹备中 / 报名进行中 / 报名已截止 / 比赛进行中 / 赛事已结束 / 已归档）
- 报名开关
- 赛事须知（一行一条，学生端按顺序显示）
- 学院列表（增删标签，实时显示数量）

保存时前端校验「报名截止不能晚于赛事日期」，服务端再校验状态枚举、日期可解析、
学院列表非空。保存后立刻 `EventStore.refresh(true)`，学生端刷新即见新配置。

## 验证结果

```
【后端】53 项冒烟测试通过（原 38 项 + 新增 15 项）

【新增测试覆盖】
  ✓ 配置接口可访问 / 返回学院列表 / 返回组别配置 / 返回状态文案 / 返回报名开关
  ✓ 非法状态被拒绝
  ✓ 非法日期被拒绝
  ✓ 空学院列表被拒绝
  ✓ 更新赛事配置
  ✓ 截止时间已生效
  ✓ 学院列表已生效
  ✓ 须知已生效
  ✓ 关闭报名后拒绝新报名（REG_CLOSED）
  ✓ 配置已恢复
  ✓ 未登录不能改赛事配置

【浏览器实测 · 真实提交】
  ✓ 首页日期/截止/起点/关门时间来自数据库
  ✓ 学院下拉 14 项，组别 3 个，同心组队友学院同步
  ✓ 填表提交成功，跳转签到页
  ✓ 后台改截止时间 + 新增学院 → 保存 → 学生端新会话立即读到新值
  ✓ 控制台零报错

【多尺寸回归】
  375×667 / 390×844 / 412×915 / 768×1024 / 1920×1080
  全部无横向滚动、无元素溢出
```

## 仍未做

| 项 | 说明 |
|---|---|
| 组别增删 UI | 后端 `PUT /api/event` 已支持 `groups`，管理页暂未做编辑器（改动频率低） |
| 多赛事并存 | `events.code` 已支持多行，前端仍固定请求 `qzsf-2025` |
| 配置变更推送 | 目前靠页面刷新；要做实时需 WebSocket（第六阶段） |
| 学院排序 | 按保存顺序显示，暂不支持拖拽排序 |
