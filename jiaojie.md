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
node tools/cloud-e2e.mjs / dm-e2e.mjs / status-e2e.mjs  # 线上端到端（自造 wp-* 测试账号并清理）
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
| 暖心墙 | `wall_posts` | 帖子（文字+可选图）；views/dislikes/removed/created_day；**dislikes≥5 自动下架（removed=假删除）** |
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
- `wall_*`（3）：daily_limit/add_view/toggle_dislike（≥5 下架）
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
- **utils 规则层（纯函数，全有单测）**：`wallRules`（排序/范围/去重/1%→≥5 下架）、`dmRules`（撤回窗口/未读/错误码映射）、`notifyRules`（分栏/聚合/跳转）、`snackGame`、`statuses`（24h 窗口）、`authRules`、`imaging`。
- **utils 云层**：`wall`/`dm`/`bottle`/`notify`/`comments`/`admin`（封装 db 调用+降级）、`storage`（本机 localStorage：未登录兜底如 `wp-status`）、`supabase`。

## E. 视觉与设计语言
- **暖色治愈系**：CSS 变量（`src/style.css`）——墨色文字 `--ink:#4a3b2f`、主橙 `--accent:#ff9f5a`、玻璃拟态卡片 `--glass: rgba(255,255,255,.62)` + 柔和投影。
- **多皮肤**：`src/data/themes.js` 定义主题集，`uiStore` 切换（换的是变量集，不是重写样式）。
- **双语**：`i18n.js` zh/en 全量对称；emoji 写在文案里；插值 `{n}` 风格。
- **宠物**：代码生成 Lottie JSON（非美术资源）——改造型=改 `lottiePet.js`，`pet-visual-test` 钉形状断言。

## F. 测试与验证体系（接手后跑什么）
- **24 套离线测试**（`node tools/x-test.mjs`，秒级、不碰网络）：规则层纯函数 + 契约（前端↔Worker↔SQL 形状）+ i18n 对称 + 迁移覆盖。
- **undef-check / arity-test**：静态检查未导入符号与参数个数（白屏/undefined 元凶）。
- **三套线上 e2e**（注册 `wp-*` 测试账号，结束清理）：cloud-e2e 38 项、dm-e2e 47 项、status-e2e 17 项。
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
| 厌恶下架 | 累计 ≥5 个不满才下架（假删除） | `wall_toggle_dislike` SQL + `wallRules.js` |
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

# 一、当前状态速览（2026-09-18 更新）

| 项 | 值 |
|---|---|
| 项目 | peiban（陪伴 / warm-paws），路径 `D:\05ruanjian\peiban` |
| 技术栈 | Vue 3 + Vite + Naive UI；数据层双模式：直连 Supabase（`db.supabase.js`）/ Worker 网关（`db.gateway.js` + `worker/api.js`，**线上走网关**）；Cloudflare 部署 https://dale.de5.net；Supabase Postgres + RLS + security definer RPC |
| 代码 | `HEAD = origin/main = 4443b1e`（忘记密码修复），工作区干净 |
| 部署 | Worker 版本已上线（修复含 `index-CGmbko5p.js`，SHA 与本地一致）；`live-check` 13 项全过 |
| 数据库 | 10 个迁移文件**全部已在 Supabase 执行**（最后两个 `MIGRATION_bottle_records.sql` / `MIGRATION_dm_first_contact.sql` 由用户于 09-18 手动执行，已探针确认） |
| 测试 | 24 套离线测试全绿 + `undef-check` 0 问题 + 三套线上 e2e（cloud 38 / dm 47 / status 17 全 PASS） |

## 二、现在在做什么

- **当前任务**：无进行中的代码任务。第 13–22 条已全部提交部署，数据库迁移已执行并确认。
- **等待用户输入**：① 实机验收结果（见「八、下一步」清单）；② 第 10 条的浏览器型号/版本；③ 第 7 条暖心故事、#12 宠物年龄衰老的开工通知。

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
21. 厌恶下架阈值：**累计 ≥5 个不满才下架**（SQL `wall_toggle_dislike` 内改，不再是 1 人/1% 即下架）。
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


## 四、还没做的

| 项 | 说明 | 依赖 |
|---|---|---|
| #1/#3/#11/#17/#22 实机验收 | 代码已上线，但真实浏览器/手机交互未验收（本地无浏览器自动化） | 用户实机点一遍 |
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
4. 下一轮任务完成时：**先更新本文件再结束回复**。

## 九、踩坑录（勿重复）

1. **emoji 双拼**：i18n 文案自带 emoji，模板又前缀 `STATUS_EMOJI[k]` → "💻 工作中 💻"。**教训**：展示文案只从 i18n 取，映射表已删；新写文案时确认 emoji 归属。
2. **测试块结构被插入破坏（假通过）**：往 e2e 插入新用例时把 T4 塞进了 T3 的 `{}` 块内，T3 断言被挤到文件末尾执行，读到的 null 来自后面的清理步骤——**看起来 PASS 其实是假通过**。**教训**：改测试后核对用例执行顺序与作用域；断言的"前置状态"必须真前置。
3. **改名漏网**：#12 改口径时 petStore 改了，但 PetView 物种领养路径还调旧 `adoptLimitHit` → 运行时错。**教训**：重命名后全仓 grep 旧名（含 .vue 模板）；`undef-check` 必跑。
4. **i18n 占位符与传参不符**：文案用 `{lv}`、调用传 `{from,to}` → 用户看到原始 `{lv}`。**教训**：加带参数的键时，键/传参/两语言三处对齐；用 `t()` 实调验证。
5. **通知 kind 拼写不一致**：库发 `death`、前端认 `dead` → 死亡通知不显示。**教训**：事件 kind 建常量清单，生产方与消费方同源。
6. **`SUPABASE_SETUP.sql` 漂移**：只改了 MIGRATION，新装脚本没同步 → 新装库缺功能。**教训**：动 SQL 迁移必须同步 SETUP 文件（bottle_chat 漂过一次已补）。
7. **匿名探针误判"函数缺失"**：anon 调 security definer 函数报 `42501 permission denied`，与 `PGRST202` 不存在是两回事。**教训**：判定函数存在性必须区分这两个错误码；拿不准就用带 JWT 的账号探测。
8. **PowerShell 终端截断/引号地狱**：长命令被截断、中文乱码、退出码拿不到 → 我曾连续多轮重复读文件不发结论（**最严重的一次卡死**）。**教训（强制）**：复杂检查写成 `tools/_xxx.mjs` 用 node 跑；输出落盘后用 read_files 读；**拿到结果必须立刻给结论**，禁止连续多轮只读不答；收尾阶段禁止重复确认同一状态，直接执行提交/部署。
9. **构建通过 ≠ 没问题**：路由漏接线、模板引用旧符号，构建照样绿。**教训**：视图改动后跑 undef-check + grep 引用面 + e2e/探针验证线上行为，不能只报 build OK。
10. **测试账号副作用**：线上 e2e 会注册 `wp-*` 测试账号；profiles 无 delete 策略删不掉行，只能清空状态字段。**教训**：e2e 头部注明副作用；不碰真实用户数据。
11. **源码标识符在打包产物中被混淆**：搜 `sparkle0`、`petMood` 等源码名在产物里找不到，误判"没部署上"。**教训**：线上产物验证要用不会被混淆的字符串（i18n 文案、CSS 类名）或直接 SHA 比对 dist。
12. **"已完成"口径纪律**：多次被提醒"不要把代码存在/测试通过说成完成"。**教训（强制）**：每条交付必须标注到三层验收的哪一层；数据库类改动必须注明"迁移已执行/未执行"。
13. **重置密码令牌被提前抹掉（auth 时序 bug，已修）**：`captureRedirect()` 在 createClient 前就把地址栏 `#access_token` 清了，而本项目 supabase-js 默认 `flowType:'implicit'`——auth-js 要靠这个令牌建恢复会话（它自己会在建会话成功后才清 URL）。结果：点重置链接能到"设置新密码"表单，但提交必报 `Auth session missing`。**教训（强制）**：读 URL 信号 ≠ 可以清 URL；凡是"先读后交给库处理"的参数，清理必须交给库或等处理完成后兜底清。测试 auth-test A30/A30b 已钉住。
14. **PGRST202 在 error.code 而非 message（已修，影响面大）**：PostgREST 找不到 RPC 时，`error.message` 是 "Could not find the function public.xxx(...) in the schema cache"，**不含 "PGRST202" 字样**；项目三处降级判定（errorKind / isMissingFnError / bottleErrKey）只匹配消息文本 → 全部漏判，用户直接看到英文报错。离线测试里用 `"PGRST202"` 当消息喂进去是**假通过**。**教训（强制）**：写错误分类前先打一次真实请求看 message/code 长什么样；测试夹具必须用真实响应文本，不能想当然拼。
15. **改名后旧内容署名不会自动变**：署名冗余存（列表免 join 的代价）→ 改昵称必须配 RPC 同步（rename_me），否则「我改名了、墙上是旧名」。**教训**：任何「插入时快照」字段，在改源头时都要想清楚要不要回填、能不能回填（reply_to_name 无 uuid 就回填不了）。
16. **supabase-js 同一 client 在 signUp 后的"匿名"是假的**：auth-js 把会话留在内存，同一 client 后续 `.rpc()` 自动带 JWT —— 用它测"匿名被拒"会测成"匿名成功"。**教训**：真匿名断言必须 `createClient` 全新实例；同理 auth-test 等凡涉及"无 JWT"的用例都要用 fresh client。
17. **`revoke from public` 撤不掉旧库的显式 `grant to anon`**：SETUP 文件曾 `grant execute on all functions to anon`，那是显式授权，后补的 `revoke ... from public` 只撤 PUBLIC。**教训**：收权要写全角色（`from public, anon`）；判定"被拒"的测试不要写死报错话术（权限层 42501 permission denied 与函数层 raise 的 message 不同，都算拒）。
