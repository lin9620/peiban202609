# 🐾 Warm Paws · 暖爪

一个面向海外用户的**温馨治愈系网站**：每日暖心故事、手绘食物喂养的宠物伙伴、温柔的社区墙。

技术栈：**Vite + Vue 3 + Naive UI**（前端）· **Lottie**（宠物动画）· **Supabase**（登录/数据/图片，第二批接入）· Vercel（托管）。

## ✨ 功能

### 🐾 宠物乐园（v2 重点）
- **5 种预设伙伴**：小橘猫 / 柴柴 / 麻薯兔 / 小恐龙 / 水獭，全部是 **Lottie 矢量动画**（呼吸 / 眨眼 / 摇尾 / 抖耳朵；睡觉自动切到闭眼慢呼吸变体）
  - 动画不依赖外部素材：`src/utils/lottiePet.js` 在运行时按声明式图层规格生成合法 Lottie JSON，体积小、风格统一、无版权风险
  - 想换成美术给的 `.json` 素材：登记进 `src/data/lottieAssets.js` 即可自动优先使用，无需改组件
  - 初始赠送小橘猫，其余用金币 + 等级解锁（Lv.2 💰200 → Lv.7 💰800），养成有目标
  - 每只**独立养成**：独立名字、四维状态、等级经验；多只同养时非当前宠物衰减减半
- ⭐ **上传自己的二次元角色当宠物**：上传立绘（前端自动压缩）→ 通用"活化"动效（呼吸浮动 / 点击摸头冒爱心 / 状态气泡 / 说话气泡）
- **4 种性格**：温柔 🌷 / 元气 ⚡ / 高冷 🖤 / 粘人 🫂
  - 每种性格有**全套双语台词库**（问候/饿了/困了/脏了/低落/玩耍/抚摸/洗澡/睡前/升级…），说话语气完全不同
  - 自定义角色还可填 3 句专属台词，混进日常台词池
- **四维养成**：饱食 / 心情 / 清洁 / 精力，实时衰减 + 离线结算（回来算清这段时间的变化）
- ⭐ **手绘食物画板**：画笔 / 橡皮 / 撤销 / 8 色配色盘，5 种样品线稿可描摹（猫粮碗 / 小鱼干 / 罐头 / 布丁 / 爱心饼干）
- **用心度系统**：笔画数、颜色丰富度、线条长度 → 决定喂养效果，越用心吃得越开心
- **每日温柔任务**：喂一份亲手画的食物 / 记心情 / 画一道新料理 / 陪它玩一次 → 一键领取金币
-  **零食雨小游戏**：宠物张嘴接从天而降的食物，鼠标左右移动或按 ← → 键跑动；**你亲手画的料理也会掉下来，分数翻倍**。一局 45 秒，漏 8 个或时间到即结算成金币 / 饱食 / 心情 / 经验，最高分本地保存
- 可给宠物起名、切换当前伙伴、查看每只的等级

### 🏠 首页
- 每日暖心故事 + 治愈语录（内置 14 天双语内容，按日期自动轮换）
- **此刻陪你大厅**：挂"工作中 / 学习里 / 睡不着 / 随便待着"状态（**不展示虚构在线人数** —— 数字不是实时数据时容易误导用户）
- **每日心情打卡**：心情记录 + 温柔连续天数，打卡还会让宠物心情变好
- **每日一问**：每天一个温柔的小问题
- **分享卡片**：一键生成"今日语录 + 宠物"精美卡片下载分享

### 💛 暖心墙
留言 + 发图（自动压缩），用 **抱抱🫂 / 暖暖☀️ / 同感🤝** 代替点赞（每种回应每人限一次）
- **每条帖子都有评论区**：可回复 / 删除自己的评论，示范评论只在首次访问注入一次（删了就不会复活）
- 评论逻辑抽成纯函数模块 `src/utils/comments.js`（注入幂等 / 200 字截断 / 权限校验 / 脏数据兜底）
- **排序**：默认「最新」，另有「同感最多 / 抱抱最多 / 暖暖最多」（票数相同按时间倒序，选择持久化）→ `src/utils/wallRules.js`
- **时间范围**：默认「近两天」，另有「近 7 天 / 这个月」（按 UTC 判，选择持久化；示例帖不参与筛选，示范内容永远在）
- **每人每天最多一条**：前端即时提示 + 数据库触发器兜底（`wall_daily_limit`，UTC 日）；删掉今天那条可以重发
- **浏览次数**：同一访客对同一条帖一天只算一次（登录用户按 uid、游客按本机匿名 id），服务端 `wall_post_views` 再去重一次，刷新页面刷不高
- **厌恶 🙁 与自动下架**：登录后可点「不喜欢」；当 **厌恶数 ÷ 浏览数 ≥ 1%** 时帖子自动**下架**（数据库**假删除**：`removed = true`，数据仍在库里，前台不再展示，不再自动恢复以免忽隐忽现）
- **可选云端模式**：连接 Supabase 后帖子 / 评论 / 回应真·多人共享，图片上传 Storage，邮箱注册登录；未配置时自动降级本地模式（见下方配置章节）
- **用户主页 `/u/:id`**：点帖子头像 / 昵称进入（匿名也能看）。展示昵称、加入时间、TA 的帖子与收到的回应；**TA 的伙伴**——云端镜像的宠物（登录后自动同步，含形象 / 性格 / 等级），**访客可以摸摸头、投喂**，互动真实计入 TA 的亲密度 / 饱食度（RPC 计费，非本地演出）；**TA 的手绘厨房**——TA 画的食物墙，点菜即投喂。立绘与菜图都存在 Storage，云端快照里只留路径（主人每次同步只写几百字节，不再写 MB 级 JSON）

### 👤 我的
访客昵称 / 我的食谱管理 / 近 30 天心情日历

### 🌐 双语与视觉
- 英文为主，右上角一键切换中文；新增语言只需加一个语言块
- **5 套 UI 主题**（右上角 🎨 下拉切换，选择持久化）：奶油橘 / 樱花粉 / 薄荷森林 / 薰衣草紫 / 星夜蓝（深色，Naive UI darkTheme 联动）→ `src/data/themes.js`
- **两侧玩法栏**（宽屏显示）：左侧宠物速养面板（摸头 / 投喂 / 呼吸放松练习），右侧小道具体验 → `src/components/SideRails.vue`
- 设计系统：暖色奶油渐变背景 + 光斑装饰 + 毛玻璃卡片 + 多层阴影 + 页面切换过渡
- UI 组件库 **Naive UI**，主题在 `src/theme.js` 定制（品牌橙 #FF9F5A、圆角胶囊按钮、毛玻璃输入框）
- 四个页面全部重做为现代治愈风版式：首页（宠物主视觉 hero + 双栏语录/故事）、宠物乐园（舞台 + 侧栏）、暖心墙（杂志式动态流）、我的（头像卡 + 数据统计 + 心情热力格）
- 字体：Quicksand（英文圆润）+ 霞鹜文楷（中文手写温度感）
- **可被搜索到**：robots + 站点地图（构建时自动刷新 lastmod）+ canonical/OG 分享卡 + 真实 PNG 图标 + JSON-LD 结构化数据（见「收录与站点地图」章节）

## 🚀 本地运行

```
双击 dev.cmd   → 开发模式（自动打开浏览器，http://localhost:5173）
双击 build.cmd → 生产构建（输出到 dist/）
```

## 🧪 测试与静态检查

```bash
node tools/comment-test.mjs   # 评论系统纯函数单测（26 项：二级回复/parentId 封顶/级联删除/评论数兜底）
node tools/wall-test.mjs      # 暖心墙云端数据层纯函数单测（34 项：行映射/二级字段/评论数聚合/浏览与厌恶字段）
node tools/wall-rules-test.mjs # 暖心墙进阶规则纯函数单测（29 项：排序/时间范围/浏览去重/1% 下架/每日一条/错误归类）
node tools/pet-home-test.mjs   # 宠物主页云层纯函数单测（19 项：宠物快照 / 手绘厨房清洗 / 互动计数独立列 / 图片引用外置与行体积安全阀 / 镜像队列安全性）
node tools/api-contract-test.mjs # 云端数据访问适配层契约测试（36 项：表名 / 过滤 / 排序 / RPC 参数 / Storage 桶与路径 / 降级查询形状 / upsert 只写 user_id+data+updated_at 的计数红线）
node tools/gateway-contract-test.mjs # 网关模式前端侧契约测试（30 项：/api/* 端点形状 / 鉴权头 / 计数红线 / 错误上抛）
node tools/worker-test.mjs    # API 网关 Worker 契约测试（53 项：/api/* → Supabase REST 翻译形状 / JWT 透传 / PGRST116→null / 路径穿越防护）
node tools/i18n-test.mjs      # 文案完整性与插值回归（19 项：en/zh 键集合对称、修复过的 key、$ 特殊字符）
node tools/snack-test.mjs     # 零食雨游戏纯逻辑单测（20 项：难度曲线/生成/碰撞/结算上限）
node tools/seo-test.mjs       # SEO 资产检查（35 项：robots/sitemap/OG 标签/PNG 尺寸/安全头/产物）
node tools/image-fit.mjs       # 图片纯函数单测（20 项：尺寸缩放/形状体检/文件预检/dataURL 校验）
node tools/undef-check.mjs    # 静态检查「用了项目内导出符号但没导入」（白屏元凶），报告写 undef-report.txt
node tools/arity-test.mjs     # 静态检查「模板/同文件自调用 参数个数 < 函数签名必填参数」（undefined 崩溃元凶）
node tools/cloud-verify.mjs   # Supabase 连通性：Auth/四张表/Storage桶/RLS（需先配好 .env）
node tools/cloud-e2e.mjs      # 云端全链路实测：注册→建档→发帖→评论→二级回复(层级/级联/计数)→回应→权限→浏览去重→厌恶下架→每日一条→清理（会造测试数据并清理）
node tools/smoke.mjs          # 模块冒烟：需 dev 服务器在跑，探测 30 个关键模块 + 5 个 SEO 静态文件
node tools/live-check.mjs     # 线上部署验证：页面/缓存/安全头/SEO 资产（部署后跑，应输出 LIVE ALL PASS）
node tools/online-check.mjs   # 旧版线上检查（已被 live-check 替代，如无特别需要可忽略）
node tools/mood-test.mjs      # 心情打卡纯逻辑单测（12 项：连续天数/死循环回归）
node tools/make-og.mjs        # 重新生成分享图与图标到 public/（改了品牌色或文案后可跑）
node tools/uifix-test.mjs     # 修复项回归（20 项：评论字数上限/立绘上传校验/大厅文案/安全头/图片纯函数）
node tools/restart-dev.cmd    # 重启 dev 服务器（改了 .env 后用：Vite 只在启动时读环境变量）
```

## 🧩 新增语言（零成本扩展）

两步即可新增日语/西语/韩语等：
1. `src/i18n.js` 的 `messages` 里加一个语言块（key 与英文块一致）
2. 同文件顶部 `languages` 数组加一行 `{ code: "ja", label: "日本語" }`

每日故事/语录在 `src/data/stories.js`，同样是 `en/zh` 并列字段，加语言并列加字段即可。

## ☁️ Supabase 配置（云端暖心墙 + 登录）

云端功能是**可选的**：不配置时网站完全以本地模式运行（行为与单机版一致）。

**① 建库**：注册 [supabase.com](https://supabase.com) → New Project（免费）→ 左侧 **SQL Editor** → 粘贴 `SUPABASE_SETUP.sql` 全部内容 → Run。这会创建：
- `profiles`（注册自动建档）· `wall_posts`（含 `views` 浏览数 / `dislikes` 厌恶数 / `removed` 假删除 / `created_day` 每日限额）· `wall_comments`（二级评论：`parent_id` 自关联 + `reply_to_name`）· `wall_reactions`（回应，`kind` 含 `dislike`）· `wall_post_views`（浏览去重，全套 RLS 策略）· `pet_profiles`（宠物主页镜像：`data` 只放展示快照 + `pats`/`feeds` 互动计数**独立列**）· `pet_interactions`（互动去重，每人每天每种一次）
- 函数与触发器：`wall_daily_limit()`（每人每天一条）· `wall_add_view()` · `wall_toggle_dislike()`（含 1% 自动下架）
- Storage 桶 `wall-images`（公开读、登录上传、只能改删自己路径；**帖子配图与宠物立绘 / 手绘菜图共用此桶**——宠物图放 `<uid>/pet-<hash>.<ext>`，云端快照里只留路径、不留 dataURL，一行只有几百字节）

> **已经建过库的老用户**：按顺序跑两个增量迁移（都在 SQL Editor 里粘贴全部内容 → Run，幂等、可重复跑）：
> 1. `MIGRATION_two_level_comments.sql` —— 评论改成二级结构（旧评论不用回填，会当一级评论正常显示）
> 2. `MIGRATION_wall_daily_view_dislike.sql` —— 每日一条 + 浏览数 + 厌恶与 1% 自动下架
>
> 没跑第 2 个时：查看看板、发帖、评论一切照旧（浏览数不显示、点厌恶会出现「这个功能还没开启」提示），不会报错白屏。

**② 配置密钥**（二选一，anon key 是公开密钥，安全由 RLS 保证）：
- 左侧 **Settings → API** 复制 `Project URL` 和 `anon public key`，然后：
- 方式 A：项目根目录新建 `.env`：
  ```
  VITE_SUPABASE_URL=https://xxxx.supabase.co
  VITE_SUPABASE_ANON_KEY=eyJhbGci...
  ```
- 方式 B：新建 `public/supabase.json`（开发时放根目录的 supabase.json 也能被识别）：
  ```json
  { "url": "https://xxxx.supabase.co", "anonKey": "eyJhbGci..." }
  ```

**③ 生效**：重启 `dev.cmd`。右上角会出现 👤 登录入口（「我的」页有邮箱注册/登录表单）；暖心墙自动切换为云端模式——发帖、评论、回应真·多人共享，图片上传到 Storage。想退回本地模式，删掉配置文件即可。

> 说明：新注册用户需到邮箱确认验证邮件（Supabase 默认开启）。若要关闭验证：Dashboard → Authentication → Providers → Email → Confirm email 关闭。

**④ 可选：API 网关模式（默认关，不影响任何现有功能）**：前端数据请求默认**直连** Supabase。想改为走自托管网关：先把 Worker 侧密钥配好（`npx wrangler secret put SUPABASE_URL`、`npx wrangler secret put SUPABASE_ANON_KEY`；本地联调写进根目录 `.dev.vars` 再 `npm run dev:api`），然后以 `VITE_API_GATEWAY=1` 构建/启动前端。此时数据请求全部走同源 `/api/*`，由 `worker/api.js`（Cloudflare Worker，与静态资源同一 Worker 部署）把具名端点**纯翻译**到 Supabase REST/Storage：用户 JWT 原样透传、RLS 照旧由数据库执行、Worker 不解析 token、也不是开放代理（每个端点只指向固定表/RPC/桶，图片路径按 `<uid>/<file>` 白名单校验）；Auth 仍直连 Supabase。数据层实现可切换：`src/utils/api/db.js` 是选择器（默认 `db.supabase.js` 直连，置 1 时 `db.gateway.js` 走网关），契约由三套测试锁形（直连 36 / 网关前端侧 30 / Worker 侧 53 项）——阶段 3 换 Hyperdrive/D1/R2 时只重写 Worker 内部与适配实现，端点契约与页面零改动。

## 🔍 收录与站点地图（Google Search Console）

**站点侧已备好的东西**（`node tools/seo-test.mjs` 全部 26 项校验通过）：

| 文件 / 标签 | 作用 |
|---|---|
| `public/robots.txt` | 允许全站抓取，并声明站点地图地址 |
| `public/sitemap.xml` | 站点地图；**构建时由 `vite.config.js` 的 `seo-sitemap` 插件自动把 `lastmod` 刷成当天**，不会给搜索引擎提交陈旧日期 |
| `public/og-image.png` | 1200×630 分享卡（微信/QQ/Discord/X 分享出去有图） |
| `public/favicon.png` · `apple-touch-icon.png` | 浏览器标签页图标 / iOS 主屏图标（真实 PNG，搜索结果里也能显示） |
| `index.html` | canonical、description、robots、theme-color、Open Graph、Twitter 大卡、JSON-LD 结构化数据、`noscript` 兜底文案 |

> 上面三张图由 `node tools/make-og.mjs` 生成（纯 Node、零依赖，手写 PNG 编码器画出品牌爪印）。改了品牌色或文案后重跑即可，产物直接覆盖 `public/`。

**Search Console 验证（域名属性走 DNS TXT）**

1. [search.google.com/search-console](https://search.google.com/search-console) → 添加资源 → 选 **域名** → 填 `dale.de5.net`
2. 复制它给的 `google-site-verification=...` 整串
3. 加 TXT 记录：**Cloudflare → DNS → 记录 → 添加记录**，类型 `TXT`、名称 `@`、内容粘贴整串、TTL `Auto`、保存
   - `dale.de5.net` 的解析已委派给 Cloudflare（NS 是 `tori/cesar.ns.cloudflare.com`），所以记录必须加在 **Cloudflare**；dnshe 那边只需保留 `de5.net` 里指向 Cloudflare 的 NS 委派
4. 回 Search Console 点 **验证**（一般 1~10 分钟通过）
5. 验证通过后 → **站点地图** → 提交 `sitemap.xml`（完整地址 `https://dale.de5.net/sitemap.xml`）

**几个要点**

- 路由是 hash 模式：`/#/pet` 与 `/` 对爬虫属于同一 URL，所以站点地图**只登记根地址**（列 hash 地址会被判重复内容）
- 校验通过的 TXT 记录**不要删**，Google 会定期复查，删了属性会掉
- 想加速收录：验证后在「网址检查」里输入首页 → 请求编入索引；再把站点分享到几个地方被链接到，外链是最有效的加速器
- 部署后可用 `node tools/online-check.mjs` 一次性验证线上：HTTPS、页面、资源、云端配置、**SEO 资产是否都能取到**

**提交站点地图没反应？按这个顺序排查**

1. **先确认资源已验证**：Search Console 顶部若还有「验证所有权」提示，站点地图是**提交不了**的（往往表现为点了没反应）。域名属性走 DNS TXT，点「验证」即可
2. **TXT 记录的 zone 要对**：必须加在 `dale.de5.net`（Cloudflare），不是 `de5.net`（dnshe）。自检命令：`nslookup -type=TXT dale.de5.net 8.8.8.8`，应看到 `google-site-verification=...`
3. **填完整地址更保险**：`https://dale.de5.net/sitemap.xml`（只填 `sitemap.xml` 也可以，前提是资源为域名属性）
4. **提交后显示「待处理」是正常的**：首次抓取可能几小时；若显示「无法获取」，等几分钟再点一次提交（部署刚生效/CDN 缓存滞后时常见）
5. **别期待立刻收录**：站点地图只是「告知有这些页面」，不等于收录。新域名通常要几天到几周，最有效的加速是 **「网址检查」→ 请求编入索引** + 让别处链接到你的站
6. **一键体检**：`node tools/online-check.mjs` 会**模拟 Googlebot 抓取**，确认没被 Cloudflare 拦截、没有 `noindex` 头、robots 与 sitemap 都能取到、伪路径返回真 404（共 21 项）

> 注意 Cloudflare 会在 `robots.txt` 顶部自动注入一段「AI 内容信号」声明（`Content-Signal: search=yes,ai-train=no`，并屏蔽 GPTBot / ClaudeBot / Google-Extended 等）。**这不影响 Google 搜索收录**（Google-Extended 只管 AI 训练），你自己的 `Allow: /` 与 `Sitemap:` 行会被完整保留。

**提交成功长什么样（正常状态，不用再折腾）**

| 字段 | 正常显示 | 说明 |
|---|---|---|
| 状态 | **成功** | Google 已成功抓取并解析该文件 |
| 已提交的网址数 | **1** | hash 路由（`/#/pet`）与根地址同属一个 URL，所以只登记 1 条是正确的 |
| 已发现的网页 | **1** | 同上；不是"只收录了 1 页"，收录进度看左侧 **「网页 / 页面」** 报告 |
| 上次读取时间 | 今天 | 说明 Google 刚来过 |

> 看到「成功 / 1 / 1」就代表站点地图这条链路完全通了。**接下来做两件事**：① **「网址检查」→ 输入 `https://dale.de5.net/` → 请求编入索引**（主动催抓，比等站点地图快）；② 在 **「网页」报告**里等状态从「已发现 - 尚未编入索引」变成「已编入索引」（新站通常几天到几周，有外链会明显更快）。

**「请求编入索引」弹「出了点问题，请稍后重试」怎么办？**

这是 Search Console 自己的提示，**几乎总是 Google 侧的限流或临时抖动，与网站无关**。对照排查：

| 可能原因 | 说明 | 处理 |
|---|---|---|
| 提交配额用完 | Google 未公布确切数值，社区实测同一资源**每天约十余条**；超了就报这个错 | 隔天再试，只对最重要的 URL 请求 |
| 同一 URL 冷却中 | 同一个网址短时间内重复请求会被拒 | 等十几分钟到数小时再点 |
| Google 服务临时抖动 | 该报错在社区长期存在，属于非确定性故障 | 换时间、换浏览器或换 Google 账号重试 |

**不一定非要靠这个按钮**，三条替代路径同样有效（而且更"自然"）：

1. **「测试实际网址」**（同一页面里）→ 能正常抓取并显示「网址可用于 Google 搜索」，说明站点一切就绪，剩下只是时间问题
2. **放一条外部链接**（GitHub 仓库主页 / 社交平台简介 / 论坛签名）指向 `https://dale.de5.net/` → Google 依靠外链自然发现新站，这是**新站最有效的加速方式**
3. **等站点地图的下次抓取** —— 它已提交成功，Google 会按 `changefreq` 定期重抓；也可以再回站点地图页点一次「提交」（这不是索引请求，不受配额影响）

> 若「网址检查」详情里出现「无法显示在 Google 搜索结果中」，那是**未收录时的常规文案**，重点看它下面的 **「发现方式 / 抓取情况 / 收录情况」** 三行：<br>
> `已发现 - 尚未编入索引` → 正常，等（新站常态）· `已抓取 - 尚未编入索引` → 正常，等（Google 认为内容暂不值得收录，等外链积累）· 若出现 `robots.txt 屏蔽` / `noindex` / `备用网页（有规范标签）` → 才是真问题（本站已用 `node tools/online-check.mjs` 排除这三项）。

## 🌐 部署（Cloudflare Workers · 已上线 https://dale.de5.net）

```bash
npm run build    # 构建出 dist/（改完代码随手跑，验证能编译）
npm run deploy   # wrangler deploy 发布到 Worker warm-paws（dale.de5.net）
```

> ⚠️ **发布策略：攒着发，不随手发。** 改 bug / 加功能时**只做本地验证**（`npm run build` + 相关 `tools/*-test.mjs`），**不要每改一处就 `npm run deploy`**；等确认「可以部署了」再一次性发布，省掉无谓的构建与 CDN 版本堆积。同理，也不要擅自 `git push`。

1. 发布就是上面两条命令（`package.json` 的 `build` / `deploy` 脚本，配置见 `wrangler.jsonc`：Worker 名 `warm-paws`，静态资源目录 `./dist`，SPA 回退已配好）。
2. Supabase 后台 → **Authentication → URL Configuration**：Site URL 填 `https://dale.de5.net`，Redirect URLs 加 `https://dale.de5.net/**` 与 `http://localhost:5173/**`
3. 部署后验证：`node tools/live-check.mjs`（页面 / 缓存 / 安全头 / SEO 资产，应输出 `LIVE ALL PASS`）。

> 路由已是 **history 模式**（`/pet`、`/community`、`/profile` 可直接访问与分享），构建时会为每条路由产出独立静态 HTML（含各自的 title / canonical / OG）；SPA 回退由 `wrangler.jsonc` 的 `not_found_handling` 兜底。部署后可用 `node tools/live-check.mjs` 验证线上站点（页面 / 缓存 / 安全头 / SEO 资产）。
> 备选方案：推 GitHub → Vercel 导入（根目录 vercel.json 已配好 rewrites），环境变量在 Vercel 项目 Settings 里配 `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`。

## 📁 结构

```
src/
  main.js / App.vue / router.js / i18n.js / style.css / theme.js
  data/
    stories.js         每日内容库（故事 / 语录 / 每日一问）
    pets.js            SPECIES 物种 / PERSONALITIES 性格 / LINES 台词库
    lottieAssets.js    真实 Lottie 素材登记表（放入 .json 即优先使用）
  utils/
    daily.js           按日期轮换工具
    lottiePet.js       Lottie 动画工厂（运行时生成 5 种宠物的矢量动画）
    snackGame.js       零食雨游戏纯逻辑（坐标系 0~1、随机源可注入 → Node 可单测）
    wall.js            暖心墙云端数据层（行映射 / 上传 / 浏览 / 厌恶 / 评论计数 / 宠物主页镜像与互动）
    wallRules.js       暖心墙进阶规则纯逻辑（排序 / 时间范围 / 浏览去重 / 1% 下架 / 每日一条）
  stores/petStore.js   宠物状态机（多宠物 / 养成 / 食谱 / 任务 / 心情打卡；登录后自动把宠物+菜谱镜像到云端，主页可见）
  components/
    LottiePet.vue      Lottie 渲染器（预设宠物动画）
    PetMotion.vue      动效层（跳跃 / 睡眠 + 自定义立绘活化）
    FoodPainter.vue    手绘食物画板
    SnackRain.vue      零食雨小游戏（鼠标/键盘操作 + 结算面板）
    ShareCard.vue      分享卡片生成
  views/               Home / Pet（宠物乐园）/ Community / Waller（用户主页 /u/:id）/ Profile
public/                robots.txt · sitemap.xml · og-image.png · favicon.png · apple-touch-icon.png · _headers（安全头 + 资产长缓存）
```

> 宠物动画：**预设 5 种宠物用 Lottie**（`utils/lottiePet.js` 在运行时生成矢量 JSON 交给 lottie-web 播放，因此不依赖任何外部素材文件、可离线、可缩放不糊）。
> 想换成设计师给的 Lottie 素材：把 `.json` 放到 `src/assets/lottie/<物种>.json` 并在 `data/lottieAssets.js` 里登记，组件会优先使用真实素材。
> **自定义二次元立绘**走另一条路：上传图片后用 CSS 活化（呼吸浮动 / 摸头摆动 / 睡眠变暗），与 Lottie 体系并存。

## 🩹 修复记录（体验审计 · 两轮）

| 级别 | 问题 | 处理 | 落地位置 |
|---|---|---|---|
| P1 | 社区反应拉全站前 2000 条，用户增长后漏算 | 只查当前页 30 帖的回应 | `utils/wall.js` |
| P1 | 上传图片无体积/像素上限，极窄长图撑爆 Canvas | 5 MB 上限 + 宽高比 ≤ 12 + ≤ 30 MP + 最长边 900px | `utils/imaging.js` |
| P1 | 未登录访客看不到云端帖子 | 匿名只读（写入仍要登录，RLS 兜底） | `utils/wall.js` |
| P1 | 自定义立绘上传同样无校验（还会撑爆 localStorage） | 复用 imaging 管线，压到 480px PNG 保透明 | `views/PetView.vue` |
| P2 | 评论 200 字上限但输入框无计数/硬限制 | `:maxlength` 硬限制 + 剩余字数 + 达上限提示（双语） | `views/CommunityView.vue` |
| P2 | 评论展开后永久缓存，新评论不出现 | 30s TTL，超时重拉 | `views/CommunityView.vue` |
| P2 | 所有资源 `max-age=0, must-revalidate` | `/assets/*` 一年 immutable，HTML 保持短缓存 | `public/_headers` |
| P2 | 缺常见安全响应头 | 补 CSP + HSTS（原有 nosniff / Referrer-Policy / X-Frame-Options / Permissions-Policy 保留） | `public/_headers` |
| 体验 | `#/` 路由直接访问 `/pet` 会 404 | 迁移到 history 模式 + 每条路由独立静态 HTML + SPA 回退 | `router.js` / `vite.config.js` / `wrangler.jsonc` |
| 体验 | 「在线陪伴数」是本地随机数，易误导 | 去掉虚构人数，改如实文案（路线图保留"等有真实统计再接"） | `views/HomeView.vue` / `i18n.js` |

回归验证（全部本地可跑）：`wall-rules-test` 29 项 · `comment-test` 26 项 · `wall-test` 33 项 · `pet-home-test` 10 项 · `uifix-test` 20 项 · `image-fit` 20 项 · `snack-test` 20 项 · `mood-test` 12 项 · `i18n-test` 19 项 · `arity-test` 8 项 · `seo-test` 35 项 · `undef-check`。

## 🗺️ 路线图

- ✅ **已完成**：Supabase 云端暖心墙（邮箱注册登录 + 多人发帖 / 评论 / 回应 + 图片上传 Storage）+ 上线 Cloudflare Pages
- ✅ **已完成**： 零食雨小游戏（手绘料理掉落 + 分数结算成养成资源 + 本地最高分）
- ✅ **已完成**： SEO 收录优化（robots / 站点地图 + 搜索框收录 + 分享卡与图标 + 结构化数据）
- ✅ **已完成**：暖心墙进阶——每人每天一条、排序（最新/同感/抱抱/暖暖）、时间范围（近两天/近7天/这个月）、浏览计数、厌恶达 1% 自动下架（假删除）
- ✅ **已完成**：用户主页 `/u/:id`——点帖子头像/昵称进入；展示宠物（云端镜像，访客可摸摸头/投喂，互动计入 TA 的亲密度/饱食度）、TA 的手绘厨房（点菜投喂）、TA 的帖子与收到的回应
- ✅ **已完成**：宠物图外置 + 互动计数独立列——立绘 / 手绘菜图进 Storage（`wall-images/<uid>/pet-<hash>.<ext>`，按内容哈希命名、重复上传即覆盖），`pet_profiles` 的互动计数改用独立列 `pats`/`feeds`：修掉「主人同步把访客计数清零」，并把单行数据从 MB 级降到几百字节（解掉将来迁库时单行 2MB 的硬限制）
- ✅ **已完成**：数据访问适配层——`wall.js` 里所有云端调用（查询 / RPC / Storage）收口到 `src/utils/api/db.js` 一个文件（行为不变），附 `api-contract-test.mjs` 契约测试锁定调用形状；将来换库 / 换托管（Cloudflare Hyperdrive、D1 或自建 API）只改适配层，页面与业务逻辑零改动
- ✅ **已完成**：API 网关骨架（阶段 2）——Cloudflare Worker 同时托管静态资源与同源 `/api/*` 具名端点（**纯翻译层**：Supabase REST/Storage，用户 JWT 原样透传、RLS 仍由数据库执行、不解析 token、非开放代理、图片路径白名单防穿越）；前端数据层变成可切换实现（默认直连，`VITE_API_GATEWAY=1` 走网关），Auth 仍直连。三套契约测试锁形（api 36 / gateway 30 / worker 53 项）——阶段 3（Hyperdrive / D1 / R2）只换 Worker 内部与适配实现，端点契约不动
- ✅ **已完成**：墙上的主页（/u/:id）——点帖子头像/昵称进入，看 TA 的帖子、加入时间与收到的抱抱/暖暖/同感
- 每日一问接入真实数据、陪你大厅接入真实在线人数（**当前刻意不显示人数**，等有真实统计再接）
- 宠物冒险（带回手绘明信片图鉴）、装扮系统、季节彩蛋
- 🏅 成就徽章：连续打卡 / 养成等级 / 评论互动解锁勋章墙
- 手绘画作上墙、温暖信箱（树洞回信）
- Google 一键登录、云端宠物存档多设备同步
