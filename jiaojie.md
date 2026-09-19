# jiaojie.md — 项目交接与进度记录

> **维护约定（必读）**：每完成一段任务（一轮改动提交/部署后），必须更新本文件的
> 「当前状态速览 / 正在做 / 已完成 / 未完成 / 现存问题 / 下一步」各节，并把这轮新踩的坑补进「踩坑录」。
> 本文件是唯一权威进度记录：口头说"做完了"不算数，以这里的证据（提交号/测试/探针结果）为准。

## ⓪ 长期固定规则（先读这里 —— 除非用户明说，否则永不违反）

### 0.1 技术栈与环境
- **框架**：Vue 3（Composition API）+ Vite 5 + Vue Router（history 模式）+ Naive UI 2 + @iconify/vue + lottie-web + @supabase/supabase-js。
- **部署**：Cloudflare Pages（前端，`dist/`）+ Cloudflare Worker（API 网关，`worker/api.js`，wrangler 部署）；站点 https://dale.de5.net；Worker 项目名 `warm-paws`；SPA 回退 `not_found_handling: "single-page-application"`（所以未知路径返回 200 是**有意设计**，别当 bug 修）。
- **数据库**：Supabase（Postgres）——RLS 行级安全 + `security definer` RPC 做服务端权威逻辑；**anon key 是公开密钥，安全全靠 RLS，前端不得存敏感判断**。
- **`.env` 键**：只有 `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` 两个；`.env`、`supabase.json`、`.dev.vars` 绝不提交（已在 .gitignore）。

### 0.2 数据层双模式（最重要的架构约束）
- 前端永远经由 `src/utils/api/db.js` 的统一 `db` 接口取数，底层两种实现**必须同步改**：
  - `db.supabase.js`（直连模式，本地 dev）
  - `db.gateway.js`（网关模式，走 `/api/*` → `worker/api.js` → Supabase REST —— **线上用它**）
- **规则：给任一模式加方法时，另一个模式同轮加齐**；`worker/api.js` 的路由白名单与 `gateway-contract-test` / `worker-test` 契约测试同轮更新。
- 服务端权威逻辑（计数、去重、解锁、限额）写进 **SQL RPC（security definer）**，不写在 Worker 或前端；错误用 `raise exception '错误码'`，前端经 `sendErrKey`/`errorKind` 映射成 i18n 提示。

### 0.3 常用命令
```bash
npm run dev            # 前端开发
npm run dev:api        # 本地 Worker
node node_modules/vite/bin/vite.js build   # 生产构建（比 npm run build 更容易拿到明确退出码）
npx wrangler deploy    # 部署 Worker + 静态资产
git -c http.proxy= -c https.proxy= -c http.version=HTTP/1.1 push   # push（本机网络需要这些参数）
node tools/<x>-test.mjs # 24 套离线测试（提交前全跑）
node tools/undef-check.mjs  # 未导入符号检查（白屏元凶，必跑）
node tools/live-check.mjs   # 部署后线上验证，应输出 LIVE ALL PASS (13)
node tools/cloud-e2e.mjs / dm-e2e.mjs / status-e2e.mjs / nick-e2e.mjs / bottle-e2e.mjs / img-cache-e2e.mjs  # 线上端到端（自造 wp-* 测试账号并清理）
```

### 0.4 目录与文件红线
| 路径 | 规则 |
|---|---|
| `MIGRATION_*.sql` | 只增不改历史语义；必须**幂等**；同步进 `SUPABASE_SETUP.sql`；执行权在用户（我没有 SQL Editor 权限） |
| `SUPABASE_SETUP.sql` | 新装库的完整真相源，与所有迁移保持同步 |
| `.env` / `supabase.json` / `.dev.vars` | 私密配置，永不提交 |
| `dist/` / `.wrangler/` / `.edge-final/` | 构建产物，不手改不提交 |
| `src/utils/api/db.supabase.js` 与 `db.gateway.js` | 成对修改，见 0.2 |
| `src/i18n.js` | 加键必须 zh/en **成对**；emoji 写在文案里；i18n-test 查对称 |
| `worker/api.js` | 路由白名单风格；不透传任意 select；只透传 JWT |
| `tools/_*` | 临时探针/脚本，用完即删（.gitignore 已盖，但别留垃圾） |

### 0.5 代码规范
- 中文注释，注释写"为什么"而非"是什么"；区块用 `/* ═══ xxx ═══ */` 分隔。
- Vue SFC：`<script setup>`；store 用 `src/stores/`（petStore/uiStore）；纯函数规则层放 `src/utils/*Rules.js` / `statuses.js` 等，**可测的逻辑不写进组件**。
- 状态 key 类常量（如 `STATUS_KEYS`、`VALID_STATUS`）前后端**同源对齐**，改一处必查另一处。
- 样式统一走 `src/style.css` 的 CSS 变量（`--ink`/`--accent`/`--glass` 等），不硬编码颜色；主题（皮肤）经 `uiStore` 切换。
- 时间窗口类展示（状态/记录）用 `STATUS_WINDOW_MS` 风格常量 + 查询侧 since 过滤。

### 0.6 提交与交付要求（强制流程）
1. 改动 → 全量 24 套离线测试 → `undef-check` → `vite build`（明确退出码）→ `git diff --check`。
2. 一轮一个主题的 commit（如"第 13-22 条：…"）；跨条目发现的 bug 单独小提交。
3. commit 后 `npx wrangler deploy` → push → `node tools/live-check.mjs` → 线上产物 SHA 与本地 dist 比对。
4. 有新迁移：列出文件名请用户在 Supabase SQL Editor 执行，再用探针确认（区分 `42501` 存在无权 vs `PGRST202` 不存在）。
5. **验收口径三層，不混说**：离线单测 ≠ 接口契约 ≠ 线上端到端 ≠ 实机交互。构建通过不算完成；迁移未执行必须明说。
6. **交付后更新本文件**（速览/已完成/未完成/踩坑录）。
7. 线上 e2e 只用自注册测试账号（`wp-*`），**不碰真实用户数据**。

### 0.7 协作守则（对我自己的硬约束）
- **拿到的结果必须立刻给结论**；禁止连续多轮重复读同一批文件不发一言（踩过最严重的一次坑）。
- 收尾阶段禁止反复确认同一状态：验证已过就直接提交/部署，别再问自己一遍。
- 复杂检查写成 `tools/_xxx.mjs` 用 node 跑，输出落盘后用 read_files 读（PowerShell 长命令会截断、中文会乱码）。
- 每条任务交付时标注：做到三层验收的哪一层；不能把"代码存在"说成"完成"。

---

# ⓪½ 架构与设计总览（给接手的人：先读 ⓪，再读这节，就能上手）

## A. 一句话概括
「暖心陪伴」是一个**以治愈系宠物 + 暖心墙（社区）为核心的中文情感陪伴 Web 应用**：
用户领养 Lottie 动画宠物（喂食/玩耍/手绘食物/穿衣/零食雨小游戏），在暖心墙发帖互动（回应/评论/浏览/每日一条），
通过漂流瓶与陌生人交换心事（可续聊成私信），所有社交行为产生通知。数据全在 Supabase，前端与数据库之间隔一层 Cloudflare Worker API 网关。

## B. 整体架构（请求流向）
```
浏览器 (Vue 3 SPA, dist/ 静态资产)
   │  页面代码按路由分包（HomeView 内联首屏，其余 lazy）
   │
   ├─ 数据请求 → src/utils/api/db.js（统一接口，运行时二选一）
   │     ├─ 模式①直连:  db.supabase.js ─────────────→ Supabase (REST/Auth/Storage)
   │     └─ 模式②网关:  db.gateway.js → /api/* → Cloudflare Worker (worker/api.js)
   │                        （JWT 透传、路由白名单、翻 REST 查询串）→ Supabase REST
   │                        【线上生产用这条】
   │
   └─ 注册/登录 → Supabase Auth（邮箱密码 + Google OAuth；注册触发器自动建 profiles 行）
                     ↓
        Postgres：15 张表 + RLS + 44 个 security definer RPC（权威逻辑都在库里）
                     ↓
        触发器（AFTER INSERT）→ notifications 通知（评论/回应/宠物互动/漂流瓶回信）
```
**为什么这样设计**：RLS 管"谁能读写哪行"，RPC 管"业务规则怎么算"（计数、去重、解锁、限额），
Worker 只做"翻译 + 白名单 + JWT 透传"——三层各司其职；双模式让本地 dev 可直连调试，线上收紧为只走网关。

## C. 数据库（15 张表 + 44 RPC + Storage）
> 建表/函数真相源：`SUPABASE_SETUP.sql`；增量：`MIGRATION_*.sql`（10 个，全部已在线上执行）。

### 核心表（按功能域）
| 功能域 | 表 | 说明 |
|---|---|---|
| 用户 | `profiles` | 昵称、created_at、**status/status_at（大厅状态，24h 窗口）**；注册触发器自动建档 |
| 暖心墙 | `wall_posts` | 帖子（文字+可选图）；views/dislikes/removed/created_day；**双档自动下架（<100 超 3 个 / ≥100 超 0.5%，removed=假删除）** |
| | `wall_comments` | 二级评论（parent_id 封顶，级联删除） |
| | `wall_reactions` | 回应（同感/抱抱/暖暖，一人一帖一种） |
| | `wall_post_views` | 浏览记录（去重用） |
| 宠物 | `pet_profiles` | 宠物数值（饱食/心情/清洁/等级）、lastCareAt（7 天死亡判定）、食物食谱（≤7 份、48h 过期） |
| | `pet_interactions` | 摸/喂/玩互动（触发对方通知） |
| 私信 | `dm_conversations` / `dm_messages` | 会话与消息（撤回=替换占位符；**首聊限 3 条**在 dm_send 内判） |
| | `dm_states` | 已读水位 / 免打扰 / 隐藏会话 |
| | `dm_blocks` | 拉黑（**不发通知**；dm_send 双向查它） |
| 漂流瓶 | `bottle_letters` / `bottle_fishes` | 信与"捞取持有"关系；每日写 3 捞 7；回信触发 `bottle_notify_reply` |
| 通知 | `notifications` / `notification_prefs` | 分栏 kinds（comments/reactions/pets/dms/system）+ 用户偏好开关 |
| 管理 | `admin_users` | 管理员白名单；`is_admin()` 判权；admin_overview 治理列表 |

### RPC 分组（44 个，全部 `security definer`，命名即文档）
- `dm_*`（15）：send/list_convs/list_messages/conv_meta/mark_read/hide/unhide/mute/accept/recall/**block/unblock/blocks**/unread_total/is_blocked/find_conv/open
- `notif_*`（6）：page/unread/mark/clear/prefs_get/prefs_set
- `bottle_*`（7）：send/fish/reply/release/mine/held/**records(p_id,p_offset,p_mine,p_limit)**/chat_decide（+触发器 notify_reply）
- `wall_*`（3）：daily_limit/add_view/toggle_dislike（双档下架）
- `pet_interact`、`admin_broadcast`、`is_admin`/`admin_overview`、触发器 `notify_on_comment/reaction/pet`

### RLS 惯例
- 读：内容表**匿名可读**（未下架优先）；`profiles` 全可读；dm/通知仅参与者。
- 写：全部收口在 RPC（service owner 权限）+ 少量 self 策略（如 `profiles self update` → 大厅状态写入靠它）。
- **Storage**：`wall-images` 公共桶（帖子图片外置，行体积安全阀）。

## D. 前端页面（10 视图 / 9 组件 / 3 store）
### 路由表（history 模式，`/u/:id` 等直链可达；未知路径回首页）
| 路由 | 视图 | 内容 |
|---|---|---|
| `/` | HomeView | **首屏（内联不加载动画）**：陪伴大厅（状态 4 键→云端人数统计/个人状态在主页显示）、心情打卡（在大厅下方）、手绘食物入口、漂流瓶（投/捞/记录两类分页 10 条）、暖心墙预览 |
| `/pet` | PetView | 宠物主页：Lottie 舞台（动作栏紧贴舞台）、三页签（宠物/冒险/领养）；手绘食物画板、零食雨（全屏移动、2 金币/局 每日 3 次）、衣柜、7 天疏忽死亡/降级通知 |
| `/community` | CommunityView | 暖心墙：发帖、排序（最新/同感/抱抱/暖暖+时间范围）、二级评论、回应、**无浏览眼睛**、`?post=` 深链 |
| `/profile` | ProfileView | 「我的」：账号信息、**我发的帖子**、状态徽章、设置入口 |
| `/u/:id` | WallerView | 他人公开主页：TA 的帖子、状态徽章（24h 内才显示）、**从这里可发首聊（限 3 条）** |
| `/messages(/:id)` | MessagesView | 私信：会话列表+聊天同页；**漂流瓶记录区块**（同意后带入原信/回信）；拉黑管理/删除会话；头像点击进对方主页 |
| `/notifications` | NotificationsView | 通知中心：分栏、**20 条分页**、偏好开关（已移入设置）、点击跳目标（他人主页/会话/原帖） |
| `/settings` | SettingsView | 设置页：皮肤/语言/总通知/各细分通知（**从 App 头部与通知页迁来**） |
| `/admin` | AdminView | 管理中心（仅白名单）：总览、**帖子点进详情可上架/下架**、广播 |
| `/privacy` | PrivacyView | 隐私政策（Google OAuth 审核抓取，不能要求登录） |

### 关键组件
`LottiePet`（宠物渲染：贴纸风描边+表情变体+粒子，`lottiePet.js` 生成）/ `PetMotion`（跳跃浮动睡眠）/
`FoodPainter`（手绘食物画板：8 色/撤销/5 样品线稿/满 7 提示/保存清板）/ `SnackRain`（零食雨游戏）/
`BottleRecords`（漂流瓶记录）/ `ShareCard`+`PostcardCard`（分享明信片）/ `SeasonFx`（季节特效）/ `SideRails`。

### 状态与工具层
- **stores**：`petStore`（宠物数值/食谱/金币/死亡判定——最大的一个）、`uiStore`（皮肤/语言/总通知开关）、`badgeStore`（红点）。
- **utils 规则层（纯函数，全有单测）**：`wallRules`（排序/范围/去重/双档下架阈值）、`dmRules`（撤回窗口/未读/错误码映射）、`notifyRules`（分栏/聚合/跳转）、`snackGame`、`statuses`（24h 窗口）、`authRules`、`imaging`。
- **utils 云层**：`wall`/`dm`/`bottle`/`notify`/`comments`/`admin`（封装 db 调用+降级）、`storage`（本机 localStorage：未登录兜底如 `wp-status`）、`supabase`。

## E. 视觉与设计语言
- **暖色治愈系**：CSS 变量（`src/style.css`）——墨色文字 `--ink:#4a3b2f`、主橙 `--accent:#ff9f5a`、玻璃拟态卡片 `--glass: rgba(255,255,255,.62)` + 柔和投影。
- **多皮肤**：`src/data/themes.js` 定义主题集，`uiStore` 切换（换的是变量集，不是重写样式）。
- **双语**：`i18n.js` zh/en 全量对称；emoji 写在文案里；插值 `{n}` 风格。
- **宠物**：代码生成 Lottie JSON（非美术资源）——改造型=改 `lottiePet.js`，`pet-visual-test` 钉形状断言。

## F. 测试与验证体系（接手后跑什么）
- **24 套离线测试**（`node tools/x-test.mjs`，秒级、不碰网络）：规则层纯函数 + 契约（前端↔Worker↔SQL 形状）+ i18n 对称 + 迁移覆盖。
- **undef-check / arity-test**：静态检查未导入符号与参数个数（白屏/undefined 元凶）。
- **六套线上 e2e**（除 img-cache 外都注册 `wp-*` 测试账号，结束清理）：cloud-e2e 38 项、dm-e2e 47 项、status-e2e 17 项、nick-e2e 12 项、img-cache-e2e 11 项、bottle-e2e（双账号漂流瓶全链路）。
- **live-check**：部署后必跑（13 项：页面/缓存/安全头/SEO）。
- **线上探针纪律**：判函数存在性必须区分 `42501`（存在无权）与 `PGRST202`（不存在）。

## G. 业务规则速查（魔法数字都在这里，改值前先看"位置"）
| 规则 | 值 | 代码位置 |
|---|---|---|
| 大厅状态新鲜窗口 | 24h | `statuses.js STATUS_WINDOW_MS` + Worker since 参数（**两处必须一致**） |
| 大厅状态 key | working/studying/sleepless/chilling | `statuses.js STATUS_KEYS` + `worker/api.js VALID_STATUS`（前后端同源） |
| 手绘食物上限 / 保质期 | 7 份 / 48h | `petStore.js DISH_MAX / DISH_TTL_MS` |
| 宠物疏忽 | 7 天死亡；前 3 天缓冲，第 4–7 天均摊降到 1 级 | `petStore.js NEGLECT_MS / NEGLECT_GRACE_DAYS / NEGLECT_DECAY_DAYS` |
| 自定义角色配额 | ≤3 个（初始伙伴/物种伙伴不占名额） | `petStore.js MAX_CUSTOM_PETS`（判定 `customQuotaHit`） |
| 零食雨奖励 | 2 金币/局，每日 3 次 | `petStore.js RAIN_REWARD_COINS / RAIN_REWARD_MAX` |
| 漂流瓶限额 | 每日写 3 封、捞 7 封；信与回信各 ≤1000 字 | `MIGRATION_bottle.sql` RPC 内 + `bottle.js` |
| 首聊限制 | 对方回复前，发起方最多 3 条 | `MIGRATION_dm_first_contact.sql` 的 `dm_send`（错误码 `first-limit`） |
| 厌恶下架 | 双档：浏览 <100 超 3 个 / ≥100 超 0.5%（假删除） | `wall_toggle_dislike` SQL + `wallRules.js`（`REMOVAL_LOW_VIEWS/DISLIKE_MIN_COUNT/DISLIKE_RATIO`） |
| 私信正文 / 撤回窗口 | 2000 字 / 15 分钟 | `dmRules.js BODY_MAX / RECALL_WINDOW_MS` |
| 通知分页 / 漂流瓶记录分页 | 20 条/页 / 10 条/页 | `NotificationsView.vue` / `HomeView.vue`+`BottleRecords.vue` |
| 初始金币 | 50 | `petStore.js wallet` |

> **改任何一行前**：先 grep 该常量名（含测试断言与 README 登记），前端/Worker/SQL/测试四处同查。

## H. 术语表（产品词 ↔ 代码标识符）
| 产品词 | 代码里叫 |
|---|---|
| 暖心墙 | `CommunityView` / `wall_posts` |
| 回应（同感/抱抱/暖暖） | `wall_reactions`（一人一帖一种） |
| 这里不止你一个人 / 大厅 | HomeView 状态区块 / `profiles.status`+`status_at` |
| 状态徽章 | `WallerView` 主页 `statusFresh()` 24h 内才显示 |
| 漂流瓶 / 温暖信箱 | `bottle_letters`/`bottle_fishes`；投=`bottle_send`、捞=`bottle_fish`、放回=`bottle_release` |
| 首聊限制 | `dm_send` 内 first-contact 判定（错误码 `first-limit`） |
| 下架（假删除） | `wall_posts.removed=true`（内容保留、前台不可见、管理员可恢复） |
| 每日一条 | `wall_daily_limit` |
| 物种伙伴 / 我的角色 | 预设五种（cat/dog/rabbit/dino/otter）vs 用户上传自定义（后者才受 3 个配额） |
| 冒险 | PetView 第二页签（`data/adventure.js`） |
| 金币 | 🪙 `wallet.coins`（衣柜消费） |
| 零食雨 | `SnackRain.vue` 小游戏 |
| 手绘食物/食谱 | `FoodPainter.vue` → `pet_profiles` 食谱 |
| 错误码 | SQL `raise exception 'xxx'`（如 `auth-required`/`blocked`/`first-limit`），前端 `sendErrKey`/`errorKind` 映射 i18n |
| 通知 kinds | comments/reactions/pets/dms/system（`notifyRules.js KINDS`，SQL 白名单对应） |

## I. 常见改动的标准 checklist
**加一个云端字段/功能**（最容易漏步骤，按序走）：
① 新建 `MIGRATION_x.sql`（幂等）→ ② 同步 `SUPABASE_SETUP.sql` → ③ `db.supabase.js`+`db.gateway.js` **成对**加方法 → ④ `worker/api.js` 路由（白名单风格）→ ⑤ `gateway-contract-test`/`worker-test` 加断言 → ⑥ i18n zh/en 成对加键 → ⑦ 视图接线 → ⑧ 全量测试+build+`git diff --check`+commit+deploy+push → ⑨ **请用户在 SQL Editor 执行迁移** → ⑩ 探针确认（分清 42501/PGRST202）→ ⑪ README + jiaojie.md 更新。

**加一个页面**：`router.js`（lazy import）→ 入口（底部导航/App 头部）→ i18n 双语 → 若需被搜索引擎抓取则同步 `seo-test`（预渲染/sitemap）→ `uifix-test` 视需要加断言。

**加一个通知类型**：SQL 触发器插入 notifications（定 kind）→ `notifyRules.js`（KINDS/kindsFor/aggKey/targetOf）→ NotificationsView 分栏与文案 → `notify-test` → i18n 两语言。

**重命名导出符号**：改名 → 全仓 grep 旧名（**含 .vue 模板与 tools/ 测试**）→ `undef-check` → 全量测试。

## J. 新环境搭建（Day 1 清单）
1. `npm install`；node ≥ 20。
2. `.env` 只有两个键（`VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY`）——向项目主人要；anon key 是公开键，**service key 永远不要进仓库**。
3. 数据库：线上库已就绪；**只有新装库**才在 SQL Editor 跑 `SUPABASE_SETUP.sql`（全套表+RLS+RPC+Storage），再用 `MIGRATION_add_admin.sql` 把自己设为管理员。
4. 本地开发：`npm run dev`（直连 Supabase）；`npm run dev:api`（本地 Worker 网关）。
5. 部署权：`npx wrangler login`（Cloudflare 账号，项目 `warm-paws`）。
6. push 用代理参数（见 0.3）。
7. 上手路径：读本文件 ⓪→⓪½→九 → 跑 24 套测试确认基线全绿 → 再动第一行代码。

## K. 故障排查速查（症状 → 先查什么）
| 症状 | 先查 |
|---|---|
| 页面白屏 / undefined 崩溃 | `node tools/undef-check.mjs` + `arity-test`（九成是漏导入/参数个数） |
| 界面显示原始 `{xxx}` | i18n 占位符与调用传参不匹配（键/传参/两语言三处对） |
| 功能提示"未开启" | 对应 MIGRATION 是否已执行——探针区分 `42501`(已执行,无权) vs `PGRST202`(未执行) |
| 部署后行为没变 | 线上产物 SHA 与本地 dist 比对；产物内搜**不会被混淆的字符串**（i18n 文案/CSS 类名），源码标识符搜不到是正常的 |
| 通知不出现 | kind 拼写生产方 vs 消费方 + 占位符 + 偏好开关（notif_prefs） |
| 测试假通过 | 用例执行顺序/作用域被破坏；断言的前置状态是否真的前置 |
| 构建拿不到退出码 | 用 `Start-Process`/`spawnSync` 子进程跑 vite，别信外层管道 |
| 长命令输出被截断/乱码 | 写成 `tools/_x.mjs` 用 node 跑，落盘后 read_files 读 |

## L. 分工与权限现实（谁做什么）
| 事项 | 项目主人（用户） | AI 助手 |
|---|---|---|
| Supabase SQL Editor 执行迁移 | ✅ 只有 TA 能执行 DDL | ❌ 只能撰写 SQL + 事后探针验证 |
| 实机/手机/双账号验收 | ✅ 唯一手段 | ❌ 环境无浏览器自动化 |
| 提供故障环境信息（如 #10 浏览器） | ✅ | — |
| 产品决策（做/停/改口径） | ✅ 最终拍板 | 提建议 |
| 写代码/测试/迁移文件 | 提需求 | ✅ |
| wrangler 部署 / git 提交推送 | 授权过 | ✅（按 0.6 流程） |
| 线上探针/e2e（不碰真实用户数据） | — | ✅ |

---

# 一、当前状态速览（2026-09-19 更新）

| 项 | 值 |
|---|---|
| 项目 | peiban（陪伴 / warm-paws），路径 `D:\05ruanjian\peiban` |
| 技术栈 | Vue 3 + Vite + Naive UI；数据层双模式：直连 Supabase（`db.supabase.js`）/ Worker 网关（`db.gateway.js` + `worker/api.js`，**线上走网关**）；Cloudflare 部署 https://dale.de5.net；Supabase Postgres + RLS + security definer RPC |
| 代码 | `HEAD = 52adfa1` + 本轮 #23–#29 改动（见轮 13） |
| 部署 | 前端新包 `index-CV4U24yC.js` 已上线；`live-check` 13/13 |
| 数据库 | **新增 `MIGRATION_notifications_drop_dm.sql`（#23）待用户执行**；其余 11 个迁移全部已执行（含 `MIGRATION_nickname_sync.sql`，`nick-e2e` 12/12 确认） |
| 测试 | 25 套离线测试全绿（auth 84 / notify 149 / wall-rules 37 为本轮新计数）+ `undef-check` 0 问题 + 五套线上 e2e（cloud 38 / dm 47 / status 17 / nick 12 / img-cache 11 全 PASS） |

## 二、现在在做什么

- **当前任务**：轮 13（清单 #23–#29 共 7 条）已完成并部署前端；**等用户在 Supabase 跑 `MIGRATION_notifications_drop_dm.sql`**（私信退出通知中心）+ 实机验收。
- **等待用户输入**：① 实机验收结果（见「八、下一步」清单）；② 第 10 条的浏览器型号/版本；③ 第 7 条暖心故事、#12 宠物年龄衰老的开工通知。
- **可选加码（等有量再做）**：图片搬 Cloudflare R2（出口永久免费，见「十、容量评估」方案 B）。

## 三、已完成（按轮次，均含验证证据）

### 轮 1：大厅状态上云（原 #4，提交至 51ab0a9f 部署）
- `profiles` 加 `status` / `status_at` 两列 + 倒序索引；写路径复用 `profiles self update` RLS。
- 前端 `statuses.js`（STATUS_KEYS / STATUS_WINDOW_MS=24h / statusFresh）+ HomeView 状态按钮 + WallerView 主页徽章；Worker 白名单 `VALID_STATUS` + 服务端盖时间戳。
- 大厅按 **24h 窗口**显示，过期自动隐去；未跑迁移时优雅降级（只存本机 + 提示"功能没开启"）。
- 修复既有 bug：模板 `STATUS_EMOJI` 前缀与文案自带 emoji 重复（"💻 工作中 💻"）→ 约定 **emoji 只写在 i18n 文案里**，删掉映射表。
- 验证：`status-e2e.mjs` 线上 17/17；`status-test.mjs` 离线 48 项。

### 轮 2：12 条清单 v1（逐条落地）
1. **食物 7 份上限 + 48h 过期 + 存入食谱后画板清空复位**（FoodPainter + petStore；`food-painter-test.mjs`）。
2. **7 天不照顾 → 前 3 天缓冲、第 4–7 天降到 1 级、第 7 天死亡**；回到应用时浮层通知（修了两个 bug：通知 kind `death→dead`、占位符 `{n}/{lv}`→`{name}/{from}/{to}`，此前死亡通知不显示、降级通知显示原始占位符）。
3. **动作栏紧贴舞台**（喂食/玩耍不用翻页）、**零食雨全屏移动**、**一局 2 金币每日 3 次**。
4. 状态上云（见轮 1；后按用户新口径重构，见轮 4）。
5. 心情打卡移到"这里不止你一个人"下方。
6. **漂流瓶 v1**：`MIGRATION_bottle.sql`（投/捞/回/放回海里；每日写 3 捞 7、信件 1000 字）。
7. 今日一问移除（暖心故事等用户通知后再做）。

### 轮 3：第 6 条更新 —— 漂流瓶续聊
- `MIGRATION_bottle_chat.sql`：回信触发器 `bottle_notify_reply` 通知作者 + `bottle_chat_decide(p_id,p_accept)`。
- 会话页新增 `BottleRecords.vue` 漂流瓶记录区块；**只有原信作者 A 能同意建聊**；同意后复用 `dm_open` 建会话并把原信+回信导入为两条消息（幂等）。
- 通知点击跳转对应记录。

### 轮 4：第 4 条更新 —— 大厅只统计人数
- 新接口 `GET /api/statuses/counts`（Worker 用 HEAD + content-range 精确计数）。
- 大厅显示"学习里 📚 7 人"式**人数**，不显示昵称/列表；个人状态只在用户公开主页可见。
- `status-counts-test.mjs` + `status-test` 同步更新。

### 轮 5：第 8、9、12 条（c3c081f + 84bb307 补修）
8. 摘除浏览"眼睛"（CommunityView / WallerView 两处），文案"{n} 次浏览"保留。
9. 「我的」页新增"我发的帖子"区块（复用 `cloudFetchUserPosts` + `rowsToPosts`）。
12. **名额口径修正**：`MAX_PETS`（全部存活≤3，含初始）→ **自定义上传角色 ≤3，初始宠物与预设物种不占名额**；84bb307 补修物种领养路径残留的旧 `adoptLimitHit` 调用。

### 轮 6：#11 宠物形象（dcfe111 部署）
- `lottiePet.js`：贴纸风描边 + 表情变体（眼弧/嘴型/眉毛）+ 粒子（sparkle/zzz）+ 情绪 tick；`pet-visual-test.mjs`。**观感是否达标待用户实机评价**。

### 轮 7：第 13–22 条（39c9bb5，部署 d9c6b2a7）
13. **设置页** `/settings`（新 `SettingsView.vue` + `uiStore.js`）：皮肤/语言/总通知开关/各通知细分开关统一收口；App 头部相应精简。
14. 通知页：无效偏好按钮移入设置；**通知/私信红点只在聊天入口**；**默认 20 条 + 手动"下一页"分页**。
15. 通知点击进入**对方用户主页**（`notifyRules.targetOf` → `/u/:id`）；聊天框点头像进主页。
16. 画第 8 份食物时**提示已满不能再画**（而非显示继续添加），食谱保持 7 份。
17. 漂流瓶记录（`MIGRATION_bottle_records.sql`：`bottle_records(p_id,p_offset,p_mine,p_limit)`）：信封显示**发布时间**；记录分"我发布的（被捞/未捞）"与"我捞到的"两类、按发布时间倒序、**10 条分页**；**有回信可聊天的点击直接进聊天页**。
18. 暖心墙按钮变色过渡加快（style.css 过渡时长）。
19. **删除会话**功能；**已拉黑列表 + 取消拉黑**；**拉黑不再通知对方**（`dm_block` 去掉通知插入，迁移已同步）。
20. 管理中心：帖子**可点进详情**并可**上架/下架**。
21. 厌恶下架阈值：**累计 ≥5 个不满才下架**（SQL `wall_toggle_dislike` 内改，不再是 1 人/1% 即下架）。→ **轮 14 又改**为双档（浏览 <100 超 3 个 / ≥100 超 0.5%），见下。
22. **首聊限制**（`MIGRATION_dm_first_contact.sql` 替换 `dm_send`）：从暖心墙主页发起的首次会话，对方回复前发起方最多发 3 条，回复即解锁；错误码 `first-limit` 前端映射提示；漂流瓶导入的会话天然解锁。

### 交付流水线（每轮固定动作，全部通过后才提交）
全量 24 套离线测试 → `undef-check` → `vite build`（明确退出码）→ `git diff --check` → commit → `wrangler deploy` → push → `live-check` → 线上产物 SHA 与本地比对 → （有新迁移时）给用户迁移文件并探针确认执行结果。

### 轮 8：遗留问题修复 —— 忘记密码重置必失败（4443b1e）
- **根因**：`supabase.js captureRedirect()` 在 createClient 前把地址栏恢复令牌抹掉；本项目 supabase-js 默认 implicit 流程，auth-js 靠该令牌建恢复会话（它自己建完才清 URL）→ 令牌被抢先清掉 = 会话建不起来 = `updateUser` 报 `Auth session missing`（用户看到"没成功"）。
- **修复**：captureRedirect 改为**只读不清**（error 分支无令牌可消费，才立即清）；会话在手（onAuthStateChange 有 session）时兜底清地址栏残留。
- **验证**：auth-test 49 项（A30/A30b 新断言钉住"恢复令牌不被提前抹"）；全量测试/build/live-check/SHA 全过；**真实邮件闭环待用户实机验收**。

### 轮 9：Google 登录昵称提示 + 设置页改昵称（提交待查）
- Google 登录用户昵称是自动取的（bestNickname 兜底），**首次登录后 ProfileView 给「改一改」提示**（cloudNicknameIsAuto 判定，只在 provider=google 且昵称仍等于自动值时提示）；设置页加常驻改昵称入口（登录改云端，游客提示先登录）。
- 改名写库：首选 RPC `rename_me`（一个事务里连旧帖/旧评论署名一起改）；缺失时退回只改 profiles 并如实返回 synced:false。

### 轮 10：改昵称署名同步 + PGRST202 判定修复（已部署 70ef53fd，迁移未跑）
- **新迁移 `MIGRATION_nickname_sync.sql`**：security definer RPC `rename_me(p_nick)` —— 一个事务里改 profiles.nickname + 同步自己全部 wall_posts/wall_comments 的 author_name（校验非空与 24 字上限 = authRules.NICK_MAX），返回改动行数；执行权只给 authenticated。**已知局限**：别人评论里「@旧名」的 reply_to_name 是纯文本无 uuid，无法回填（README 已注明）。未跑时前端退回「只改档案，旧帖留旧名」（不报错）。
- **修复三处漏判 bug（重要）**：PostgREST 找不到 RPC 时 **错误码 PGRST202 在 error.code 里，error.message 是 "Could not find the function … in the schema cache"，不含 PGRST202** —— 项目里 `wallRules.errorKind` / `authRules.isMissingFnError` / `bottle.bottleErrKey` 三处只匹配消息文本，全部漏判（用户会直接看到英文报错而不是优雅降级文案）。已改为 **code 与 message 双认**（含 42883/42703/42P01），调用点补传 error.code。
- **验证**：`nick-e2e.mjs` 线上 **12/12**（迁移已由用户执行：RPC 同步旧署名 ✓ / 匿名被权限层拒绝 ✓ / 空与超长被拒 ✓ / 幂等 ✓）；auth-test 77、wall-rules 33（T22 新增真实响应文本用例）、bottle 36、bottle-chat 80 全绿；build + wrangler 部署 70ef53fd + live-check 13 过 + 线上产物含新判定与 rename_me 调用。

### 轮 11：GSC「已抓取-尚未编入索引」治理（已部署 b55e3b9e）
- **线上探针取证**（`tools/_seo_probe.mjs`，Googlebot UA）：发现 ① 任意乱路径都被 SPA 兜底返回 200+首页（软 404 原料）② 无 JS 时各页仅 ~295 字（薄内容——「抓了不收录」的根本原因）③ `http://` 明文直接 200 不跳 https（zone 层未开 Always Use HTTPS，**代码兜不了静态路径，待用户在 Cloudflare 开**）。
- **修复**：① `wrangler.jsonc` not_found_handling 改 `"404-page"` + 构建期生成 `dist/404.html`（noindex + 回首页）——乱路径/大小写错误全部真 404；② `vite.config.js` seoRoutes 扩展：首页与 /pet /community /profile 构建期预渲染 hero 正文（**文案唯一来源仍是 i18n en 词条**，不新造句子；h2 避免与 noscript h1 重复），无 JS 文本量 295 → 502-575 字。
- **验证**：seo-test 42/42、live-check 13/13（T32 与未知路径断言同步更新为新行为）；线上复测：乱路径 404、尾斜杠 307 归一、五页 canonical/description/og 健康、sitemap lastmod=当天。
- **SEO 事实**：「已抓取-尚未编入索引」非报错；新站+低权重普遍要几天~几周。技术上能做的已做完，剩下靠 GSC 请求编入索引 + 外链积累。
- **GSC 请求编入索引已提交（用户操作）**：5 个可收录 URL 全部走「网址检查 → 请求编入索引」。**踩坑**：GSC 网址检查框手打 URL 易混入全角字符（中文冒号`：`/斜杠`／`，肉眼难辨）→ 全部报「此网址不在该资源中」；从效果报表点数据行（新站的「未知」聚合项）也会弹同样错误。**解法**：提供完整 URL 列表让用户复制粘贴；不从效果报表行进入检查。
- **Always Use HTTPS 已由用户在 Cloudflare 开启（同日）**：http://dale.de5.net/ 与 /pet 等全部实测 **301 → https**（保留原路径）。http/https 重复内容风险消除。**踩坑**：这个开关在 zone 层（SSL/TLS → 边缘证书 → 始终使用 HTTPS），Worker 代码兜不了静态路径的 http 请求；若加密模式为「关闭」则该开关不显示，需先把加密模式设为「完全」。


### 轮 12：图片边缘缓存 —— 把 Supabase egress 降到 1/N（已部署 b025d9cb）
- **问题根源（带货来源）**：`/api/img/*` 原来是 **302 重定向**到 `<proj>.supabase.co/storage/...` —— 浏览器**最终直连 Supabase 下载字节，Cloudflare 压根不经手**，所以每个新访客的每张图都算一次 Supabase egress（免费 5GB/月主要被这项吃掉）。302 虽然带了 `immutable`，但 **Cloudflare 默认不缓存 302**，跨用户完全不共享。
- **修法**：`worker/api.js` 的 `imgRedirect` → **`imgResponse`**：Worker 取字节后直出 + **Cache API（`caches.default`）长效缓存**；响应头 `x-img-cache: MISS|HIT|FALLBACK|BYPASS` 便于线上取证。
  - 敢用 `immutable` 的依据：路径为 `<uid>/<时间戳|内容哈希>.<ext>`，上传一律 `upsert=false` → **同一 URL 字节永不改变**。
  - **降级不白块**：上游取不到/图不存在 → 退回与原实现完全一致的 **302 直连 Storage**（最差退化成改造前行为）；写缓存失败只 `waitUntil().catch()`，不影响本次响应。
  - **安全阀没放松**：`safeImagePath` 仍先行校验，路径穿越照旧 **400**。
- **验证**：`worker-test` **180 → 191**（新增 11 项：Miss→Hit、字节一致、immutable 头、content-type 透传、上游失败退回 302、非法路径 400、非 GET 405…）；新工具 **`img-cache-e2e.mjs` 线上 11/11**（经 Worker 上传真实 PNG → 连打两次：`MISS` 首字节代理、**`HIT` 无凭证的另一访客命中边缘缓存** ⭐ 跨用户共享成立）；build + 部署 `b025d9cb` + live-check 13/13。
- **收益**：图片出口量降到约 **1/N**（N = 同一张图被看的次数），免费套餐 ~490 → **~1,000+ 日活**；Pro ~2.3 万 → **约 7 万**。
- 剩余可选（不着急）：方案 B 搬 **Cloudflare R2**（存储 10GB 免费 + 出口永久免费）→ 图片流量与日活彻底脱钩。

### 轮 13：清单 #23–#29（7 条，前端已部署 `index-CV4U24yC.js`，live-check 13/13）

- **#23 私信退出通知中心**：通知中心去掉「私信」分栏；「全部」不再用 `null=不过滤`，改为**显式非 dm 白名单**（`kindsFor` 兜底也不含 dm，防老库残留冒出来）。数据层用 **BEFORE INSERT 触发器把 `kind='dm'` 静默丢弃**（`MIGRATION_notifications_drop_dm.sql`，清历史 + 拦生成）——**不重写** `dm_send`/漂流瓶触发器这些复杂函数，一处拦住所有生成点；`notif_unread` 的 total 从此自然不含 dm。设置页同步移除「私信」偏好开关（开关已无效果）。⭐ **待用户在 Supabase SQL Editor 执行**（SUPABASE_SETUP.sql 已同步同款块）。
- **#24 云按钮移除**：App.vue 顶栏的账号标签（☁️→/profile）与导航「我的」重复，已删（`accountLabel` 一并清理）。
- **#25 帖子时间到分钟**：新纯函数 `wallRules.fmtWhen`（月日 + HH:mm，跨年补年份；非法/null → 空串 —— **踩坑**：`new Date(null)` 是 1970-01-01 而非 Invalid，必须显式拦）。CommunityView（帖子+评论）与 WallerView（帖子）都接上。
- **#26 厌恶文案放软**：`community.dislikeRule` 重写。⚠️ **向用户澄清过**：真实规则是 **「≥5 人 且 ≥浏览的 1%」同时满足**（SQL 164 行），不是用户复述的「或」——「且」防小样本误杀（2 个浏览 1 个厌恶 ≠ 50% 就下架）；文案按「且」写、语气放软（"退下休息——不会删掉，随时能回来"）。
- **#27 设置页改密码**：`cloudChangePassword(oldPw, newPw)` —— 邮箱用户**先用旧密码重登一次**验证（signInWithPassword 失败 → `old-password-wrong`），再 `updateUser`；**谷歌用户没有旧密码，直接设新密码**，之后可用邮箱+密码登录。设置页新增密码区（旧/新/确认三框，谷歌用户不显示旧密码框），本地先拦「两次不一致/太短/没填旧密码」。`auth-test` 77→**84**。
- **#28 游客不能参与云端帖互动**：评论（含二级回复框）、回应、厌恶——未登录点击云端帖一律**给登录提示**（`reactSignIn`/`commentSignIn`；评论输入区直接换成提示+登录链接；`openReply` 也拦）。**修复的原始抱怨**：之前游客评论走本地分支"能写但别人看不到"，误导。示例帖保留本地演示行为。
- **#29 回应再点取消 + 跟手**：登录用户**乐观翻转**（`p.mine[kind]` + 计数立即变），网络回来用权威计数校正，失败**回滚 + 提示**（`reactFail`）；`reactBusy` Set 防连点竞态；本地/示例帖第二次点击也会**取消**（原来是 `includes→return`，取消不了——用户遇到的正是这个）；厌恶按钮同样乐观化。
- **验证**：`wall-rules-test` 33→**37**（fmtWhen 4 项）、`notify-test` 148→**149**（分栏断言按 #23 重写）、`auth-test` 77→**84**（#27 契约 7 项）、`i18n-test`/`uifix-test`/`undef-check`/`arity-test` 全绿 + **全部 25 套重跑通过**；build ✓ 部署 ✓ live-check 13/13；README（迁移清单第 10 条 + 工具计数 + 回归行）与 SUPABASE_SETUP.sql 已同步。
- **待办**：① 用户跑 `MIGRATION_notifications_drop_dm.sql`；② 实机验收 #23（通知页无私信栏）、#27（改密码闭环）、#28/#29（游客提示 + 再点取消跟手）。

### 轮 14：#26 下架规则二次修订 + 线上判别工具（提交 e142150，已推送）

用户把 #26 的规则**又改了一次**（推翻轮 13 的「≥5 且 ≥1%」），并说明 **SQL 已自己跑好** —— 但线上实测发现**并没有生效**，这是本轮最重要的发现。

- **新规则（当前权威）**：`views < 100` 时 **厌恶 > 3 个**（即 ≥4 人）即下架；`views >= 100` 时 **厌恶 ÷ 浏览 > 0.5%** 即下架。文案压到 **≤15 字**（`community.dislikeRule`：中文 15 字以内、英文同步），并在 `wall-rules-test` 加断言**锁住字数上限**，防止以后又写长。
- **改动点（四处必须同步，漏一处就「前端算了、线上没算」）**：`src/utils/wallRules.js`（`REMOVAL_*` 常量 + `shouldRemove` 纯函数）· `MIGRATION_wall_daily_view_dislike.sql`（`wall_toggle_dislike` 函数内判定）· `SUPABASE_SETUP.sql`（同款块）· `tools/wall-rules-test.mjs`（双档位用例，含边界 3/4 个、100 浏览分界）＋ `src/i18n.js`（中英文案）。
- **⭐ 线上实测结论（关键）**：用 4 个测试账号各投 1 次厌恶（`views≈0`，必走「<100」档），结果是 **`dislikes=4, removed=false` → 线上仍是旧规则**。即「SQL 已经跑好」的认知与实际不符 —— 用户粘的可能是旧文件内容，或只跑了片段而 `create or replace` 未覆盖到。**判别工具已固化为 `tools/dislike-e2e.mjs`**（见下），跑完 SQL 一条命令即可验证到底哪一档生效。
- **`tools/dislike-e2e.mjs`（新增，已登记 README）**：不依赖浏览量（避免真实访客把分母推过 100 边界导致不可判别），只看「4 人各投 1 次是否在第 4 个触发下架」；`removed` 一律取 **RPC 返回值**。会建 1 条测试帖 + 4 个测试账号并清理。
- **验证**：`wall-rules-test` 37→**38**、全量 25 套重跑通过；build ✓ 部署 ✓；README（工具清单新增 dislike-e2e、迁移第 2 条补「改阈值必须重跑该文件」的强提示）已同步。

#### 轮 14 续（同轮）：判别器升级为「唯一解」，并定位到线上到底是哪一版

第一版判别器（4 人各投 1 次）**有歧义** —— 规则在库里改过三次，其中 ① 和 ③ 都会在 4 个厌恶时下架，所以只看一条无法判断线上是哪版；而且它把结论写成「线上仍是旧规则」也过于笼统。**重写为两档联合判别**（`tools/dislike-e2e.mjs`，5 个账号）：

| 档位 | 构造 | ① 纯比例 1%（73ee2ba） | ② ≥5 且 ≥1%（39c9bb5） | ③ #26 双档（e142150） | 线上实测 |
|---|---|---|---|---|---|
| 低浏览 | views≈2，逐个投 | 第 1 个即下架（50% ≥ 1%） | 1 < 5 → 不下架 | 1 ≤ 3 → 不下架 | **第 1 个即下架 → 排除 ②③** |
| 高浏览 | views=121，1 个 | 0.83% < 1% → 不下架 | 1 < 5 → 不下架 | 0.83% > 0.5% → **下架** | **不下架 → 排除 ③，确立 ①** |

- **结论（精确）**：线上数据库跑的是**最早那版「纯比例 1%，无最少人数」**（`73ee2ba`）—— 即这条迁移自最初执行后**再没重跑过**（`#21` 的 ≥5、`#26` 的双档都只落在仓库文件里）。两档实测互为交叉验证，是唯一解而非猜测。
- **高浏览档怎么造**：`wall_add_view(p_post, p_viewer)` 的 `p_viewer` 是**调用方自填的自由文本**（服务端只按「键 + UTC 日」去重）→ 可用脚本批量造出 120 个不同访客键，精确控制分母，不必依赖真实流量。
- **`tools/cloud-e2e.mjs` 同步升级**：T19b 的期望值不再写死，改为调前端纯函数 `shouldRemove(views, dislikes)` 推导（与 SQL 同口径，杜绝「测试里另抄一份阈值」漂移）；当出现「1 个厌恶却被判下架」时，失败信息**附带可执行修复提示**（重跑迁移文件）。
- **前端侧确认已上线**：本地 `index-Dc7wMqQT.js` 与线上同哈希，含 15 字文案「超3人不喜欢，或>0.5%隐去」。
- 全量 25 套离线测试复跑全绿（`wall-rules-test` 38 · `wall-test` 34 · `cloud` 契约 83/65 · `worker-test` 191 · `pet-visual-test` 163 · `auth-test` 84 等），`undef-check problems=0`，build ✓。


## 四、还没做的

| 项 | 说明 | 依赖 |
|---|---|---|
| #26 线上 SQL 未生效 | **已精确定位：线上是 ① 纯比例 1%（无最少人数）那版（73ee2ba）**，即该迁移自最初执行后再没重跑过；代码与仓库文件都是最新的 ③ 双档 | **用户重跑整段 `MIGRATION_wall_daily_view_dislike.sql`**（create or replace，整段粘最稳）→ `node tools/dislike-e2e.mjs` 应 8/8 全绿 |
| #23 迁移待执行 | `MIGRATION_notifications_drop_dm.sql`（清历史 dm 通知 + 拦新生成） | **用户在 Supabase SQL Editor 执行** |
| #1/#3/#11/#17/#22/#23/#27/#28/#29 实机验收 | 代码已上线，但真实浏览器/手机交互未验收（本地无浏览器自动化） | 用户实机点一遍 |
| #7 暖心故事 | 今日一问位置的替换品：标题+正文、每日一篇、点赞、7 天点赞榜新页面 | **等用户通知开工** |
| #12 宠物年龄与衰老 | 用户明确"以后再改" | **等用户通知开工** |
| #10 评论数跨浏览器 | 有预取逻辑，但问题未在故障浏览器复现定位，不能算解决 | 需用户提供浏览器与版本 |
| 第 2 条通知为本地浮层 | 死亡/降级通知是回到应用时的前端浮层，不是云端通知中心消息 | 如需上云另行设计 |

## 五、关键决策与理由

1. **emoji 只写在 i18n 文案里，模板不再拼**：与心情打卡等既有区块一致；模板再拼必然重复（踩过坑，见坑录 #1）。
2. **状态/记录等时间窗口过滤放查询侧（since 参数）而非只靠前端**：24h 隐去是"窗口过滤不是数据丢失"，e2e 用 25h/48h 双窗口证明过。
3. **状态写入时间戳由服务端盖**（Worker `status_at: new Date().toISOString()`）：客户端只送 status，防伪造"几分钟前"。
4. **大厅只给人数（HEAD+content-range 计数）不给昵称列表**：用户明确要隐私口径（"不显示昵称"），且少传数据。
5. **漂流瓶续聊复用 dm 体系**（`dm_open` 建会话 + 原信/回信导入为两条消息），不另造聊天：少一套并行系统；导入幂等防重复点击重复导入；`bottle_chat_decide` 只允许原信作者同意。
6. **拉黑不通知对方**（#19）：通知=骚扰，与拉黑目的相悖；`dm_send` 两侧都查 `dm_blocks`。
7. **首聊限 3 条做在数据库 RPC（dm_send 内）而非前端**：前端限制可绕过；错误码 `first-limit` 前端映射文案。
8. **迁移一律幂等**（`add column if not exists` / `create or replace`）：用户手动在 SQL Editor 执行，跑重不炸。
9. **每轮只动当前条目、不混其他需求**：多轮教训后确立；跨条目发现的新 bug 单独提交（如 84bb307 补修）。
10. **验收分三层、不混说**：①模块/纯函数离线测试 ②接口形状契约测试 ③线上 e2e/探针。**构建通过 ≠ 交互验收**；接口 200 ≠ 业务闭环；匿名探针 `42501`(存在无权) 与 `PGRST202`(不存在) 必须区分。
11. **线上 e2e 不碰真实用户数据**：dm/bottle 测试只用自注册的 `wp-*` 测试账号，结束清理；不随机捞真实信件。
12. **`SUPABASE_SETUP.sql` 与迁移保持同步**：新装库跑一个文件即可，不必追跑所有迁移（漂过一次，见坑录 #6）。

## 六、改过的重要文件（本轮 #13–#22 为例）

- **数据库**：`MIGRATION_bottle_records.sql`（新增）、`MIGRATION_dm_first_contact.sql`（新增）、`MIGRATION_dm_notifications.sql`（dm_block 去通知）、`MIGRATION_wall_daily_view_dislike.sql`（下架阈值 ≥5）、`SUPABASE_SETUP.sql`（同步以上全部）。
- **Worker**：`worker/api.js`（bottle/records 路由、dm 块列表/删除会话路由、admin 上下架透传）。
- **前端数据层**：`src/utils/api/db.gateway.js` / `db.supabase.js`（两模式同步加方法——**改一个必须改另一个**）、`src/utils/bottle.js`（records 分页）、`src/utils/dm.js`（blocks/unblock/deleteConv）、`src/utils/notifyRules.js`（targetOf 用户主页跳转）。
- **视图**：`SettingsView.vue`（新增）、`router.js`（/settings）、`App.vue`（头部精简）、`NotificationsView.vue`（分页/红点）、`MessagesView.vue`（拉黑管理/删除会话/头像进主页）、`HomeView.vue`（漂流瓶记录）、`AdminView.vue`（帖子上下架）、`BottleRecords.vue`。
- **store/组件**：`stores/uiStore.js`（新增：皮肤/语言/通知开关集中）、`components/FoodPainter.vue`（满 7 提示）。
- **i18n**：`src/i18n.js`（zh/en 双语新增约 30 键——**加键必须 zh/en 成对**，i18n-test 会查对称）。
- **测试/文档**：`tools/food-painter-test.mjs`、`bottle-chat-test.mjs`、`dm-test.mjs`、`wall-rules-test.mjs`、`uifix-test.mjs` 更新；`README.md`（迁移清单/工具清单/回归行登记）。

## 七、现存问题

1. **实机验收缺口**（最大缺口）：#1 画板清空、#3 喂食可见性、#11 宠物观感、#17 记录分页、#22 首聊限制——均无真实浏览器验证。
2. **#10 评论数**：未在用户报障的浏览器上复现，盲改无效，等用户提供环境。
3. **死亡/降级通知是本地浮层**，用户换设备/清缓存可能错过（见"未做"表）。
4. **无浏览器自动化、无隔离测试库**：双账号闭环（如 #22）只能靠用户实测或以后引入 Playwright。

## 八、下一步

1. **等用户实机反馈** #13–#22（尤其设置页、通知分页、漂流瓶记录、拉黑管理、管理员上下架）。
2. 收到 #10 的浏览器信息后：复现 → 定位 → 修复 → 验收。
3. 用户通知后开工 **#7 暖心故事**（标题+正文/每日一篇/点赞/7 天榜页面）与 **#12 宠物年龄衰老**。
4. 有量之后（不急）：图片搬 **Cloudflare R2**（方案 B，出口永久免费）。
5. 下一轮任务完成时：**先更新本文件再结束回复**（含 README 两处项数校准，见踩坑 #19）。

## 九、踩坑录（勿重复）

1. **emoji 双拼**：i18n 文案自带 emoji，模板又前缀 `STATUS_EMOJI[k]` → "💻 工作中 💻"。**教训**：展示文案只从 i18n 取，映射表已删；新写文案时确认 emoji 归属。
2. **测试块结构被插入破坏（假通过）**：往 e2e 插入新用例时把 T4 塞进了 T3 的 `{}` 块内，T3 断言被挤到文件末尾执行，读到的 null 来自后面的清理步骤——**看起来 PASS 其实是假通过**。**教训**：改测试后核对用例执行顺序与作用域；断言的"前置状态"必须真前置。
3. **改名漏网**：#12 改口径时 petStore 改了，但 PetView 物种领养路径还调旧 `adoptLimitHit` → 运行时错。**教训**：重命名后全仓 grep 旧名（含 .vue 模板）；`undef-check` 必跑。
4. **i18n 占位符与传参不符**：文案用 `{lv}`、调用传 `{from,to}` → 用户看到原始 `{lv}`。**教训**：加带参数的键时，键/传参/两语言三处对齐；用 `t()` 实调验证。
5. **通知 kind 拼写不一致**：库发 `death`、前端认 `dead` → 死亡通知不显示。**教训**：事件 kind 建常量清单，生产方与消费方同源。
6. **`SUPABASE_SETUP.sql` 漂移**：只改了 MIGRATION，新装脚本没同步 → 新装库缺功能。**教训**：动 SQL 迁移必须同步 SETUP 文件（bottle_chat 漂过一次已补）。
7. **匿名探针误判"函数缺失"**：anon 调 security definer 函数报 `42501 permission denied`，与 `PGRST202` 不存在是两回事。**教训**：判定函数存在性必须区分这两个错误码；拿不准就用带 JWT 的账号探测。
8. **PowerShell 终端截断/引号地狱 + 中文乱码**：长命令被截断、中文乱码、退出码拿不到 → 曾连续多轮重复读文件不发结论（**最严重的一次卡死**）。**教训（强制）**：复杂检查写成 `tools/_xxx.mjs` 用 node 跑；输出落盘后用 read_files 读；**拿到结果必须立刻给结论**，禁止连续多轮只读不答；收尾阶段禁止重复确认同一状态，直接执行提交/部署。
   **编码已做的持久修复（2026-09-18）**：① 用户 profile `Documents\PowerShell\profile.ps1` 已写 UTF-8（Console In/Out + `$OutputEncoding` + `chcp 65001`）——**手动打开的终端自动生效**（已子会话验证 utf-8/65001；注意 agent 工具会话是 -NoProfile 启动，不加载 profile）；② git 全局 `core.quotepath=false` + `i18n.logOutputEncoding/commitEncoding=utf-8`（中文文件名/提交信息不再转义）。**命令写法规矩（agent 会话必须遵守）**：读文件带 `-Encoding UTF8`；node 输出**不要**再经 `Select-String`/`Format-*` 等 PS cmdlet 管道过滤（会用 GBK 重编码致乱码）——要么整段直出，要么落盘用 read_files 读；复杂检查一律 node 脚本。
9. **构建通过 ≠ 没问题**：路由漏接线、模板引用旧符号，构建照样绿。**教训**：视图改动后跑 undef-check + grep 引用面 + e2e/探针验证线上行为，不能只报 build OK。
10. **测试账号副作用**：线上 e2e 会注册 `wp-*` 测试账号；profiles 无 delete 策略删不掉行，只能清空状态字段。**教训**：e2e 头部注明副作用；不碰真实用户数据。
11. **源码标识符在打包产物中被混淆**：搜 `sparkle0`、`petMood` 等源码名在产物里找不到，误判"没部署上"。**教训**：线上产物验证要用不会被混淆的字符串（i18n 文案、CSS 类名）或直接 SHA 比对 dist。
12. **"已完成"口径纪律**：多次被提醒"不要把代码存在/测试通过说成完成"。**教训（强制）**：每条交付必须标注到三层验收的哪一层；数据库类改动必须注明"迁移已执行/未执行"。
13. **重置密码令牌被提前抹掉（auth 时序 bug，已修）**：`captureRedirect()` 在 createClient 前就把地址栏 `#access_token` 清了，而本项目 supabase-js 默认 `flowType:'implicit'`——auth-js 要靠这个令牌建恢复会话（它自己会在建会话成功后才清 URL）。结果：点重置链接能到"设置新密码"表单，但提交必报 `Auth session missing`。**教训（强制）**：读 URL 信号 ≠ 可以清 URL；凡是"先读后交给库处理"的参数，清理必须交给库或等处理完成后兜底清。测试 auth-test A30/A30b 已钉住。
14. **PGRST202 在 error.code 而非 message（已修，影响面大）**：PostgREST 找不到 RPC 时，`error.message` 是 "Could not find the function public.xxx(...) in the schema cache"，**不含 "PGRST202" 字样**；项目三处降级判定（errorKind / isMissingFnError / bottleErrKey）只匹配消息文本 → 全部漏判，用户直接看到英文报错。离线测试里用 `"PGRST202"` 当消息喂进去是**假通过**。**教训（强制）**：写错误分类前先打一次真实请求看 message/code 长什么样；测试夹具必须用真实响应文本，不能想当然拼。
15. **改名后旧内容署名不会自动变**：署名冗余存（列表免 join 的代价）→ 改昵称必须配 RPC 同步（rename_me），否则「我改名了、墙上是旧名」。**教训**：任何「插入时快照」字段，在改源头时都要想清楚要不要回填、能不能回填（reply_to_name 无 uuid 就回填不了）。
16. **supabase-js 同一 client 在 signUp 后的"匿名"是假的**：auth-js 把会话留在内存，同一 client 后续 `.rpc()` 自动带 JWT —— 用它测"匿名被拒"会测成"匿名成功"。**教训**：真匿名断言必须 `createClient` 全新实例；同理 auth-test 等凡涉及"无 JWT"的用例都要用 fresh client。
17. **`revoke from public` 撤不掉旧库的显式 `grant to anon`**：SETUP 文件曾 `grant execute on all functions to anon`，那是显式授权，后补的 `revoke ... from public` 只撤 PUBLIC。**教训**：收权要写全角色（`from public, anon`）；判定"被拒"的测试不要写死报错话术（权限层 42501 permission denied 与函数层 raise 的 message 不同，都算拒）。

18. **302 让 Cloudflare 完全不经手（本轮真凶）**：`/api/img/*` 原来 302 到 Storage，浏览器**最终直连 Supabase 下字节** —— 边缘没有字节可缓存，且 **Cloudflare 默认不缓存 302**（尽管响应带了 `immutable`）→ 每个新访客的每张图都算一次 Supabase egress。**教训（强制）**：判断「内容有没有走边缘缓存」要看**最终响应是谁发的、字节从哪来**，不能只看 `cache-control` 头；重定向 ≠ 缓存。改造后必须用线上探针看 `x-img-cache` MISS→HIT 才算证据。
19. **README 里的测试项数会悄悄过期**：`auth-test` 实际 77 项而文档写 48、`worker-test` 实际 191 项而文档写 180（加了用例没回头改文档）。**教训（强制）**：每次加/改用例后，跑一遍全量采集真实项数并同步 README 两处（测试清单行 + 第 317 行「回归验证」汇总）；文档数字与实际不符 = 误导交接人。
20. **Node 里没有 `caches`**：本地跑 Worker 测试时 `typeof caches === "undefined"`，缓存分支会走 `BYPASS`（代理字节但不共享）。**教训**：涉及边缘 API 的代码要做能力探测 + 明确降级（本项目 `x-img-cache: BYPASS`），并另用线上 e2e 验证真实缓存行为 —— 离线绿不等于线上缓存成立。
21. **「我 SQL 已经跑好了」≠ 线上真的生效（本轮真凶，代价最大）**：用户确认已执行，但线上实测 4 个厌恶仍未下架 = 还是旧规则。**教训（强制）**：凡是「改了 SQL 才能生效」的需求，**收尾必须用线上探针验证行为**（不是看文件、不是看谁说过跑过），并给用户一条可复跑的命令；改阈值类 SQL 一定要提示「文件是 create or replace，整段粘最稳、别只粘几行」——只跑片段会静默保留旧定义，且完全没有报错，最难发现。

22. **判别器必须有「唯一解」（本轮的返工点）**：第一版下架阈值判别器只看「4 人各投 1 次是否触发下架」，但规则在库里改过**三次**，其中 ①纯比例 1%（73ee2ba）与 ③#26 双档（e142150）**都会**在 4 个厌恶时下架 → 根本分不出线上是哪版，结论只能是含糊的「还是旧规则」。**教训（强制）**：做线上判别前先列出**所有可能的历史版本**，再挑「各版本预测相反」的构造点（本项目 = 低浏览档第 1 个厌恶 + 高浏览档 0.83%），两档交叉验证才算证据；单点断言容易"碰巧对上"。

23. **探针用错账号会自己造假象**：「取消一次厌恶」那步用了**从未投过厌恶的发帖账号**，结果不是取消而是又投一次 → 观察到 `dislikes=5`（预期 3），一度让人怀疑服务端计数坏了。**教训（强制）**：e2e 里操作「某人的数据」必须用**那个人的账号**；断言失败先怀疑夹具与前置状态，再怀疑实现。

---

## 十、容量评估（能承接多少日活）—— 决定「要不要提前优化」

> 结论先说：**当前免费套餐 ≈ 500 日活**；但真正压垮它的不是文本接口（文本极小），
> 而是**图片字节走 Supabase 出口、且没被 Cloudflare 缓存**。有一项**零成本**优化（**已在轮 12 落地**）把图片出口打到约 1/N。

### 1. 官方额度（2026-09 核实，来源：Supabase「Manage Egress usage」文档）

- **Egress 覆盖所有服务**：Database、Auth、**Storage**、Edge Functions、Realtime、Log Drains。
  也就是说 **图片下载算 egress**，不是只有数据库查询算。
- 免费：**5 GB 未缓存 + 5 GB 已缓存**（两个独立额度，合计最多约 10 GB/月）
  → 超出价 $0.09/GB（未缓存）、$0.03/GB（已缓存）
- Pro（$25/月）：**250 GB + 250 GB**
- ⚠️ **额度按「组织」共享**，不是按项目 —— 以后同组织下再开项目会互相挤占。
- 其他额度：DB 体积 500 MB · Storage 体积 1 GB · Auth MAU 5 万 · Workers 免费 **10 万请求/天**

### 2. 本项目实测消耗口径（这些数字是量出来的，不是猜的）

| 项 | 实测值 | 位置/证据 |
|---|---|---|
| 帖子列表响应 | **995 B**（br 压缩） | 线上 `/api/posts` 实测 |
| 状态流响应 | **393 B** | 线上 `/api/statuses` 实测 |
| 图片压缩 | JPEG **q0.78**、最长边 **≤900px** | `imaging.js` `shrinkToDataUrl` |
| 单图典型字节 | **~80–150 KB**（照片/截图；手绘食物更小） | 由 q0.78 + 900px 推算 |
| 图片分发 | `/api/img/*` → Worker **302** → 浏览器直连 `<proj>.supabase.co/storage/...` | `worker/api.js` `imgRedirect` |
| 图片缓存 | 文件名是内容哈希 → **浏览器**可永久缓存；但**Cloudflare 不缓存字节** | 同上 |
| 调用密度 | 私信页可见时 **5s** 轮询（=720 次/小时）· 角标 **30s**（可见才发）· 逛墙一次 3–6 次 | `MessagesView.vue:281`、`badgeStore.js` |

**关键点**：`/api/img/*` 是 **302 重定向**，不是代理 —— 浏览器最终从 Supabase 直接下载字节，
**Cloudflare 完全不经手**。所以：**每一个新访客看每一张图，都是一次 Supabase Storage 出口。**

### 3. 算术（假设已写明，可自行替换）

- 每人每天：文本 ~150 次调用 × ~1.5 KB ≈ **0.23 MB** ＋ 首见图片 ~5 张 × ~100 KB ≈ **0.5 MB**
  → 合计 **~0.7 MB/人/天**
- Supabase 免费：10 GB/月 ÷ 30 = **341 MB/天** ÷ 0.7 MB ≈ **≈ 490 日活**
- Workers 免费：10 万请求/天 ÷ 150 次 ≈ **≈ 660 日活**

→ **两条线在 500–650 日活附近同时触顶**（所以我此前回答的「几百」数值是对的，
但机制说错了：不是列表 JSON 大，而是**图片字节**）。

> ⚠️ **本节是「单点粗估」**（假设一个平均用户）。它已被**第 8 节的两类用户口径（轻/重）取代** ——
> 数字不一致时以第 8 节为准。所有日活数字都带 **±2× 量级不确定**（图片体积 80–150KB、人均在线时长、
> 是否逛私信页），请当**量级判断**用，不要当精确预测。

### 4. 零成本优化（最高杠杆）

**方案 A —— 已做（轮 12，已部署 b025d9cb）** ✅
`/api/img/*` 不再 302，改为 **Worker 代理字节 + Cache API 长效缓存**（`immutable`）。
线上实测 `x-img-cache` MISS → **HIT（跨用户共享）**，Supabase 图片出口降到约 **1/N**。
（历史背景：302 曾带 `immutable`，但**跨用户不共享** —— Cloudflare 默认不缓存 302，
每个新访客的每张图仍打一次 Supabase。）

**方案 B（长期，尚未做）**：图片搬到 **Cloudflare R2**（免费 10 GB 存储 + **出口永久免费**），
公开桶 + CDN。图片出口从此与日活彻底脱钩。等真正有量了再考虑。

效果：免费套餐从 ~490 → **~1,000+ 日活**（此后瓶颈变成文本 egress 与 Workers 请求数）；
Pro 套餐从 ~23,000 → **约 7 万+ 日活**。

### 5. 阶梯表（**旧单点粗估** —— 权威口径看第 8 节的「轻/重两类用户」表）

> ⚠️ 本表的「瓶颈」一列在**第 8 节有修正**：瓶颈会随人均在线时长翻转（重度用户其实是 Workers 请求数先触顶）。
> 下面的日活数是**旧单点口径**，与第 8 节数值不一致属正常（假设不同），**别把两张表混着引用**。

| 档位 | 月费 | 约合日活（旧单点估） | 当时的第一瓶颈 |
|---|---|---|---|
| 免费 | $0 | **~500** | Supabase egress（图片）＋ Workers 请求数 |
| 只升 Workers Paid | $5 | ~700（仍被 Supabase 免费 egress 卡住） | Supabase egress |
| ＋Supabase Pro | $30 | **~2,000–3,000** | Workers 请求数（10M/月） |
| ＋图片走 Cloudflare（第 4 节） | $30 | **~2 万+** | 调用密度 |
| 再往上 | — | 需减调用 | 私信 5s 轮询 → Realtime |

### 6. 触顶前会看到的信号（现在不用管，但知道去哪看）

- Cloudflare → Workers → 请求数日曲线接近 **10 万**
- Supabase → **Organization** → Usage → Egress（注意看 uncached 与 cached 两条）接近 5 GB
- Supabase → Storage → 体积接近 1 GB（用户传图先到量的是**存储**，不是带宽）

### 7. 结论一句话

架构本身没有承载缺陷（Workers 无状态可横向扩展、Supabase 可平滑升配），
这是**「花钱阶梯 + 一个免费的图片缓存优化」**问题，不是重构问题。
增长到几百日活之前无需任何动作；真要提前做，**先做第 4 节的图片缓存**（性价比最高）。


### 8. 如果先隐藏「图片上传」，纯文字能撑多少日活？（2026-09-18 追加）

**先纠正上面第 3、5 节的瓶颈排序**：免费套餐其实是**两条线在不同使用强度下交替触顶**，
不能只说「图片 egress 是瓶颈」。关键在**人均在线时长**（角标轮询是按时长线性烧请求的）。

实测/读码得到的请求密度（这决定 Workers 那条线）：

| 场景 | 请求密度 | 依据 |
|---|---|---|
| 登录 + 页面可见（干放着） | 角标每 30s 一轮 × **2 个端点** = **4 请求/分钟** | `badgeStore.js` `BASE_MS=30000` + `refreshBadge` 里 `Promise.all(unreadTotalSafe, unreadSafe)` |
| 停在私信页 | 每 5s 一次 tick × **2 个请求**（会话列表 + 消息）= **24 请求/分钟** | `MessagesView.vue` `setInterval(tick, 5000)`，`tick` 内 `loadConvsImplicit` + `listMessages` |
| 浏览一页（墙/主页/大厅） | 一次性 4–6 请求 | 各视图 `onMounted` |
| 实测响应体 | `/dm/unread` **27 B** · `/notifications/unread` **77 B** · `/posts?limit=20` **1015 B** · `/statuses?limit=12` **393 B** | `tools/_size_probe.mjs` 线上实测（鉴权接口用临时账号测得，跑完已清理） |

**Workers 免费 = 10 万请求/天**，换成「用户·分钟」预算：
- 干放着为主：100,000 ÷ 4 = **25,000 用户·分钟/天**
- 其中 20% 时间在私信页：100,000 ÷ 8 ≈ **12,500 用户·分钟/天**

| 人均在线时长/天 | 纯停留为主 | 20% 时间在私信页 |
|---|---|---|
| 10 分钟 | ~2,500 DAU | ~1,250 |
| 20 分钟 | ~1,250 | ~625 |
| 60 分钟 | ~417 | ~208 |
| 120 分钟 | ~208 | ~104 |

**隐藏图片后会发生什么**：

| 项 | 隐藏图片前 | 隐藏图片后（纯文字） |
|---|---|---|
| Supabase egress 线 | ~490–660 DAU（图片 5 张×100KB 占 97%） | **~2 万 DAU**（纯文字人均仅 ~16–34 KB/天）→ **这条线基本解除** |
| Workers 请求线 | ~600–1,250 DAU（20 分钟用户） | **不变**（图像与请求数无关）→ **成为唯一瓶颈** |
| 结论 | 图片是瓶颈 | **瓶颈换成「角标轮询密度」，隐藏图片一点忙帮不上** |

所以：**只隐藏图片，日活提升有限**（从 ~600 到 ~1,250，还是取决于在线时长）；
真正的杠杆是**压低请求数**，三条（按性价比排序）：

1. **角标 30s → 60s**：零迁移、零风险，请求减半（4 → 2 请求/分钟）
2. **合并两个 unread 端点**：再减半（2 → 1 请求/分钟）。
   ⚠️ 修正我之前的说法：**只合并网关路径即可**（线上就是网关模式，`worker/api.js` 加一个 `/badge/unread` 内部并行打两次 RPC），
   **不需要新 SQL 迁移**；直连模式保持 2 请求（仅本地开发用）。旧端点保留（老标签页不刷新还在用），收益随刷新渐进。
3. **私信页 5s → 10s**：只影响「停在私信页时」的延迟（最坏 +5s），但把 24 请求/分钟砍半 —— 对重度用户杠杆最大。

**做完 1+2（4× 削减）后** —— 下面这张表是按**统一假设算出来的**，不是拍脑袋：
轻用户 = 登录、可见 20 分钟、不逛私信页、浏览 ~15 次请求；
重度 = 登录、可见 60 分钟、其中 20% 时间停在私信页、浏览 ~30 次请求。

| 档位（假设见上） | 轻用户（20 min） | 重度（60 min · 20% 在私信页） |
|---|---|---|
| 免费·**现状**（图片开 + 角标 30s×2 + 私信 5s） | **~660**（Supabase egress 先触顶） | **~196**（Workers 请求先触顶） |
| 免费·**只隐藏图片**（纯文字） | **~1,050**（瓶颈换成 Workers） | **~196（一点没涨）** |
| 免费·隐藏图片 **+ 角标 60s + 合并端点** | **~2,850** | **~273**（私信 5s 变成大头） |
| 免费·再 **+ 私信 5s→10s** | ~2,850 | **~450** |
| ＋Workers Paid $5（10M/月 ≈ 33 万/天）· 全优化 | ~9,500（egress 线 ~2 万 在后面） | ~910（egress 线 ~1,330 开始逼近） |

**读表要点**：
- 重度用户那条线上，**「只隐藏图片」的提升是 0** —— 因为他的瓶颈从头到尾都是 Workers 请求数。
- 轻度用户「隐藏图片」能翻倍（660 → 1,050），但**远不如把角标改 60s + 合并端点**（→ 2,850）。
- 重度用户的真凶是**私信页 5s 轮询**（24 请求/分钟），必须单独动它。

### 9. 给决策的一句话

**想靠「隐藏图片」把免费额度从几百拉到几千，是拉不动的** —— 那只解决 egress 一条线；
先做**角标 60s + 合并端点**（两条都是零迁移、可回滚），才轮到 egress 成为瓶颈，
那时「隐藏图片」或「搬 R2」才有意义。顺序反了会白忙一场。

### 10. 「角标 60s + 合并端点」的代价（2026-09-19 追加 —— 用户问缺点，先记下来免再推一遍）

> 结论：**值得做，但不是零代价**；真要开工按下面清单逐条评估（含一条「修正我自己的说法」）。

**A. 合并端点的代价（比听起来贵一点）**

| # | 代价 | 说明 |
|---|---|---|
| A1 | 旧端点**不能删** | Vite 产物是 hash 命名，**用户不刷新页面就永远跑旧 JS**（开着的标签页还在打两个旧端点）→ 只能「只增不减」，Worker 里新旧路径**并存维护**，收益随刷新渐进（不是部署完立刻 -50%） |
| A2 | 失败**耦合** | 现在是两个独立 `safe` 包装：通知端点挂了，私信角标仍显示真实值。合并后**一次失败 → 两个角标同时清零**（60s 内自愈，影响小但可靠性耦合变高） |
| A3 | **Supabase 侧一点没省** | 只在 Worker 层合并、Worker 内部仍打两次 RPC → Supabase 请求数/egress 完全不变，**只减 Workers 的 10 万/天**（是单线收益） |
| A4 | 测试面 | `worker-test` 6 处、`gateway-contract-test` 2 处、`api-contract-test` 2 处、`dm-test` 2 处断言都要**新增**（不是替换），三套路径并存 |

> ✅ **修正（重要）**：我一度说「合并端点必须新写 SQL 迁移」。**这是错的** ——
> 线上就是**网关模式**，只需在 `worker/api.js` 加一个 `/badge/unread`（内部并行调两个既有 RPC），
> **不需要新迁移**；直连模式（仅本地开发用）保持 2 请求即可。

**B. 角标 30s → 60s 的代价（轻得多）**

- 唯一实质缺点：**未读红点的感知延迟 +15 秒平均 / +30 秒最坏**
  （事件在周期内随机发生，等待在 `[0,T]` 均匀分布：平均 = T/2，最坏 = T）。
  **按体感该用「平均 +15 秒」**，我第一次拿最坏值说成了 +30 秒，偏重了。
- 三层折扣让感知更轻：① 切回标签页 / 手机点亮 → `visibilitychange` **立即刷**；
  ② 发消息、读通知 → 调用点**立即刷**（`MessagesView` 6 处 / `NotificationsView` 4 处）；
  ③ 停在私信页时消息本身是 **5s 轮询**，红的只是导航栏那个小角标。
- 唯一受影响场景：**干坐着不动，别人发消息给你** → 最坏 60s 才亮。

**C. 顺带发现的既有缺陷（不是这两项改动引入的，别误记）**

`badgeStore.js` 的失败退避**从未生效**：`ok = !!(dm && notif)`，但 `dm`/`notif` 是
`safe` 包装——**永远返回对象、从不返回 null** → `ok` 恒为 `true` → `backoff` 永远是 1，
云端持续故障时会**每 30 秒空转**（注释意图是「未登录不算失败，别退避」，意图合理但实现了空网）。
改 60s 后空转减半算附带好处；**要真修得改判断逻辑**（见第 七 节现存问题）。


