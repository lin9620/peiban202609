# jiaojie.md — 项目交接与进度记录

> **维护约定（必读）**：每完成一段任务（一轮改动提交/部署后），必须更新本文件的
> 「当前状态速览 / 正在做 / 已完成 / 未完成 / 现存问题 / 下一步」各节，并把这轮新踩的坑补进「踩坑录」。
> 本文件是唯一权威进度记录：口头说"做完了"不算数，以这里的证据（提交号/测试/探针结果）为准。

## 🗂️ 文档三大类分区（2026-09-20 起的结构约定）

本文件按**三大类**组织。历史章节编号保持不变（保住「见 四」「踩坑 #21」这类交叉引用），归属如下：

| 大类 | 内容 | 承载章节 |
|---|---|---|
| **第一大类 · 网页端** | 网站本身：架构、进度轮次、待办、决策、容量 | ⓪½ 架构总览 · 一～十 · 十一（App 交接背景，已归档） |
| **第二大类 · App** | 以后**所有 App 相关**内容：决策 / 规范 / 进度 / 踩坑 / 发布 | **十二「App 轨道（Capacitor）」** —— 唯一锚点，新内容一律续写在此，不再新开编号 |
| **第三大类 · 两端共通** | 网页端与 App 都适用的规则与方法 | **⓪ 长期固定规则**（技术栈/数据层双模式/命令/红线/代码规范/交付流程/协作守则）；踩坑录中与端无关的通用条目（如 #8 终端编码、#24 行尾噪声） |

**归档规则**：以后新增内容先判断归属 → 网页端写进对应网页章节、App 写进「十二」续小节、两端共用的放 ⓪ 或踩坑录并注明适用范围。App 与网页共享的资产（`src/` 代码、Supabase 库、i18n、测试工具链）改动时，**两个大类都要各自记录一行**，避免只记一头。

## ⓪ 长期固定规则（先读这里 —— 除非用户明说，否则永不违反）

### 0.1 技术栈与环境
- **框架**：Vue 3（Composition API）+ Vite 5 + Vue Router（history 模式）+ Naive UI 2 + @iconify/vue + lottie-web + @supabase/supabase-js。
- **部署**：Cloudflare Worker（静态资产 + API 网关一体，`worker/api.js`，`npm run deploy` 部署）；站点 https://dale.de5.net；Worker 项目名 `warm-paws`；路由兜底（轮 11 定案）：`not_found_handling: "404-page"`——未知乱路径返回**真 404**（防软 404，这是有意设计，别当 bug 修），仅 `/u/:id`、`/messages/:id` 两个动态直链前缀由 Worker 兜底分支改写成 SPA 壳（200）。
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
node tools/live-check.mjs   # 部署后线上验证，应输出 LIVE ALL PASS (14)
node tools/live-bundle-check.mjs  # 部署后必跑：线上入口包 SHA 与本地 dist 逐字节比对 + Supabase slug 检查（踩坑 #25/#26）
node tools/build-until-good.mjs   # 构建保险：构建→自验产物含 slug→不合格自动重试（会清掉环境里空的 VITE_SUPABASE_*）
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

# 一、当前状态速览（2026-09-22 更新）

| 项 | 值 |
|---|---|
| 项目 | peiban（陪伴 / warm-paws），路径 `D:\05ruanjian\peiban` |
| 技术栈 | Vue 3 + Vite + Naive UI；数据层双模式：直连 Supabase（`db.supabase.js`）/ Worker 网关（`db.gateway.js` + `worker/api.js`，**线上走网关**）；Cloudflare 部署 https://dale.de5.net；Supabase Postgres + RLS + security definer RPC |
| 代码 | 轮 20 已改（本轮末提交）；核心：ProfileView 帖子卡跳 /post/:id（轮 19 漏改补上）+ 恢复态死循环三层修复（SIGNED_IN 清态/12s 自愈/登录兜底）+ 限额报错同步服务端次数 + `_headers` 加 HTML no-cache |
| 部署 | 前端 Version `03376511` 已上线（轮 20）；`live-check` 14/14；**线上 index 已返回 Cache-Control: no-cache（实测）** |
| 数据库 | **`MIGRATION_bottle_quota_fishfix.sql` 已由用户执行**（探针 401=函数存在实锤）；服务端行为已全矩阵实测：捞到记账/放回不返还/失败不记账/限额 7 生效；`MIGRATION_notifications_drop_dm.sql`（轮 13 #23）执行状态仍未确认 |
| App | 轮 20 APK 已打包：SHA16 `33f42a2a5d66d71e`（`apk\warm-paws-debug.apk`+桌面备份）；**装机待做**（手机断连）；CLI 打包环境 `JAVA_HOME=D:\00ruanjiananzhuang\android-studio-quail4-windows\jbr` + `android\gradlew.bat -p android assembleDebug` |
| 测试 | 离线 **30 套 ALL GREEN**（auth-test 103/103：A30 适配自愈+新增 A44d/e/f；uifix T23 更新；post-detail 15/15）+ build 0 |

## 二、现在在做什么

- **当前任务**：轮 20（「先找根因」四条）**代码全部完成：已部署、已验证、APK 已打包**（F 区轮 20，含两个动态探针的取证结论）。**待三件事**：①手机重连后装机 ②真机验收（我的页帖子进详情页/退出登录不再见重置卡/浏览器强刷后次数两端一致/手机重测空捞不扣） ③口径确认：现行「捞到即扣、放回不返还、失败不扣」vs 用户轮 18 要的「回复了才扣」（后者需再跑一次迁移，回复才扣有防刷权衡）。
- **待用户确认**：①轮 20 四条真机验收 ②口径确认（见上） ③`MIGRATION_notifications_drop_dm.sql`（轮 13 #23，仍未确认） ④轮 18/19 遗留项复验。
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

#### 轮 14 收尾：用户重跑迁移后线上闭环 ✅

用户按提示重新粘贴执行 `MIGRATION_wall_daily_view_dislike.sql` 全份内容后，两套线上验证同时转绿：

| 验证 | 结果 |
|---|---|
| `tools/dislike-e2e.mjs`（两档判别器） | **8/8 PASS** —— 低浏览 views=2 第 1 个厌恶 `removed=false`（旧规会误下架）、第 4 个才 `removed=true`；假删除后取消一次计数回 3 且不自动恢复；高浏览 views=121 投 1 个（0.83% > 0.5%）→ `removed=true` |
| `tools/cloud-e2e.mjs` | **37/37 PASS** —— 之前失败的 T19b/T20/T21 全部转绿，服务端判定与前端 `shouldRemove()` 完全一致 |

**#26 至此真正闭环**：用户最初的投诉（"一个用户点一下就下架"）根因是旧版「纯比例 1%」在小分母下极易触发；现规则为**低浏览按人数（>3）、高浏览按比例（>0.5%）**，且这条迁移**今后每次改阈值都必须重跑整份文件**（已写进 README 同一条目）。

### 轮 15：用户反馈 12 条（网页/App 共有 7 + 手机端 5；提交 9559e20，已部署 + App 已打包）

| # | 反馈 | 落地 |
|---|---|---|
| 1 | 私信请求同意/拒绝后按钮不消失 | `acceptReq` 之前改的是 rowView 展示拷贝 → 列表纹丝不动；改为改 `convs.value` 原始行 + `meta`（拒绝=hide 本就会移除） |
| 2 | 抱抱点了又取消又点、通知太多 | `MIGRATION_notif_dedupe.sql`：① 同人同帖同类回应未读只留最新一条 ② **删除回应 = 撤销对应未读通知（undo 触发器）** ③ 宠物互动同人同动作 24h 只留一条 ④ 历史重复未读清理。探针 5/5（P3 取消 → 未读归零） |
| 3 | 一进去十几条通知实际只显示 3 条 | 聚合组带 **×N 徽标**；**点一条 = 整组标已读**（`notifyRules.idsOf`）；markAll/清空后 `cacheDrop("notif:")` 防未读「复活」 |
| 4 | 「我的帖子」显示完整 | ProfileView 卡片改暖心墙同款（完整正文 + 配图 + 作者行）；`/my-posts` 本就完整 |
| 5 | 发帖每天 1 → 7 条、每帖 1 图 | `wallRules.WALL_POST_DAILY_LIMIT=7` + 发帖页剩余条数 + 单图；`MIGRATION_wall_daily_7.sql`（触发器 ≥7 拒 + 拆 `one_per_day` 唯一索引）+ SETUP 同步；cloud-e2e T23/T24 线上确认 |
| 6 | 暖心墙「最新」按钮去掉 | `SORT_BTNS = SORTS.filter(key !== "new")`：new 仍是默认排序逻辑，按钮不再出现 |
| 7 | 一堆英文乱码 | `index.html` 启动看门狗：`preloadError` 自动重载一次 + 6s 未挂载把 SEO 英文占位换成中文提示；404 页双语 |
| 8 | App 生成分享图片没用 | 根因：Capacitor WebView 无 DownloadListener，`<a download>` 无效。新增原生 `WpSharePlugin`（cacheDir + FileProvider + ACTION_SEND 系统分享面板，MainActivity 注册）；ShareCard 分层：App 走原生 → 网页走 `navigator.share(files)` → 桌面下载兜底；跨域图 `crossOrigin="anonymous"` 防画布污染 |
| 9 | 金币只能领一次 | `dailyTasks.claimed` 布尔 → `claimedMap` 按任务记账：领过后再完成的新任务随时可领；旧存档自动迁移；按钮显示待领数 `{c}` |
| 10 | 手机横屏 | `AndroidManifest` 加 `screenOrientation="portrait"` |
| 11 | 换账号漂流瓶次数还是上个人的 | 次数记账键按 uid 分域（`warm-paws-bottle-quota-v1:<uid>`），`watch(myId)` 换号立即换账本 |
| 12 | 已捞到有回信的不能点 | 记录列表对「收到回信待决定」的条目直接给「同意/拒绝」按钮，同意即进聊天；新文案 `bottle.stDecide`（zh/en 成对） |
| 13 | 评论数点击弹输入框（手机） | 手机形态展开评论默认只读，点「✎ 写评论」才出输入框（`cmtCompose`，桌面不变） |

- **工具沉淀**：`tools/build-until-good.mjs`（构建 + 自验产物含 slug + 不合格自动重试，防坏包出门）、`tools/live-bundle-check.mjs`（线上入口包与本地 dist 逐字节比对 + hasSlug 检查）。
- **本轮事故（已修复，教训见踩坑 #25/#26）**：一次 `npm run build; npm run deploy` 链式执行，build 被 env-guard 拦下后 deploy 照跑 → 坏包上线（线上无 Supabase 配置、登录失效）。复部署后线上 `hasSlug=true`、SHA 与本地一致。
- **验证**：i18n 19 / wall-rules 39 / cache 12 / undef 0；线上 `cloud-e2e` 38/38、通知去重探针 5/5、`live-check` 14/14；README（排序/每日 7 条/迁移 12·13/工具清单）已同步。


## 四、还没做的

| 项 | 说明 | 依赖 |
|---|---|---|
| #26 线上 SQL 未生效 | ✅ **已闭环（2026-09-19）**：用户重跑整段迁移后，判别器 **8/8 全绿** + `cloud-e2e` **37/37**（T19b/T20/T21 全部转绿） | 无需再动 |
| #23 迁移执行状态未确认 | `MIGRATION_notifications_drop_dm.sql`（清历史 dm 通知 + 拦新生成）；轮 13 报的待执行，用户尚未明确反馈已跑 | **未跑则通知中心残留老私信条目**（其余不受影响） |
| 轮 15 实机验收 | 12 条反馈已上线 / App 已打包，需真机逐条验收（重点：App 分享面板、竖屏、金币重复领取、漂流瓶换号记账、通知 ×N 与取消撤销、每日 7 条） | 用户实机 |
| #1/#3/#11/#17/#22/#27/#28/#29 实机验收 | 代码已上线，但真实浏览器/手机交互未验收（本地无浏览器自动化） | 用户实机点一遍 |
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

1. **等用户实机验收轮 15 的 12 条**（App 端重点：分享面板、竖屏、金币重复领取、漂流瓶换号记账；网页端重点：通知 ×N 与取消撤销、每日 7 条、私信请求按钮消失）。
2. 确认 `MIGRATION_notifications_drop_dm.sql`（轮 13 #23）是否已执行；未执行就跑。
3. 用户通知后开工 **#7 暖心故事** 与 **#12 宠物年龄衰老**。
4. 有量之后（不急）：图片搬 **Cloudflare R2**（方案 B，出口永久免费）。
5. 下一轮收尾：**先更新本文件再结束回复**（含 README 两处项数校准，见踩坑 #19）。

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

24. **`git diff --check` 恒报「trailing whitespace / ^M」是既有噪声，不是本次引入**：仓库 .sql/.js/.vue 源文件全部是 **CRLF 行尾且没有 `.gitattributes`** → 任何改动那一行都会被 diff-check 标成行尾空白。**教训**：判定「有没有弄坏行尾」的正确方法不是看 diff-check 退出码，而是**统计 CRLF 与 LF-only 计数**（混合行尾时 LF_only > 0）——本项目八个高频文件实测 LF_only 全为 0，属健康。要彻底消除噪声需加 `.gitattributes` 并做一次全仓 renormalize，属独立事项，别顺手混在功能提交里。

25. **build 失败后 deploy 照跑，坏包上线（轮 15 真凶）**：`npm run build; npm run deploy` 用 `;` 链接，PowerShell 不看退出码——build 被 env-guard 拦下（产物没 Supabase slug）后，deploy 仍把坏 dist 发上线，线上登录整个失效（`cloud.ready=false` 退化本地模式）。**教训（强制）**：构建与部署永远分两步，deploy 前必须看到构建成功；链式命令用 `&&`（失败即停）或分开执行；部署前跑 `node tools/build-until-good.mjs`，部署后跑 `node tools/live-bundle-check.mjs`，两头都不靠运气。

26. **运行环境里空的 `VITE_SUPABASE_*` 会覆盖 .env**：agent 会话进程环境带着 `VITE_SUPABASE_URL=""`（0 字符），而 **Vite 中进程环境优先于 .env** → 产物丢 slug，env-guard 次次红（用户自己的终端没有这两个变量所以构建正常，一度误判为「偶发 flake」）。**教训（强制）**：构建脚本给子进程显式 `delete env.VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY`（`build-until-good.mjs` 已内置）；guard 连续红时先查 `Get-ChildItem Env: | ? Name -like 'VITE*'` 有没有空串，别急着怪 vite。

27. **Capacitor WebView 里 `<a download>` 完全无效**：安卓 WebView 没配 DownloadListener（grep `@capacitor/android` 全部 Java 零命中），网页端「下载卡片」在 App 里点了没有任何反应（用户报「生成分享图片功能没有用」）。**教训（强制）**：App 内凡「保存/下载/分享」类浏览器惯用手法都必须有原生兜底（本项目 = `WpSharePlugin`：cacheDir + FileProvider + ACTION_SEND 系统分享面板，MainActivity `registerPlugin` 注册，JS 侧 `registerPlugin("WpShare")` + `Capacitor.isNativePlatform()` 分层降级）；另外跨域图进 canvas 前必须 `img.crossOrigin="anonymous"`，否则 `toDataURL/toBlob` 直接抛 SecurityError。

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

---

# 十一、App 轨道交接备注（2026-09-20 · 网页主线暂缓，用户将在新会话做安卓 App）

> 用户决策：**App 开发在新的 Cline 会话进行**（本会话上下文过长、响应慢）。
> 本节写给新会话：先读完 ⓪ 固定规则与 ⓪½ 架构，再读本节，即可直接开工。

## 1. 任务定义

把现有 Vue3 网站做成安卓 App 上架 Google Play。**复用现有网站，不重写。**
三条候选路线（新会话需先给对比再等用户拍板）：

| 路线 | 成本 | 说明 |
|---|---|---|
| **TWA**（Trusted Web Activity） | **最低，推荐起步** | 用 Bubblewrap/PWABuilder 把 `https://dale.de5.net` 包成 APK/AAB。前提：① 网站加 PWA `manifest.json` + 512px 图标（当前只有 favicon/apple-touch，**没有 manifest**）；② 域名根放 `.well-known/assetlinks.json`（Cloudflare public/ 加静态文件即可）做应用验证。注意 Worker 的 SPA 回退：`/.well-known/assetlinks.json` 需要能直接命中静态文件（workers assets 优先静态，应无碍，但要实测） |
| Capacitor | 中 | 现有 `dist` 包进原生壳，可加原生插件（推送等）；构建链变重 |
| 原生重写（RN/Flutter） | 高，**不建议** | 网站已功能完备，重写无收益 |

## 2. Google Play 硬门槛（逐条对照现状）

| 门槛 | 现状 | 待办 |
|---|---|---|
| 开发者账号 | 无 | 用户自行注册（**$25 一次性**，注册后审核需数天） |
| **应用内自助删号**（账号系统 App 强制，2024 政策） | ❌ **没有**——只有隐私政策写了“联系管理员删除”（网页版探针确认过无删号能力） | **第一批任务**：设置页加「删除我的账号」，走 Supabase：前端调 `auth.deleteUser()` 需 service key 不行 → 正确做法是 security definer RPC（`is_admin` 同款授权思路：只删自己的行，`auth.uid()` 校验）级联清理 profiles/posts/comments/reactions/pet_*/dm_*/notifications（FK 大多已 on delete cascade，逐表核对）+ Storage 对象删除；隐私政策 §删号 时限同步改 |
| 隐私政策链接 | ✅ `https://dale.de5.net/privacy`（预渲染、可抓取） | 无 |
| 数据安全表单 | — | 按 privacy 页内容如实填（只收 email/昵称/用户内容图片；不转售/不分享） |
| 内容分级/目标受众 | — | 表单如实填；13 岁以下定位会触发家庭政策，如实填“不面向儿童” |
| 签名/上架格式 | — | AAB + Play App Signing；版本号递增 |

## 3. 网页侧要为 App 做的配合改动（都在现有仓库）

1. `public/manifest.json`（name/short_name/icons 192+512/start_display/theme_color——复用 `--brand` 橙）
2. `public/.well-known/assetlinks.json`（TWA 签名指纹，Bubblewrap 生成时给出）
3. 检查 WebView 兼容：全站依赖 localStorage/网络字体/Supabase——TWA WebView 均支持；**无浏览器扩展干扰**（反而更稳）
4. iOS 若日后要做：同一套 PWA 基建，Add to Home Screen 即可，另议

## 4. 不要重复踩的坑（见 九 踩坑录全文，App 轨道特别相关）

- **#21/#22**：改 SQL 规则必须整份重跑迁移 + 判别器要能唯一解——App 上架改后端规则时同样适用
- **#24**：`git diff --check` 的 CRLF 噪声是既有仓库问题，别误判自己引入
- 用户能做/AI 不能做：**只有用户能**执行 SQL DDL、实机验收、注册 Google Play/开发者账号、在 Play 后台操作（分工见 ⓪½ L 节）

## 5. 本会话遗留（新会话不用管，网页主线回本会话或另开）

- #7 暖心故事、#12 宠物年龄衰老：等用户通知
- #10 评论数跨浏览器：等用户提供故障浏览器
- 实机验收：#1/#3/#11/#17/#22/#27/#29 等（见 四）
- Workers 容量 ~700-1000 日活见 十；付费阶梯与三项优化清单也在 十

---

# 十二、App 轨道（Capacitor）—— 设计规范与进度（2026-09-20 起，App 事项唯一权威记录）

> 路线已拍板：**Capacitor**（推翻第十一节「TWA 推荐起步」的倾向；对比讨论后用户选定，动因：iOS 规划与推送等原生能力预留）。
> 本节为 App 事项的唯一权威记录，以后 App 的决策/进度/踩坑都记在这里；第十一节保留作交接背景。

## A. 已拍板决策（设计规范 v0.1）

| # | 决策 | 内容 |
|---|---|---|
| D1 | 技术路线 | **Capacitor 8**（非 TWA）：`dist` 打包进 APK/AAB；每次网站改动需 `build → cap sync → AAB → versionCode+1 → Play 审核`；工程在 **peiban 仓库内集成**（`android/` 进仓库，`*.keystore`/`local.properties`/build 产物进 .gitignore）。**定案：appId=`net.de5.dale`（域名反写，上架后不可改）、appName=`Warm Paws`（Play 商店展示名另填完整版，如「Warm Paws · 暖心陪伴」）** |
| D2 | 信息架构 | 向小红书看齐：底部 Tab「**首页 · 暖心墙 · ＋ · 消息 · 我的**」+ 中间暖橙 ＋ 钮 |
| D3 | 首页形态 | 顶部频道条（**今日 · 漂流瓶 · 宠物**）+ 手势左右滑三联，**默认居中「漂流瓶」**；宠物联内禁用滑动穿透（画板/零食雨手势优先）；频道条只在首页 Tab 显示 |
| D4 | 中间 ＋ 钮 | 上弹两瓣：✉️ 投漂流瓶 / 🧱 发暖心墙帖；未登录点击 → 登录页 |
| D5 | 登录时机 | **小红书式「游客可玩、互动时才登录」**：浏览/本地养成免登录；发帖/评论/回应/私信/漂流瓶触发登录（与双模式数据层天然契合） |
| D6 | 通知入口 | 🔔 并入「消息」Tab 内分栏（私信 \| 通知，小红书同款）；消息 Tab 红点 = `dm + requests`（badgeStore 现状），通知红点挂分栏 |
| D7 | **UI 全面重设计** | 用户明确：**网页端布局不直接套用，位置/颜色/形状都要重新设计**（见 B） |
| D8 | 双形态共存 | 桌面 Web 版保持现有顶栏/SideRails 不变；App/窄屏走新导航 —— `Capacitor.isNativePlatform()` + 视口宽度双条件切换 |
| D9 | 数据合并 | **B：登录后以云端为准，本地数据留在设备不迁移**（≈现有网站行为）；游客期成果不升舱，登录前给出提示文案 |

## B. UI 重设计范围（D7 展开）

- **布局**：780px 单栏文档流 → 移动端全屏卡片流；SideRails 在 App 内移除/入口化
- **颜色**：品牌暖橙变量体系（`--accent` 等）保留，按移动端重新映射 surface/状态栏/导航栏；多皮肤 + 暗色跟随系统
- **形状/密度**：999px 胶囊、26px 大圆角按移动端重定密度；触控热区 ≥44px
- **组件形态**：Naive UI 桌面件（Dropdown/Dialog 顶部弹出）→ 底部 Sheet、Toast 顶部避让键盘
- **特殊场景**：手绘画板鼠标→手指；零食雨 ←→ 键→触屏操控方案；私信键盘顶起输入框；刘海屏 safe-area（现顶栏 `top:12px` 会被压住）
- **字体**：Quicksand / LXGW WenKai 打进包内（离线可用）
- **页面映射**：HomeView→首页左联；漂流瓶区块→独立中联主页面；PetView→右联；CommunityView→暖心墙 Tab；Messages+Notifications→消息 Tab 两栏（会话详情保留 push 页）；Profile/Settings→我的；WallerView/Privacy/Admin/BottleRecords→push 二级页

## C. Google Play 硬门槛与第一批任务

1. **应用内自助删号（2024 政策强制，第一批开发任务）**：设置页「删除我的账号」→ security-definer RPC（`auth.uid()` 只删自己）级联清理 profiles/posts/comments/reactions/pet_*/dm_*/notifications（FK 多已 on delete cascade，逐表核对）+ Storage 对象删除；隐私政策删号时限同步改
2. 开发者账号 $25（**用户注册**，审核数天）；数据安全/内容分级表单如实填；AAB + Play App Signing
3. 图标 512px + adaptive icon（前/背景分层）；`manifest.json` 与 `assetlinks.json`（深链校验仍建议放）

## D. 待拍板

- 壳层细节：App 图标/启动屏/状态栏具体方案（随批 3 推进逐项定）
- 深链与返回键细节（二级页逐级返回、首页双击退出、全屏场景先退场景）

## E. 环境备忘（2026-09 核实）

- **JDK**：AS 自带 JBR 是 Java **25**（`D:\00ruanjiananzhuang\android-studio-quail4-windows\jbr`）→ Gradle 8.14 不支持（class file 69 报错）；**构建用 `D:\00ruanjiananzhuang\jdk-21\jdk-21`（OpenJDK 21，华为镜像下载解压）**
- **SDK**：`C:\Users\lin\AppData\Local\Android\Sdk`（adb ✓）；`android/local.properties` 已写 sdk.dir（gitignore 内）
- **出包命令**：`$env:JAVA_HOME='D:\00ruanjiananzhuang\jdk-21\jdk-21'` → `cd android; .\gradlew.bat assembleDebug --no-daemon` → **`android/app/build/outputs/apk/debug/app-debug.apk`（4.5MB）**；全流程含依赖下载首次 3m23s 成功，依赖已缓存（后续增量构建更快）
- **网络备忘**：Gradle 发行版/大文件用「**curl 多段并行 + copy /b 合并**」（单连接仅 ~150-250KB/s，6 段并行 ~900KB/s，华为云 CDN 最快）；清华镜像会封异常网段；腾讯云 OpenJDK 镜像 404；分段的 Range 边界必须统一且最后一记 `total-1`
- Capacitor 8：Node 22+；Android Studio 2025.2.1+（自带 JDK）；SDK API 24+（最新稳定 Android 16 / API 36）
- iOS（日后）：Xcode 26、需 macOS（可用 GitHub Actions macOS runner 云构建）
- Play target API：以 Play 后台当年要求为准；App Store 审核对「与网站同内容的壳」更严（Guideline 4.2），iOS 版届时需补原生价值设计

## F. 进度

- **2026-09-20**：路线拍板 Capacitor；设计规范 v0.1 全部拍板（**D1–D9**：IA/Tab/频道条/登录时机/通知入口/＋钮/UI 全面重设计/双形态共存/数据合并=B）；UI 全面重设计原则确立；G 节动工路线图定稿；本节建档。**代码未动，等用户令开工批 1**。
- **2026-09-20 · 批 1**：
  - **T1 ✅（代码层；出包待 Android Studio）**：Capacitor **8.5.2** 安装（npm 缓存绕权限 → `D:\05ruanjian\npm-cache`，全局 npm 配置目录无写权限）；`capacitor.config.json`（appId=`net.de5.dale`、appName=`Warm Paws`、webDir=`dist`、androidScheme=https）；`cap add android` ✓ + `cap sync` ✓（Android 工程已生成）；`.gitignore` 补 `*.keystore`/`*.jks`/`android/local.properties`/build 产物红线。
  - **T2 ✅**：`uiStore.js` 导出 `isApp`（`Capacitor.isNativePlatform()`）+ `isMobileNav`（isApp ‖ 视口 <900px，断点对齐 .shell 780px）；消费方未接（批 2 T5 用），**桌面行为零变化**。
  - **T3 ✅ 全链路完成（2026-09-20）**：`MIGRATION_delete_account.sql`（security-definer RPC：按 `wall-images/<uid>/` 前缀删 Storage → 删 `auth.users` 行级联清全部业务数据；错误码 `not-signed-in`；revoke anon + grant authenticated）+ `SUPABASE_SETUP.sql` 同步 + db 双模式 `deleteMyAccount()` 成对 + Worker `/account/delete` 路由 + 设置页危险区（两步确认 + danger 样式）+ i18n zh/en 各 6 键 + 隐私政策 s9l 改「自助、立即生效」（**P23 锁形同步改**：en "immediately"/zh "立即生效"）。**迁移已由用户在 SQL Editor 执行**，线上探针三绿（临时 `_probe_delete_rpc.mjs`，跑完已删）：① RPC 存在（非 PGRST202）② 匿名被拒——**权限层 42501**（revoke anon 生效，比函数层 not-signed-in 更严；与 nick-e2e「权限层/函数层都算被拒」同口径）③ Worker `/api/account/delete` 线上 401（路由已部署）。
  - **T4 ✅（2026-09-20）**：品牌图标 **SVG 矢量重绘**（180px 源图放大 2.8× 会糊 → `tools/gen-icons.mjs`（临时脚本转正，批 3 T12 adaptive icon/启动屏复用）用 sharp 从 SVG 光栅化）→ `public/icons/`：`icon-512.png`(19KB) / `icon-192.png` / `icon-maskable-512.png`（爪印缩至 72% 安全区，背景满幅）；`public/manifest.json`（name 双语、short_name=`Warm Paws`、standalone、portrait、theme `#fff7ee`/bg `#fff0e2`）；`index.html` 加 `<link rel="manifest">`；**live-check 13→14 项**（新增 manifest 断言）。验收：seo 42/42、i18n 19、privacy 34、undef 0、build 0、cap sync ✓、部署 `c1f66f82`、**LIVE 14/14**。提交 `b274f54` 已 push。
  - **批 1 ✅ 全部收官（T1–T4）**。
  - **T5 ✅（2026-09-20）**：底部 TabBar（`src/components/TabBar.vue`：4 Tab + 中间暖橙 ＋ 钮，点击旋转 135° 弹两瓣「投漂流瓶/发帖」带副标题；红点 = `badge.dm + requests` 与桌面同口径）+ App.vue 双形态接线（`shell--mobile-nav` 形态类：窄屏/App 隐藏顶部 nav 与 💬🔔 图标、SideRails 改桌面专属、main 让位 padding；**桌面 ≥900px 零渲染零变化**）+ i18n `tab.*` 8 键 zh/en 成对（zh `tab.home`=首页 区别于 `nav.home`=今天）+ 样式（safe-area、≥44px 热区、毛玻璃、弹层动画）+ 新测试 `tools/app-shell-test.mjs` **14 项**（含桌面锚点断言：`const NAV = [` 原样、SideRails 条件渲染）。验收：app-shell 14/14、i18n 19、seo 42、privacy 34、undef 0、build 0、cap sync ✓、部署 `1c7baa18`、LIVE 14/14，提交 `d3d571d`。**投瓶跳 `/?tab=bottle`（T6 三联消费）、发帖跳 `/community?compose=1`（T10 聚焦）**。
  - **T6 准备中**：HomeView 解剖完（漂流瓶 script 120–269 + 模板 392–444，抽 `BottleView.vue`；今日内容抽 `TodayPane.vue`；HomeView 变形态路由器：桌面=TodayPane+BottleView 嵌尾，App/窄屏=三联容器）；**PetView 零路由依赖已确认可嵌 pane**。
  - **首包 ✅ 出包成功（2026-09-20）**：环境两坑已解——① AS 自带 JBR 是 Java 25，Gradle 8.14 不支持 → 装 **OpenJDK 21**（华为镜像，curl 6 段并行 90 秒）；② 缺 `android/local.properties`（sdk.dir 已写，gitignore 内）。`gradlew assembleDebug` **BUILD SUCCESSFUL 3m23s（93 tasks）→ app-debug.apk 4.5MB**。adb 未检出设备（用户未连线），等用户装机看 T5 视觉。详细命令与网络备忘已记入 E 节。
  - **验收（三层口径）**：第一层离线 ✅ —— **25 套全绿**（auth 84→**94**、worker 191→**193**、gateway 65→**66**、privacy 34、i18n 19）+ `undef-check problems=0` + build exit 0；README 已登记迁移第 11 条与计数。第二层契约 ✅（三套契约测试含新路由断言）。第三层线上：删号 RPC 探针三绿 ✅（见 T3）；**删号 e2e（真实注册→删号→复查残留）⏳ 可随后补 `tools/account-e2e.mjs`**。
  - **待用户**：① ~~执行 `MIGRATION_delete_account.sql`~~ ✅ 已执行（探针三绿）；② 装 Android Studio 后我陪跑 T1 出包；③（可选）真机/设置页点一次删号验证 UI 流程。
  - **T5 视觉反馈改造 ✅（2026-09-20，真机 APK 验收后当日落地）**：
    ① **手机端去掉「暖爪」置顶顶栏** → `.shell--mobile-nav .topbar { display: none; }`（品牌感交给启动屏/图标，导航交给底部 TabBar，账号信息去「我的」页；原「只藏 `.nav`/`.icon-link`」写法已删，`main`/`footer` 让位规则保留）；
    ② **消息页微信式（T7 提前）**：手机形态 = 会话列表页 ↔ **整屏聊天页** 二选一 —— `openConv` 手机走 **push**（历史保留列表 → ← 与系统返回键都能回列表）/ 桌面走 **replace**（双列同页，原行为零变化、不污染浏览器历史）；新增 `shell--chat` 形态类（`inChat = isMobileNav && route.name === "messages" && 有 id`）→ **TabBar 与页脚让位 + `100dvh` 整屏 + 消息区内部滚动 + 输入区自然吸底 + 顶部 ← 返回钮**（`backToList`：列表点进来用 `router.back()`，深链进来用 `router.push('/messages')`）；路由回到 `""` 时清空 `activeId/msgs/meta`（列表页立刻接管整屏）；
    ③ **安卓系统返回键（T9 提前，`@capacitor/app` 8.1.1）**：聊天页/其他二级页（他人主页 · 设置 · 通知…）→ 回上一页；四个 Tab 根视图（home/community/messagesList/profile）→ `minimizeApp()` 最小化到桌面（Android 惯例，后台保留、避免误退出）。装插件 → `cap sync`（Found 1 plugin）→ 重新出包 `BUILD SUCCESSFUL 13s（123 tasks）` → `adb install` Success，真机复验。
    **验收**：`app-shell-test` 14→**20 项**（新增 T14–T19：整屏样式 · 隐藏 TabBar/页脚 · push/replace 双形态 · ← 走 backToList · 回列表清会话 · 返回键策略）+ undef `problems=0` + i18n 19 + dm 286 + **26 套全绿** + build exit 0 + 部署 `c1973a8c` + **LIVE 14/14**。
  - **聊天页只占左侧窄条修复 ✅（2026-09-20，用户真机截图定位）**：`.dm-wrap` 桌面双列栅格的 `align-items: start` 泄漏到手机 `shell--chat`（flex column 交叉轴按 start 收缩 → `.dm-thread` 被压成 260px 靠左）→ `shell--chat` 补 `align-items: stretch`；顺手藏掉手机形态的桌面提示 `.dm-hint`、`.dm-send-row` 靠右、输入框手机短占位符「写点什么…」。真机 CDP 实测 `.dm-thread` 260→357.1px 满宽。`app-shell-test` 20→**23 项**。提交 `9258144`。
  - **T6 首页三联容器 ✅（2026-09-20）**：HomeView 变**形态路由器** —— 桌面（≥900px）= `TodayPane + BottleView` 顺序拼回（原布局零变化）；手机/App = 顶部**频道条（今日 · 漂流瓶 · 宠物）+ 横滑三联**，**默认「漂流瓶」**（D3；TabBar ＋ 钮投瓶跳 `/?tab=bottle` 由 `watch(route.query.tab)` 消费成初始联，深链同款）。新组件：`TodayPane.vue`（主视觉+陪你大厅+心情打卡+语录故事+分享卡；「去宠物」只发 `go-pet` 事件，落点由父层定：手机切宠物联/桌面跳 `/pet`）、`BottleView.vue`（投/捞/回/放回 + 记录两栏分页，含 SWR 缓存），新工具 `src/utils/panes.js`（联顺序/paneFromQuery/paneIndex/swipeDir 纯函数）。**手势**：先辨轴（纵向让位页面滚动 `touch-action: pan-y`），横向达 48px 阈值且横向占优才切联；**宠物联整段禁滑动穿透**（画板/零食雨手势优先，切联走频道条，D3）；**PetView `defineAsyncComponent` 懒挂载**（重件 Lottie 不进首屏 chunk，挂过保留不卸）。样式 `.home3/.home-chips(sticky+毛玻璃)/.home-track/.home-pane` 仅手机形态渲染，`.home3` 用 `overflow: clip`（不创建滚动容器 → 频道条 sticky 相对视口生效；老内核回退 hidden）。i18n `home.paneToday/paneBottle/panePet` zh/en 成对（今日/漂流瓶/宠物）。**测试口径随抽件演进**：bottle-test/status-test/uifix-test 的扫描目标搬到 BottleView/TodayPane（断言语义不变）+ 新增「HomeView 抽件接线」断言（桌面拼回与三联各挂一次）+ 新 `tools/home-panes-test.mjs` **9 项**。验收：**28 套离线测试全绿**、undef 0、build exit 0、cap sync ✓、gradle 出包 + adb install Success；**真机实证**（CDP）：频道条三 chip + sticky 生效、点宠物 `-200%` + PetView 懒挂载成功、回漂流瓶 `-100%`、**reload 后冷启动默认联 = 漂流瓶（onIdx=1, translateX(-100%)）**、截图视觉正常（频道条/hero/TabBar 对齐）。
  - **T7 消息 Tab 两栏（私信 | 通知）+ 我的 Tab 整合 ✅（2026-09-20）**：
    ① **分栏**：手机形态消息 Tab 顶部**分段条（私信 · 通知）**（`.dm-seg`，胶囊选中态，仅 `isMobileNav` 渲染 → **桌面零变化**）；通知段**直接复用 `NotificationsView`**（`defineAsyncComponent` 懒 chunk，不拖首屏）—— 数据层零重写，通知页自带卡片/分页/SWR 缓存原样生效；
    ② **红点挂分栏**（与桌面顶栏同口径）：私信段 = `badge.dm + badge.requests`、通知段 = `badge.notif`，均 99+ 封顶；
    ③ **免「卡中卡」**：通知段外层会话列表卡只**去装饰**（`.dm-list--seg` 去背景/描边/阴影，**保留 14px 内缩** —— 实测贴边后修正）+ 藏通知页「← 返回首页」+ 标题卡收紧；
    ④ **系统返回键先退内部层级**（App 惯例）：`uiStore` 新增**返回拦截栈** `pushBack/runBack/popBack`，App 的 `backButton` 监听**先问栈顶**；消息页挂 `segBack`（通知段 → 回私信段，其余返回 `false` 交回默认策略）；进聊天/回列表强制回私信段；
    ⑤ **我的 Tab 整合**：手机形态顶栏已隐藏（金币/连签原在桌面顶栏）→ 「我的」头部补**钱包金币**（`isMobileNav` 条件渲染，桌面零变化，页面头点击**不冒泡**）。
    ⑥ **真机调试基建现象定位（无代码改动）**：Vue 路由过渡依赖 `requestAnimationFrame`，WebView 息屏/被遮挡时 rAF 冻结 → `mode="out-in"` 停在「旧视图离场」、新视图不挂载 —— **仅调试取数环境现象**（前台用户回到 App 时 rAF 恢复、过渡自动完成，无感知）；`tools/cdp-eval.mjs` 补 `Emulation.setFocusEmulationEnabled` 后息屏也能取数。
    **验收**：`app-shell-test` 23→**28 项**（新增 T23–T27：分栏仅手机渲染 · 通知段复用与红点 · 免卡中卡（含「不得再设 padding:0」反向断言）· 返回拦截栈 · 我的页钱包）+ **28 套离线测试全绿** + undef 0 + build 0 + `cap sync` ✓ + gradle 出包 + `adb install` Success + 部署 LIVE 14/14；**实证**：新工具 `tools/web-probe.mjs`（无头 Edge + CDP + `--serve=dist --url=/messages --w=393`，精确 393px **真机等价**量真实构建产物：分栏 flex/选中态 `rgb(240,132,47)` / 通知段 `notif-back:none` + `head 14px` / `.dm-list--seg` 背景 `rgba(0,0,0,0)` 而对照背景 `rgba(255,255,255,.62)`、内缩仍 14px）；`tools/cdp-eval.mjs` 补 `Emulation.setFocusEmulationEnabled`（息屏也能取真机数据）。
  - **本地优先缓存（SWR）✅（2026-09-20，用户痛点「每次点击都重新刷新」）**：新 `src/utils/cache.js` —— 进页**先渲染 localStorage 快照**（不闪「载入中」），后台照常拉取，回来无缝覆盖并回写（`wp-cache:v1:` 命名空间，box `{t,s,d}`）；key 一律带 uid（换号不串）；登出 App.vue 按前缀清 `dm:/notif:/bottle:` 个人域；7 天 TTL 安全网 + 60 条容量护栏按写入时间淘汰；隐私模式经 storage.js 自动降级内存（storage.js 新增 `keys(prefix)` 枚举）。**接入五处**：消息会话列表 `dm:convs`、聊天首屏 `dm:msgs|<conv>`（**乐观消息在屏时不被旧响应覆盖**，交 5s 轮询/send 后重载纠正）、首页漂流瓶 `bottle:rec|<tab>`/`bottle:held`、通知首屏 `notif:p0|<tab>|<未读开关>`、暖心墙 `wall:posts`（**帖+评论数整包**，命中时评论数也是真的）；翻页/key=null 不缓存只走网络。**单测抓到并修掉一个真 bug**：swr 在 key=null 时提前 return，fresh 钩子不执行 → 翻页拿不到数据。新 `tools/cache-test.mjs` **12 项**（命中先渲染/回写/相同数据去抖/无缓存 onError/有缓存断网静默保留/fetcher null 不覆盖/换号隔离/前缀清理/容量淘汰/null 不写缓存/key=null 走网络）+ `tools/cdp-eval.mjs` 转正常驻真机调试基建。验收：**27 套离线测试全绿**、undef 0、build exit 0、cap sync ✓、gradle 出包、adb install Success、部署 `1cc4691d`、LIVE 14/14；**真机实证**：用户正常使用 27s 后五域缓存全部落盘（convs 2 行 / msgs 8 条 / bottle 3+1 / wallPosts 整包）——下次点击即秒开。
  - **T8 用户反馈批量修 ✅（2026-09-20，用户 17 条意见一次落地；网页端+手机端全改）**：
    ① **共有-回应 toggle（根因级修复）**：抱抱/暖暖/同感点第二次不取消的真因是 `cloud.ready` 在**会话恢复完成前置位** → `reactions/mine` 拿到空会话 → 前端以为没点过。`supabase.js` 改为**会话恢复后再置位 ready**；`toggleReaction` 支持取消（worker 增 `/api/wall/reactions/mine`，supabase/gateway 双适配器）；桌面+手机行为一致；
    ② **共有-不喜欢**：按钮调大、**点击后不再显示比例**（只显示次数不带百分之比）、点了这条帖子**立即从列表消失**（本地移除 + 云端下架计数）；
    ③ **共有-默认推荐**：暖心墙默认 `recommend` 排序（`wallRules.DEFAULT_SORT`，**近 7 天内容按稳定哈希随机推荐**，参数化天数后续可调 5/3/2）；
    ④ **共有-我的帖子**：我的页默认显示**最新 3 条**，「暖心墙」入口改「**更多**」→ 新页面 `/my-posts`（**默认 10 条 + 下拉每次再载 10 条**，数据层补 `offset` 分页，worker `parseOffset` 支持）；
    ⑤ **共有-食谱入口**：我的页「我的食谱」点击**跳 `/pet?tab=book`**；
    ⑥ **共有-回复聚焦**：点「回复」或评论内容**一次点击直接出输入框且光标已聚焦**（`nextTick` focus 锚点，不用二次点击）；
    ⑦ **手机-消息 Tab 三栏**：分段条改 **漂流瓶 | 会话（居中）| 通知**（原文案「会话中心」改「会话」）；
    ⑧ **手机-加号面板**：点击上方**遮罩空白即关闭**（`tabbar-mask`）；
    ⑨ **手机-发布收拢**：暖心墙顶部发布框手机端隐藏，发布只走 ➕ → **新页面 `/compose` 独立发帖页**（大输入框；ComposeView 重建，之前文件是截断的坏文件）；
    ⑩ **手机-捞瓶结果居中**：捞到的瓶子**居中弹出**（`bottle-tray` fixed 居中 + 背景压暗），不再沉在页面下方被忽略；
    ⑪ **手机-首页三联**：空白联**不渲染**（无内容联不出现空白页）；「今日」联**去掉宠物项**；**去掉三联区毛玻璃**；
    ⑫ **手机-暖心墙触底加载**：默认 10 条，**滑到底自动再载 10 条**（IntersectionObserver 哨兵，手机常用模式）；
    ⑬ **手机-页脚隐私**：页脚「隐私政策」去掉，**入口挪到设置页**；
    ⑭ **手机-陪你大厅可点**：「这里不止你一个人」卡**可点击**（之前整卡无事件）；
    ⑮ **手机-TabBar 纯文字**：去图标只留文字、字号调大、**选中项文字放大**（小红书式）；
    ⑯ **手机-首页三联手势补漏**：宠物联内**左滑可回到漂流瓶**（之前宠物联禁滑穿透后回不去）；
    ⑰ **共有-旅行睡着提示**：宠物睡觉时点「送宠物旅行」**给提示**（不再无反应）。
    **验收**：`app-shell-test` 28→**33 项**（本批 5 个新行为断言）+ **28 套离线测试全绿** + undef 0 + build 0 + LIVE 14/14；`web-probe`（393px 真机等价）实测 home/messages/compose/my-posts/pet?tab=book 五页全过。APK 已出包；真机未连接，待装机复验。
  - **轮 16 · 登录页独立 + 设置页 Soul 风格重构（2026-09-21，已部署：线上入口 bundle 与 dist 逐字节一致 `live-bundle-check` SHA16=7ea6b17445be0748，LIVE 14/14，/login /settings /messages 及 /u、/messages 深链线上全 200）**：
    ① **新登录页 `/login`**：把「我的」页里的登录/注册/忘记密码/Google/重置密码整体搬出独立成页（手机+网页共用同一组件）—— `src/views/LoginView.vue`（路由懒加载）。登录成功按 `?redirect=` 回跳，只认站内 `/` 开头路径（防开放跳转）；**Google OAuth 往返会丢 query** → 跳转前把目标存 `sessionStorage(wp-auth-redirect)`，回来取回并清掉；已登录再进 /login 自动回跳；**例外**：重置密码落地（`cloud.recovery`）时虽已是登录会话也不跳走，先显示「设置新密码」表单；`?forgot=1` 直达忘记密码表单（「我的」页重置链接失效卡用它）；
    ② **「我的」页瘦身**：未登录时原登录大卡换成一张入口卡（按钮 → `/login?redirect=当前页`，带当前 fullPath）；recovery / recoveryErr 卡保留（老的重置邮件可能回落 /profile）；登录表单相关 ~90 行逻辑与四个 supabase 导出删除；
    ③ **设置页 Soul 风格重构**：顶部身份卡（渐变圆头像 + 昵称 + 邮箱；游客显示 🐾 + 「去登录」按钮）+ 分组行式条目（**外观 / 账号 / 通知 / 危险区 / 关于**），行点击展开（皮肤/语言胶囊组、昵称/改密码表单、删号两步确认），通知总开关 + 三类偏好改 Soul 式 toggle；功能与旧版一一对应（皮肤/语言/昵称/改密/通知偏好/删号/隐私政策/回「我的」），`set-opt/set-opts` 复用全局类；手机形态带 ← 返回（有历史 back、深链 replace /profile）；
    ④ **i18n**：新增 `login.title/sub/guestTitle`（en/zh）与 `settings.appearance/account/about/dangerZone/tapToLogin/nickRow/pwRow/notifRow`、`profile.goSignIn` 成对键；
    ⑤ **踩坑**：editor 分段写入 SFC 时 insert_line 定位漂移造成 script/template 交错 —— 大文件改用 PowerShell here-string（`Set-Content`/`Add-Content` 逐块追加）一次性重排，块边界用 `^<script|^</script>…` 断言验证后再继续。
    **验收**：i18n 19/19 + undef 0 + smoke 35/35 + dev 编译 `/login`、`/settings`、`/profile` 全 200 + `npm run build` ✓（13.8s）；部署 ✓（2026-09-21 bundle 校验一致）；真机验收待做。

  - **轮 17 · 收尾修复 5 项（2026-09-21，已部署 Version 4d7f1911）**：
    ① **未登录入口统一**：Compose/Messages/Notifications/MyPosts 四页的「去登录」改跳 `/login?redirect=当前页`（登录后原路回来），不再绕道「我的」页；MyPosts 未登录从一行文字升级为入口卡 + 按钮（与全站同口径）；测试补 `A44b/A44c`；
    ② **文档实证回填**：轮 16 标「已部署」（live-bundle-check SHA16 一致 + LIVE 14/14 + /login /settings /messages 及深链线上 200）——此前「未部署」是过时记录；
    ③ 删临时探针 `tools/_probe_routes.mjs`（`tools/_*` 用完即删约定）；
    ④ `apk/` 进 `.gitignore`（调试包二进制不入库，发版走 Play 后台）；
    ⑤ **seo-test T25 时区假红修复**：lastmod 判定基准从「测试运行时刻」改为「dist/sitemap.xml 自身 mtime 的 UTC 日」（= 构建时刻证据）——本地 00:00–08:00（UTC 还是昨天）跑测试不再假红，陈旧产物仍会被抓出。
    **验收**：离线 30 套全部退出码 0（含 auth 新增 A44b/c）+ undef 0 + `npm run build` 0 + seo 42/42 + `live-check` 14/14 + `live-bundle-check` 本地=线上（SHA16 `07ba42e50b687db9`）+ cap sync android 完成；APK 重打包待用户真机验收。

  - **轮 18 · 用户反馈 7 条（2026-09-21，已部署 Version b0c514e9）**：
    ① **次数显示打架（网页+App 共有）**：根因——每日次数记在**本机 localStorage**，网页/App 各记各的账，跨端必然打架。修法：新 RPC `bottle_quota()`（UTC 日服务端权威计数）+ Worker `GET /api/bottle/quota` + 前端 `bottleQuota()`；显示一律「服务端值优先，本地账只做乐观显示与迁移未跑时兜底」。
    ② **帖子卡完整渲染（共有）**：「我的」页区块 + /my-posts 全量页的帖子卡与暖心墙**同款结构**（头像/署名/时间/全文不截断/配图/三类回应数/浏览数），点卡片回墙互动。
    ③ **启动闪英文（共有）**：三层修——(a) 启动看门狗 6s 未挂载 → 英文 SEO 占位换成**中文**提示+重试按钮（App 内占位被剥离的场景也覆盖）；(b) `vite:preloadError` 自动整页重载一次（sessionStorage 防循环）；(c) i18n 首启默认语言**跟随系统**（中文手机首启即中文，用户手动选过的存档优先）。
    ④ **捞 1 次被锁死 + 空捞也扣次数（手机端）**：根因一——旧版「手里压着一封信就禁捞」+ 托盘只显示一封；改**多封托盘**（新捞 + 未回的合并、逐封回/放，捞新信互不阻塞）。根因二——旧 `bottle_fish()` 先 insert 计数、再条件更新，竞态落空返回 null 被客户端误当「捞到了」；迁移把捞信重写为**抢占式重试（最多 3 次）**：`found` 才记次数，**绝不返回 null**；前端空捞明示「海里暂时没信」且不扣次数。
    ⑤ **显示被捞走了却不能聊天（手机端）**：这是产品规则（写信人要等对方**回信**后才决定是否聊天），问题在状态不可见 + 入口藏太深。修法：记录卡状态机补齐「被捞走了 · 等对方回信后可开始聊天 / 在你手里 / 已放回」；收到回信后**记录上直接给「同意/拒绝」按钮**（BottleView 与 BottleRecords 双处），同意即建会话并跳进聊天。
    ⑥ **首次进主页漂流瓶记录空白（共有）**：旧版只在 onMounted 拉一次，那一刻会话往往还没就绪、拉了个空就再也不拉；改 `watch([cloudSigned, myId])` 自动（重）拉托盘+记录+次数，登录就绪/换号都刷新，不再依赖手动点刷新。
    ⑦ **暖心墙下拉刷新（手机端）**：轮 14 写了 ts/tm/te 三个函数却**从未绑到模板**（死代码，用户看到「完全没做」）——现在绑上（CommunityView + MyPostsView 两处）：顶部下拉 60px 松手重拉，指示条跟手回弹。
    **交付物**：`MIGRATION_bottle_quota_fishfix.sql`（**需用户在 Supabase SQL Editor 执行**——未执行时前端自动退本地账，跑完自动恢复服务端权威；探针实测 `bottle_quota` 线上 404 = 尚未执行）；`SUPABASE_SETUP.sql` 已同步 quota+抢占式捞信（新装库免跑迁移）；测试 bottle-test 扩到 **46 断言**（空捞不扣次/迁移契约/SETUP 同步/Worker quota 路由/自动加载/多封托盘），全量 **29 套 ALL GREEN** + undef 0 + build 0。
    **验收**：已部署（live-bundle-check SHA16 `4d1696d95b15f74e` 本地=线上）+ live-check 14/14 + cap sync 完成（android assets 同哈希）。**APK 已由本轮 CLI 打包完成**（JAVA_HOME=Studio JBR + `gradlew assembleDebug`，包内 assets 三项验证通过：轮 18 bundle/无 SEO 占位/中文兜底在），产物 `apk\warm-paws-debug.apk`（4.85MB）。**待用户**：① Supabase 执行迁移；② 安装 APK 后真机验收 7 条。

  - **轮 19 · 用户反馈 4 条（2026-09-22，已部署 Version c063b684，已装手机并启动）**：
    ① **退出登录误跳重置密码页**：根因——恢复密码的标记（isRecoveryEvent）把恢复完成后的会话事件也误判成恢复，登出后 token 刷新又触发，直接渲染重置卡。修：仅当事件本身是 `PASSWORD_RECOVERY` **且带 session** 才置恢复标记；`SIGNED_OUT` 时清掉恢复标记与表单态。
    ② **我的帖子独立详情页**：新增路由 `/post/:id`（postDetail）+ `PostDetailView.vue`（377 行）——完整帖子卡（全文不截断 + 配图 + 回应行 + 浏览/厌恶）+ **与暖心墙同款的评论**：点「N 条评论」展开、两级回复（回复「回复」仍挂一级下并 @对方）、就地回复框、删自己的评论、未登录给登录提示。数据链新增**单帖读取**：`wall.js cloudFetchPost` + `db.getPost`（直连/网关两适配器）+ Worker `GET /posts/:id`（objectOrPassthrough 翻译行不存在；老库无 removed 列自动降级）。零新迁移、零新 i18n 键（复用 comment.*/community.*/common.*）。「我的帖子」点卡片从「跳回暖心墙」改为进详情页。
    ③ **首页三联改「宠物｜今日｜漂流瓶」**：开局不再直接是漂流瓶（首拉慢、延迟感重）——今日内容秒开，默认联=今日；滑动边界改为顺序无关写法 `HOME_PANES[idx±1]`。
    ④ **消息页左右滑动**：分栏（会话|漂流瓶|通知）支持与首页同款手势左右滑动切换。
    **验收**：全量 30 套 ALL GREEN（app-shell-test 修 T31 过时断言→40/40）+ 新增 post-detail-test 14 断言 + home-panes 9/9 + api-contract 83/83 + gateway-contract 66/66 + build 0 + live-check 14/14 + cap sync + APK SHA16 `32c0061efd5dab77` 已 `adb install -r` Success 并启动（包名 `net.de5.dale`）。
    **待用户**：真机验收 4 条（①退出登录后回登录页而非重置页 ②我的帖子点进独立详情页、评论可展开 ③首页左右滑=宠物|今日|漂流瓶 ④消息页左右滑切换分栏）。

  - **轮 20 · 「先找根因」四条（2026-09-22，已部署 Version 03376511）**：
    **取证（按用户要求先诊断）**：写了两个动态探针（用完即删）+ 读 auth-js 源码，全部实锤后才动手。
    ① **「我的」页帖子跳暖心墙**：轮 19 **改漏了文件**——只改了 /my-posts（MyPostsView:93），「我的」页帖子卡在 ProfileView.vue:308 还是老跳转。修：`:to="'/post/' + p.dbId"`。
    ② **退出→登录→又见重置卡**：动态探针（注册真账号实测事件序列）——signOut 只发 SIGNED_OUT、密码登录只发 SIGNED_IN，**都不发 PASSWORD_RECOVERY**（轮 19 注释里的「signOut 怪癖」不存在，已更正）；auth-js 2.116.0 源码：PASSWORD_RECOVERY 全库仅 3 处发出点（427/1652/2070），全部是「URL 回调带 type=recovery 令牌」。⇒ **recovery 残留只来自地址栏失效恢复链接**：令牌失效消费失败 → supabase-js 不清 URL → 我们只在「有会话」时清 → **每次页面重载 captureRedirect 重新点亮重置卡（死循环）**。修三层：SIGNED_IN 一到强制清恢复态（auth-js 里与 PASSWORD_RECOVERY 二选一互斥）+ captureRedirect 失效落地 12s 自愈（清 URL 回登录卡，真链接 1-2s 完成消费不受影响）+ LoginView doAuth 成功 cloudClearRecovery 兜底。
    ③④ **次数打架/空捞扣次**：**迁移已被用户执行**（探针 `bottle_quota` 从轮 18 的 404 变 401=函数存在实锤）。双账号全链路实测线上服务端行为矩阵：quota RPC 经网关通 ✓、捞到记账 ✓、放回不返还 ✓、**失败/空捞不记账 ✓**（C 连捞 7 次计数=7，第 8 次失败后仍=7）、限额生效 ✓ ——「没捞到也扣次数」在服务端已不存在；「显示还能捞2但用完」「手机3封/网页0封」是**迁移生效前的观测**（当时前端退回各端各记各的本地账）。前端自愈补丁：限额报错瞬间强制 syncQuota（BottleView doSend/doFish catch）。**缓存修复（「改了不见好」最大嫌疑）**：index.html 此前**无任何 Cache-Control** → 浏览器启发式缓存持旧 bundle → `_headers` 给 `/*` 加 `Cache-Control: no-cache`（assets 保持 immutable；线上已验证 index 返回 no-cache）。**口径说明（待用户确认）**：现行规则=「捞到即扣、放回不返还、失败不扣」（防无限刷信必需）；用户轮 18 曾要「回复了才扣」——改它需动服务端限制口径（bottle_reply 记账+limit 改数回复，再跑一次迁移），等确认。
    **验收**：全量 30 套 ALL GREEN（auth-test A30 更新+新增 A44d/e/f → 103/103；uifix T23 深链断言更新；post-detail 15/15）+ build 0 + 部署 Version 03376511 + live-check 14/14 + 线上 index no-cache 实测 ✓ + cap sync。
    **APK**：SHA16 `33f42a2a5d66d71e` 已打包（`apk\warm-paws-debug.apk` + 桌面备份）；装机因手机断连**待做**。
    **待用户**：①重连手机→我装机 ②真机验收四条（我的页帖子进详情页/退出登录不再见重置卡/浏览器强刷后次数一致/手机重测空捞不扣） ③口径确认（捞到即扣 vs 回复才扣，回复才扣需再跑一次迁移）。

  - **轮 21–25 · 漂流瓶口径重构 + App 登录链路 + 启动页（2026-09-22，最新部署 Version 877c016f）**：
    - **轮 21（`235c71b`）**：①**次数口径改为「回信才扣」**（用户拍板）——迁移 `MIGRATION_bottle_reply_quota.sql`：捞信不记账、`bottle_reply` 成功那一刻盖章计次、quota 只数「今日已回信」；顺带修「跨天捞→放→捞一次回信扣 N 次」（只盖最新一行）与「囤 ≥7 封未回拦截新捞」（`bottle-stock-full` 专属文案）；SUPABASE_SETUP.sql 三函数同步。②**退出→登录又见重置卡真根因**：ProfileView `@click="goSignIn"`（无括号）把 MouseEvent 当 `withForgot` 传参 → 跳 `/login?forgot=1`——修 `goSignIn(false)` + 函数内 `=== true` 双保险。
    - **轮 22（`315f257`）**：捞信结果一律**居中弹窗**（捞到=弹窗展示全文+就地回信/放回；没捞到/限额/囤满=弹窗说清原因），「点捞没动静」不再存在。
    - **轮 23（`8057127`）**：**手机端全挂 fail-to-fetch 根因**=国内网络对 supabase.co 的 TLS 重置（logcat `net_error -101` 实锤）。治本：Worker 新增 `/sb/*` 透明代理（auth/REST/Storage 全透传，带 apikey/JWT，CORS 预检补齐 supabase-js 自定义头）+ 前端 `sbFetch` 重写与图片 URL 改写——网页/App 统一走 `dale.de5.net/sb`，线上实测注册/登录真返回 token。
    - **轮 24（`f02c039`/`c1a94fd`）**：**启动页**（index.html 静态层盖白屏窗口；云端就绪+会话列表缓存预热后淡出，2.5s 兜底放行；看门狗触发先摘启动页）+ **黑边第一层**（capacitor `android.backgroundColor` + `html` 兜底底色）。
    - **轮 25（本次）**：①弹窗「先收着，稍后回」**按用户要求移除**（捞到当场回信或放回，popKeep 键双语清干净，bottle-test 加不许回归守护）；②记录卡补齐押信按钮（轮 24c：「我捞到的」里 held 信**卡上直接回信/放回**，回复框卡内展开，`bottle.replySend` 双语键补齐）；③**黑边原生层根因**：styles.xml `AppTheme.NoActionBar` 的 `android:background=@null`（窗口底渲染成黑）→ `android:windowBackground=#FFF7EE`。
    **验收**：bottle-test **59/0**（新增「弹窗只有回信/放回」不许回归断言）+ 全量 **31 套 0 fail** + build 0 + 部署 Version `877c016f` + APK 重打（styles.xml 原生层改动，BUILD SUCCESSFUL 15s）。**待办**：手机断连未装机——重连后 `adb install -r apk\warm-paws-debug.apk`。

  - **轮 26 · 捞信提速 + 弹窗禁闭 + 启动页加厚（2026-09-22，已部署 Version dc1e6f67）**：
    ① **捞信反馈 <100ms**：doFish 现在**按下瞬间**就弹「撒网中」弹窗（🎣 钓竿轻摆动画 + 「海风正把信往你这边送」），RPC 回来秒切信内容——不再网络空转 1-3s+ 毫无反应；同时加 **8s 悬死兜底**（Promise.race → `bottle-slow` → 弹窗给「再捞一次」出口；不能 3s 硬断，慢网真捞到的信会被押在海里）。
    ② **弹窗禁闭（用户明确要求）**：捞信弹窗 `:closable="false" :mask-closable="false" :close-on-esc="false"` 三重关闭——**无右上角 X、点遮罩不关、Esc 不关**，捞到信只有「回信 / 放回海里」两条路（「先收着」轮 25 已删，不许回归断言继续在）。
    ③ **启动页内容加厚**：slogan「一个温柔的角落」+ 三条特性胶囊（🐱 亲手照顾一只小宠物 / 🌊 把心事装进漂流瓶 / ❤️ 在暖心墙遇见温柔的人）+ 温柔话「你已经做得比想象中好了」，逐条浮现动画（sp-in staggered），prefers-reduced-motion 降动画保留。
    **验收**：bottle-test **60/0**（+2 断言：禁闭三属性/撒网即时弹+超时出口）+ splash-test **7/0**（+1 断言：加厚内容）+ 全量 **31 套 0 fail** + build 0 + 部署 + cap sync + APK 重打**已装机启动**（adb Success）。

  - **轮 27/28 · 图标与 FAB（`404eae4`，APK 21:43 已发测试者）**：①App 启动图标换品牌款（橙渐变圆底 + 奶油白三趾爪印，5 密度 × 方/圆/自适应 15 张重生成）；②FAB 爪印 → 温柔 ＋ 号（弹层展开旋转 45° 成 ×）；③英文 tab "Warm Wall" → "Wall" 不再折行；④APK 位置 `apk\warm-paws-debug.apk` 交测试者。

  - **轮 29 · 手机端传图失败真根因（2026-09-22，已部署 Version 9b1e7216）**：
    **根因（logcat 实锤用户 21:58 在 /compose 的真实报错）**：supabase-js Storage 上传请求带 `cache-control` 头，Worker CORS 预检白名单没放行 → 预检失败 → `StorageUnknownError: Failed to fetch`。**网页同源不发预检所以一直正常、只有 App（origin https://localhost）挂**——「传图只有手机端坏」由此完全解释。
    **取证过程（CDP 远程调试手机 WebView）**：先实测排除三项——/sb 代理 Storage 上传 200 通、直连 supabase 当时也通、4000×3000 大图 canvas 压缩 OK；再用 logcat grep CONSOLE 拿到用户真实报错，钉死预检白名单。
    **修法**：`corsPreflight(request)` 改为**回显**客户端 `access-control-request-headers`（一劳永逸，客户端带任何新头都不会再被卡）+ 显式兜底名单补 `cache-control`。
    **验证**：PC curl 线上预检回显 ✓；**CDP 在手机 App 内重放当时失败的上传 → 200 成功**（修的是服务端，**无需重打 APK**，用户手机直接重试即生效）。worker-test **195/0**（+2 守护：回显/兜底含 cache-control）+ 全量 **32 套 0 fail**。

   - **轮 30 · 登录失败锁定 + 网页去启动页（`e583ca2`）**：①**连错 5 次锁 12 小时**（两端一致）：`cloudSignIn` 内记账（`LOCK_MAX=5` / `LOCK_MS=12h`，按邮箱在本地记账，锁定期直接拒 `reason:"locked"`，成功即清零），登录页显示「先休息 {h} 小时」；②**网页端去掉启动页**（`index.html` 只在 App 壳里保留 splash，正式站点直接进首屏），splash-test 与 auth-test 同步锁形。

   - **轮 31 · App 端谷歌登录改「全程不出 App」（2026-09-22，已部署 Version `dec3cfb3`）**：
     **用户问题**：App 里点「用谷歌登录」整页跳去系统浏览器，在浏览器里登完回不到 App —— 等于登录不进 App。
     **为什么不能直接在 App 的 WebView 里登**：Google OAuth 明文禁止内嵌 WebView（`disallowed_useragent`），只能走系统浏览器组件；所以 App 内的正解是 **Chrome Custom Tabs（`@capacitor/browser`）**：视觉上仍是 App 的授权窗口、任务栈不出 App。
     **线上差分实测（钉死 redirect 白名单口径，`POST /auth/v1/authorize` + `GET /auth/v1/verify`）**：`https://dale.de5.net/**` 原样放行；**`net.de5.dale://login` 被悄悄换成站点首页**（白名单只认站内 https）——所以 `redirectTo` 绝不能写自定义 scheme。
     **方案（三段）**：①App 端 `redirectTo = https://dale.de5.net/app-auth`（站内中转页）+ `skipBrowserRedirect` 拿到授权 URL → `Browser.open` 在 App 内开授权窗口；②中转页 `public/app-auth.html` 把 `?code=` / `#access_token=` **原样**转交 `net.de5.dale://login`（先自动跳，2.5s 没走就把按钮做成「点我回 App」——按钮是用户手势，必定能拉起）；③Android `AndroidManifest` 加 `net.de5.dale://login` 的 `intent-filter`（配 `singleTask`）→ App 回前台，`App.vue` 用 `appUrlOpen` + **冷启动 `getLaunchUrl`** 取回，`cloudHandleAppRedirect()` 建会话（implicit 走 `setSession`、PKCE 走 `exchangeCodeForSession`），失败原因写 `cloud.appAuthErr` 由登录页显示。
     **同时修的基建坑**：①`env-guard` 旧口径「所有 `index-*.js` 都必须含 supabase slug」被 `@capacitor/browser` 的动态 import 懒块误报（好包被挡在门外）→ 改成**只校验 `index.html` 真正加载的入口脚本**；②`undef-check` 揪出**轮 30 的真 bug**：登录失败锁记账用了 `getItem/setItem` 却没从 `storage.js` 导入 → `ReferenceError` 被 catch 吞掉 → **「连错 5 次锁 12 小时」实际静默失效**（纯源码断言 A52 没抓住）。修法：补导入 + 记账函数导出为 `loginLockLoad/loginLockSave` 并让 auth-test **真跑 round-trip**（A101-A104）+ 失败时 `console.warn` 留痕；`undef-check` 由 2 问题 → **0 问题**。
     **验收**：auth-test **130/0**（+A80-A95 谷歌回跳接线、**A96-A100 在 `vm` 里真跑中转页脚本**（断言深链一字不差 / 自动跳转真的调了 `location.replace` / 2.5s 兜底改文案）、A88b 冷启动等云端就绪、+A101-A104 登录锁真跑 round-trip）+ 全量 **31 套 0 fail** + `undef-check 0` + build 0 + 部署（Version `69f936cb`，`live-bundle-check` 本地=线上 `c534a74a83e6f61d`）+ **aapt2 校验 APK 内已注册 `net.de5.dale://login`（`launchMode=singleTask`）** + APK 与 dist 逐文件同哈希 + APK 重打（`apk\warm-paws-debug.apk` 4.99MB SHA16 `1e47501c686d62b9`；本次手机未插 USB 故未装机，包已就绪待装）。
     **无需改 Supabase 配置**（Web 与 App 用的都是站内 https 白名单地址）；**无需再改 `Redirect URLs`**。

## G. 开发任务拆解（动工路线图，逐批交付）

### 批 1 · 地基与合规（先行，无 UI 风险）

| # | 任务 | 产出 / 验收 |
|---|---|---|
| T1 | Node 22 环境核对 + Capacitor 8 初始化：`cap init`（appId/appName 待用户定名）、`cap add android`、`.gitignore` 补 `*.keystore`/`local.properties`/`android/app/build/` | `npm run build → cap sync` 通过；Android Studio 打开工程可出调试包 |
| T2 | 双形态检测基建：`uiStore` 增加 `isApp`/`isMobileNav` 形态标志（`Capacitor.isNativePlatform()` + 视口宽度） | 桌面 Web 行为完全不变（回归测试全绿）；App 内能读到形态标志 |
| T3 | **删号功能（Play 硬门槛，第一批任务）**：`MIGRATION_delete_account.sql`（security-definer RPC，`auth.uid()` 只删自己，逐表核对 cascade + Storage 对象删除）+ `SUPABASE_SETUP.sql` 同步 + db 双模式方法 + 设置页「删除我的账号」入口（网页/App 共用） | 离线测试全绿 → **用户在 SQL Editor 执行** → 线上探针验证；隐私政策删号时限同步改 |
| T4 | 图标/manifest 资产：512px 图标（仓库现成 `sharp` 从品牌图导出）+ `public/manifest.json` | 构建产物含 manifest；图标供 App 与 PWA 共用 |

### 批 2 · App 壳与导航（UI 重设计第一波）

| # | 任务 | 产出 / 验收 |
|---|---|---|
| T5 | 底部 Tab Bar 组件（5 位含中间 ＋ 钮）+ 与桌面顶栏按 D8 切换共存 | 仅 isApp/窄屏出现；桌面回归全绿 |
| T6 | 首页三联容器：频道条 + 手势滑动（今日/漂流瓶/宠物，默认漂流瓶）；漂流瓶从 HomeView 抽出独立组件；宠物联禁滑动穿透 | undef-check + 组件级离线测试；实机滑动验收 |
| T7 | 消息 Tab 两栏（私信 \| 通知）+ 红点；我的 Tab 整合 | 复用现有 Messages/Notifications 数据层，不重写 |
| T8 | 登录页 + 互动触发登录统一拦截（D4/D5/D9 提示文案） | 游客全流程可玩；触发点弹登录；登录后本地数据不迁移 |
| T9 | Android 返回键 / 深链（App plugin） | 二级页逐级返回、首页双击退出、全屏场景先退场景 |

### 批 3 · UI 重设计细化与发版

| # | 任务 | 产出 / 验收 |
|---|---|---|
| T10 | 密度/组件形态重设计（BottomSheet、Toast 避让键盘、safe-area、≥44px 热区） | 逐页实机走查 |
| T11 | 画板手指绘画 + 零食雨触屏操控方案 | 宠物联内实机验收 |
| T12 | 字体打包离线、启动屏、adaptive icon、状态栏跟随皮肤 | 离线开 App 正常；暗色皮肤状态栏联动 |
| T13 | AAB 签名 + Play 后台提交（**用户操作**）+ 内部测试轨道 | AI 出清单与素材，用户上传 |

> 每批收尾按 ⓪.6 流程：全量离线测试 + `undef-check` + build（明确退出码）→ commit → 部署（网页侧改动）→ 更新本节 F 进度。SQL 类一律：文件就绪 → 用户执行 → 线上探针验证后才算完成。

