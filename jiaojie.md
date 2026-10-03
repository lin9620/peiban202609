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
- **部署**：Cloudflare Worker（静态资产 + API 网关一体，`worker/api.js`，`npm run deploy` 部署）；站点 **https://warmpaws.de5.net**（轮 109 换域名；旧域 dale.de5.net 的面板绑定保留、双域并存）；Worker 项目名 `warm-paws`；路由兜底（轮 11 定案）：`not_found_handling: "404-page"`——未知乱路径返回**真 404**（防软 404，这是有意设计，别当 bug 修），仅 `/u/:id`、`/messages/:id` 两个动态直链前缀由 Worker 兜底分支改写成 SPA 壳（200）。
- **数据库**：Supabase（Postgres）——RLS 行级安全 + `security definer` RPC 做服务端权威逻辑；**anon key 是公开密钥，安全全靠 RLS，前端不得存敏感判断**。
- **`.env` 键**：`VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` / `VITE_API_BASE`（**网关与中转页的绝对地址，打 APK 必须指向线上域名**，轮 109 换域名改的就是它）；`.env`、`supabase.json`、`.dev.vars` 绝不提交（已在 .gitignore）。

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
node tools/<x>-test.mjs # 36 套离线测试（提交前全跑）
node tools/undef-check.mjs  # 未导入符号检查 + 「赋值给未声明裸标识符」（白屏元凶，必跑；--selftest 10 项）
node tools/tdz-check.mjs    # immediate watch 引用「后面才声明的 const」的 TDZ 检查（崩页元凶，改 .vue 必跑）
node tools/feed-window-live.mjs  # 动态流虚拟窗口真机几何取证（需 dev 服务器 + CDP 9222；改动态流必跑）
node tools/web-refresh-test.mjs  # 网页端刷新按钮与首帧 SEO 静态正文回归（6 项）
node tools/page-smoke.mjs --serve=dist   # 无头真实挂载 8 条关键路由 + 无崩溃盒断言（改 .vue 必跑）
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

### 0.6 提交与交付要求（强制流程 · **2026-09-25 用户修订：攒批提交部署制**）
> **用户新规（原话）**：「没有我同意，不要每改一次就去部署提交，等我发话，几轮之后一起部署提交。」
> 轮 1-44 一直按旧的「每轮 commit+deploy」在跑（旧 0.6 就是这么写的，已废）；**自轮 45 起改攒批制**：
1. **每轮收尾 = 改动 + 全量离线测试 + `undef-check`/`tdz-check`（改 .vue 必跑）+ 需要时本地 build / page-smoke + 更新本文件**，然后**停**——不 commit、不 deploy、不 push。
2. **`git commit` / `npx wrangler deploy` / push / 重打 APK / adb 装机，一律等用户发话**（如「提交」「部署」「打包」「装机」）。发话后把攒下的几轮**一起**处理：每轮仍各一个主题 commit（跨条目 bug 单独小提交）→ 一次 deploy → `live-check` + `live-bundle-check` → 需要时 cap sync + APK。
3. **攒批不许变糊涂账**：每轮完成时在本文件「现在在做什么」标清「改动完成、测试过了、**待提交待部署**」；发话提交时按记录清单逐轮落 commit。
4. 有新迁移不受攒批影响：SQL 文件写好即列名给用户（SQL Editor 执行权在用户），执行后用探针确认（区分 `42501` 存在无权 vs `PGRST202` 不存在）。
5. **验收口径三层，不混说**：离线单测 ≠ 接口契约 ≠ 线上端到端 ≠ 实机交互。构建通过不算完成；迁移未执行必须明说。
6. 线上 e2e 只用自注册测试账号（`wp-*`），**不碰真实用户数据**。

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
| 漂流瓶限额 | 每日写 3 封、**回信**计次 7 次/天（捞信不扣、捞到手 ≥7 封未回先处理）、信与回信各 ≤1000 字 | `MIGRATION_bottle.sql` + `_quota_fishfix` + `_reply_quota` RPC 内；**轮 37 起客户端零记账**（显示只读 `bottle_quota()`，`bottle.js` 只剩常量与错误归类） |
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
| wrangler 部署 / git 提交推送 / 打包装机 | **发话制**：等用户说「提交/部署/打包/装机」才做，攒批执行 | ✅（2026-09-25 攒批新规，见 0.6） |
| 线上探针/e2e（不碰真实用户数据） | — | ✅ |

---

# 一、当前状态速览（2026-09-28 更新 · 轮 114 换域名改动待部署）

| 项 | 值 |
|---|---|
| 项目 | peiban（陪伴 / warm-paws），路径 `D:\05ruanjian\peiban` |
| 技术栈 | Vue 3 + Vite + Naive UI；数据层双模式：直连 Supabase（`db.supabase.js`）/ Worker 网关（`db.gateway.js` + `worker/api.js`，**线上走网关**）；Cloudflare 部署 https://dale.de5.net；Supabase Postgres + RLS + security definer RPC |
| 代码 | 轮 107-113 **已提交 `8fecc0f` + `c194df0` / 已部署 `3a91942c` / APK `A4852FA5763FAE05` 已装机 ✅**。轮 112（**详情页一级评论回复框上移到「一级评论 ↔ 二级列表」之间（原在整条评论最底部，与暖心墙轮 110 同款同位）**：桌面专属纯 DOM 搬家，App/手机形态零变化）。上一：轮 111（**详情页桌面主评论输入框上移到「浏览次数 ↔ N 条评论」之间（与暖心墙轮 109 同款）；桌面悬浮底栏 cmt-bar-fixed 退役**：桌面专属）。上一：轮 110（**网页端一级评论回复框上移到「一级评论 ↔ 二级列表」之间（原在整条评论最底部），待提交待部署**：桌面专属纯 DOM 搬家）。上一：轮 109（**网页端主评论输入框上移到「浏览次数」与「N 条评论」之间（每条卡常驻），待提交待部署**：桌面专属）。上一：轮 108（**暖心墙主评论两段式，待提交待部署**：App 端卡内占位条 → 点击弹底部输入条发送在右；桌面内联框不变）。上一：轮 107（**死代码清理，待同批提交**：删孤儿组件 CommentComposer.vue + PostDetailView composer 残留 + 本文件补录轮 101-106）。上一：轮 106（**评论输入定案：恢复轮 98 基线，已提交 `bb93875` / 已部署 / 已装机**）——App 端弹窗 / Web 端内联框，两平台不同输入方式。上一：轮 84（**评论互动与详情页，已提交 `7271ce0`**）：墙内点正文/图进 `/post/:id`、评论只显前 3 条一级 + 「查看更多」、评论行 ❤️/💔（RPC 服务端权威计数）、详情页评论「最新/最热」排序、帖子/评论 `⋯` 菜单（举报迁入 + 拷贝，execCommand 兜底）；库新增 wall_comment_reactions + RPC（迁移已执行）。顺手修：字体 CDN 阻塞样式挡脚本执行（page-smoke 全红真凶）→ 字体 CSS 非阻塞。上一：轮 82（**动态流 B 档虚拟窗口**，`43d3021`）：300 条长列表只挂 ~16 张卡，深链钉住 + 近底续载由 `nearEnd` 算。轮 81（**A 档性能**）：`content-visibility:auto` + 列表图懒加载 + 时间文案 `memoWhen`。轮 80（**陈旧 dist 事故修复**）：CDP 取证 /community 渲染 0 张卡→轮 77 孤儿代码块让每次 vite build 语法失败被误判成功→轮 73-79 部署全是旧 dist；删孤儿块→部署 9946c57b→装机。轮 74-79：启动页语言跟随/newestSeenTs 崩溃修复/下拉提速+提示三态/英文精修/换一批取舍。 |
| 部署 | Version **`6beaed3f`** 已上线（**轮 115：旧域下线，本 Worker 唯一入口 = warmpaws.de5.net**；workers.dev 预览地址保留）；历史：`2c19d907`（轮 114 换域名批次，双域并存过渡）、`3a91942c`（轮 113 批：轮 107-112 上线，入口 `index-C5pZNGVS.js`）、`a2c7fa48`（轮 106）、`06ac3672`（轮 104）、`2604ddd1`（轮 103）、`396d4259`（轮 98+100）、`7701fd8e`（轮 87）、`754d910a`（轮 86）、`f9db3563`（轮 85）、`5c82e4e9`（轮 84）、`757a4fac`（轮 81-83）、`9946c57b`（轮 80）、`1a0570fb`（轮 72）、`176c967f`（轮 60-62） |
| 数据库 | 轮 84 `MIGRATION_comment_reactions.sql` **已执行**（探针实测：`/api/comments/reactions?ids=1` → 200 `[]`、anon 调 RPC → `auth-required` 即函数就绪）；`MIGRATION_reports.sql` 已执行（线上 e2e 6/6 闭环）；`MIGRATION_notifications_drop_dm.sql`（轮 13 #23）仍未确认 |
| App | **轮 116 APK 已装机 ✅（换 appId 后首个包）**：**applicationId `net.de5.warmpaws`**（新域倒写；深链 scheme 三处同步：AndroidManifest + `supabase.js` APP_SCHEME + `app-auth.html` SCHEME；**namespace/Java 包保留 `net.de5.dale` 不动**——applicationId ≠ namespace 合法，零文件搬移）。SHA16 **`9167272BD3BE0662`**，包内入口 `index-0ZPTRW7-.js`；安装为**独立应用**（MIUI 需手机上点 USB 安装确认）+ 旧应用 `net.de5.dale` 已卸载（**登录态随之清空，用户需重新登录**；云端数据不受影响）；冷启动前台 + logcat 无崩溃。**注意**：谷歌登录回跳链路（app-auth 中转页 → `net.de5.warmpaws://login`）已随 scheme 同步，Supabase 白名单无需改动（自定义 scheme 从不入白名单）。历史 appId：`net.de5.dale`（= 旧域倒写，随轮 115 旧域下线一并退役）。作废 APK：`A4852FA5763FAE05`(轮113) → `AA60666FBE4D9D8E`(续5) → …（见 F 区轮 113/114/115）。 |
| App 冷启动实测 | 轮 38：**真机冷启动 14 帧像素扫描（浅色模式）**：原生启动层米色+橙爪（四角 `#FFF7EE`、左右零暗像素）→ 网页启动页 → 首页，App 自己的每一帧都没有黑边。**轮 39 补勘**：那次抓帧是下午**浅色模式**下做的——夜间深色模式的路径当时测不到，正是「白天验收全绿、夜里黑屏」的盲区（F 区轮 39）；深色模式验证须装机后补做 |
| 测试 | 最新基线（轮 146 交付批，	ools 共 39 套 + 4 项静态/挂载门槛，**全量 0 fail**）：story **101/101**（新增）+ admin 39 + api-contract 87 + app-shell **64** + arity 8 + auth 130 + back-stack 9 + bottle-chat 94 + bottle **71** + cache 12 + comment 35 + dm 286 + feed-perf 27 + feed-window 19 + food-painter + gateway **80** + home-panes 9 + i18n 19 + mood 12 + notify 149 + pet-home 19 + pet-visual 163 + post-detail **17** + privacy 34 + rail 31 + react-queue 12 + report 61 + rps 14 + seo 50 + snack 24 + splash 21 + status-counts + status 49 + uifix 24 + userScope 8 + wall-rules 44 + wall 34 + web-refresh 6 + worker **247** + undef **0**（含 --selftest **10/10**）+ tdz **0**（+ 独立跑：page-smoke **12/12** + feed-window-live 10/10 + build 0）。详见 README 与 F 区各轮。

## 二、现在在做什么

- **当前任务**：**轮 146（暖心墙示例帖全清 + 推荐档分级放宽 + 月档改滚动 30 天）待部署** —— 验收点：`/community` 停在「推荐」档应看到大量真实老帖（不再是示例帖），跨天均匀不霸屏；「本月」档 = 前 30 天。遗留待用户拍板：库里 9/24 有 47 条 `〔压测 #xxx〕` 灌水帖，是否清理（删数据需用户明确指示）。
- **上一批（历史）**：轮 114（**换域名 dale.de5.net → warmpaws.de5.net：改动完成、36 套离线全绿，待提交待部署——攒批；部署即自动绑新域，之后 APK 必须重打**）。22 文件 + `.env` 全量替换 + wrangler.jsonc `custom_domain` 自动建绑 + 旧域面板绑定保留双域并存；外部面板（Supabase Redirect URLs / Google Branding / GSC）待办清单见 F 区轮 114。**顺序红线：先 deploy 再打 APK**。
- **上一批（已交付）**：轮 113（**上传 / 部署 / 打包 / 装机 四链路全部完成 ✅**）。用户发话「上传，部署，打包，装机」→ 把轮 107-112 的攒批一次性发出去：① 提交 `bf7b2c2`（轮 107 死代码清理）+ `c194df0`（轮 108-112 代码）+ `8fecc0f`（轮 108-112 测试与文档），**push 成功**（`HEAD == origin/main == 8fecc0f`，工作区干净）② 部署 Worker **Version `3a91942c`**（`wrangler deploy` EXIT=0，https://warm-paws.yi1614351.workers.dev）③ 线上验证 **LIVE ALL PASS (14)** + live-bundle-check **本地 dist = 线上**（入口 `index-C5pZNGVS.js`，SHA16 `c6dbdbad5170f85f` 两边一致、443181 字节、含 slug）④ `cap sync` EXIT=0（SEO 占位剥离 ×8）+ Gradle **BUILD SUCCESSFUL in 30s** → APK `apk/warm-paws-debug.apk` 5.21 MB，SHA16 **`A4852FA5763FAE05`**，包内入口 `index-C5pZNGVS.js` = 线上同一份 ⑤ `adb install -r` **Success**（`net.de5.dale`）+ 冷启动前台存活、`mWakefulness=Awake`、`logcat` 无 crash/FATAL + 截图确认渲染。**待用户真机/网页验收**。详见 F 区轮 113。
- **上一轮（已交付）**：轮 112（**详情页一级评论回复框钉到「一级评论 ↔ 二级列表」之间（原在整条评论最底部），与暖心墙轮 110 同款同位；已随轮 113 批提交 `c194df0` / 部署 `3a91942c` / APK `A4852FA5763FAE05` 装机 ✅**）。用户原话：「帖子详细页面的一级评论输入框：把一级评论回复框点击后出现在一级评论下面，二级评论上面，你现在是一级评论最下面。二级评论输入框不改。app端不改」。详见 F 区轮 112。
- **上一轮（待同批提交）**：轮 111（**详情页桌面主评论输入框挪到「浏览次数 ↔ 💬 N 条评论」之间（与暖心墙轮 109 同款同位），桌面悬浮底栏 cmt-bar-fixed 退役；改动完成、全量离线 0 fail + post-detail 16/16 + page-smoke 9/9 + build 0 + 运行时取证（放宽看已登录形态 + 还原后匿名/手机复验 + 截图）全过，**待提交待部署——攒批；APK 无需重打**（桌面专属）**）。详见 F 区轮 111。
- **上一轮（待同批提交）**：轮 110（**网页端一级评论回复框上移到「一级评论下面、二级评论上面」；改动完成、全量 36 套离线 0 fail + page-smoke 9/9 + build 0 + 桌面运行时取证全过，待提交待部署——攒批；APK 无需重打**）。纯 DOM 搬家：`.cmt-input-rep` 从整条评论最底部搬到本评论 `.cmt-acts` 之下、`.cmt-reps` 之上。详见 F 区轮 110。
- **上一轮（待同批提交）**：轮 108（**暖心墙+详情页评论输入两段式：占位条/整条评论点击 → 底部输入条；经续「贴键盘收 tabbar」+续2「点空白收起」+续3「回复统一底部条+整条评论接管」+续4「详情页主评论同款两段式」+续5「详情页回复统一底部条」后已重打并装机 ✅（SHA16 `AA60666FBE4D9D8E`）；提交/部署待发话——攒批**）。App 端每张卡/详情页评论区首部加「说点温柔的话…」占位条（图1），点击/点任意评论弹底部输入条、发送在右（图2）；桌面保持内联框/悬浮栏不变。详见 F 区轮 108（含续）。
- **上一轮（待同批提交）**：轮 107（**死代码清理**）。① 删孤儿组件 CommentComposer.vue（轮 105/106 回退后无 import，且模板引用的 insertAt 从未定义）② 删 PostDetailView composer 弹窗残留死代码 ③ 本文件补录轮 101-106（此前记录只存在于空提交 message 里）。详见 F 区轮 107。
- **上一轮（已交付）**：轮 106（**评论输入定案：恢复轮 98 基线，已提交 `bb93875` / 已部署 `a2c7fa48` / APK `0C95FE4486FA1934` 装机+冷启动确认**）——用户定案 App 端弹窗 / Web 端内联框，两平台不同输入方式。详见 F 区轮 106。
- **已吸收**：轮 90（详情页微调）。① 发评论输入框位置此后经轮 93（cmt-bar-fixed 常驻底栏）→ 轮 104/106 迭代定案；② 浏览次数保留不动（未删）；③ 评论「默认」排序已去 7 天推荐池（tops 无 recommendPosts，默认 = 旧→新）。
- **上一批**：轮 89（**墙内回复跳详情定位 + 详情页展开/回复修复**：已提交 `b5f7375` / 已部署 `f5b8e461` / 已装机）。① 详情页「展不开更多回复/回复像失败」真因：`visibleReps` 在 script 里把 `repOpen` 当普通对象读（少 `.value`）→ 永远走收起分支，新发的回复也被藏住——修为 `repOpen.value[cm.id]`。② 墙内回复超过可见数（>2）→ 按钮改「查看全部 {n} 条回复 ›」**跳详情页带 cid 参数**（goDetailReplies）；详情页收到 cid：切「最新」排序保证目标可见 + `repOpen` 展开该线程 + `cmtReveal` 撑到目标位 + scrollIntoView 定位 + `.cmt-focus` 描边高亮；一级评论锚点 `id="cmt-{dbId}"`。i18n comment.viewAllReplies 新增（中英成对）。详见 F 区轮 89。
- **上一批**：轮 88（**回复展开钮移到回复列表底部**：已提交 `b5f7375` / 已部署 `f5b8e461` / 已装机）。两个视图（墙+详情页）把「N 条回复 ▾」从评论操作行移除，在回复列表下方新增 `replies-toggle` 胶囊钮——收起态「展开其他 {n-2} 条回复 ›」（参考用户给的截图样式），展开态「收起回复」；i18n comment.expandOthers/collapseReplies 新增、comment.replies 退役（中英成对）；post-detail-test 断言同步。详见 F 区轮 88。
- **上一批**：轮 87（**暖心墙/详情页六项修复：已提交 `928c79b` / 已部署 `7701fd8e` / 已装机 APK `C8F2D7F9AC4494E9` ✅**）。① **⋯菜单无反应修因**：全屏遮罩被 `.card` 的 backdrop-filter 堆叠上下文盖住菜单（z-index 出不来）→ 点击全被遮罩吞掉；改 document 级点击收起（触发钮 .stop，菜单项动作后冒泡收起），两个视图同修。② 回应图标 ❤️/💔 改**空心灰内联 SVG**（点亮 = 深一档灰+细描边，不再用品牌色/emoji）。③ 详情页排序「最热」移除 → 「**默认**」（推荐模式，视图层用 recommendPosts 与暖心墙帖子同源）/「最新」，SORT_MODES=["default","new"]，sortHot 词条删除。④ 详情页评论**默认展开**（openCmt=true + load() 自动拉取）+ 一级评论先 15 条、下滑接近底部续 15 条 + 「查看更多评论」按钮（cmtReveal；回复仍默认前两条，轮 50 口径不变）。⑤+⑥ 手机端（isMobileNav）回复改**统一底部输入条**（固定在 tabbar 之上，发送在右下角，repActive 反查目标，自动聚焦）——「二级评论>1 条无法评论/回复框内联不可用」一并解决；桌面保持就地内联框。验收口径：离线全绿；**待用户真机验收（亮屏）**：① 帖子/评论 ⋯ → 举报弹窗/拷贝「已拷贝 ✓」② 心形为灰色描边、点亮深一档 ③ 详情页排序「默认/最新」④ 评论默认展开 15 条+下滑续+「查看更多评论」⑤ 二级>1 条的线程能正常回复 ⑥ 回复点按从底部弹输入条、发送在右下。详见 F 区轮 87。
- **上一批**：轮 86（**SEO ①c 帖子注入壳 + ⑥ /zh/* 中文预渲染+hreflang：已提交 `5de652f` / 已部署 `754d910a`，线上探针全过**；前端有改 → **APK 需重打包机等发话**）。详见 F 区轮 86。
- **上一批**：轮 85（**SEO 组合三件套：已提交 `1373421` + 已部署 `f9db3563`，线上探针全过**）——①b 帖子详情 `/post/:id` 存在性检查+回壳（查无/上游挂真 404）；③ `/u/:id` 薄内容壳 noindex；② sitemap 动态化。纯 Worker 侧。
- **上一批**：轮 84（**评论互动与详情页：已提交 `7271ce0` / 已部署 `5c82e4e9` / 已装机 ✅，迁移已执行**）——五条需求全部落地：①墙内点正文/图进详情页（示例/本地帖不响应）+ 评论只显前 3 条一级 + 「查看更多」；②评论行时间移到「回复」左 + ❤️/💔（RPC 服务端权威计数，乐观更新失败回滚）；③详情页评论排序「最新/最热」按钮在评论标题右（只排一级）；④评论右上角 …（举报迁入 + 拷贝）；⑤帖子右上角 …（同）。App/网页同改（同一份 dist；APK 等发话重打）。顺手修：字体 CDN 阻塞样式挡脚本执行（page-smoke 全红真凶）→ 字体 CSS 非阻塞 + noscript 兜底。验收口径：本轮=离线+契约两层；线上端到端等部署+迁移执行后跑。**待用户验收（部署+迁移后）**：墙内点帖进详情、前 3 条+查看更多、点赞/点踩计数与高亮、排序切换、…菜单举报/拷贝。详见 F 区轮 84。
- **上一批**：轮 81-83（**动态流性能 A+B 档 + 网页刷新按钮，已提交 / 已部署 `757a4fac` / 已装机 ✅**）——B 档把「已亮的帖子全挂 DOM」改成**窗口化**：只渲染视口附近 ~16 张卡（上下占位块撑住滚动高度），高度表按真实 `getBoundingClientRect` 长出来、只有深链才吃估高并按锚点位移补偿一次；近底续载改由 `nearEnd` 算（有占位块后原哨兵会被推到几万像素外）。**真机取证修掉三处真缺陷**：卡距从真卡片现读（手机断点 12 / 桌面 18）、估高与 `.post-card` 的 `contain-intrinsic-size` 锁成一条链（320）、交出浏览器自带滚动锚定并在卸载时还原。**验收**：36 套离线全绿 + feed-perf 27/27 + feed-window 19/19 + **feed-window-live 10/10**（真引擎 300 条：DOM 卡片 ≤16 张、视口内零空档、回滚/回顶不白屏、控制台无异常）+ undef 0（含 --selftest 10/10）+ tdz 0 + page-smoke 8/8 + build 0；部署后 live-check **14/14** + live-bundle-check 本地=线上（SHA16 `6c21022ca0ffe37c`）；APK SHA16 `307438B28DBA2143` 装机 Success。
- **待用户验收（亮屏，已装机）**：暖心墙长列表快速上下滚——**不白屏、不跳位**；一直往下滑始终能续上新帖；从通知点「评论」跳回来能正确定位到那条（不再拽回列表顶部）。桌面网页右上角刷新按钮可用。
- **上一轮**：轮 81（**动态流 A 档性能，已随本批 `757a4fac` 部署/装机**）——屏外卡片跳过渲染（`content-visibility:auto` + `contain-intrinsic-size`）、列表图 `loading=lazy` + `decoding=async` + 未解码占位底色、时间文案记忆化 `memoWhen`（同一批帖子不再每帧重跑 `toLocaleString`）。
- **上一轮**：轮 80（**陈旧 dist 系统性事故修复,已上机**）——**等用户验收**:①暖心墙下拉 → 「刷新中…」→ 换一批/新增提示,**内容真的会变**②下滑到底自动翻页③消息页无错误盒④发帖页信纸样式⑤英文 UI。**上一批轮 59-79 的部署全部发的是 03:54 旧产物——本轮才真正带上全部修复**。
- **上一轮**：轮 79（**「换一批」取舍逻辑恢复**）
- **当前任务**：轮 77（**刷新死锁修复,已上机**）——**等用户验收**:暖心墙下拉 → 「刷新中…」→ 1 个往返换内容;网络抖动时提示「没刷出来,再试一次」且**再拉仍可用**(不再永久死锁)。轮 74 的启动页语言跟随同包。
- **上一轮**：轮 74（**启动页语言跟随,已上机**）——**等用户验收**:系统/设置语言为英文时,启动页显示英文(名称 Warm Paws/口号/三条特性/温柔话全英文);中文用户不变。轮 73 的崩溃修复也在此包(刷新已恢复)。
- **当前任务**：轮 75（**下拉刷新再提速+提示生命周期修复,已上机**）——**等用户验收**:暖心墙下拉 → 顶部立刻「刷新中…」→ **约 1 个网络往返**直接换内容(帖子先渲染,评论数后台补);提示 2.5 秒后必消失(单定时器管理,连续下拉不再卡住)。上一轮 74 同包。
- **上一轮**：轮 74（**启动页语言跟随,已上机**）
- **上一轮**：轮 73（**newestSeenTs 缺声明崩溃修复,已上机**）——**等用户验收**:暖心墙下拉 → 「刷新中…」→ 换一批/新增提示正常出现,列表真的换内容;消息页不再弹错误盒。轮 72 的提速逻辑本轮起才真正生效(此前被崩溃废掉)。
- **当前任务**：轮 73（**newestSeenTs 缺声明崩溃修复,已上机**）——**等用户验收**:暖心墙下拉 → 「刷新中…」→ 换一批/新增提示正常出现,列表真的换内容;消息页不再弹错误盒。轮 72 的提速逻辑本轮起才真正生效(此前被崩溃废掉)。
- **上一轮**：轮 72（**下拉刷新提速,已上机**）——**等用户验收**:下拉 → 立刻「刷新中…」→ 约 1 个网络往返后直接换内容(有新帖见新帖,没有换一批)。轮 71 同包(输入框圆角自适应)。
- **上一轮**：轮 71（**输入框圆角自适应,已上机**）——**等用户验收**:任意输入框单行=椭圆、多行=圆角长方形(聊天/漂流瓶/登录/搜索全适用)。
- **上一轮**：轮 70（**消息页记录页签,已上机**）——**等用户验收**:消息 → 漂流瓶记录 → 胶囊切换「我发布的 / 我捞到的」,各自列表+空态。轮 69 同批(示例文字已删)。
- **上一轮**：轮 69（**示例提示文字已删,已部署已装机**）——暖心墙底部那行「这几条是小小的示例」没了(示例帖本身保留)。连同轮 68 输入框三连一起验收。
- **上一轮**：轮 68（**输入框体验三连,已上机**）——**等用户验收**:①漂流瓶投瓶框随内容长高(3~10行)②捞信回信弹窗框随内容长高(3~8行)③聊天输入框单行起、长了往上顶、发送键在框右(微信式)。轮 66 的「我的回信」标签+「换一批持久化」也在此包。
- **上一批**：轮 60-66（刷新修复+换一批+UI精修+标签+谷歌提示,均已上线）——**等用户验收**:①「我捞到的」回信标注「我的回信」②刷新换一批后,关闭重开:先见上批,再下拉换新批;旧批 A 不再复活。轮 65 的「换一批」语义不变。
- **上一轮**：轮 65（**提示简化已上机**）——**等用户验收**:暖心墙连续下拉:每次都换一批(500 压测帖池);有新帖直接出现在列表(无计数提示);失败才提示。轮 64 的「换一批」语义不变。
- **上一轮**：轮 64（**刷新=换一批,已上线已装机**）——**等用户验收**:暖心墙下拉:有新帖 → 「新增 N 条」;没有 → 自动随机换一批(提示「换了一批内容」),每次拉都有新东西看。机制:Worker sample(count 总量→随机偏移,7 天池),取回的批走推荐洗牌;游标从批末继续,触底续载不冲突。
- **上一轮**：轮 63（**谷歌登录预期提示**）——**改动完成、auth 130/130 + i18n 19/19 + uifix 24/24 + undef/tdz 0 + page-smoke 8/8 + build 0,待提交待部署**。机制口径:Google 禁 WebView 登录→App 内最佳=CCT→需设备有支持 CCT 的浏览器(本机无,已实测);装 Chrome 零改动变 App 内授权窗;外部浏览器回退时深链回跳链路(轮31)仍自动返回 App。
- **上一批**：**轮 60-62 全部已部署已装机**（`176c967f` + APK `21AAA9660D9DE6E0`），等用户真机验收：①暖心墙下拉 → 「已刷新 ✓ 新增 2 条」+ 两条〔刷新验证新帖〕②下滑到底自动翻页（游标版）③「我的」页帖子秒开 ④页脚没了 ⑤UI 精修观感。**测完执行 `CLEANUP-loadtest.sql`**（500 压测帖下架/压测评论隐藏）。（`176c967f` + APK `21AAA9660D9DE6E0`），等用户真机验收：①暖心墙下拉 → 顶部「已刷新 ✓ 新增 2 条」+ 两条〔刷新验证新帖〕②下滑到底自动翻页继续加载（游标版）③「我的」页帖子秒开 ④页脚没了 ⑤UI 精修观感。**测完执行 `CLEANUP-loadtest.sql`**（500 压测帖下架/压测评论隐藏）。
- **教训（工具/环境）**：手机锁屏后 Chromium 冻结被遮挡的 WebView 渲染进程——CDP 读数（卡片数/挂载/滚动）全部变成冻结假象，**真机验证必须在亮屏解锁状态下做**（轮 59 前「100→0→14 坍缩」等怪读数同源）。——**等用户验收**:暖心墙下拉 → 顶部「已刷新 ✓ 新增 2 条」+ 两条〔刷新验证新帖〕(推荐流位置随机,找〔刷新验证〕标记);没有新内容时提示「已刷新 ✓」列表不变属正常(推荐流设计)。静态机制见 F 区轮 60/61。
- **上一轮**：轮 59（**手机端 UI 精修第一波**）——**改动完成、全套测试绿,待提交待部署**。改了密度/暖色/文案/空态/空日历五项(见代码行);用户若要更深的重构(导航/视觉语言),等拍板方向再动(轮46教训:别替用户做大决定)。
- **上一轮**：轮 58（**我的页帖子提速 + 页脚移除**）——**改动完成、app-shell 40/40 + privacy 33/33 + i18n 19/19 + cache 12/12 + auth 130/130 + undef/tdz 0 + build 0,待提交待部署**。轮 56（暖心墙无限流）也在此批,同待发话。
- **上一轮**：轮 56（**暖心墙无限流+刷新取新**）——**改动完成、全套测试绿(见代码行),待提交待部署;生效需部署,App 端要新包**。修的就是你压测时报的两条:①下拉刷新现在强制取最新第 1 页并提示「已刷新 ✓」②下滑到底自动向服务器翻页追加(50 条/页),真到底才出「就到这里啦」。**测刷新要等部署+装机**。
- **上一轮**：轮 55（**压测数据已灌注**）——墙上现有 516 帖/1011 评(约 2/3 帖带评,267 条二级@回复),直接测**下拉刷新/触底加载/SWR 缓存**即可；测完执行 `CLEANUP-loadtest.sql` 一键下架+隐藏（幂等,不物理删）。探针已删;Supabase 注册限频在耗(近期 e2e 若撞「Request rate limit reached」,等小时窗或放缓)。
- **上一批**：**轮 45-54 攒批已收官**（用户发话「部署，装机」）——4 笔主题提交（31dcd8d 漂流瓶 / 173a59c ＋钮 / 002753b 墙与评论 / ed2c6f6 首页宠物）+ 部署 Version `dc625459`（live-check 14/14，入口 SHA16 `830db4520c5a41f3` 本地=线上）+ APK `3D3E5E701FFDD1C4` 装机 Success（冷启动冒烟通过，＋钮已收回栏内）。jiaojie 收尾提交后本批完全闭环。
- **待用户真机走查（攒批验收单）**：① 漂流瓶「我捞到的」只剩已回信、按捞到时间倒序；已回信待对方同意显示「待对方同意后可聊天」② ＋ 钮圆不再探出栏外、弹层两卡宽度原样 ③ 暖心墙顶部无「暖心墙」字牌、二级评论默认显示前两条 ④ 宠物页任务行「记录今天的心情」点了跳今日联打卡卡 ⑤ 「我的→去厨房」落首页宠物联食谱页签 ⑥ 深色模式全程米色（轮 39）。
- **前情**：轮 54（**去厨房落首页宠物联食谱**）——**改动完成、pet-home 19/19 + home-panes 9/9 + undef 0 + page-smoke 8/8 + 本地 build 过,待提交待部署**。「我的→去厨房」手机端现在深链到首页宠物联并自动停在食谱页签,不再跳独立页;轮52的返回钮保留但只在独立 /pet 显示。
- **上一轮**：轮 53（**打卡跳转方向纠正**）——**改动完成、home-panes 9/9 + pet-home 19/19 + undef 0 + page-smoke 8/8 + 本地 build 过,待提交待部署**。宠物页「今日温柔任务→记录今天的心情」行现在可点(带「去打卡 →」),点了跳首页「今日」联的「今天过得怎么样」卡;轮51「打完卡跳去宠物」已撤销(方向做反)。
- **上一轮**：轮 52（**宠物页补返回钮**）——**改动完成、pet-home 19/19 + page-smoke 8/8 + undef 0 + 本地 build 过,待提交待部署**。我的 → 去厨房落到 /pet?tab=book,页内从此有 ← 返回(有历史回上页,直链回「我的」);若用户说的「三级按钮」不是返回钮,等澄清再动。
- **上一轮**：轮 51（**打卡后跳转宠物**）——**改动完成、home-panes 9/9 + page-smoke 8/8 + undef 0 + 本地 build 过,待提交待部署;生效需部署,App 端还要新包**。点心情按钮 → 绿字「打卡完成」闪 800ms → 自动滑到宠物联(宠物+心情+经验+照顾+3金币,每日任务在宠物侧可领);桌面保持不跳。
- **上一轮**：轮 50（**二级评论默认显两条**）——**改动完成、post-detail 15/15 + uifix 24/24 + page-smoke 8/8 + 本地 build 过,待提交待部署**。暖心墙列表页与帖子详情页两处同改:有回复默认显示前两条;>2 条时「N 条回复」可展开全部/收回;≤2 条无按钮。
- **上一轮**：轮 49（**「我捞到的」待同意提示**）——**改动完成、bottle-test 69/69 + i18n 19/19 + page-smoke 8/8 + 本地 build 过,待提交待部署;生效需部署,App 端还需重打包装机**。状态链:我回信后信变 answered → 对方(原信作者)同意前显示「待对方同意后可聊天」→ 同意后记录卡出现进聊天入口(原有逻辑)。
- **上一轮**：轮 48（**轮46纠偏：弹层宽度回滚 + ＋钮圆收回栏内**）——**改动完成、app-shell 40/40 + page-smoke 8/8 + 本地 build 过,待提交待部署;注意已装机的 APK(108F2B9D7727B4EC)还是纠偏前的样子,重打包+装机等发话**。①「投漂流瓶/发帖」两卡恢复全宽原样;②＋钮的圆从探出栏外 16px 收回到栏内（用户原话:「谁让你改投漂流瓶跟发帖的宽度了,改回原来的宽度」「我说的是那给+号整体往下一点,那个上面的圆都超出了」——当初要修的是钮的位置,不是弹层宽度,理解跑偏了）。
- **上一轮**：轮 47（**暖心墙去标题浮卡**）——**改动完成、uifix 24/24 + page-smoke 8/8 + 本地 build 过,待提交待部署**。手机端暖心墙页顶那张只装着「暖心墙」三个字的玻璃卡不再渲染(发布走底部 ＋,Tab 名本来就是暖心墙);桌面端带副标题+发布框的头部原样保留。
- **上一轮**：轮 46（**＋ 号弹层样式**）——**改动完成、app-shell 40/40 + page-smoke 8/8 + 本地 build 过,待提交待部署**。全宽双卡改成一枚紧凑菜单卡:水平居中、紧贴 ＋ 钮上方(留 6px),两瓣入口变卡内两行,行为不变。手机上点 ＋ 即可看(App/窄屏才有 TabBar;生效需部署后)。
- **上一轮**：轮 45（**漂流瓶记录口径**）——**改动完成、测试过了（bottle-test 68/68）、SQL 迁移已就绪：`MIGRATION_bottle_records.sql` 请整份粘贴到 SQL Editor 执行（幂等,别只粘片段,踩坑 #21）;按攒批新规未提交、前端零改动无需部署**。「我捞到的」页签此后只显示已回信的信、按捞到时间最新在前;已放回的/在守的不进记录（回信/放回走首页顶部托盘）。「我发布的」本就按发布时间最新在前,未动。执行迁移后立即生效（网页+App 同步）。
- **前一轮（已提交已部署）**：轮 44（**我的页：帖子挪底 + 时间到秒**）**已完成并交付**（F 区轮 44）。用户原话：「我的页面，我在暖心墙的帖子移到最下面，在我的食谱下面，而且时间显示到秒」。① ProfileView 的「我在暖心墙的帖子」整块从「改昵称」下方挪到页面最底（我的食谱之下）；② 帖子卡时间从「只有日期」改为**显示到秒**——新纯函数 `fmtWhenSec`（与 `fmtWhen` 同口径：跨年补年份、非法→空串）。已部署 Version `12e6e3e0`（线上 SHA16 `88fc3eeb89fd5983` 本地=线上），wall-rules-test 39→42、undef/tdz 0、page-smoke 8/8；APK `88B42A09744AB402` 待装机。**网页端刷新「我的」页即可验收**；App 端随下次装机。
- **待用户真机验收（轮 43，启动这几秒）**：① 冷启动**不再出现大橙爪页面**（原生段纯米色一闪而过）② 随后的网页启动页照常（米色+🐾+文案）③ 进首页正常。若**连网页启动页也不要**（开 App 直接进首页），说一声，那是 `index.html` 的 #app-splash 层，另做一轮摘掉。
- **前一轮**：轮 42（**修「冷启动首页整页崩」**）**已完成并交付**——真因是轮 41 给 `BottleView` 的 watch 加了 `{ immediate: true }`，回调里用了第 224 行才声明的 `recPage` → TDZ `Cannot access 'ht' before initialization` → `App.vue` 错误边界把整页换成「这里好像有点小状况」，首页/漂流瓶数据全出不来（**线上 `index-CPSDoYFN.js` 与真机包同坏**）。已修（撤 `immediate`，初始查询移入 `onMounted` 显式调用）、已测（33 套离线 0 fail + undef 0 + **新增 tdz-check 0** + page-smoke 8/8）、已部署（Version `3431e8bb`，线上入口 SHA16 `0ed578e10f51a0c3` 本地=线上）、已装机（SHA16 `17A0CAB139460AC7`）并真机复验（冷启动无错误盒、367ms 发取数、页面零「同步中」）。**上轮教训**：轮 41 漏跑 `page-smoke` 就交付 → 坏包上线，已写进踩坑 #32，并把 `page-smoke` 定为与 `undef-check` 同级的硬门槛。
- **待用户真机验收（轮 42，首页）**：① 手机冷启动首页正常（不再出现「这里好像有点小状况 / 刷新页面」）② 进首页/漂流瓶时次数与记录**立刻有值**（不再长时间「同步中」）③ 网页端同样正常（线上已修，可直接刷新网页对照）。
- **前一轮**：轮 40（**桌面端弹窗宽度收敛**）**已完成并交付**——代码已提交（`083c895`）、已测（33 套离线 0 fail）、已部署（Version `baa4367e`）、APK 已装机（SHA16 `D88A2E9C0496140A`，见 F 区轮 40）。上一轮 39（**深色模式「黑屏」修**）已改、已测，并**随轮 40 的 APK 首次装机**，待你在深色模式下验收（F 区轮 39）。用户原话：「黑屏没改，改一下」。真因：恒浅色 App 却用 DayNight 主题 + WebView 未退 Force Dark——深色模式下（夜间）系统/MIUI 的「强制深色」把米色界面整个反黑；轮 38 的 14 帧实测是下午浅色模式抓的，恰好测不到这层。三道闸已全关（主题 Light+forceDarkAllowed=false ×3、MainActivity 强制浅色、WebView 实例关 Force Dark），splash-test 18/18；那份 APK（`63F5932ACDA5434A`）当时未装机，本轮轮 40 重新出包时**连同三道闸一起装机**（装机包 SHA16 `D88A2E9C0496140A`）。
- **待用户真机验收（轮 39，深色模式 · 装机已完成）**：① 手机开**深色模式**后冷启动 + 全程使用：界面始终米色**不变黑**；② 切回浅色模式：冷启动无黑边（轮 38 结论保持）、启动页照常。**装机已完成**（2026-09-24 01:37，`D88A2E9C0496140A`，`Displayed +720ms`、crash 空）。若深色模式下仍发黑：MIUI「设置 → 显示 → 深色模式」里有按 App 的开关，把 Warm Paws 设为**不加深色/始终浅色**再试——那是系统侧最后一级开关，App 侧能做的三道闸本轮已全部关掉。
- **待用户验收（轮 40，弹窗尺寸）**：① 桌面网页打开**漂流瓶捞信弹窗**/**举报弹窗**：窗宽收敛为 **560px / 520px**（原先铺满整屏）② 手机上这两个弹窗仍是留 16px 边距的近全宽，**视觉不应有变化**。

- **待用户真机验收（轮 38，看启动这几秒）**：① 冷启动**不再有黑边**（原生启动层米色 + 橙爪铺满，四角无黑；我这边的真机逐帧已是如此）② **启动页回来了**（米色底 + 🐾 温暖的爪印 / Warm Paws / 一个温柔的角落 + 三条特性 + 「你已经做得比想象中好了」，然后淡出进首页）③ 网页端**仍然不显示启动页**（轮 30 的要求保持）。注意：桌面点图标那一瞬的**黑幕是桌面的「打开应用」转场背景**，不属于 App（我这边的帧里 App 窗口自己始终是米色圆角）。
- **待用户真机验收（轮 37，漂流瓶）**：① 首页/App 漂流瓶：剩余次数显示与服务器一致（发 3 封后「今天还能投 0 封」、回 7 次后「还能捞 0 瓶」，不再出现「显示还剩 7 次却已被挡」）② 网页与 App 两端显示的次数**同源**（在网页用掉 1 次，App 里刷新即见同一本账）③ 捞到的信/记录列表不再出现**上一个人**的（换号或清缓存后重进为空/自己的）④ 超限只会被服务器挡住并给出明确文案。
- **仍待用户（承轮 34）**：管理端「举报」页签里那条线上 e2e 留下的测试举报（显示「内容已删除」），点「驳回」即走完 处置→通知→已处理 全流程；重连手机后装机走查（举报弹窗、拉黑后内容隐藏、轮 31/32 遗留项）。
- **待用户确认**：①`MIGRATION_reports.sql` 已执行（✅ 2026-09-23）②`MIGRATION_notifications_drop_dm.sql`（轮 13 #23，仍未确认）。
- **可选加码（等有量再做）**：图片搬 Cloudflare R2（出口永久免费，见「十、容量评估」方案 B）。
- **待用户确认**：①`MIGRATION_reports.sql` 执行 ②`MIGRATION_notifications_drop_dm.sql`（轮 13 #23，仍未确认）。
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
| 11 | 换账号漂流瓶次数还是上个人的 | 次数记账键按 uid 分域（`warm-paws-bottle-quota-v1:<uid>`），`watch(myId)` 换号立即换账本 → **轮 37 再收口**：本机账本整体删除，次数只认服务端 `bottle_quota()`（漂流瓶全线上，见 F 区轮 37） |
| 12 | 已捞到有回信的不能点 | 记录列表对「收到回信待决定」的条目直接给「同意/拒绝」按钮，同意即进聊天；新文案 `bottle.stDecide`（zh/en 成对） |
| 13 | 评论数点击弹输入框（手机） | 手机形态展开评论默认只读，点「✎ 写评论」才出输入框（`cmtCompose`，桌面不变） |
| 14 | **App 冷启动黑边一直没修好 + 启动页又没了**（2026-09-23 用户原话：「为什么改了那么多次黑边还在，而且 app 端启动页又没了」） | **两个真因，都在"改了多轮没改对"的账上**：① 黑边：轮 25 的米色窗口底写在 `AppTheme.NoActionBar` 上，而 Activity 用的是 `AppTheme.NoActionBarLaunch`（parent=`Theme.SplashScreen`，与我们的主题**毫无继承**）→ 米色从未生效；该启动主题的 `android:background` 还是 Capacitor 模板自带蓝色 X 的 `splash.png`；Android 12+ 的系统启动画面（`windowSplashScreenBackground`）也没配 → 冷启动一圈黑。**修法**：窗口底/品牌启动图写进**真正被使用的主题**（parent 改 `AppTheme.NoActionBar`，`android:background=@drawable/launch_bg`）+ 删 11 张默认 `splash.png` + 新增 `values-v31/styles.xml`。② 启动页消失：轮 30 在 `<style>` 块中间插了一个**字面的 `</style>`**——HTML 解析器在 style 元素里见到它就立刻结束元素（注释也不豁免）→ 后面 30 行 CSS 全成裸文本，唯一活着的规则是 `display:none`（连 `html.cap-app #app-splash{display:flex}` 也死了）；且 `cap-app` 的判据是 UA 里有没有 "capacitor"，而 **Capacitor Android 的 WebView UA 默认不含这个串**。**修法**：合成一个合法样式块 + 判据四路（`window.androidBridge` / `window.Capacitor` / `appendUserAgent`("WarmPawsApp") / UA）+ `src/main.js` 用 `Capacitor.isNativePlatform()` 在挂载前兜底加类。见 F 区轮 38 |
| 15 | **App 夜间/深色模式下整个变黑屏**（2026-09-23 夜用户原话：「黑屏没改，改一下」；承 #14 黑边老账） | **真因：恒浅色 App 没做任何深色模式退出**：① `AppTheme.NoActionBar` parent 是 `Theme.AppCompat.DayNight.NoActionBar`（深色下回落色翻黑）；② WebView 没退 Force Dark——Android 10-12 在夜间 uiMode 下默认对 WebView「强制深色」，把浅色页面整个反黑（`@capacitor/android` 8.5.2 **全包零 forceDark 处理**，grep 实锤），MIUI 自家深色实现也吃同一套开关。**取证**：回放轮 38 抓帧（15:05 浅色模式）冷启动全程无黑 → 唯一昼夜翻转变量=深色模式；轮 24-38 每轮验收都在白天浅色下做，这层从未被测到。**修法（三道闸）**：主题 DayNight→Light + `android:forceDarkAllowed=false` 写全三个继承节点；`MainActivity` 在 `super.onCreate` **之前** `setDefaultNightMode(MODE_NIGHT_NO)`；WebView 实例 `setForceDarkAllowed(false)`。另查实：**`values-night/` 目录从未存在**——轮 38 记录「values-night/styles.xml 沿用同款米色」系误记，就地纠正。见 F 区轮 39 |
| 16 | **启动后首页整页「这里好像有点小状况：Cannot access 'ht' before initialization」，漂流瓶/首页全空**（2026-09-24 用户报障：「你自己看看吧」） | 真因 = 轮 41 给 `BottleView` 的 watch 加 `{ immediate: true }` 触发 TDZ：回调里 `recPage.value = 0` 而 `recPage` 声明在第 224 行、watch 在第 87 行 → setup 同步执行时抛错 → `App.vue` 错误边界接管整页。**修法**：撤掉 `immediate`，初始查询改为 `onMounted(() => { purgeLegacyBottleLocals(); onSessionChanged(); })` 显式调用（setup 跑完才执行，const 已就绪）；轮 41 的「启动期预热 + 单飞合并」保留。**验证**：tdz-check 新增（0 问题 + 回归命中旧代码）、page-smoke 8/8、离线 33 套 0 fail、真机冷启动 3s/9s 两帧无错误盒、367ms 发 quota+held、页面零「同步中」。见 F 区轮 42、踩坑 #32 |
| 17 | **启动时那个「米色底+大橙爪」页面不要了**（2026-09-25 用户原话：「启动页不要那个大爪子的页面，去掉」） | 那是**原生启动层**（Android 12+ 系统启动画面的 `windowSplashScreenAnimatedIcon` + 窗口底 `launch_bg` 的 108dp 居中爪印，轮 38 加的）。**修法**：两层全退纯米色——`launch_bg` 删爪印项、图标位改指**全透明 drawable**（不能不设：不设系统默认放 App 图标，我们的图标本身就是爪印，等于没去掉）、`launch_paw.xml` 删除；**带文案的网页启动页保留**（#app-splash：🐾56px + 温暖的爪印 + 三条特性——轮 38 用户点名要回来的页面）。冷启动视觉 = 纯米色一闪 → 网页启动页 → 首页。splash-test 18→20（启动链零爪印 + 图标位透明两条断言）；APK 重打 SHA16 `35115BBB8BEEB235` 待装机。见 F 区轮 43 |
| 32 | **手机端 UI 丑,要求重构**（2026-09-25 用户原话:「你看一下ui,手机端真的很丑啊,你能不能重构一下ui啊」） | **先审计后动手**:无头 Edge 393px 对 9 页截屏(轮35办法)。通病:①卡片 24px 肥边密度极低(一屏两三张)②按钮全灰 pill 米色底上发闷③技术腔文案泄漏(「大厅只统计人数,不展示昵称」)④游客态孤卡+大片空渐变⑤0 记录也渲染 30 格空日历。**轮59 修了这五项**(全限定 .shell--mobile-nav);更深的重构(导航/视觉语言)属 D7 批3 T10,等用户拍板方向。见 F 区轮 59 |
| 33-40 | （这些编号因脚本断言静默失败未落表——明细见 F 区轮 59-72 各记录，此处不补造） |
| 41 | **启动页不跟随语言**（2026-09-26 用户原话:「当语言是英文的时候,怎么还是中文启动页」） | 启动页是 index.html 静态层（i18n 之外），文案硬编码中文。**修**:启动页标记后加内联脚本——渲染前读 `wp-lang` 存档（无则系统语言）,英文时替换全部启动页文案;脚本同步执行在首帧前,不闪中文;异常保持中文默认。splash-test +1 断言（21/21）。见 F 区轮 74 |
| 42 | **发帖页丑,重构为「信纸」**（2026-09-26 用户原话:「发暖心贴那个发帖页面丑啊」） | CDP 带登录态截屏审计(注入 supabase 会话)后重构:发帖卡=「信纸」(暖纸底+🐾水印+收紧留白),textarea 字号 16/行高 1.9/最小高 38vh,字数右移 accent 色,游客卡居中收窄(46vh)。类名全保留(T36 40/40 不破)。见 F 区轮 76 |
| 43 | **下拉刷新仍慢+提示不消失**（2026-09-26 用户原话:「太慢了」「老是刷新之后还不消失」） | ①慢:下拉要等「取帖子+取评论数」串行往返;②提示不消失:连续下拉的定时器互相覆盖+网络挂起无超时,「刷新中…」永久钉住。**修**:帖子 1 个往返先渲染(评论数后台并入+回写缓存)、8 秒超时保护(挂起时报「没刷出来」并复位)、提示单定时器管理。见 F 区轮 75 |
| 44 | **刷新死锁:一次拉取失败→刷新永久失灵**（2026-09-26 用户原话:「sb,我他妈现在刷新根本不动」） | 轮 76 死锁:随机批/最新页任一失败→box.posts=null 仍进 consume→filterBlocked(null) TypeError→loadingCloud 卡 true→所有刷新被卫语句挡死,直到重启 App。**修**:①posts 非空数组才进 consume,失败如实提示并保留旧列表②loadCloud 整体 try/finally,loadingCloud 必复位③评论数后台补不阻塞渲染。见 F 区轮 77 |
| 45 | **陈旧 dist 系统性事故:轮 73-79 的「已部署」全是旧产物**（2026-09-26 用户:「刷新根本不动」→ CDP 取证 /community 渲染 **0 张卡**） | **真因**:轮 77 的 try/finally 补丁在 CommunityView 留下**孤儿代码块**（复制了一份评论数逻辑在函数闭合外）→ **此后每一次 vite build 都语法失败**,而构建输出被 grep 过滤只看了两行(env-guard)→ 以为成功;此后所有 deploy 发的都是轮 76 时代旧 dist(无崩溃修复/无换一批/无英文修复),所有「已部署」记录为假。page-smoke 持续 8/8 的原因:旧 dist 能挂载(崩溃在异步链不触发 crash-box)。**修**:删孤儿块→build 成功(新 chunk index-CB4a4YgL.js)→部署 9946c57b→装机。**流程强制**:①build 输出必须看完整 tail(不许 grep 过滤)或用 build-until-good;②deploy 后 live-bundle-check 的 SHA 必须与本轮源码构建产物比对;③jiaojie「已部署」记录必须附 chunk 名。见 F 区轮 80 |
| 33-40 | （这些编号因脚本断言静默失败未落表——明细见 F 区轮 59-72 各记录，此处不补造） |
| 43 | **刷新死锁:一次拉取失败→刷新永久失灵**（2026-09-26 用户原话:「sb,我他妈现在刷新根本不动」） | 轮 76 死锁:随机批/最新页任一失败→box.posts=null 仍进 consume→filterBlocked(null) TypeError→loadingCloud 卡 true→所有刷新被卫语句挡死,直到重启 App。**修**:①posts 非空数组才进 consume,失败如实提示并保留旧列表②loadCloud 整体 try/finally,loadingCloud 必复位③评论数后台补不阻塞渲染。见 F 区轮 77 |
| 44 | **发帖页丑,要求重构**（2026-09-26 用户原话:「发暖心贴那个发帖页面丑啊,你他妈不能改一下吗」） | CDP 带登录态截屏审计后重构:发帖卡=「信纸」(暖纸渐变底+右下🐾水印+16px 收紧留白),textarea 字号/行高升级,字数右移 accent 色,游客卡居中收窄(46vh)。类名全保留(T36 40/40 不破)。见 F 区轮 76 |
| 41 | **启动页不跟随语言**（2026-09-26 用户原话:「当语言是英文的时候,怎么还是中文启动页」） | 启动页是 index.html 静态层（i18n 之外），文案硬编码中文。**修**:启动页标记后加内联脚本——渲染前读 `wp-lang` 存档（无则系统语言）,英文时替换全部启动页文案;脚本同步执行在首帧前,不闪中文;异常保持中文默认。splash-test +1 断言（21/21）。见 F 区轮 74 |
| 42 | **下拉刷新仍慢+提示不消失**（2026-09-26 用户原话:「太慢了」「老是刷新之后还不消失」） | ①慢:下拉要等「取帖子+取评论数」串行往返;②提示不消失:连续下拉的定时器互相覆盖+网络挂起无超时,「刷新中…」永久钉住。**修**:帖子 1 个往返先渲染(评论数后台并入+回写缓存)、8 秒超时保护(挂起时报「没刷出来」并复位)、提示单定时器管理。见 F 区轮 75 |
| 31 | **页脚文案与空框移除**（2026-09-25 用户原话:「把每个页面的用心制作.你做的比你认为的更好去掉,以及那段空框内容去掉」） | 那是 App.vue 的 `<footer class=footer>`（轮里只剩这一句 footerNote,隐私入口早挪去设置页）→ 剩个空玻璃框。**整块移除**:footer 元素 + i18n footerNote(zh/en) + .footer/.footer-link 样式 + mobile/chat 两处形态规则;钉它的 4 条断言同步(T15/T35 去 footer 子句、P27 去 .footer-link、P28 整条删)。见 F 区轮 57 |
| 30 | **「我的」页帖子出现很慢**（2026-09-25 用户原话:「我的页面,我的帖子老是出现的很慢,有什么优化措施?先改上面的」） | 根因:3 条预览块**无缓存**,每次进页干等一次 /api 往返（国内 0.5~2s）;轮 36 只给 /my-posts 接了 SWR,这里漏了。**改法(轮 58)**:① ProfileView 接 `swr(cacheKey("profile-myposts",uid))`——快照秒开、后台取新覆盖回写;② App.vue 启动预热链加 `prefetchProfilePosts()`（同一把键,登录后启动即预热,首次进页也不用等）。见 F 区轮 58 |
| 29 | **暖心墙下拉刷新没用 + 下滑有尽头**（2026-09-25 用户压测 500 帖后原话:「暖心墙下拉刷新没有用」「一直往下滑怎么会有尽头,不应该下滑到尽头继续刷新吗」） | **架构性根因**:feed 是「一次性拉 SORT_WINDOW 条 + 本地 reveal 亮卡」——服务器分页根本不存在,拉完就「尽头」;下拉刷新只是重拉同一份固定列表(SWR 缓存优先),自然「没用」。**改法(轮 56)**:① 双模式 `listPosts(limit,offset)`(网关仅非 0 附 offset——gateway-contract 旧断言不破;supabase range 且链序保持 api-contract 形状);② CommunityView 50 条/页服务端分页:触底亮完→取下一页追加(拉黑过滤+评论数补齐),空页=到底;③ 下拉刷新绕过缓存取新第 1 页 +「已刷新 ✓」。见 F 区轮 56 |
| 28 | **「三级按钮」澄清+去厨房落位**（2026-09-25 用户原话:「我说的『三级按钮』就是首页上面的,宠物,今日,漂流瓶。在文档页面点击去出发,直接跳到首页-宠物-食谱就行了」——「文档页面」=「我的页面」、「去出发」=「去厨房」） | 轮52按「上一级按钮」理解是错的:用户指的是首页**频道条(宠物|今日|漂流瓶)**——去厨房应该落**首页宠物联+食谱页签**,不跳出三联。**改法**:① ProfileView 去厨房:手机端 `to={path:'/',query:{tab:'pet',petTab:'book'}}`(桌面无三联,保持 /pet?tab=book);② PetView:`routeQ` 改路由对象,setup 首读 `petTab` + `watch(query.petTab)` 同步页签(懒挂载+挂过保留,深链到达时可能已挂载);③ 轮52的 ← 返回钮改 `v-if=isMobileNav && route.name==='pet'`(独立页才需要)。见 F 区轮 54 |
| 27 | **每日打卡跳转方向澄清**（2026-09-25 用户原话:「去首页每日打卡,那个点击之后要能跳转啊,跳转到今日页面,今天过得怎么样」） | 轮51方向做反:把「打卡完」跳去了宠物。用户真正要的:**宠物页「今日温柔任务」里「记录今天的心情」行可点 → 跳首页「今日」联的打卡卡**。**改法**:① 撤销轮51(TodayPane 恢复纯本地打卡+3s提示,清掉重复导入);② PetView 任务行 mood 可点 + 「去打卡 →」小标 → `router.push('/?tab=today')` 深链(HomeView watch 消费成初始联;宠物联内嵌/独立页都成立)。见 F 区轮 53 |
| 26 | **去厨房落地的页面没有返回按钮**（2026-09-25 用户原话:「文档页面,去厨房,那个页面没有三级按钮啊」;「三级按钮」按「上一级按钮」理解） | 我的 → 去厨房 → /pet?tab=book:PetView 整页只有底部 TabBar 与系统返回键,页内无可见返回——网页端(无系统返回键)用户只能瞎摸。**改法**:照 SettingsView 的 set-back 给 `.park-hero` 加 ← 圆钮(仅 isMobileNav):有历史 router.back,直链进来 replace /profile(去厨房的来路)。pet-home 19/19。**若「三级按钮」另有所指,待用户澄清**。见 F 区轮 52 |
| 25 | **首页每日打卡点击后要能跳转**（2026-09-25 用户原话:「去首页每日打卡,那个点击之后要能跳转啊」） | 打卡本身有效(心情日志+宠物+5心情/+8经验/算照顾/+3金币/每日任务 mood),但点完哪儿都不去。**改法**:moodPick 成功后 800ms(让「打卡完成」绿字先闪)emit `go-pet`——复用 hero「去宠物」的既有通道(手机切宠物联/桌面跳 /pet);桌面侧不自动跳(宽屏布局整页拽走太打断,落点判断在 HomeView 不变)。见 F 区轮 51 |
| 24 | **二级评论默认显示前两条**（2026-09-25 用户原话:「暖心墙帖子,二级评论如果有的话,默认显示两条,现在是默认关闭」） | 原口径:二级回复默认全收起,点「N 条回复」才展开(轮13定「默认收起防刷屏」,用户现在推翻)。**改法**(两视图同口径):新增 visibleReplies/visibleReps = 展开时全量、否则 slice(0,2);回复列表容器从 `isRepOpen 才渲染` 改为 `有回复就渲染`;「N 条回复」按钮改 `v-if 数量>2`(≤2 条全显无按钮)。回复完顺手展开、就地回复框等联动不动。见 F 区轮 50 |
| 23 | **「我捞到的」已回信待同意要给提示**（2026-09-25 用户原话:「我已回信,但是对方还没有回信,这个时候需要给用户一个提示,待对方同意后可聊天,简洁一点」） | 流程:我回信后原信作者要**同意**才建聊——这段空窗原来只显示「你已回信」,用户不知道下一步在对方手里。**改法**:新增 `bottle.stWaitAgree`(zh「待对方同意后可聊天」/en "Chat opens once they accept"),`recState` held 分支判 `bottleChatState===waiting` 时显示;同意/婉拒后仍走原状态。消息页记录卡(BottleRecords)已有 `chatWaiting` 文案未动(两处口径不同:卡片副行 vs 状态签)。bottle-test 68→69 锁形。见 F 区轮 49 |
| 22 | **＋号纠偏：弹层宽度不该改,＋钮的圆超出栏外**（2026-09-25 用户原话:「+号之后谁让你改投漂流瓶跟发帖的宽度了,改回原来的宽度,还有,我说的是那给+号整体往下一点,那个上面的圆都超出了」） | 轮46 理解跑偏:把「往下居中」理解成了改弹层样式,实际用户要的是**＋钮本身下移**——它的圆 `margin-top:-16px` 探出 TabBar 顶缘,用户看着像溢出坏了。**改法**:① `.tabbar-sheet`/`.tabbar-opt` 整段回滚到轮46前原样(全宽双卡);② `.tab-compose-x` margin-top -16px→0——46px 圆 flex 居中于 44px 行高,上下各溢 1px 被 4px 栏内边距吃掉,圆完全在栏内,栏高不变。见 F 区轮 48 |
| 21 | **暖心墙顶部「暖心墙」文字浮卡去掉**（2026-09-25 用户原话：「最上面那个暖心墙的文字浮窗去掉,留在那儿干嘛」） | 那张卡是轮 35 头部压缩后的残余:副标题(桌面专属)与发布框(桌面专属)都收走后,手机端卡里只剩 h2「暖心墙」三个字 = 一块纯文字玻璃卡占首屏。**改法**:整卡 `v-if="!isMobileNav"`——手机端不渲染,桌面端(副标题+发布框)原样。一行改动,无 i18n 键增减。见 F 区轮 47 |
| 20 | **＋ 号发布弹层样式**（2026-09-25 用户原话：「那个+号发布的样式调好一点,往下居中」） | 原来是两张**全宽卡片**从 TabBar 顶上贴着弹(左右各 18px,几乎满屏宽),不像「从 ＋ 钮长出来的菜单」。**改法**（只动 style.css 两段,行为零变化）：① `.tabbar-sheet` 全宽 → **紧凑菜单卡 236px**（`min(236px, 100vw-150px)` 不盖两侧 Tab 文字）,水平**居中**用 `margin:0 auto`——刻意不用 `transform: translateX(-50%)`,入场动画 `tabbar-up` 的 `translateY` 也是 transform,终帧 `transform:none` 会把居中一起抹掉;② `bottom` 64→70px,底边贴 TabBar 上沿留 6px,正悬 **＋ 钮上方**;③ 两瓣入口变卡内两行(去独立卡片底/影,按压高亮),遮罩点击关闭不变。app-shell T2 只钉结构未钉样式,40/40 不受影响。见 F 区轮 46 |
| 19 | **漂流瓶记录口径**（2026-09-25 用户原话：「我发布的按最新排序,我捞到的按捞到的时间最新排序,而且不显示已放回海里的信封,只显示我已经回信的信」） | 「我发布的」本就是发布时间倒序（轮 17 口径,未动）。**「我捞到的」重写 SQL RPC** `bottle_records` 的 p_mine=false 分支：① 过滤 `reply_by=auth.uid() and reply_at is not null`——只有捞到信的人能回信,即「已回信的」;已放回（status 回 sea 无回信）与在守（held）天然排除,在守信的回信/放回仍走首页托盘 ② 排序 `case when p_mine is false then held_at else created_at desc`——回信后信是 answered,held_at 保留为捞起那一刻且不会再变（answered 不可放回/重捞）,即精确捞到时间。前端零改动（RPC 生效即两端生效）;MIGRATION+SETUP 同源,bottle-test 66→68 锁形。**✅ 迁移已执行（2026-09-25），线上探针 8/8 实锤**：判别器「放回的信缺席」成立（旧口径必现）、不变量「每行 reply_by=我」成立、held_at 倒序、后捞排前。见 F 区轮 45 |
| 18 | **我的页：帖子区块沉底 + 时间到秒**（2026-09-25 用户原话：「我的页面，我在暖心墙的帖子移到最下面，在我的食谱下面，而且时间显示到秒」） | ① ProfileView 的「我在暖心墙的帖子」整块（含最新 3 条卡与「更多 →」）从「改昵称」下方挪到**页面最底**（我的食谱之下）；② 帖子卡时间原来只有日期（`toLocaleDateString`），改为**显示到秒**——新纯函数 `fmtWhenSec`（与 `fmtWhen` 同口径：跨年补年份、非法→空串，只多 second；刻意不做参数，两处调用语义各自显式：墙上列表到分钟、个人主页到秒）。范围就按用户说的只动「我的」页——暖心墙/my-posts/帖子详情仍是到分钟，要全站到秒说一声。验证：wall-rules-test 39→**42** + undef/tdz 0 + page-smoke 8/8 + 部署 Version `12e6e3e0`（SHA16 `88fc3eeb89fd5983` 本地=线上）+ APK `88B42A09744AB402` 待装机。见 F 区轮 44 |

- **工具沉淀**：`tools/build-until-good.mjs`（构建 + 自验产物含 slug + 不合格自动重试，防坏包出门）、`tools/live-bundle-check.mjs`（线上入口包与本地 dist 逐字节比对 + hasSlug 检查）。
- **本轮事故（已修复，教训见踩坑 #25/#26）**：一次 `npm run build; npm run deploy` 链式执行，build 被 env-guard 拦下后 deploy 照跑 → 坏包上线（线上无 Supabase 配置、登录失效）。复部署后线上 `hasSlug=true`、SHA 与本地一致。
- **验证**：i18n 19 / wall-rules 39 / cache 12 / undef 0；线上 `cloud-e2e` 38/38、通知去重探针 5/5、`live-check` 14/14；README（排序/每日 7 条/迁移 12·13/工具清单）已同步。


## 四、还没做的

| 项 | 说明 | 依赖 |
|---|---|---|
| #26 线上 SQL 未生效 | ✅ **已闭环（2026-09-19）**：用户重跑整段迁移后，判别器 **8/8 全绿** + `cloud-e2e` **37/37**（T19b/T20/T21 全部转绿） | 无需再动 |
| #23 迁移执行状态未确认 | `MIGRATION_notifications_drop_dm.sql`（清历史 dm 通知 + 拦新生成）；轮 13 报的待执行，用户尚未明确反馈已跑 | **未跑则通知中心残留老私信条目**（其余不受影响） |
| 轮 15 实机验收 | 12 条反馈已上线 / App 已打包，需真机逐条验收（重点：App 分享面板、竖屏、金币重复领取、通知 ×N 与取消撤销、每日 7 条）。**「漂流瓶换号记账」已被轮 37 取代**：本机不再记漂流瓶次数（全线上），换号/清缓存都不可能串账或回满 | 用户实机 |
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

1. **等用户真机验收轮 31/32**（轮 31：App 内谷歌登录全程不出 App；轮 32：换号不串档——A 登录玩→退出→注册全新 B 号，B 必是 1 级 50 金币，A 再登录档还在；APK 装机待做）。
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

28. **同一个口径改了两处只记得一处（轮 32 真凶）**：轮 31 因 `@capacitor/browser` 懒块把 env-guard 的「所有 `index-*.js` 都必须含 slug」改成「只验 index.html 真正加载的入口」，但 `tools/build-until-good.mjs` 里**同一段判定逻辑还留着旧口径**（两处是复制粘贴的兄弟代码）→ 构建明明成功、guard 明明放行，保险脚本却恒报 BUILD_ALWAYS_BAD 重试 5 次失败。**教训（强制）**：修「误报口径」时要先全仓 grep 同类判定（`index-`、`slug`、`entry`），兄弟脚本一起改；判定逻辑尽量抽成单一实现（本次因一个在 vite.config 插件、一个在独立 node 脚本，暂以注释互相指向）。

29. **「immediate watch 在 setup 期间同步执行」会把后面才声明的 const 变成 TDZ（轮 34b 真凶，/admin 白屏）**：轮 33 在 AdminView 里把举报页签的状态 const 声明放在 switchTab 之后，而文件更前面的 `watch(signedIn, …, { immediate: true })` 同步调 load() 重置这些状态 → `Cannot access before initialization`。构建、undef-check、33 套源码扫描测试**全都不执行组件代码**，所以全绿照样白屏。**教训（强制）**：①immediate watch / setup 期同步执行的代码路径，其引用的响应式状态必须声明在它**之前**（AdminView 举报块已加「位置硬约束」注释）；②新增 `tools/page-smoke.mjs`（8 条关键路由无头真实挂载 + 无崩溃盒断言）作为运行时防线，改 .vue 构建完必跑；③Git Bash 跑 web-probe/page-smoke 记得 `MSYS2_ARG_CONV_EXCL="--url"`（MSYS 会把 /admin 转成 Windows 路径）。

30. **`<style>` 里不能出现字面 `</style>`；Android 主题必须看「Activity 用的是哪一个」（轮 38 双真因，各拖了 8 轮 / 13 轮）**：① **启动页消失**：轮 30 在启动页那个 `<style>` 块中间写了行注释，注释里带了**字面 `</style>`** —— HTML 解析器在 `<style>` 元素内遇到它就**立刻结束元素（注释也不豁免）**，后半段 CSS 全成了文档里的裸文本；恰好留在元素内的那半段是 `display:none`，于是「App 端启动页」静默消失，而网页端本来就要隐藏 → 症状只在 App，八轮没被发现。**教训（强制）**：写 `<style>`/`<script>` 内容时永不写出字面闭合标签（要举例就写「style 结束标签」文字），并让测试守标签守恒（`tools/splash-test.mjs` ⑥/⑦ 现断言 `<style` 与 `</style>` 计数相等 + 注释内不得含字面闭合标签）。② **黑边**：轮 25 把米色窗口底 `android:windowBackground` 写在 `AppTheme.NoActionBar` 上，而 `AndroidManifest.xml` 里 Activity 用的是 `AppTheme.NoActionBarLaunch`（当时 parent=`Theme.SplashScreen`，与我们的主题**毫无继承关系**）→ 米色从未生效，冷启动露的是启动主题默认底（黑）+ Capacitor 模板默认蓝色 X 的 `splash.png`。**教训（强制）**：改原生主题前**先打开 Manifest 确认 Activity 用哪个 style**，再确认它的 parent 链；`values-v31/` 里同名 style 是**整体替换不是合并**（要写全 parent+items），Android 12+ 系统启动画面走 `windowSplashScreenBackground`/`windowSplashScreenAnimatedIcon`，不设就退回 `?colorBackground`（深色下=黑）。③ **判定黑边不能用单张静态截图**：黑边只存在于「原生启动层结束 → WebView 铺满」的几百毫秒里，静态截图（甚至运行中截图）都扫不到；必须**连续抓帧**（本次 14 帧 / 约 100ms 间隔）再逐帧扫左右边缘列的暗像素，并且要能区分「桌面『打开应用』转场动画的黑幕」与「App 窗口自己的黑边」——前者是系统的，别当 bug 修。

31. **恒浅色 App 必须显式退出深色模式；「验收时段」本身就是盲区（轮 39 真因）**：App 内 UI 恒为米色，但 `AppTheme.NoActionBar` 用 DayNight parent、WebView 没关 Force Dark——深色模式下 Android 10-12 的 WebView Force Dark（夜间 uiMode 默认开启，`@capacitor/android` 8.5.2 对此零处理）与 MIUI 自家深色会把浅色页面**整个反黑**；轮 24-38 每轮验收都在白天浅色模式下抓帧，这层从未被测到 → 用户「白天验收、夜里黑屏」。**教训（强制）**：① 浅色恒定的 App 三道闸缺一不可：主题不用 DayNight + `android:forceDarkAllowed=false` **写满继承链每个节点**（显式 parent 不继承、同名 style 整体替换，见 #30②）+ `AppCompatDelegate.setDefaultNightMode(MODE_NIGHT_NO)` 必须在 `super.onCreate` **之前**（BridgeActivity.onCreate 内部就 setContentView + 建 WebView，晚调无效）+ WebView 实例 `setForceDarkAllowed(false)`；② **验证要覆盖使用时段**：白天的浅色实测证明不了夜里深色下的表现——凡动主题/配色，浅色+深色各跑一遍（`adb shell cmd uimode night yes/no` 可切换）；③ splash-test 已把三道闸钉成断言（15→18），拆掉任何一道都红。

32. **同一坑第二次犯：immediate watch 的 TDZ（轮 41 真因，首页整页崩）**：#29 已经把这条写成「强制」规矩，轮 41 还是在 `BottleView.vue` 重犯——为了让「进首页就查漂流瓶」生效，把 `watch([cloudSigned,myId], cb)` 改成 `{ immediate: true }`，而 `cb` 要动 `recPage`（连带 `recTab/recLoading`）这些**声明在第 224 行**的 const，watch 在**第 87 行** → immediate 在那一行同步执行回调，绑定还在 TDZ → `ReferenceError: Cannot access 'ht' before initialization`（`ht` = 打包后 `recPage` 的压缩名）→ `App.vue` 的 `onErrorCaptured` 接管 → **首页整页变「这里好像有点小状况」**，漂流瓶与首页数据全军覆没。**为什么上一轮没拦住**：轮 41 只跑了离线套件（不执行组件代码）+ `undef-check`（这不是「未定义」，是执行顺序）+ `build`（构建不看运行时），**偏偏漏跑 #29② 自己立的 `page-smoke`** —— 它一跑就红。**教训（强制）**：① 交付前 `page-smoke` 与 `undef-check` **同级硬门槛**，改任何 `.vue` 必跑（真机/线上出现错误盒也先跑它复现）；② 初始查询不要用 `immediate: true`，改成「`onMounted` / setup 末尾显式调用一次」——`onMounted` 在 setup 全部执行完之后才跑，引用的 const 必已初始化（`BottleView` 现按此写）；③ 新增 **`tools/tdz-check.mjs`** 静态防线（顶层 `watch(..., {immediate:true})` 的回调体——含它调用的本文件顶层 function 声明的体——里出现的标识符，若其顶层 const/let 声明行在本文件更后面即报错；自带 `--selftest` 2 项，并用轮 41 旧代码回归实测命中 `BottleView.vue:87 recPage（声明 224）`），构建前必跑；④ 定位手法留档（源码名被混淆时很好用，承 #11）：真机抓帧看到错误盒 → `adb logcat | Select-String 'before initialization'` 拿到压缩名 → 在 `dist` 产物里数该名字的**所有**出现处，找到声明点反查源码变量。

33. **「未声明就赋值」连 undef-check / tdz-check 都抓不到（轮 82 真凶，B1 虚拟窗口整段接线静默失效）**：给页面接管滚动锚定时写了 `prevAnchor = root.style.overflowAnchor` 却**漏了 `let` 声明** —— ESM 是严格模式，赋值未声明标识符直接 `ReferenceError`，`onMounted` 从那一行起**整段中断**（后面 5 个 addEventListener / 首次窗口计算 / RO 装配全没执行），界面却「看着正常」：首屏十几条照常显示，只是永远不再续载、也没有占位块。`undef-check` 只查「导入的符号导入了没」，`tdz-check` 只查 immediate watch 的声明顺序，`vite build` 更不看运行时 —— **三层防线全绿**，只有真机量几何（DOM 卡片数 / 占位块高度 / docH 是否增长）才现形。**教训（强制）**：① `tools/undef-check.mjs` 新增第 2b 类检查（赋值给本文件从未声明的裸标识符），并自带 `--selftest` 10 项；② 挂载钩子里「顺序敏感的大量装配」要能一眼看出是否中断 —— 关键装配放前面、可疑赋值放后面，或包成独立函数；③ 真机几何取证脚本（`tools/feed-window-live.mjs`）把「DOM 卡片数上限」「回滚/回顶不白屏」「docH 单调增长」量成断言，纳入改动态流的收尾。
34. **「近似正则」的静态检查会假绿也会假红，必须自带反向样本（轮 82 的 undef-check 2b 落地过程）**：初版实现直接整文件扫赋值 → 刷出 **365 条**假警报，来源三类：① `.vue` 的 `<template>` 里 `class="x"`、`:style="{…}"` 被剥成 `class=` / `style=`，与赋值长得一模一样（**必须只扫 `<script>` 块**）；② 多层嵌套模板串（`` `…${a ? `&before_id=${enc(b)}` : ""}` ``）剥不干净，把 `before_id=` 当赋值（**赋值正则要 `(?<![\w$.'"`])` 前缀 + `=(?![=>])` 后缀**）；③ 声明集合漏收 —— `const W = 640, H = 480` 只收 W、方法简写 `async listPosts(limit, opts = {})` 的参数、`for (const [k, v] of xs)` 与解构默认值 `{ replyTo = "" }` 全算「未声明」（**要按语句级切声明器 + 收方法参数 + 支持解构/for-of**）。修完 365 → **0**，且十类样本（含「真缺陷」与九类「不许报」）钉进 `--selftest`。**教训**：这类检查**假红会淹没真问题、假绿会放过真事故**，落地时必须：先跑全仓看假红 → 修到 0 → 再把「真缺陷样本 + 各类假红样本」都写成自检项；只加规则不写自检等于埋雷。
35. **硬编码的布局常量 ≠ CSS 真相；「同一件事的三个数字」必须锁成一条链（轮 82 三处真缺陷之二）**：① 组件里 `POST_GAP = 18`（桌面 `.card` 的 margin-bottom），可同一份 CSS 里 `.shell--mobile-nav .card { margin-bottom: 12px }`（420px 断点）—— 手机端每张卡少算 6px，几百条后累计上千像素**串位**；② 估高写死 `FEED_EST = 340`，而 `.post-card` 的 `contain-intrinsic-size`（= 未渲染时浏览器实际给的高度）是 **320px** —— 20px × 窗口尾部十几张 = 一截可见空档（真机取证量到过 **138px**）。**教训（强制）**：① 布局常量**从真实元素 `getComputedStyle` 现读**（读不到才回落常量，断点/主题一变就得失效重读）；② 同一件事分散在三处（CSS 的值 / 模块常量 / 组件用的值）时，**只留一条链**（`FEED_EST = DEFAULT_EST`）并用测试断言三者严格相等（`feed-window-test` T17 + `feed-perf-test` T23），禁止各自写一个「差不多」的数。
36. **`overflow-anchor` 是双刃剑；「正在滚动」的时间戳必须先有人写（轮 82 真缺陷之三）**：① 虚拟窗口按设计会改动视口上方的布局（占位块高度），浏览器自带的滚动锚定会在这种时候擅自把滚动位置搬回去 —— 真机取证里 `window.scrollTo(0,0)` 被拽回 **39k** 处；正确做法是 `document.documentElement.style.overflowAnchor = "none"` 交出控制权、卸载时把**原值**还回去，滚动补偿由我们自己按「锚点卡片位移」做。② 补偿前有两条守卫（「还在滚让位」「别人动过让位」），其中「还在滚」依赖 `lastScrollAt` —— 而这个时间戳**从来没被写过**（不是声明漏了，是 `scroll` 监听里那行赋值没加），于是守卫恒为假 = 形同虚设，脚本滚动有概率把用户的平滑滚动**掐在半路**。**教训**：写守卫条件时顺手确认「这个变量谁在写」，否则条件恒真/恒假都不会报错；关键守卫加一次性真机场景验证（跳转/回顶/上滚）。
37. **rAF 被节流时，真机几何取证会得出假结论（轮 82 取证环境雷）**：无头 / 被遮挡的 Chromium 会把 `requestAnimationFrame` 压到 ~1Hz，于是「跳转后的下一帧」要等一整秒 —— 空档、延迟、串位类信号全被放大成假缺陷（这也是此前「100→0→14 坍缩」读数的一类来源）。**教训**：真机取证脚本开头先量 rAF 频率，低于 20fps 就在结论里显式标注「时序相关信号不可信」并要求前台复跑（`tools/feed-window-live.mjs` 已内置）；量几何要用「当前真实存在的元素」而不是上一帧的缓存读数。
38. **外部字体 CDN 的阻塞样式会挡住 module 脚本执行（轮 84 page-smoke 全红真凶）**：`<link rel="stylesheet">` 指向 jsdelivr/googleapis，CDN 慢/挂时浏览器等样式表（后续脚本执行被阻塞）→ Vue 迟迟不挂载，页面停在 SEO 静态占位；page-smoke 8/8 全红（mounted=false、crash=null——**无崩溃盒不等于没病**），用户侧就是「先看到英文占位页才进正页」。**教训（强制）**：第三方装饰性样式（字体）一律 `media="print" onload="this.media='all'"` 异步化 + `<noscript>` 兜底（CSP `script-src` 有 `unsafe-inline`，内联 onload 可用）；探针 mounted=false 且无 crash 时先看 `document.readyState` 与外部资源，别急着改业务代码——本轮 12 秒长等待实测 readyState 从 loading → interactive、shell 立挂，实锤才动手。
39. **import 大括号内写注释会被 undef-check 的 IMPORT_RE 粘连（轮 84 误报「未导入」）**：解析器按逗号切名字，`/* 注释 */\n  nextName` 粘成一个垃圾 token → nextName 没进绑定集 → 误报「使用了但未导入/未定义」。**教训**：import 语句的 `{}` 内不写注释（写在语句上方）；要改解析器得连 `--selftest` 样本一起动（本轮选择改写法绕开）。
40. **Git Bash 会把以 `/` 开头的命令行参数做 MSYS 路径转换（轮 108 web-probe 假故障）**：`node tools/web-probe.mjs --url=/community` 在 Git Bash 里实际传给 Node 的是 `D:/00ruanjiananzhuang/git/Git/community`（MSYS 把绝对路径参数翻译成 Windows 路径）→ `Page.navigate → Cannot navigate to invalid URL`，看似工具坏了其实参数被改写。**修**：命令前加 `MSYS_NO_PATHCONV=1`。**教训**：在本机 Git Bash 里给 node 工具传「以 / 开头」的参数（URL、绝对开关）都要想到这层；报 invalid URL 先打印 target 验证。
41. **getBoundingClientRect 验不出堆叠层级；fixed 浮层压不过根级 tabbar（轮 108 续 tabbar 露头）**：底部输入条改 `bottom:0` + `z-index:150` 后，几何探针全部「正常」（barCoversViewportBottom ✓），真机截图里 tabbar 却仍盖在条上——条在 route-wrap 内部、受父级堆叠上下文限制，z-index 只在**父上下文内部**比大小（轮 103 弹窗被 tabbar 盖住是同一陷阱；CommentComposer 为此上过 Teleport 又因 WebView 事件问题拆掉）。**教训**：① 「全屏浮层 vs tabbar」别玩 z-index 竞赛——直接**收起 tabbar**（`uiStore.tabbarSuppressed`，聊天页 inChat 同款先例）或 Teleport 到 body；② 几何断言（bounding rect）只能证位置不能证绘制层级，浮层验收必须**目检截图**；③ 抄既有样式前先看清它的定位前提（`.reply-bar` 的 `bottom:64px` 是「浮在 tabbar 上」的口径，不是「贴键盘」的口径）。
42. **wrangler.jsonc 的 `routes` 会整体替换 Worker 的绑定集合，不是追加（轮 114 换域名旧域 530）**：首部署只在 config 写了新域 `warmpaws.de5.net`，deploy 后触发器列表只剩它——面板上绑的旧域 `dale.de5.net` 被顶掉，**旧域直接 530**（DNS 记录虽在，边缘无路由），存量 APK（VITE_API_BASE=旧域）当场断粮。另外加了 routes 后 `workers.dev` 默认被关闭（配置没写 `workers_dev`）。**修**：双域都写进 `routes` 重部署 + `"workers_dev": true` 恢复，三址全 200。**教训**：① Worker 的入口集合以 config 为准，面板手工绑的域在下次 deploy 都可能被清——**所有正式域名必须写进 wrangler.jsonc 的 routes**；② 换域名/动 routes 后必须**逐个 curl 全部旧入口**（不能只验新域）；③ 本机 DNS 缓存会抖（000/exit 6 与 530 混在一起），判定要用 `nslookup 权威 DNS` + `curl --resolve 钉 IP` 交叉验证，并等边缘配置生效一两分钟再下结论。

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

### 11. 推荐流规模化（2026-09-25 追加 —— 用户问「几十万用户、7 天几百万帖时怎样展示」）

**现在的「推荐」不是推荐，是「7 天新帖稳定洗牌」**，三层：
① 服务器 `ORDER BY created_at DESC` 给最新 50 条（无任何打分）；② 客户端过滤出 7 天内的帖，用 `mulberry32(当天UTC日)` 稳定洗牌——**同一天所有人看到的顺序完全相同且稳定**，零点换序；③ 本地切片展示。内容少时够用；它的本质是「只洗已拉取的那一小撮」。

**量级断点表**（7 天窗口内帖子数 → 会发生什么）：

| 量级 | 现象 | 根因 |
|---|---|---|
| ~千帖 | 正常 | 设计目标 |
| ~万帖 | 「推荐」名存实亡：只展示最新几百条，7 天窗口 99% 的帖永远没人看到 | 洗牌只作用于已拉取子集 |
| ~十万帖 | 翻页线性变慢拖垮库 | `OFFSET N` 要扫过并丢弃 N 行 |
| ~百万帖 | 客户端炸：已加载数组无限增长，每次互动全量重排 O(n log n) | 纯客户端排序 |

产品事实：**没有产品会展示百万条**——小红书/微博/抖音都是「为用户现场挑几十条」。到那个量级，展示形态 = 服务端按用户打分（新鲜度衰减 + 互动热度 + 阅读去重 + 关注加权）+ 游标翻页的个性化流；「7 天窗口」被分数衰减取代。

**演进路线（到量级才做，不预支 complexity）**：
- **万帖级（✅ 轮 62 已做）**：offset → **游标（keyset）分页**——`id` 是串行主键（单调=发布序），`id < 游标` 走主键索引，任意深翻页成本恒定；全链路（Worker `before_id` → 网关 → 直连 `.lt` → CommunityView 游标=末条 dbId）。
- **十万帖级**：排序上服务器（新鲜度衰减 + 互动加权），评论数物化到帖子行；配 `(removed, created_at desc)` 复合索引。
- **几十万日活**：真正的个性化 feed（fan-out / 读时排序）+ 付费架构，单独立项——同时免费套餐容量（本节上文）早已触顶，先升配再说。

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

  - **轮 32 · 本地个人数据按账号分域（2026-09-23，已部署 Version `b19875c3`，提交 `5dc9181`）**：
     **用户报障**：「宠物我一个新注册的号怎么就 3 级了，你这缓存怎么写的」。
     **根因**：宠物档/金币/手绘厨房/心情/每日任务/冒险/装扮这些 localStorage 键全是**全局单键**——同一台设备换账号直接读到上一个人的档（新注册的号「继承」别人的 3 级宠物）。同类串档键还有暖心墙的浏览去重/匿名 id/当日发帖记账/本地帖/回应/本地评论。
     **修法（新 `src/utils/userScope.js` = 唯一机制）**：个人数据键统一 `base:<域>`，域 = 登录 uid；未登录 = guest。四件套：①各模块 `registerScopeBases([...])` 声明个人键（petStore 的 7 个 base 自注册；暖心墙 6 个键收在 wallRules/comments、由**急加载的 wall.js** 代注册——懒加载视图组件注册来不及，main.js 的 initUserScope 跑在路由组件加载之前）；②`initUserScope()` 启动时把「升级前的无域老档」搬进 guest 域 + 登记待认领（幂等；**搬完触发一次 reload**——模块级初始读档跑在迁移之前，首次升级加载不补这次就丢档）；③`claimForUser(uid)` 升级后第一次登录把 guest 老档认领给该账号（**只认一次**、不覆盖账号已有档 → 认领过之后新注册的号必然是全新 1 级 50 金币）；④`setUserScope(uid)` 换号唯一入口：先 flush（旧域落盘）→ 切域+认领 → reload（新域重读），App.vue `watch(cloud.user.id)` 接线，登出传空回 guest。petStore 注册 flush/reload 就地重读（splice/delete+assign 保响应式引用）；wall.js 加 `cancelPetHomeSync()` 换域时撤销 4s 延迟的宠物主页推送（防 A 的宠物推到 B 的主页）。**漂流瓶配额账本轮 18 起已按 uid 分键，无需动**；SORT/RANGE 是设备级偏好故意不进域。
     **口径**：纯前端键名变化，**零迁移**、云端数据不动；网页端刷新即生效，**App 端要装新 APK 才生效**；v1 时代老档（`warm-paws-pet-v1`）不经此机制（petStore 自身的 v1→v2 迁移路径处理，量级可忽略）。
     **验收**：userScope-test **8/0**（T7 端到端复现原报障：A 认领老档后新注册 B 必无档）+ 全量 **32 套 0 fail** + `undef-check 0` + build 0 + 部署 + live-check 14/14 + 线上 SHA16 `888112a83f9d7747` 本地=线上 + cap sync + APK 重打（4.77MB SHA16 `d73e84248242747b`，手机未连未装机）。
     **顺带修的基建坑**：`build-until-good.mjs` 还在用「所有 index-*.js 都要含 slug」旧口径 → 轮 31 引入 `@capacitor/browser` 懒块后恒报 BUILD_ALWAYS_BAD（env-guard 当轮改了、这脚本漏改）→ 对齐成「只验 index.html 真正加载的入口」（见踩坑 #28）。

  - **轮 33 · 举报 / 审核 / 拉黑体系（2026-09-23，已部署 Version `2c918771`，提交 `a9e5b16`）**：
     **需求（用户拍板）**：UGC（帖子/评论）配举报 + 管理员审核 + 拉黑；管理中心查举报并处理，分待处理/已处理。拍板结果：拉黑=全站生效（复用 dm_blocks）；帖子不因举报数自动下架（厌恶阈值已有），下架后进「待复核」；评论 ≥3 人举报自动隐藏；处理结果通知举报人；「举报用户本人」本期不做。
     **数据库（`MIGRATION_reports.sql`，待用户执行）**：①`reports` 表（reporter 可空=系统条目 / target_type post|comment / reason 六枚举+auto / source report|auto / status pending|handled / handled_by+at+action+note；同人同目标 partial unique；待复核同目标只排一条 partial unique；RLS 本人或 admin 可读，写入全收口 RPC）②`wall_comments` 加 `hidden/hidden_at`，读策略升级为「hidden 对作者与管理员可见」③RPC `report_create`（防刷每日 10 条 + 同目标幂等 + 目标存活校验 + 评论 ≥3 人自动隐藏，`hidden_at is null` 保证恢复后不再自动隐藏）④RPC `admin_report_page`（两档分页，带正文/作者/聚合人数/内容丢失标记）⑤RPC `admin_report_handle`（dismiss/remove_post/restore_post/delete_comment/unhide_comment 五动作 + 幂等 + 给举报人发 `event=report_handled` 的 system 通知）⑥`wall_toggle_dislike` 下架时插待复核条目 ⑦`admin_overview` 加 `reports_pending`。SUPABASE_SETUP.sql 已同步（两个既有函数原地更新、其余追加，report-test 钉住「只保留一份定义」）。
     **Worker**：`POST /api/reports`、`GET /api/admin/reports?status=&offset=&limit=`、`POST /api/admin/reports/:id/handle`（白名单翻译，参数透传 RPC）。
     **前端**：`ReportDialog.vue`（原因六选一+补充说明+成功先示「已收到」再收起；PGRST202→「功能还没开启」按坑 #14 判 code）；CommunityView/PostDetailView 帖子卡与两级评论「举报」入口（自己的内容不显示）+ 拉黑内容过滤（consume/loadThread/loadComments 出口 filterBlocked）；`userBlocks.js`（复用 dm_blocks，按账号域快照 + 换域重置，blockUser/unblockUser 即时改缓存）；WallerView 拉黑按钮（两步确认 4s 复位 + 已拉黑态可撤销）；AdminView「举报」页签（待处理/已处理子档 + 页签红点 `reports_pending` + 处理后本地移除并同步扣红点 + 已处理档可查处理记录；评论条目给「看原帖」跳 /post/:id）；notifyRules `report_handled` 分支；i18n zh/en 各约 30 键。
     **验收**：report-test **58/0**（迁移/SETUP 同源 + Worker 白名单 + 双模式成对 + 错误码↔i18n + itemView 真跑 + userBlocks 过滤/换域真跑 + 四视图接线）+ 全量 **33 套 0 fail** + undef 0 + build 0 + 部署 live-check 14/14 + SHA `9d9dfc7e1cd32d69` 本地=线上 + APK 重打 `9aa11fce669cdf13`。**数据库行为（阈值/防刷）离线锁形 + 上线探针闭环，迁移未执行前功能不生效（优雅降级）**。
     **待用户**：执行 `MIGRATION_reports.sql` → 探针验证 → 真机走查（举报→待处理→处置→通知→已处理闭环 + 拉黑隐藏）。

  - **轮 34 · 拉黑收尾（2026-09-23，已部署 Version `62722c5d`，提交 `6f95cec`）**：
     **背景**：拉黑主体功能轮 33 已上线（复用 dm_blocks + userBlocks 前端过滤）；本轮补「消息页侧」的一致性——原来聊天页菜单拉黑与拉黑列表解除都直调 `dmApi.block/unblock`，**绕过了 userBlocks 的内容过滤缓存**：解除拉黑后，TA 的帖子/评论在暖心墙要等刷新页面才恢复显示。
     **改动**：①MessagesView 两处拉黑调用点（聊天页菜单 `toggleBlock`、拉黑列表 `unblockOne`）改走 `userBlocks.blockUser/unblockUser`（RPC + 缓存 + 快照同步更新）②进消息页 onMounted 同步一次名单 ③拉黑列表提示文案升级全站口径：「被你拉黑的人无法给你发消息，TA 在暖心墙的帖子/评论也会对你隐藏。对方不会收到任何通知。」（zh/en 成对）。
     **验收**：report-test **60/0**（+2：消息页不再直调 dmApi.block/unblock、文案双语全站口径）+ 全量 **33 套 0 fail** + undef 0 + build 0 + 部署 live-check 14/14 + SHA `f19813f10e2a8e61` 本地=线上 + APK `ce86e7c3e60f557d`（装机待做）。
     **顺带探针**：确认 `MIGRATION_reports.sql` 尚未执行（report_create/admin_report_page 均 PGRST202，坑 #7 判据）。

  - **轮 34b · 修 AdminView 白屏（TDZ）+ 页面挂载冒烟上线（2026-09-23，部署 Version `da1d2b4b`，提交 `931324e`）**：
     **用户实测 /admin 白屏**：Uncaught ReferenceError: Cannot access before initialization（AdminView setup 阶段）。**根因**：轮 33 把举报页签的状态声明（reports/repLoaded 等 const）放在了 switchTab 之后，而 `watch(signedIn, …, { immediate: true })` 在 setup 期间**同步**执行 load()，load() 里重置这些状态 → 暂时性死区（TDZ）。构建/undef-check 都不执行代码所以没拦住（踩坑 #9 家族）。**修法**：举报状态块整体移到 watch 之前（加「位置硬约束」注释）。**全仓排查**：其余 8 处 immediate watch 逐一核对，均安全（声明在前或回调短路不触达）。**新防线**：`tools/page-smoke.mjs`——8 条关键路由无头 Edge 真实挂载，断言「挂载成功 + 无崩溃盒」（App.vue onErrorCaptured 兜住的 .crash-box），TDZ/运行时崩溃类只有真挂载才抓得到；改 .vue 构建后必跑。**验收**：page-smoke **8/8**（含此前必崩的 /admin）+ 全量 33 套全绿 + undef 0 + 部署 live-check 14/14（首轮 FAILED=1 为部署后瞬时网络抖动，复测全绿）+ SHA `e32eb8db823af0ee` 本地=线上 + APK `5db36b38ca3b2939`。
     **顺带踩坑**：Git Bash 下跑 web-probe/page-smoke 必须 `MSYS2_ARG_CONV_EXCL="--url"`，否则 `--url=/admin` 被 MSYS 路径转换改写成 `D:/…/Git/admin` → 导航失败（page-smoke 已内置处理）。

  - **轮 34c · 「评论没有举报」澄清 + 游客入口（2026-09-23，部署 Version `c0be242f`，提交 `9c6d3cc`）**：
     **用户反馈「评论的举报没有」**。数据侧查明：墙上 13 条云端评论全部来自用户自己的两个号（9632×8、linyi×5），举报按钮按设计**不显示在自己的内容上**（不能举报自己）→ 一条都看不到是口径所致，不是功能缺失。**改进**：4 处 canReport（CommunityView/PostDetailView × 帖/评）去掉 signedIn 依赖——**游客也能看到举报入口**，点击后弹窗内提示「先登录再来举报哦」；登录用户看别人的云端内容必有按钮。report-test 61 项（+1：游客可见断言）。**验收**：report-test 61/0 + page-smoke 8/8 + 全量 33 套全绿 + undef 0 + 部署 live-check 14/14 + SHA `4cc06541329f8a66` + APK `eafea3f5218e0753`。**给用户的验收口径**：用另一个号发一条评论，主号刷新后该评论下方就有「举报」。

  - **轮 35 · UI 优化一轮（2026-09-23，部署 Version `854e7975`，提交 `503855a`）**：
     **方法**：无头 Edge 对 9 个页面/双视口截屏逐页看，改完再截屏对比（不再凭感觉盲改）。**改动**：①首页大厅状态 4 键 + 心情打卡 5 键 quaternary → **secondary**（原来是近乎纯文字，看不出能点——真可用性问题）②手机端暖心墙头部压缩：去掉与 h2 重复的小标签、副标题只留桌面（首屏多露一帖）③心情日历手机端 6 列大方格 → **10 列小格**（空态不再占三屏）④大厅人数胶囊紧凑 ⑤排序行「排序/时间」前缀手机隐藏 ⑥「去厨房/更多」入口链接统一主题色（原浏览器默认蓝紫跳出暖调）。**验收**：page-smoke 8/8 + 全量 33 套全绿 + undef 0 + live-check 14/14 + SHA `b96f8168ac849fd2` + APK `5c8d64ba7d6a8019`。

  - **轮 36 · 响应速度专项（2026-09-23，部署 Version `12b1547a`，提交 `bacb559`）**：
     **用户报「进 App 后暖心墙帖子/会话消息/我的帖子都不跟手」**。诊断出三个根因：①**启动链被昵称网络请求串行卡死**——initCloud 里 ready 压在 refreshSession 之后，而 loadProfile 是一次 /sb 代理网络往返（国内 0.5~2s），所有以 cloud.ready 为首拉条件的列表页干等，SWR 缓存快照也被押后；②路由过渡 out-in 两段 0.15+0.3=0.45s；③「我的帖子」无缓存每次进页白屏。**修法**：①`cloud.ready` 提前到本地会话（user/token 同步恢复）后立即置位，昵称异步补（校验 uid 未变防登出竞态）——「防游客身份竞态」的原意图不受影响（user 在置位前已恢复，首拉仍带身份；昵称只影响署名显示）②过渡 0.3/0.15 → **0.18/0.08s**、位移 14→8px ③MyPostsView 首屏接 SWR（key=myposts:uid，快照秒开 + 云端覆盖，翻页仍走网络；uifix T23 断言同步更新）。**验收**：uifix 24/0（T23 更新）+ auth 130/0 + 全量 33 套全绿 + page-smoke 8/8 + undef 0 + live-check 14/14 + SHA `7ce958d6a4e44c78` + APK `3e1e62db9a14a490`。**待真机对比**：装机后体感验证冷启动列表出现速度与切 Tab 跟手度。

  - **轮 37 · 漂流瓶全线上（2026-09-23，部署 Version `3aa322a3`，提交 `1c5f112`）**：
     **用户报障（原话）**：「你把漂流瓶功能全改成线上的，不要本地缓存了……什么每天捞 7 瓶、写 3 瓶，你老老实实的改成线上好吗，我是被你整怕了，改了十几轮」。此前轮 15/18/21/26 反复修的正是「次数显示打架」，每次都在**本机账本 + 服务端值两套真相**之间打补丁 —— 只要本机那份还在，问题就会换张脸再回来。
     **根因（一次说清）**：`BottleView.vue` 里留着一本本机乐观账 `warm-paws-bottle-quota-v1:<uid>`：①服务端值还没回来（或拉不到）时它顶上去显示满额 3 封 / 7 瓶 → 「明明用完了还显示还能捞 7 次」；②清缓存/换设备 = 次数直接回满（可绕过的假限额）；③网页与 App 各记各的账，跨端必然对不上。此外托盘（`bottle:held`）与记录（`bottle:rec`）各有一份 SWR 本机快照，换号/换端会先闪一份别人的或过期的数据。
     **修法（全线上 = 本机零真相）**：①**删掉整本本机次数账**（`QUOTA_BASE`/`loadQuota`/`freshQuota`/`bumpQuota`/乐观 +1 与 `todayKey` 依赖全部移除），`quota` 只存服务端 `bottle_quota()` 返回值；没拉到时是 `null` → 界面显示「次数同步中……」，**绝不编数字**；发信/捞信/回信成功后一律 `await syncQuota()` 回读，客户端不再做任何记账。②**拉不到也不拦操作**（不拿未知当满额、也不当 0）：如实提示「今天的次数由服务器为准，暂时没取到」，真限额由 SQL RPC 的 `bottle-limit-send/fish/hold` 挡住 —— 前端永远不替服务端做减法。③**托盘与记录去掉 SWR 快照**（`refreshBottle` / `loadRecords` 直接现拉，失败如实报错 `trayErr`/`recErr`，不用旧快照假装成功）。④新增 `bottle.js purgeLegacyBottleLocals()`：进页面清掉老版本留在设备上的 `warm-paws-bottle-quota-v1:*` 与 `wp-cache:v1:bottle:*`（只删漂流瓶前缀，不碰私信/通知缓存）；`App.vue` 登出时的 `cacheDrop("bottle:")` 保留作老设备快照兜底（已注释说明不许删）。⑤新文案 `bottle.quotaSyncing` / `bottle.quotaUnavailable`（zh/en 成对）。
     **口径澄清（产品规则没变，变的是「谁说了算」）**：每天最多写 3 封、**回信**才计 1 次（每天 7 次）、捞到手 ≥7 封未回时拦新捞、48h 未处理自动回海 —— 这些**一直都在 SQL RPC 里**（`MIGRATION_bottle.sql` + `_quota_fishfix` + `_reply_quota`），本轮只是把本机那本假账删干净，让显示与执行都只剩服务端这一本账。
     **验收**：bottle-test **66/0**（旧「本机账兜底/乐观 +1」断言全部改写 + 新增 4 条回归守护：不许再出现 `bumpQuota`/`quotaRemote`/`swr(`/`cacheKey(`/`todayKey`/`storage`/`cache` 导入；**2 条真跑**：造 5 个键 → `purgeLegacyBottleLocals()` 正好删 3 个、私信缓存与宠物档原样留下、再清一次返回 0）+ home-panes 9/9（T9「本地优先缓存」断言反向更新）+ 全量 **33 套 0 fail** + undef 0 + build 0（`BUILD_GOOD index-CyOIbHUP.js`）+ page-smoke 8/8 + 部署 Version `3aa322a3` + live-check 14/14 + SHA16 `b6a5a99f39d0edb4` 本地=线上 + 线上 `bottle-e2e` **16/16**（T4 第 4 封被服务端 `bottle-limit-send` 挡下 / T12 A 捞不到自己的信 / T13–T16 权限与 RLS）+ cap sync（android assets 与 dist 逐文件同哈希）+ APK 重打 `apk\warm-paws-debug.apk` 4.77MB SHA16 `221ffd65d054383b`，**并已装机启动冒烟通过**（`adb install -r` Success；`ActivityTaskManager: Displayed net.de5.dale/.MainActivity: +672ms`；`logcat -b crash` 空；WebView 进程正常起）。**待用户真机验收**：投满 3 封后显示「还能投 0 封」并在**清缓存/重装/换设备后依然为 0**（老版本会回满）；回信 7 次后「还能捞 0 瓶」；网页与 App 显示同一本账。
     **顺带（两处假红校准，都不是本轮引入的功能问题）**：①`live-check`/`live-bundle-check` 首轮报 `ERR fetch failed`（本机到 Cloudflare 的连接超时抖动，同一分钟探针实测 5/5 200）→ 复测 14/14 且 SHA 一致；②`bottle-e2e` T12 老断言把「连捞 10 次都成功」当失败 —— A 能捞到的信在 RPC 里本就排除了自己的（`user_id <> auth.uid()`），海中真实信件一多必然假红，口径改为「连捞成功或撞空海/限额都合规」（`sawOwn` 仍必须为 false）→ 复测 **16/16**。

  - **轮 38 · App 冷启动黑边 + 启动页双修（2026-09-23，部署 Version `59c5bd12`，提交 `2d8c8a3`）**：
     **用户报障（原话）**：「来吧，告诉我，为什么改了那么多次黑边还在，而且 app 端启动页又没了，这次看你怎么狡辩哈」。两条都是**前几轮声称修好、实际没修对**的老账（黑边：轮 24/25；启动页：轮 24/26/30）。
     **取证（先证据后动手，全部实锤）**：① 真机**冷启动连续抓帧**（14 帧 / 约 100ms 间隔，`adb exec-out screencap`）；② 逐帧**像素扫描**（左右边缘列暗像素 + 四角取样）；③ 读 `AndroidManifest.xml` / `values/styles.xml` / `values-night/styles.xml` / `MainActivity.java` / `capacitor.config.json` / `index.html` / `src/main.js`；④ `git show HEAD:…/styles.xml` 与轮 30 那笔 diff 对照原文；⑤ `git log -S` 追「米色窗口底是哪一轮加在哪个主题上」。
     **根因（两条，一一对应用户骂的两件事）**：
     ① **黑边（拖了 13 轮）**：轮 25 的 `android:windowBackground=#FFF7EE` 写在 `AppTheme.NoActionBar` 上，**而 Activity 真正用的是 `AppTheme.NoActionBarLaunch`**（当时 `parent="Theme.SplashScreen"`，`android:Theme` 系，与我们的主题**毫无继承关系**）→ 米色从未生效；该启动主题的 `android:background` 还是 **Capacitor 模板自带蓝色 X 的 `splash.png`**；Android 12+ 还有一层**系统启动画面**（读 `windowSplashScreenBackground`/`windowSplashScreenAnimatedIcon`），没配 → 背景退回 `?colorBackground`（深色下=黑）。三层叠起来就是冷启动那一圈黑。
     ② **启动页消失（拖了 8 轮）**：轮 30 在那个 `<style>` 块中间插了一个**字面的 `</style>`** —— HTML 解析器在 `<style>` 元素内遇到它**立刻结束元素（注释也不豁免）**，后面 30 行 CSS 全成裸文本；恰好留在元素内的半段是 `display:none`，于是「App 端启动页」静默消失（网页端本来就要隐藏 → 症状只在 App）。另一层：`html.cap-app` 的判据是 `navigator.userAgent` 里有没有 "capacitor"，而 **Capacitor Android 的 WebView UA 默认不含这个串**（只有配了 `android.appendUserAgent` 才追加）→ 类永远加不上。
     **修法**：① 主题链归位——`AppTheme.NoActionBarLaunch` 的 parent 改为 `AppTheme.NoActionBar`、`android:background=@drawable/launch_bg`（米色矢量底），新增 `launch_paw.xml`（橙爪）、删掉 11 张 Capacitor 默认 `splash.png`、新增 `values-v31/styles.xml`（`windowSplashScreenBackground=#FFF7EE` + `windowSplashScreenAnimatedIcon=@drawable/launch_paw`）；`AppTheme` 也补米色窗口底（任何窗口露底都不再是黑）。② 启动页——`index.html` 合成**一个合法样式块**（顺序有意：布局 → 默认隐藏 → `html.cap-app` 恢复显示），判据改**四路**（`window.androidBridge` / `window.Capacitor` / `capacitor.config.json` 里 `android.appendUserAgent:"WarmPawsApp"` / UA 含 "capacitor"），并在 `src/main.js` 用 `Capacitor.isNativePlatform()` 在挂载前兜底加类。
     **验收（三层）**：离线 **40 套复跑 ALL GREEN**（`splash-test` 8→**15/15**：新增「`<style`/`</style>` 计数守恒 + 注释内不得含字面闭合标签 + `html.cap-app` 恢复显示规则在位」；bottle-test 66/66、auth 130/130、worker 195/195、pet-visual 163/163、app-shell 40/40、wall 34/34、dm 286/286、notify 149/149）+ `undef-check` 0 + build 0（`BUILD_GOOD index-B5lowAyf.js`）+ **page-smoke 8/8** + `npm run cap:sync` + 部署 **Version `59c5bd12`** + `live-check` **14/14** + `live-bundle-check` 线上入口 SHA16 `602036317f80c223` 本地=线上。
     **装机包可溯源（防「装的不是这份代码」）**：`dist/index.html` 过 `cap-strip-hero`（轮 18 基建：App 侧剥掉只给爬虫看的英文 SEO 占位）后 SHA16 = `17CAE91F03B31989` = android assets = **APK 内 assets**（三者逐字节相同，`System.IO.Compression` 直读 apk 校验）。
     **真机实测（本轮最硬的一条证据）**：APK `apk\warm-paws-debug.apk` 4.76MB SHA16 `E7FA658BC1C27060`，`adb install -r` **Success** → 冷启动抓 14 帧：**g1 = 原生启动层（米色 + 居中橙爪）四角 `#FFF7EE`、左右零暗像素**；**g4/g7 = 网页启动页真的出现**（🐾 温暖的爪印 / Warm Paws / 一个温柔的角落 / 三条特性胶囊 / 「你已经做得比想象中好了」）；g8+ = 首页。除 **g0**（桌面「打开应用」转场帧，其周围的黑色是**桌面的**遮罩，App 窗口本身已是米色圆角）外，**App 自己的每一帧都没有黑边**。
     **顺带说明（不是 bug，先记下免得下次又当黑边修）**：g0 那帧的黑来自桌面启动转场动画的背景；`values-night/styles.xml` 沿用同款米色（本轮不动深色分支，因为 App 内 UI 恒为米色主题）。
     **待用户真机验收**：① 冷启动无黑边 ② 启动页出现并淡出进首页 ③ 网页端仍不显示启动页（轮 30 的要求保持）。

  - **轮 39 · 深色模式「黑屏」修（2026-09-24，提交 `e1130fe`，APK 已重打待装机）**：
     **用户报障（原话）**：「黑屏没改，改一下」。轮 38 收尾当晚用户真机验收仍见黑。
     **取证（先证据后动手）**：① **回放轮 38 的抓帧**（/tmp/boot-38d，15:05，装机后那次）：f0 = 米色启动画面放大盖过桌面（**不是黑幕**）、f1 = 网页启动页、f4+ = 首页——浅色模式下冷启动全程无黑，轮 38 的结论在它测的条件下成立；② 排查仍可能出黑的面：`values-night/` **根本不存在**（轮 38 记录里「values-night/styles.xml 沿用同款米色」系**误记**，git 全历史查无此目录，就地纠正）、`values-v31` 系统启动画面米色在位、WebView 底色 capacitor.config.json=#fff7ee、Manifest 主题链正确；③ 唯一在「夜里 vs 下午」之间翻转的变量 = **深色模式**：App 恒为米色浅色主题，却 ① 用 DayNight parent（深色下回落色翻黑）② 没退 WebView Force Dark——Android 10-12 夜间 uiMode 下系统默认把浅色 WebView 内容**整个反黑**（`@capacitor/android` 8.5.2 **全包 grep 零 forceDark 处理**，实锤）③ 无任何退出声明；MIUI 自家深色实现吃同一套 forceDark 开关。轮 24-38 每轮验收都在白天浅色下抓帧 → 这层从未被测到，「黑边还在」的部分老账或即在此（反馈表 #15）。
     **修法（三道闸）**：① `values/styles.xml`：`AppTheme.NoActionBar` parent `DayNight`→`Theme.AppCompat.Light.NoActionBar`；`AppTheme` 与 `AppTheme.NoActionBar` 各加 `android:forceDarkAllowed=false`（NoActionBar 显式声明 parent、**不继承 AppTheme**，节点必须各带），`values-v31/styles.xml` 同加（本文件同名 style 整体替换惯例，显式再写一份防丢）；② `MainActivity.java`：`AppCompatDelegate.setDefaultNightMode(MODE_NIGHT_NO)` 放在 `super.onCreate` **之前**（BridgeActivity.onCreate 内部就 setContentView + 建 WebView，晚调无效）+ 之后 WebView 实例 `setForceDarkAllowed(false)`（API 29+ 判位，minSdk 24）；③ `tools/splash-test.mjs` 15→**18**：三道闸断言（主题零 DayNight / 三处 forceDarkAllowed=false / night-mode 调用先于 super.onCreate——断言要匹配 `super.onCreate(savedInstanceState)` 全串，短串会被 MainActivity 注释里的「super.onCreate」抢先命中假红）。
     **验证**：splash-test **18/18**；APK 重打 `apk\warm-paws-debug.apk` 4.99MB SHA16 `63F5932ACDA5434A`（00:45）。**网页/dist 零改动**——不部署、不 cap sync（auth-test 读的 AndroidManifest、cap-strip-hero 比对的 assets 均未动）。
     **待用户真机验收（装机先行：连线后 `adb install -r apk\warm-paws-debug.apk`）**：① **深色模式下**冷启动 + 使用全程米色不变黑 ② 浅色模式冷启动无黑边（轮 38 结论保持）③ 启动页照常。若深色下仍发黑：MIUI「设置 → 显示 → 深色模式」按 App 开关把 Warm Paws 设为不加深色——系统侧最后一级，App 侧三道闸已全关。
     **顺带收编**：轮 38 黑边探针 `tools/_probe-black-edge.js`（WebView 内查启动页/边缘像素/视口的 CDP 探针）入库存档。

  - **轮 40 · 桌面端弹窗宽度收敛（2026-09-24，提交 `083c895`，已部署 `baa4367e` + 已装机）**：
     **用户报障**：桌面网页上弹窗太大（铺满整屏），手机端看不出问题。
     **真因**：Naive UI 的 `n-modal`（`preset="card"`）**只给 `max-width` 不给 `width` 时，卡片会被容器撑满**——`max-width: 88vw`（漂流瓶捞信弹窗）/ `max-width: 92vw`（举报弹窗）在手机上≈343px 恰好合适，在桌面（1920 宽）就是 1670px 的巨幕。**手机端能过验收、桌面端炸**，属于「只按一端验收」的老毛病（承踩坑 #31 的「验收时段盲区」，这次是「验收设备盲区」）。
     **修法**：两个弹窗都改显式 `style="width: min(560px, calc(100vw - 32px))"`（捞信）/ `min(520px, calc(100vw - 32px))`（举报）——桌面固定 560/520px 居中，手机仍留 16px 边距的近全宽（**手机视觉不变**）。
     **验证**：离线 **33 套 0 fail**（含 auth 130、worker 195、dm 286、splash 18 等）+ `undef-check` 0 + `build-until-good` → `BUILD_GOOD index-DTHdcYlq.js` + `cap sync`（`cap-strip-hero` 剥 SEO 占位 ×4）+ `gradlew assembleDebug` **BUILD SUCCESSFUL** + 部署 **Version `baa4367e`** + `live-check` **14/14** + `live-bundle-check` 线上入口 SHA16 `826d26a0bd695227` 本地=线上。
     **装机与溯源**：APK `apk\warm-paws-debug.apk` 4.76MB SHA16 `D88A2E9C0496140A`，`adb install -r` **Success** → `Displayed net.de5.dale/.MainActivity: +720ms`、`logcat -b crash` 空。APK 内 `assets/public/index.html` 与 `android/app/src/main/assets/public/index.html` **逐字节相同**、启动页 `<style>`/`</style>` **1/1**、`html.cap-app #app-splash` 规则在位、入口 `index-DTHdcYlq.js` 与 dist 同名（防「装的不是这份代码」）。
     **顺带**：本包首次把**轮 39 的深色模式三道闸**送进真机（轮 39 那份 `63F5932ACDA5434A` 一直没装机）。
     **待用户验收**：① 桌面网页两个弹窗宽度收敛（560/520px）② 手机端弹窗视觉不变。

  - **轮 41 · 首页启动期预热漂流瓶（2026-09-24，提交 `782d0b5`，**该版引入事故**，见下）**：
     **用户报障**：「点首页的时候就把这数据提前查好，而不是点漂流瓶之后一直出不来」（次数一直显示「同步中」）。
     **真因**：`BottleView` 只看「会话变化」的 `watch`（无 immediate），而 App 启动路径是「splash 等 `initCloud` 就绪 → 再挂 HomeView/BottleView」——会话先于组件就绪，watch 永不触发；`onMounted` 又只查托盘与记录、不查次数 → 次数一直是 `null`（界面如实显示「同步中」）。
     **改法**：① `App.vue` 启动链加 `prefetchBottle()`（fire-and-forget，不阻塞启动页）；② `utils/bottle.js` 加 `singleFlight(key, fn)` 只合并在途请求（不缓存、不写存储、不复用已完成结果，轮 37 口径不变），`bottleQuota/bottleHeld/bottleRecords` 走它 → 预热那次就是界面等的那次；③ `BottleView` 初始查询改为主动触发（**这里写成了 `immediate: true`，就是事故来源**）。
     **教训**：本轮的「初始主动查」方向正确，但**实现姿势错误**，且交付前漏跑 `page-smoke` → 坏包上线（线上入口 `index-CPSDoYFN.js`），真机首页整页崩。**轮 42 修**。

  - **轮 42 · 首页崩溃修复（TDZ）+ 静态防线 + 真机复验（2026-09-24，已部署 `3431e8bb` + 已装机）**：
     **用户报障**：「你自己看看吧」——真机冷启动后首页整页是「🐱 这里好像有点小状况 / Cannot access 'ht' before initialization / 刷新页面」。
     **取证（先证据后动手）**：① 冷启动抓帧 2.5s / 9s 两帧：错误盒盖在启动页之上；② `adb logcat` 抓 `before initialization` → 文件 = `assets/index-CPSDoYFN.js`（**与当时线上入口同名同 SHA**，即网页端也是坏的）；③ 在该产物里数 `\bht\b` 共 8 处，声明点 `const he=ref("mine"),We=ref([]),ht=ref(0),Rn=ref(!1),At=ref(!1)` → **`ht` = 源码 `recPage`**；最早的使用处是 `Je([n,f],()=>{…ht.value=0…},{immediate:!0})` = `BottleView.vue` 第 87 行的 watch。**真因**：轮 41 的 `immediate: true` 在该行同步跑回调，而 `recPage/recTab/recLoading` 声明在第 224 行 → TDZ 抛错 → `App.vue onErrorCaptured` 接管整页（踩坑 #29 同类第二次 → #32）。
     **修法**：撤掉 `immediate`，回调抽为 `function onSessionChanged()`（`watch([cloudSigned,myId], onSessionChanged)` 只负责换号），初始那次由 `onMounted(() => { purgeLegacyBottleLocals(); onSessionChanged(); })` 显式触发。行为口径不变：进首页即查（次数 + 托盘 + 记录），轮 41 的预热与单飞合并保留。
     **验证**：离线 **33 套 0 fail**（worker 195 / dm 286 / auth 130 / bottle 66 / splash 18 …）+ `undef-check` 0 + **新增 `tdz-check` 0**（`--selftest` 2/2；并用轮 41 旧代码回归实测命中 `BottleView.vue:87 recPage（声明 224）`）+ `page-smoke` **8/8**（修前 `FAIL / crash="…Cannot access 'ht' before initialization"`）+ 构建 exit 0 → 部署 **Version `3431e8bb`** + `live-check` **14/14** + `live-bundle-check` 线上入口 `index-BdKRGbcL.js` SHA16 `0ed578e10f51a0c3` **本地=线上**。
     **装机与真机复验**：APK 4.76MB SHA16 `17A0CAB139460AC7`，`adb install -r` **Success** → 冷启动 3s 帧 = 干净启动页（**无错误盒**）、9s 帧 = 首页漂流瓶频道正常（记录列表已有数据）；CDP 读真机 WebView：`crashBox=false`、启动 **367ms** 发 `bottle_quota`+`bottle_held`、**469ms** 发 `bottle_records`，页面文案 `0/1000 · 今天还能投 3 封` 且**全页零「同步中」**（用户原始诉求「点漂流瓶一直出不来」在真机闭环）。
     **待用户验收**：① 手机冷启动首页正常（不再出现「这里好像有点小状况」）② 进首页/漂流瓶时次数与记录立刻有值（不再长时间「同步中」）。

  - **轮 43 · 启动链去掉「大爪子」页面（2026-09-25，APK 已重打待装机）**：
     **用户报障（原话）**：「启动页不要那个大爪子的页面，去掉」。
     **定位**：那个「米色底 + 大橙爪」是**原生启动层**，两个来源：① Android 12+ 系统启动画面的图标位（`windowSplashScreenAnimatedIcon=@drawable/launch_paw`，轮 38 配的）；② 窗口底 `launch_bg.xml` layer-list 的 108dp 居中爪印项（原生段与 WebView 未铺满的缝隙都露它）。网页启动页（#app-splash）的 🐾 只有 56px 且带全套文案，是**轮 38 用户点名要回来的页面，保留**。
     **修法**：① `launch_bg.xml` 删爪印项 → 纯米色 layer-list；② `values-v31` 图标位改指**新增的全透明 drawable `launch_transparent.xml`**——关键点：**这一项不能直接删**，不设时系统默认放 App 启动图标（我们的图标本身就是橙爪圆底），等于没去掉；③ 删 `launch_paw.xml`；④ splash-test 18→**20**：轮 38 ④ 反向（不再断言爪印存在）+ 新增「启动链零爪印（styles/v31/launch_bg 三处 + 文件系统四查）/ 系统启动画面图标位全透明」。
     **坑（本仓库规矩再+1）**：v31 的注释里写了字面「launch_paw.xml 已删」→ 被自己新加的「零爪印」断言逮住假红——**注释里不写会被 grep 的字面量**（与踩坑 #30①「style 里不写字面闭合标签」同族），已改成文字描述。
     **验证**：splash-test **20/20**；APK 重打 `apk\warm-paws-debug.apk` 4.99MB SHA16 `35115BBB8BEEB235`（02:22）。**网页/dist 零改动**——不部署、不 cap sync；轮 42 的 TDZ 修复与轮 39 深色三道闸都在本包内。
     **冷启动视觉（改后）**：点图标 → **纯米色**（原生段，一闪而过）→ 网页启动页（米色+🐾+温暖话）→ 首页。
     **待用户真机验收**：① 无大橙爪页面 ② 网页启动页照常 ③ 进首页正常。若**连网页启动页也不要**，说一声——那是 `index.html` 的 #app-splash 层，另做一轮摘掉（含看门狗/App.vue 关页逻辑联动）。

  - **轮 44 · 我的页：帖子挪底 + 时间到秒（2026-09-25，部署 Version `12e6e3e0`）**：
     **用户原话**：「我的页面，我在暖心墙的帖子移到最下面，在我的食谱下面，而且时间显示到秒」。
     **改动**：① `ProfileView.vue`：「我在暖心墙的帖子」整块（标题行 + 最新 3 条卡 + 「更多 →」）从「改昵称」下方搬到**页面最底**——新的区块顺序 = 账户头 → 改昵称/登录卡 → 心情日历 → 我的食谱 → **我在暖心墙的帖子**；② 帖子卡时间原来只有日期（`new Date(p.ts).toLocaleDateString()`），改接新纯函数 **`fmtWhenSec`**（`wallRules.js`，与 `fmtWhen` 同口径：跨年补年份、非法→空串，只多 `second: "2-digit"`；刻意不做参数——墙上列表到分钟、个人主页到秒，两处调用语义各自显式）。范围按用户说的只动「我的」页；暖心墙 / my-posts / 帖子详情仍是到分钟。
     **验证**：wall-rules-test 39→**42/42**（+3：时分秒结构 / 跨年口径 / 非法空串）+ undef 0 + tdz 0 + post-detail 15 + uifix 24 + app-shell 40 + auth 130 + bottle 66 全绿 + build 0（env-guard slug ✓）+ **page-smoke 8/8** + 部署 **Version `12e6e3e0`** + live-check 14/14 + live-bundle-check 入口 SHA16 `88fc3eeb89fd5983` 本地=线上 + cap sync + README 计数同步（wall-rules 44、**splash-test 20——补轮 43 漏改的欠账**，踩坑 #19）+ APK 重打 SHA16 `88B42A09744AB402`（含轮 43+44）。
     **待验收**：网页端刷新「我的」页即可看（帖子区块在最底、时间到秒）；App 端随下次装机。

  - **轮 45 · 漂流瓶记录口径：「我捞到的」只显已回信 + 按捞到时间倒序（2026-09-25，SQL 已就绪待用户执行；按攒批新规待提交，前端零改动无需部署）**：
     **用户原话**：「我发布的按最新排序，我捞到的，按捞到的时间最新排序，而且不显示已放回海里的信封，只显示我已经回信的信」。
     **定位**：记录列表是服务端 RPC `bottle_records(p_id,p_offset,p_mine,p_limit)` 分页的（10 条/页），排序/过滤必须在 SQL 里做——前端过滤会把分页打穿（每页先切 10 条再滤，页面会稀疏）。「我发布的」本就是 `created_at desc`（轮 17 口径），未动。
     **SQL 改动（`MIGRATION_bottle_records.sql` 整份重写 + `SUPABASE_SETUP.sql` 同步）**：① p_mine=false 过滤从「捞起过就留痕（exists bottle_fishes，含放回）」改为 **`l.reply_by = auth.uid() and l.reply_at is not null`**——只有捞到信的人能回信（bottle_reply 要求 status='held' 且 holder=我），所以「回信人=我」恰好等于「我捞到且已回信」；已放回（status 回 sea、无回信）与在守（held）天然排除，在守信的回信/放回仍走首页顶部托盘（轮 24c 的记录卡押信按钮在该口径下成死分支，无害保留）。② 排序改 **`case when p_mine is false then l.held_at else l.created_at end desc`**——回信后信是 `answered`，`held_at` 保留为捞起那一刻，且 answered 不会再被放回（release 要求 held）/重捞（fish 要求 sea），held_at 即精确捞到时间。
     **验证**：bottle-test 66→**68/68**（新增两条锁形：迁移/SETUP 同源一字不差；旧 exists 过滤不许回归——踩坑 #21 家族）+ bottle-chat-test 86/86。前端/Worker 零改动 → 无需部署、无需新 APK；RPC 执行即网页与 App 同时生效。
     **迁移执行与线上实锤（2026-09-25，用户执行后当轮）**：一次性探针 `tools/_probe_records.mjs`（跑完已删，坑 #21「跑了≠生效」）**8/8**——注册 wp-b47 测试号 → 捞 1 封放回 + 捞 2 封回信 → 拉 `records?mine=false`：①判别器「放回的那封**缺席**」✓（旧口径捞起过就留痕必现，出现即旧版——唯一解）②已回信的两封在列 ✓ ③不变量「每行 reply_by=我 且 reply_at 非空」✓ ④held_at 倒序、后捞的排前面 ✓。测试号按惯例留存（profiles 无删策略），其回信带的测试信留在海里由对方处置。
     **待发话**：提交。

  - **轮 46 · ＋ 号发布弹层重样式（2026-09-25，待提交待部署——攒批）**：
     **用户原话**：「那个+号发布的样式调好一点，往下居中」。
     **改法（只动 `src/style.css` 的 `.tabbar-sheet`/`.tabbar-opt` 两段，TabBar.vue 结构零改动）**：原「两张全宽卡片从 TabBar 顶上贴着弹」（left/right:0 + padding 0 18px ≈ 满屏宽）→ **一枚紧凑菜单卡**：`width: min(236px, calc(100vw - 150px))`（不盖两侧 Tab 文字）、**水平居中** `margin: 0 auto`、`bottom: calc(70px + safe-area)` 贴 TabBar 上沿留 6px 正悬 ＋ 钮上方；两瓣入口变卡内两行（去独立卡片底色/阴影，按压 `--accent-soft` 高亮），遮罩点击关闭、选中收起行为不变。
     **坑**：居中不能用 `transform: translateX(-50%)`——入场动画 `tabbar-up` 的终帧是 `transform: none`，会把水平居中一起抹掉（动画播完卡片右跳半宽）；用 margin auto 让动画与居中互不干涉。
     **验证**：app-shell-test **40/40**（T2 只钉 tabbar-sheet/opt 结构类名，未钉样式）+ page-smoke **8/8** + 本地 build 0（env-guard slug ✓）。
     **待发话**：提交 + 部署（攒批；生效在网页/App 端部署后，手机点 ＋ 即见）。

  - **轮 48 · 轮46纠偏：弹层宽度回滚 + ＋钮圆收回栏内（2026-09-25，待提交待部署——攒批）**：
     **用户原话**：「+号之后谁让你改投漂流瓶跟发帖的宽度了，改回原来的宽度，还有，我说的是那给+号整体往下一点，那个上面的圆都超出了」。
     **教训**：轮46 把「往下居中」理解成了「弹层样式重设计」，实际用户指的是 **＋ 钮本身的位置**——圆 `margin-top:-16px` 探出 TabBar 顶缘 15px，用户视为溢出。改了用户没让改的东西（宽度），该改的没改（钮）。
     **改法**：① `.tabbar-sheet`/`.tabbar-opt` 两段**整段回滚**到轮46 前原样（全宽双卡、玻璃底、原阴影/圆角/字号）；② `.tab-compose-x` `margin-top: -16px → 0`：46px 圆 flex 居中于 44px 行高，上下各溢 1px 恰被 4px 栏内边距吃掉——圆完全在栏内，栏高与页面让位（main padding-bottom 78px）均不变。
     **验证**：app-shell **40/40**（T2 只钉结构）+ page-smoke **8/8** + 本地 build 0。
     **注意**：已装机的 APK（`108F2B9D7727B4EC`）里仍是纠偏前样式——重打包+装机等发话。
     **待发话**：提交 + 部署 + 重打包装机。

  - **轮 49 · 「我捞到的」已回信待同意提示（2026-09-25，待提交待部署——攒批）**：
     **用户原话**：「漂流瓶我捞到的，我已回信，但是对方还没有回信，这个时候需要给用户一个提示，待对方同意后可聊天，简洁一点」。
     **背景**：轮 45 之后「我捞到的」只剩已回信的信——其中「原信作者还没同意」的（`bottleChatState=waiting`）原来只显示笼统的「你已回信」，用户不知道下一步在对方手里。
     **改法**：① `src/i18n.js` 新增 `bottle.stWaitAgree`（zh「待对方同意后可聊天」/ en "Chat opens once they accept"，照用户措辞、简洁）；② `BottleView.recState` held 分支：`waiting` → `stWaitAgree`，同意（accepted，canChat 可进聊）/婉拒（declined）仍走「你已回信」；消息页记录卡（BottleRecords）的 `chatWaiting` 副行文案未动（两处呈现形态不同，未合并口径）。
     **验证**：bottle-test 68→**69/69**（+1 锁形：双语键 + BottleView 接线）+ i18n-test **19/19** + page-smoke **8/8** + 本地 build 0。
     **待发话**：提交 + 部署 + 重打包装机（攒批；网页端部署即生效，App 端要新包）。

  - **轮 50 · 二级评论默认显示前两条（2026-09-25，待提交待部署——攒批）**：
     **用户原话**：「暖心墙帖子，二级评论如果有的话，默认显示两条，现在是默认关闭」。
     **改法（两视图同口径，轮 13 的「默认收起防刷屏」按用户拍板推翻）**：① CommunityView：新增 `visibleReplies(p,cm)`（展开=全量，否则 `slice(0,2)`）；回复列表容器 `v-if="repliesN(p,cm)"`（原来要 isRepOpen）；「N 条回复」按钮 `v-if="repliesN(p,cm) > 2"`（≤2 条全显、无按钮）。② PostDetailView：同款 `visibleReps(cm)`。回复框就地展开、回复完顺手展开（openRep=true）等联动全部保留。
     **验证**：post-detail-test **15/15** + uifix-test **24/24** + page-smoke **8/8** + 本地 build 0。
     **待发话**：提交 + 部署 + 重打包装机。

  - **轮 51 · 首页心情打卡后跳转宠物（2026-09-25，待提交待部署——攒批）**：
     **用户原话**：「去首页每日打卡，那个点击之后要能跳转啊」。
     **现状**：打卡本身有效（`checkInMood`：心情日志 + 宠物 +5 心情/+8 经验/算一次照顾/+3 金币/每日任务 mood 置为可领），但点完留在原地，用户感知不到「宠物也感觉得到」。
     **改法（只动 TodayPane.moodPick）**：成功后保留绿色「打卡完成」提示 800ms，然后 `emit("go-pet")`——复用 hero「去宠物」的既有通道，落点仍由 HomeView 决定（手机 `setPane("pet")` 切宠物联；**桌面不自动跳**，宽屏下 TodayPane 与暖心墙并排，整页拽去 /pet 太打断，桌面用户要看宠物点 hero 的「去宠物」钮）。新增 `isMobileNav` 导入。
     **验证**：home-panes-test **9/9** + page-smoke **8/8** + undef-check **0** + 本地 build 0。
     **待发话**：提交 + 部署 + 重打包装机。

  - **轮 52 · 宠物页补手机返回钮（2026-09-25，待提交待部署——攒批）**：
     **用户原话**：「文档页面，去厨房，那个页面没有三级按钮啊」——按「三级按钮」=「**上一级按钮**」理解（排除了删除按钮说：book 页签本就有 dish-del；四个页签也都在）。
     **现状**：我的 → 去厨房 → `/pet?tab=book`，PetView 整页只有底部 TabBar 和 Android 系统返回键兜底，**页内没有任何可见的返回**——手机网页端（无系统返回键）用户只能瞎摸底部 Tab。
     **改法**：`.park-hero` 首位加 `<button v-if="isMobileNav" class="pet-back">←</button>`（视觉与 SettingsView 的 set-back 同款圆钮）；`goBack()`：有历史 `router.back()`，直链进来（无历史）`replace("/profile")`（去厨房的来路）。新增 useRouter/isMobileNav 导入。
     **验证**：pet-home-test **19/19** + page-smoke **8/8** + undef-check **0** + 本地 build 0。
     **待发话**：提交 + 部署 + 重打包装机。**若「三级按钮」另有所指（比如别的按钮），等用户澄清再加**。

  - **轮 53 · 打卡跳转方向纠正（2026-09-25，待提交待部署——攒批）**：
     **用户原话**：「去首页每日打卡，那个点击之后要能跳转啊，跳转到今日页面，今天过得怎么样」——澄清轮 51：跳转目标不是宠物，是**首页「今日」联的「今天过得怎么样」打卡卡**；点击源是**宠物页「今日温柔任务」里「记录今天的心情」那行**（原来点了没反应）。
     **改法**：① **撤销轮 51**（TodayPane.moodPick 恢复纯本地打卡 + 3s 绿字提示，不跳宠物；顺带清掉轮 51 加重的 isMobileNav 重复导入）；② **PetView 任务块**：mood 行加 `clicky` 类 + 「去打卡 →」小标 + `@click=goMood()` → `router.push("/?tab=today")`——`/?tab=today` 是既有深链（panes.js paneFromQuery 认 today，HomeView watch route.query.tab 消费成初始联），宠物联内嵌与 /pet 独立页两种形态都成立；打卡卡就在今日联里，点过去直接就是「今天过得怎么样」。
     **坑（工具链）**：转换层会把 heredoc 里的 `反斜杠反斜杠u2705` 折叠成单反斜杠 → python 源码 `✅` 解码成真 ✅，与文件里的字面量对不上 → 整段替换 assert 失败。**改用不含转义序列的相邻行分段替换**绕开。
  - **轮 54 · 「去厨房」落到首页宠物联食谱页签（2026-09-25，待提交待部署——攒批）**：
     **用户澄清（原话）**：「我说的『三级按钮』就是首页上面的，宠物，今日，漂流瓶。在文档页面点击去出发，直接跳到首页-宠物-食谱就行了」（「文档页面」=「我的页面」、「去出发」=「去厨房」的输入误差）——轮 52 按「上一级按钮」理解是**错的**，真正要的是「我的 → 去厨房」**别跳出首页三联**，直接落宠物联+食谱页签。
     **改法**：① `ProfileView` 去厨房链接：手机端 `to={path:"/",query:{tab:"pet",petTab:"book"}}`（HomeView 消费 `tab=pet` 落宠物联——paneFromQuery 本就认 pet）；桌面无三联，保持 `/pet?tab=book`。② `PetView`：`routeQ` 从 query 快照改回路由对象；setup 首读 `query.petTab`（懒挂载首次激活时深链已在）；`watch(query.petTab)` 同步页签（**挂过保留**的实例靠它响应后续深链）；`/?tab=pet` 时 query.tab="pet" 不在四页签白名单，天然不冲突。③ 轮 52 的 ← 返回钮改 `v-if="isMobileNav && route.name==='pet'"`——独立 /pet 才需要，嵌在首页联里不显示。
     **验证**：pet-home-test **19/19** + home-panes-test **9/9** + undef-check **0** + page-smoke **8/8** + 本地 build 0。
     **待发话**：提交 + 部署 + 重打包装机。

  - **轮 56 · 暖心墙真·无限流 + 下拉刷新取新（2026-09-25，待提交待部署）**：
     **用户报障（压测 500 帖后）**：「暖心墙下拉刷新没有用」「一直往下滑怎么会有尽头，不应该下滑到尽头继续刷新吗」。
     **架构性根因**：feed 一直是「`cloudFetchPosts()` 一次拉 SORT_WINDOW(200) 条 + IntersectionObserver 本地 reveal 亮 10 条」——**没有服务器分页**，亮完就「尽头」（还挂着「就到这里啦」）；下拉刷新只是把同一份固定列表重拉一遍（SWR 缓存优先），数据不变 →「没有用」。500 帖入库让这个天花板第一次被撞出来。
     **改法**：① 数据层：`cloudFetchPosts(limit, offset)`；`db.listPosts` 双模式加 offset——网关**仅非 0 附参数**（0/缺省 URL 与旧契约一致，gateway-contract 66/66 不破）；supabase 用 `.range()` 且**链序保持** from→select→eq→order→limit/range（api-contract 钉形状，首轮把 eq/order 写反被逮，已修正）；Worker parseOffset 本就支持。② CommunityView：`FEED_PAGE=50`；`loadCloud({fresh})`——进页仍走 SWR（缓存先撑、后台换新），**下拉刷新 fresh=绕过缓存取第 1 页**、重置 reveal、「已刷新 ✓」2.5s；`loadMoreCloud()`——触底亮完已拉取的→取下一页**追加**（filterBlocked + countViews + 评论数就地补齐），页不满=到底；哨兵两段式（先 reveal 后翻页）；「就到这里啦」改在 `cloudDone && !hasMore` 才出现；翻页中显示「载入中」。③ i18n +`community.refreshed`（zh「已刷新 ✓」/en "Refreshed ✓"）。
     **验证**：api-contract **83/83** + gateway-contract **66/66** + worker **195/195** + wall **34/34** + wall-rules **42/42** + i18n **19/19** + uifix **24/24** + app-shell **40/40**（T29 断言同步轮 54 去厨房新落位）+ undef/tdz **0** + page-smoke **8/8**（首轮 /profile 挂载偶发红，复跑全绿）+ 本地 build 0。
     **待发话**：提交 + 部署 + 重打包装机——**用户在等这个测刷新，下次发话优先**。

  - **轮 57 · 页脚整块移除（2026-09-25，待提交待部署）**：
     **用户原话**：「把每个页面的用心制作.你做的比你认为的更好去掉，以及那段空框内容去掉」。
     **定位**：那句文案 = App.vue 唯一的 `<footer class="footer">`（隐私入口轮 13 已挪去设置页，页脚只剩 footerNote 一句话）→ 后面那段「空框」就是这个空页脚容器。
     **改法**：footer 元素 + `footerNote`（zh/en 成对）+ `.footer`/`.footer-link` 样式 + `.shell--mobile-nav .footer` / `.shell--chat .footer` 两处形态规则，一起删净；4 条钉它的断言同步（app-shell T15/T35 去掉 footer 子句、privacy P27 去 .footer-link、P28 整条删除）。`.footer-link` 全仓无视图引用（历史残留）。
     **验证**：app-shell **40/40** + privacy **33/33**（34→33，P28 删）+ i18n **19/19** + 本地 build 0。
  - **轮 58 · 「我的」页帖子预览提速（2026-09-25，待提交待部署）**：
     **用户原话**：「我的页面，我的帖子老是出现的很慢，有什么优化措施？先改上面的」。
     **根因**：轮 44 把帖子块挪到页底时它还是**无缓存**——每次进页等一次 `/api/users/:id/posts` 往返；轮 36 的 SWR 只给了 /my-posts 页，这块漏了。
     **改法**：① `ProfileView` 接 `swr(cacheKey("profile-myposts", uid), {cached, fresh}, fetcher)`——进页先渲染本地快照（秒开）、后台取新覆盖并回写；缓存的是 rowsToPosts 视图（img 已是 URL，可序列化）；空列表/失败不覆盖快照（与全局语义一致）。② `App.vue` 启动预热链加 `prefetchProfilePosts()`（与 `dm:convs` 同款 swr 键、非阻塞）——登录用户启动即预热，**首次**进页也不用等。
     **验证**：cache **12/12** + auth **130/130** + app-shell **40/40** + undef/tdz **0** + 本地 build 0 + page-smoke 3×**8/8**。
     **顺带（基建）**：page-smoke 单路由偶发 `mounted=false`（无崩溃）——无头浏览器每路由冷启动 1.5s 窗口在机器负载高时不够用，轮 56 起偶发（当时记为「首轮 /profile 偶发红」）；探针等待 1500→**2500ms** 后三连 8/8，噪声消除。
     **待发话**：提交 + 部署 + 重打包装机（含轮 56 暖心墙无限流——用户等着测刷新，一并上）。

  - **轮 59 · 手机端 UI 精修第一波（2026-09-25，待提交待部署）**：
     **用户原话**：「你看一下ui，手机端真的很丑啊，你能不能重构一下ui啊」。
     **办法（轮 35 老规矩，不盲改）**：无头 Edge 393×852 对 9 页截屏逐页审（/tmp/ui-audit 前后各一套）。通病五项全修：① **密度**：`.shell--mobile-nav .card` 24px→16px 边距、圆角 24→20、卡距 18→12、h2/sub 随缩——一屏多看半张卡，桌面零变化；② **对比**：心情/大厅状态钮从灰 pill 改暖橙软底（rgba(245,140,80,.10)+细描边 #7c4a24 字）——Naive 内联主题变量压不过，用选择器+important；③ **文案**：大厅提示「登录后可设置个人主页状态；大厅只统计人数，不展示昵称」→「登录后可以在这里留下此刻的状态」（zh/en 改写，status-test 只锁键存在不锁文案）；④ **游客空态**：消息页 .dm-empty 与漂流瓶 .bottle-guest 垂直居中 + 🐾/🌊 陪伴（此前孤卡顶在页首+一屏空渐变）；⑤ **空日历**：0 天记录不再渲染 30 个空格子（只留「去首页每日打卡 🌱」引导）。
     **验证**：app-shell **40/40** + uifix **24/24** + status **49/49** + bottle **69/69** + auth **130/130** + i18n **19/19** + undef/tdz **0** + page-smoke **8/8** + build 0；截图前后对比（今日联一屏 3 卡→4 卡、按钮变暖、消息页空态居中）。
     **留给用户拍板**：更深的重构（底部导航形态/视觉语言/卡片圆角体系）属 App 轨道 D7+批3 T10 的「UI 全面重设计」，方向（跟小红书?跟微信?保持暖系但更立体?）等用户选，不自己拍。
     **待发话**：提交 + 部署 + 重打包装机（含轮 56 无限流——测刷新一并上）。

  - **轮 60/61 · 下拉刷新两处真 bug 修复（2026-09-25，已部署 f69d42e5 + 已装机 APK 914429E2CAF09C87，提交 c2d6335）**：
     **用户实测怒斥**：「你放屁，下拉刷新有吗，就他妈显示刷新了，实际内容没变」（+此前「就显示了几条就没了」）。
     **CDP 真机取证（连手机 WebView 全程）**：① 用户停在 /community 时列表只剩 **14 张卡** = 本地帖 11 + 示例 3，即 `cloudPosts` 被清空后整表回退本地数据；② 网关 `/api/posts?offset` 与 /sb 代理 `.range` 翻页从手机与 Node 双向实测**全部正常**（0-500 每页 50 行无缝）→ 排除服务端；③ 手机 localStorage 有**三只 wall:posts 缓存盒**：老 uid 16 条(45h)、新 uid 50 条(0h)、空 uid 双前缀 15 条(54h)。
     **真因①（轮 60）**：轮 56 首版把「缓存盒行数」当分页游标——升级首启缓存是老口径 16 条，`16 < 50` 直接标「服务器已到底」→ **无限流永不动**；行数当 offset 翻页还会错位重复。**修**：缓存盒降级为**展示快照**（offset 归 0、done=false、freshLanded=false），游标只认本轮 fetch（`box.fromFetch`）；「已刷新」提示从列表底部挪到顶部。
     **真因②（轮 61）**：「已刷新 ✓」**无条件显示**——拉取失败也谎报成功。**修**：三态提示（无新「已刷新 ✓」/有新「已刷新 ✓ 新增 {n} 条」对比刷新前最新 ts/失败「没刷出来，再试一次」）。
     **机制澄清**：默认排序「推荐」=7 天稳定混排，刷新后新帖不排最前是设计使然；无新内容列表不变属正常，提示会如实区分。
     **验证**：i18n 19/19 + wall 34/34 + undef/tdz 0 + build 0 + page-smoke 8/8；**真机 CDP 复测**：冷启动 10 卡 → 滚动 20/30/40/50 → **53**（穿越第 1 页成功）；注入 2 条〔刷新验证新帖〕(id 674/675)。
     **待用户验收**：下拉 → 顶部「已刷新 ✓ 新增 2 条」+ 找到〔刷新验证〕标记帖。

  - **轮 64 · 刷新语义重做「换一批」（2026-09-26，已部署 b61bc49b + 已装机 APK A910073D77136522）**：
     **用户拍板（原话）**：「我期望的是，下拉就刷新一批内容」「实际上内容不刷新」——刷新的期望不是「确认同一批」，是「换一批」。
     **改法**：刷新流程两级——① 先取最新页对比 ts：有新帖 → 「已刷新 ✓ 新增 N 条」（新帖可见）；② **无新帖 → `cloudFetchPostsSample` 随机换一批**：Worker `samplePosts` 先 `count=exact`（+Range 0-0）数 7 天池总量（removed=false + created_at≥7天前），随机起点取 50（两次微小上游调用，不做全表排序，深池不怕）；客户端取回后走推荐洗牌 + 游标续载，提示「已刷新 ✓ 换了一批内容」。**每次下拉必有可见变化**。
     **配套**：网关/直连 `listPostsSample` 成对；`wall.js cloudFetchPostsSample`（回应数富化同款）；i18n `community.refreshBatch`（zh「已刷新 ✓ 换了一批内容」/en "Refreshed ✓ · a new batch for you"）。刷新三态 → 四态（新增/换一批/已刷新/失败）。
     **验证**：gateway 67/worker 196/api 83/wall 34/i18n 19 + undef/tdz 0 + page-smoke 8/8 + build 0；已部署（live-check 14/14）+ APK 装机 Success。
     **待用户验收（亮屏）**：暖心墙连续下拉多次 → 每次列表都换一批（500 压测帖池足够大）；若有真新帖 → 「新增 N 条」。

  - **轮 65 · 去掉「新增 N 条」提示 + 重复检测改进（2026-09-26，已部署 aa8c1f4c + 已装机 APK 2F2A3AE1649DC35D）**：
     **用户原话**：「不需要提示『新增 N 条』」。
     **改法**：① 刷新流程去掉 prevMaxTs/新增计数与 `community.refreshNew`（zh/en 删除）；② 有新帖直接进列表，无特殊提示；③ **换一批的触发条件升级**：从「对比 ts 计数」改为「**逐 id 对比列表是否完全重复**」（`box.rows.every(p => cloudPosts.some(q => q.dbId === p.dbId))`）——完全重复 = 确定没有新内容 → 随机换一批；有任一新帖 → 正常显示新列表。逐 id 对比比 ts 对比更可靠（不受编辑/回帖时间扰动）。三态提示：已刷新 ✓ / 换了一批内容 / 没刷出来。
     **验证**：i18n **19/19**（refreshNew 删除后对称）+ wall 34/34 + undef/tdz **0** + page-smoke **8/8** + build 0；已部署（live-check 14/14）+ APK 装机 Success。
     **待用户验收（亮屏）**：连续下拉 → 每次换一批；有新帖直接见列表。

  - **轮 66 · 回信标签纠正 + 换一批持久化（2026-09-26，已部署 c2c7751d + 已装机 APK 3D80C46C92E831D3）**：
     **用户报障两连**：「我捞到的描述怎么是收到的回信，不该是我的回信吗」「刷新换了B，关闭再打开还是A，且C之前又闪A，这什么鬼」。
     **改法**：① `bottle.replyMine`（zh「我的回信」/en "My reply"）——BottleView held 页签条件取（轮 45 后该页签全是「我已回信」的信，l.reply=我写的）、BottleRecords 按 `row.reply_by === userId` 条件取（该页两种来信混排：我发的信收到回信=「收到的回信」、我捞的信我回的=「我的回信」）；② CommunityView：**挂载 fetcher 与下拉刷新统一走 `cloudFetchPostsSample`（随机换一批）**，删掉「先查最新页对比」分支（静态数据下它就是「A 复活」的机制：随机批不回写缓存 + 挂载永远拉最新页 = 每次都回到同一批）；刷新结果 `cacheSet` 回写——重开 App 先看到上一批（SWR 缓存闪现），随即换新批，**旧批永不复活**。
     **验证**：i18n **19/19** + bottle **69/69** + undef/tdz **0** + page-smoke **8/8** + build 0；已部署（live-check 14/14）+ APK 装机 Success。
     **待用户验收（亮屏）**：①「我捞到的」回信标「我的回信」②刷新换 B → 重开先见 B → 下拉换新批，A 不再出现。

  - **轮 70 · 消息页漂流瓶记录页签（2026-09-26，已部署 + 已装机）**：
     **用户原话**：「消息-漂流瓶-漂流瓶记录那里需要区分我发布的跟我捞到的，给个按钮，点击一下就可以切换」。
     **改法**：BottleRecords 头部加胶囊切换钮（我发布的 / 我捞到的，复用 bottle.mineTab/heldTab 文案键，默认「我发布的」）；`load` 按 `p_mine` 过滤（30/页分页、generation 防串、深链信件不受页签限制始终置顶）；空态分文案（`mineEmpty`/`heldEmpty` zh/en 新增）；样式暖橙胶囊（与 BottleView 页签同语言）。
     **验证**：bottle-chat **94/94** + i18n **19/19** + app-shell **40/40** + dm **286/286** + undef/tdz **0** + page-smoke **8/8** + build 0。
     **待用户验收（亮屏）**：消息 → 漂流瓶记录 → 两页签切换各自列表。

  - **轮 71 · 输入框圆角自适应（2026-09-26，已部署 + 已装机）**：
     **用户原话**：「输入框，刚开始椭圆可以，但是输入长了改成长方形的，输入内容多了椭圆变形的很难看」。
     **根因**：`src/theme.js` Naive 主题 `Input.borderRadius: "999px"`——所有输入框胶囊形，autosize 多行内容把胶囊拉成怪形。
     **修法（一行）**：999px → **20px**。CSS 圆角有自动收缩特性：半径之和超过盒边长时按比例缩小——单行（约 36px 高）时 20px 渲染为完美椭圆（与 999px 观感一致），autosize 长高后固定 20px = 圆角长方形。**零 JS**，登录/搜索/漂流瓶/聊天全部输入框一次修复。
     **验证**：i18n **19/19** + auth **130/130** + page-smoke **8/8** + build 0；已部署（live-check 14/14）+ APK 装机 Success。
     **待用户验收（亮屏）**：任意输入框单行=椭圆、多行=圆角长方形。

  - **轮 72 · 下拉刷新提速（2026-09-26，已部署 + 已装机）**：
     **用户原话**：「暖心墙下拉刷新速度太慢了，能不能提速」。
     **原流程**：下拉 → 取最新页(1 RTT) → 没新帖再取随机批(1-2 RTT) → 渲染；合计 2-3 个串行往返，且拉取期间零反馈。
     **改法**：① **最新页与随机批 Promise.all 并行**——1 个 RTT 出结果；取舍：最新页有真新帖（对比 newestSeenTs）→ 用最新页提示「已刷新 ✓」，否则用随机批提示「换了一批内容」；两者皆败才报错。② fetcher 恢复为「最新页+评论数」（随机批独立并行）；newestSeenTs 恢复（轮 65 删过，本轮复用于真新帖判定）。③ 拉取期间顶部「刷新中…」。
     **验证**：i18n **19/19** + wall **34/34** + undef/tdz **0** + page-smoke **8/8** + build 0；已部署（live-check 14/14）+ APK 装机 Success。
     **待用户验收（亮屏）**：下拉 → 立刻「刷新中…」→ 约 1 个往返直接换内容。

  - **轮 73 · newestSeenTs 缺声明崩溃修复（2026-09-26，已部署 5dd27698 + 已装机 APK F333B1C45ABD514C）**：
     **用户报障**：「下拉还是不刷新啊，只显示刷新了，但实际上内容不刷新」。
     **取证（CDP 连真机）**：/messages 直接弹错误盒「newestSeenTs is not defined」——轮 72 补丁的条件重加逻辑有缺陷：判「文件里是否已有该字样」时被**残留字样**骗过 → 声明漏加、两处使用（consume/新鲜分支）保留 → 任何 loadCloud 执行即抛 ReferenceError → 刷新全废（轮 72 的提速逻辑自引入起从未真正生效）。
     **修法（一行）**：补 `const newestSeenTs = ref(0)`。undef/tdz 抓不到这类「运行时未声明引用」（非未导入符号），靠 page-smoke 真实挂载 + 真机验证兜住。
     **验证**：undef/tdz **0** + wall **34/34** + i18n **19/19** + build 0 + page-smoke **8/8**；已部署（live-check 14/14）+ APK 装机 Success。
     **待用户验收（亮屏）**：暖心墙下拉 → 「刷新中…」→ 换一批/新增提示正常、列表真的换内容；消息页无错误盒。

  - **轮 146 · 暖心墙：示例帖全清 + 推荐档分级放宽 + 月档改滚动 30 天（2026-10-02，用户报障「数据库里有很多暖心墙帖子，为什么现在加载不出来」后定位并修复）**：

      1. **报障定位（先证数据没丢）**：实测线上 `GET /api/posts?limit=50` → 200 共 **679 条**完好（最新 id 679 / 2026-09-27）。真因是**默认「推荐」档固定 7 天窗**，把 9/27 之后没发帖的老帖全过滤掉，页面只剩 6 张卡且大半是示例帖 —— 不是数据丢失，是排序把老帖藏起来了；
      2. **① 示例帖全清（四清）**：删 `CommunityView.vue` 的 `SAMPLES` 数据块 + 注入/渲染分支 + `seedComments()` 示范评论链路；删 `comments.js` 里已无引用的 `SEED_FLAG` / `SEED_META`。**故意保留** `wallRules.js` 的 `p.sample` 守卫（脏数据防御，非死代码）；
      3. **② 推荐档分级放宽**：`recommendPosts` 重写为三级窗口 —— 7 天内优先（新鲜度）→ 不足 `RECOMMEND_MIN_POOL`(10) 条放宽 **30 天**（`RECOMMEND_WIDE_DAYS`）→ 仍不足则**全部**；池内按 `interleaveByDay` **按天均匀取样**（不让某一天霸屏）。示例帖单独拎出、不占真帖名额；
      4. **③ 月档改滚动 30 天**：`inRange` 原来在 month 分支单独按 `YYYY-MM` 比对「当月 1 号起」，与 `rangeStartTs` **两处口径各说各话**；统一走 `rangeStartTs('month')` = 滚动 30 天（`RANGE_MONTH_DAYS=30`）；
      5. **真实数据实测**（679 帖 / 最新 09-27 / 今天 10-02，正是超窗场景）：推荐档输出 **6 张卡 → 50 条全出**，按天覆盖 4 天（09-27→26→25→24）均匀轮询；范围档 7d=3 / month=50 / all=50，month 窗口起点 = **2026-09-02**；
      6. **测试**：`wall-rules-test` **44/44**（新增 `recommendPosts` 三级放宽 / 按天取样 / 未来帖排除覆盖；两条旧 month 断言随新口径更新）；`comment-test` **35/35**（T1–T4 原「示范评论专属」测试改为**反向防回潮断言**：示例帖不得回潮）。全量 **39 套 0 fail** + `undef 0` / `tdz 0` + `build 0`（seo 23 页 / env-guard ✓）；
      7. **待用户拍板**：库中 9/24 有 47 条 `〔压测 #xxx〕` 灌水帖（疑似早期压测数据）。**属删数据，已明确告知用户并等指示，未动。**

  - **轮 145 · 故事栏批 2：评论区 / 书架 / 每日精选 / 我的数据面板（2026-10-01，用户「继续做后面的内容」后开工）**
    - **前提**：批 1 的 `MIGRATION_story.sql` 已由用户在 Supabase SQL Editor 执行成功（首跑 42P13 整单回滚，修参数后通过）。
    - **数据层**：新增 `MIGRATION_story_b2.sql` —— 表 `story_bookmarks`（复合主键防重复 + 级联删）、`stories.featured` 列（`add column if not exists`，单篇布尔不做多篇编排）、RLS 本人读写 + 8 个 RPC：
      - 评论三件套：`story_comment_list`（published 全员可读，带 `mine` 标记）/ `story_add_comment`（≤1000 字；**非 published 先回滚插入再抛错**，保证 `comment_count` 与实际条数一致）/ `story_delete_comment`（评论作者或故事作者，`greatest(x-1,0)` 兜底）
      - 收藏两件套：`story_toggle_bookmark`（返回 true=已收藏）/ `story_bookmark_list`（收藏时间倒序、只列仍在架）
      - 精选两件套：`story_featured`（当前那篇或空）/ `story_set_featured`（**仅 `is_admin()`**，设新先全撤 → 同时只留一篇）
      - 数据面板：`story_my_stats`（篇数/获赞/阅读/评论/收藏 + 最高赞一篇，单行汇总）
    - **42P13 铁律落地**（批 1 翻车根因）：新增校验器逐行扫每个函数的参数默认值序列，**8 函数 0 违规**；另检函数名 vs 表名冲突（故用 `story_comment_list` 而非 `story_comments`，避开批 1 已建的表）、`as $`/$; 配对、`begin`/`commit` 收尾、幂等。**生成器改用 JS 拼装落盘**——编辑器直写会把 `$` 与换行转义掉（期间还因正则误伤把文件搞乱过一次，已整file 重写而非修补）。
    - **三通道**（直连 `db.supabase.js` / 网关 `db.gateway.js` / Worker 各 8 个方法）：**Worker 路由顺序是本轮要点**——字面量子路径（`/story/featured`、`/story/stats`、`/story/bookmarks`、`/story/bookmark`、`/story/comments/:id`）必须排在通用 `/story/:id` **之前**，否则 `/story/featured` 会被当 id 掉进 bad-id；评论接口入参体检（坏 id / 空评论 / 超 1000 字 → 400 且**零出站**）。
    - **前端**：新组件 `components/story/StoryComments.vue`（列表/发送/删除/登录引导，复用 `.st-*` 样式）；`StoryDetailView` 接入评论区 + ⭐收藏；`StoryFeed` 顶部每日精选卡（无精选显示引导文案）；`StoryMine` 数据面板 + 我的书架（可翻页、下架自动隐去）。
    - **顺带修 3 个真 bug**：
      1. `story-test` 4 条断言写在 `process.exit(1)` **之后**（轮 145 遗留死断言，永不执行也不计数）→ 移到结果判定之前；
      2. `i18n.js` story 块 **6 个重复键**（JS 字面量后者覆盖前者，其中 `myBest` 被无占位符版本覆盖 → `{title}`/`{n}` 渲染不出来）→ 保留带占位符那版；
      3. i18n 缩进错乱 3 行 + 补 `errCommentEmpty`/`errCommentLong`（`storyErrKey` 引用了但字典缺失 → 会显示裸 key）。修复脚本已改成**幂等**（首版非幂等，复查时又插了一遍，靠备份回滚纠正）。
    - **验证**：全量 **39 套 0 fail**（story 101/101）+ undef 0 + tdz 0 + worker `node --check` 0 + `vite build` 0（4.94s）。
         - **部署后追加修（上线前发现）**：`app-shell-test T25` 断言写法缺陷（正则 `[\s\S]*?` 跨出花括号，把文件别处的 `padding: 0;` 误配进来 → 报「缺 padding:0」假失败，限定在块内后过）；`i18n.js` `common.delete` 中英各多一处（编辑器把相邻行粘连所致，HEAD 只有 1 处）→ 删冗余并补全仓重复键扫描脚本，**重复键 0**。
     - **部署记录（2026-10-02）**：代码 commit **`915ac97`**（14 文件 +711/−29，含 `MIGRATION_story_b2.sql` 与新组件 `StoryComments.vue`）；`vite build` **0**（4.91s）→ `wrangler deploy` **0** → Version **`9d555373`**（49 文件，Total 54.48 KiB / gzip 10.74 KiB）；live-check 首跑 2 项 `fetch failed`（`/pet`、`/favicon.png`，Cloudflare 网络抖动，单点重试即 200）→ 复跑 **LIVE ALL PASS (14)**；live-bundle-check 入口 `index-B9Ky-n3p.js` 463773 字节 SHA16 **`a54ef443d0a18fd0` 本地=线上**；批 2 线上复核脚本 **B2_LIVE 14/14**（4 个 Story 分包逐字节本地=线上、评论/书架/精选/面板四端点在位、`StoryComments` 已进 StoryDetailView 分包、`/story`+`/story/write`+`/zh/story` 200、轮144 死类未回潮）。
     - **两课（探针）**：① db 层被 rollup 提进**入口 chunk**，不在 Story 分包里——只扫分包会漏判特征串（一度误报 3 项 FAIL），须入口+分包合并扫；② 线上 fetch 偶发 ConnectTimeout，探针须自带重试，否则把网络抖动误报成部署事故。
     - **状态**：**已部署上线**（SQL 前置已由用户执行成功），待用户亮屏验收。
  - **轮 145 · 故事栏批 1：投稿/发现/榜单双栏壳 + 详情/写作独立页 + 数据层三通道（2026-10-01，用户点名「侧边栏增加一个按钮，故事栏，然后点击之后增加一几个页面，左边是投稿，右边是排行榜页面…3w字」，方案经用户拍板 **1A 三页签同居左栏 / 2A 轻 Markdown / 3 要评论（UI 批 2）/ 4 分批**；改动完成：**全量 0 fail** + build 0 + page-smoke 9/9，**已提交 `a2efb88` / 已部署（3 次 deploy 终版 Version `7717a367`，live-check 14/14）；上线前置：`MIGRATION_story.sql` 用户首执报 42P13 已修复、待重新执行**）：
     **导航/路由**：`SideNav` 新项 `{ to: "/story", ico: "📖" }`（暖心墙之后）；`router.js` 4 条懒加载 —— `/story`（双栏壳）`/story/write` `/story/edit/:id?` `/story/:id`（详情）；`vite.config.js` seoRoutes zh/en 成对 + `wrangler.jsonc` `run_worker_first` 加 story 段 + Worker 存在性回退（照 `/post/*` 惯例，详情页可被收录、查无真 404）。手机端 TabBar/三联零改动。
     **双栏壳（方案 1A，照私信页一体外壳惯例）**：`StoryView` = 左栏三页签 **投稿 | 发现 | 我的** + 右栏 340px **排行榜**四页签 **推荐 | 最新 | 月赞 | 标签**；手机端单栏（段签切换，不新增手机形态）。
     **数据层（三通道全接，先例同款）**：`MIGRATION_story.sql` —— `stories`（title≤100/body≤30000/tags text[]{1~3}/status draft·published·removed/word_count·read_minutes/like·comment·view_count 计数列/**period_key 月赞物化列（改周榜只换参数不改表）**/rev）+ `story_likes`（唯一约束防刷赞）+ `story_comments`（表已建，**UI 批 2**）+ RPC `story_publish/story_save_draft/story_toggle_like/story_add_view/story_rank/story_get/story_mine` + RLS；`db.supabase` 直连 / `db.gateway` `/api/story/*` 翻译 / `worker/api.js` 七路由 —— Worker 入参体检（3 万字/空标题/空正文/零标签/非法 mode/bad-id → **400 + 0 出站**，垃圾请求不到上游）。
     **四种排序**：**推荐**（默认）= 近 30 天已发布池加权洗牌（like×0.6 + view×0.3 + 新鲜×0.1，seed 随期换批）/ **最新** = published_at DESC / **月赞** = `period_key` 物化列（**以后改周榜预留**）/ **标签** = tags 检索 + 热门标签云。
     **编辑器（方案 2A，`StoryEditor`）**：标题 ≤100 + 正文 ≤30000 实时计数与约读时长、标签 1~3（预设池+自定义）、轻 Markdown 工具条（H2/引用/分割线/粗体）、写↔预览双页签、自动存草稿（草稿宽容：标题可空）、发布前复核；纯函数集中 `utils/storyRules.js`（可测）。**详情页**：大字排版 + 赞/浏览 + 相关推荐 + 足迹计数；草稿/下架真 404（守软 404 红线）。**我的**（`StoryMine`）：草稿箱 + 已发布。
     **测试**：新增 `tools/story-test.mjs` **97 项**（3 万字边界/标签 1~3/四排序/period_key/i18n 成对/SQL 结构）；`gateway-contract` **+9 至 80**（七方法端点+body 逐字符）；`worker-test` **+13 至 247**（RPC 翻译 + 体检）；`page-smoke` 加 `/story`；`seo-test` 50/50（seoRoutes 动态口径）。
     **验证**：**全量 0 fail**（story 97 / gateway 80 / worker 247 / app-shell 64 / bottle 71 / auth 130 / dm 286 …）+ build **0**（seo 20 页 / env-guard ✓）+ page-smoke **9/9**。
     **批 2（待批 1 验收）**：评论 UI（表已建）、书架收藏、每日精选、我的数据面板（总获赞/阅读/名次）。
     **待用户执行/验收**：① Supabase SQL Editor **重新执行修后的** `MIGRATION_story.sql`（首执 42P13 已修：两处 `p_id` 去 default，事务已整单回滚）② 亮屏看左导航「📖 故事栏」→ 双栏壳、四榜切换、3 万字投稿拦截、发布→详情链路。
     **部署记录（2026-10-01）**：3 个 commit（`35b10f5` 轮144 / `a2efb88` 轮145 / `dbb89f9` 文档）+ 补丁（vite.config zhRoutes + MIGRATION 42P13 + 测试断言）；`vite build` 0 → deploy Version **`487ad94b`** → live-check **14/14** + live-bundle-check 入口 `index-DQ0vH_li.js` 461138 字节 SHA16 **`133918fb58e75656` 本地=线上**。线上复核发现 `/zh/story` 缺中文预渲染 → zhRoutes 补一行 → deploy Version **`271e677b`**（仍 404，上传不全）→ deploy Version **`7717a367`** 后 **story-live-check 14/14 全绿（加强脚本终版复核 18/18）**（入口 JS + 5 懒加载 chunk + 入口 CSS 逐字节本地=线上、`/story` + `/zh/story` 预渲染 200、详情查无 404 兜底、轮144 `hall-pill--tap` 已清）+ live-check 复跑 **14/14**。**两课**：① `sortBottleMine` 被 minifier 改名——产物单串搜不可靠，改由字节一致性整体覆盖；② 新增静态文件后必须实测线上 200（第二次 deploy 后仍 404，第三次才传全）。
     **SQL 事故（42P13）**：用户首执报 `input parameters after one with a default value must also have defaults` —— `story_publish`/`story_save_draft` 的 `p_id bigint default null` 后跟无默认的 `p_title/p_body`。修：两处去掉 `p_id default null`（gateway/worker 恒显式传全 4 参）+ 函数头注释警示；机器校验 7 函数参数序列 ALL OK。事务包裹 → 报错即整单回滚，重跑修后文件即可。

  - **轮 144 · 漂流瓶待处理排序 / ⋯菜单点空白关 / 暖心墙页内刷新 / 大厅两排去重+动效（2026-10-01，用户四项点名，**改动完成：**全量离线 0 fail + page-smoke 9/9 + build 0 + 结构探针两档，已提交 `35b10f5` / 已部署 Version `7717a367` / 线上复核全绿**）：
     **① 漂流瓶「我发布的」待处理优先**：`bottle.js` 新导出 `sortBottleMine(rows, userId)` —— `choose` 态（收到回信 · 待你同意/拒绝聊天）置顶 → `waiting` → 其余，**同档保持服务端时间新→旧**（稳定排序不打乱时间序）；`BottleView.loadRecords` 发布页签消费。
     **② 右上角「…」点空白自动关**：`MessagesView` document 层监听 —— 点到 `.dm-head-tools`（菜单/按钮本体）外面一律关闭，菜单内项动作收口不受影响，`onBeforeUnmount` 成对移除；`watch(seg)` 切段即收。
     **③ 左导航点「暖心墙」触发刷新**：抄 TabBar 轮 100 先例 —— 已在暖心墙页时拦默认导航（同路径 push 被 vue-router 忽略 = 之前点了没反应）→ 推 `?refresh=时间戳` → `CommunityView` 既有 watch 消费（强制重拉第一页+回顶）；仅「已在本页」生效，其它按钮/非本页不干预。
     **④ 大厅两排按钮去重 + 动效（用户截图处）**：第一排 chip = **唯一设置入口**（4 按钮 + toggleHint 提示）；第二排「此刻大厅里」改**纯信息** —— 删点击/`--tap`（`hallBtnCount: 0`）、保留 `on` 联动高亮（我选的状态在统计里点亮，两排从重复按钮变成「操作→数据」对应）；补 `companion.toggleHint` i18n **中英成对**（此前渲染裸 key 字符串）；hover 上浮/按下回缩/选中高亮全部 0.22s 过渡，死规则 `hall-pill--tap` 删除。
     **断言**：`bottle-test` +2（排序纯函数运行时真跑 `[10,9,8,7]→[9,7,10,8]` + BottleView 接线）；`app-shell` +`T62`（⋯点空白关）+`T63`（暖心墙页内刷新链路两头）。
     **验证**：全量 0 fail + build 0 + page-smoke 9/9 + 结构探针（1562 桌面/393 移动）：`.hall-pill-row` 纯 div **零 button**、第一排 4 button、`transition: background .22s` 生效、无裸 `toggleHint` key。
     **待用户验收（亮屏）**：① 我发布的待处理排最前 ② ⋯菜单点空白收起 ③ 已在暖心墙时点侧栏暖心墙=刷新 ④ 大厅两排不再是重复按钮、样式顺眼。

   - **轮 143 · 私信页两列化：右资料卡退役 → 头部右上角「…」菜单 + 瓶聊昵称进空间（2026-10-01，用户两条点名「1.私信还是改成两段式的，把右边第三个取消，之前的内容放在右边第二个会话的右上角，增加...按钮。2.私信-漂流瓶-用户聊天框点击昵称无法进入对方空间」，**改动完成：**全量离线 **38 套 0 fail**（app-shell **62/62**）+ page-smoke 9/9 + build 0 + 探针 A/B/C，已提交 `8013ca4` / 已部署 Version `9072e7ef` / live-check 14/14 / 线上复核全绿**）：
     **改动**：① **右第三列整列退役** —— `MessagesView` 删 `aside.dm-info` 资料卡 + `showInfo`；`style.css` 删 `.dm-info*` 样式族、`.dm-wrap--noinfo` 轨道规则、轮138「窄桌面收拢（1479px）」媒体查询（两列后无意义）；网格 `300/1fr/264` → **`300px/1fr` 两列**（两列等高底齐 / 一体外壳 / 滚动条隐藏口径不变）。② **原资料卡内容迁中列聊天头右上角** —— 新「…」按钮（复用 `.dm-menu` 下拉，`.dm-head-tools` 相对定位锚定）：看 TA 的主页 → / 静音 / 拉黑（有会话时）/ 瓶段未建会话如实显示「还没法私信 TA」说明（不摆空按钮）；会话头（dm-thread）直插、漂流瓶头（BottleChat）走 `#headtools` slot 注入 —— **同一份 `curPeer` 数据**，两处菜单零漂移。③ **需求 2**：`BottleChat` 引 `useRouter`，头部**头像 + 昵称两处**绑 `goUser(peerId)` → `waller` 路由（与会话段 #15 同口径；`peerId` 空不硬跳）。
     **零改动边界**：手机端三段与底部导航零变化（资料卡本就桌面 only）；数据层零改动；i18n 零新键（`dm.viewHome`/`dm.mute`/`dm.block`/`bottle.noChatYet` 均复用）；左列会话列表 / 漂流瓶列表 / 两套聊天框结构不动。
     **断言（app-shell 61→62 项）**：`T47` 改「资料卡不得回潮」（无 `.dm-info` 样式族 / `--noinfo` / `showInfo`）`T59` 改两列口径（`300px minmax(0,1fr)` 全文仅一条 + 滚动条隐藏选择器去 `.dm-info`）`T60` 新「头部右上角 ⋯ 菜单」（两处 `dm-head-tools` + `#headtools` slot + `curPeer` 源 + 四键 zh/en 成对）`T61` 新「瓶聊昵称进空间」（`useRouter` / `waller` / 两处 `goUser(peerId)` / `dm-peer-link`）。
     **验证**：全量 **38 套 0 fail**（app-shell **62/62**）+ page-smoke **9/9** + build **0**（4.96s）+ 探针：A 会话段两列 **300/728**、无 `.dm-info`、底边 784 齐、⋯菜单可开；B 瓶段菜单含「看 TA 的主页 →」；**C 点昵称 `clicked:true, nickText:"Manami", /messages → /u/probe-peer, navigated:true`**（首跑失败系 dist 未含 seed 的构建时机问题，重跑即绿）。
     **部署记录（2026-10-01）**：代码 commit `8013ca4`；`vite build` EXIT=0（4.96s）→ `wrangler deploy` EXIT=0 → Version **`9072e7ef`**（42 文件，Total 46.12 KiB / gzip 9.75 KiB，域 warmpaws.de5.net）→ live-check **LIVE ALL PASS (14)** → bundle：入口 `index-BQV9u2su.js` SHA16 **`16113ee75ca05d95`**、入口 `index-BuT6mcQ2.css` SHA16 **`f12f28e72364e9f9`**、懒加载 `MessagesView-B7a7OiBg.js` SHA16 **`17e7c4c5208b6d3a`** 均**本地=线上**；线上特征：CSS 两列 `grid-template-columns:300px minmax(0,1fr)` ✓ `.dm-head-tools` ✓、无 `.dm-info`/`--noinfo` ✓；JS（MessagesView chunk）`headtools`/`dm-peer-link`/`waller` 在位、无 `showInfo` ✓（`goUser` 被 minifier 改名属正常）。
     **待用户验收（亮屏）**：桌面 `/messages` —— 右列资料卡整列取消、变两列；会话头右上角「…」能开（看主页/静音/拉黑）；漂流瓶聊天框点头像/昵称跳对方空间。**桌面专属改动，App 端零变化，APK 不需重打**。


  - **轮 142 · 私信页一体两段（会话|漂流瓶）+ 桌面漂流瓶独立聊天（2026-10-01，用户点名「私信页面按我下面这个改，要有漂流瓶的…要做成一体的」，开工前拍板 A/B/C：A 桌面两段 · B 左列胶囊改「会话|漂流瓶」、两段各自单开聊天框 · C 右列保持资料卡，**改动完成：**全量离线 **38 套 0 fail**（app-shell **61/61**，含新 T56–T60）+ page-smoke 9/9 + build 0 + 探针四档截图，已提交 `fd84f8b` / 已部署 Version `27184cb3` / live-check 14/14 / 线上复核全绿**）：
     **改动**：① **新 `BottleChatList.vue`**（桌面漂流瓶左列：「我发布的 / 我捞到的」页签 + 行式列表=头像·名字·状态胶囊·摘要·时间·选中态；昵称三级解析 **dm 会话昵称 → profiles（RLS 全员可读）→「海里的朋友」兜底，不编造名字**）② **新 `BottleChat.vue`**（独立聊天框三态：空态「左边选一封信」/ 待我决定=原信卡+「愿意，开始聊天/不了，留作书信」/ 已接受=拉该会话消息+输入发送+15 分钟撤回+可见 5s 轮询；复用 `dmRules` 与 `.dm-*` 样式——**视觉与会话框一致，组件与状态完全独立**）③ `MessagesView.vue`：桌面分段条两段「会话|漂流瓶」（手机仍三段，`role=tablist` 同一条）、左列按段切换（会话列表 ↔ BottleChatList）、中列 `v-if` 两套独立聊天盒、右列资料卡数据源改「**当前选中 peer（会话 or 瓶）**」随段联动、**删底部「当前用户」条**（`.dm-me` 模板/样式/i18n/死代码四清，`dm.online` 退役）④ `style.css`：**一体外壳**（单卡 radius20 + 内部 1px 分隔线，去卡中卡）+ **三列等高底齐**（清 `align-items:start` 参差）+ 左列/中列**隐藏滚动条**（`scrollbar-width:none` + webkit 隐藏，仍可滚）+ 新 `.bcl-*` 瓶聊样式。
     **零改动边界**：手机端三段与 `.shell--mobile-nav` 样式零变化；`/bottle` 独立页与 `BottleRecords` 原样（左导航第 3 项照旧）；数据层零改动（发消息复用 `dm_*`、瓶数据走既有 bottle RPC，未读红点口径 `badge.dm` 不变）。
     **新增断言**：`app-shell T56`（桌面两段「会话|漂流瓶」+ 新键 zh/en 成对）`T57`（BottleChat 独立实例、手机瓶列原样）`T58`（`.dm-me` 三清防回潮）`T59`（一体外壳 + 等高底齐 + 滚动条隐藏）`T60`（资料卡两段共用、随选中人变）。
     **验证**：全量 **38 套 0 fail**（app-shell **61/61**、privacy 34/34、i18n 19/19）+ page-smoke **9/9** + build **0**（5.04s）+ 探针四档截图：桌面会话段=分段 `[会话,漂流瓶]`、无 `.dm-me`、外壳 `bg #efe9de / radius 20px / overflow hidden / 1px 分隔线`、左列透明无阴影、**三列底边 785 齐平**；漂流瓶段=`BottleChatList+BottleChat` 在位、空态文案正确、等高底齐；信件态=原信 2 卡 + 决策双按钮 + 资料卡切 Manami（`wrapCols 300px/464px/264px`）；手机 393×852=三段 `漂流瓶|会话中心|通知`+底部导航、无任何桌面组件。
     **部署记录（2026-10-01）**：代码 commit `fd84f8b` → `vite build` EXIT=0 → `wrangler deploy` EXIT=0 → Version **`27184cb3-f075-4a65-817d-4ba2bd3e032e`**（40 文件，Total 46.12 KiB / gzip 9.75 KiB，域 warmpaws.de5.net）→ live-check **LIVE ALL PASS (14)** + 五资源**本地=线上**（入口 `index-Aeol5qGu.js` sha16 `070e0f0fe453a0a8` / `index-DQThYwLn.css` sha16 `6453e04da0f8c057` / vue·naive·lottie 同一致）+ 线上特征复核：新串「左边选一封信 / 海里的朋友 / 愿意，开始聊天」与 `.bcl-row`/`.bcl-more` **全在位**，死类 `.dm-me {` / `.dm-me-body` / `.dm-online` **已清**（注：`.dm-menu` 是活的右键菜单类，粗粒度 `.dm-me` 子串匹配会误报）。
     **待用户验收（亮屏）**：桌面 `/messages` —— 分段条「会话|漂流瓶」；切到漂流瓶段左列有信、点信中列开原信/继续聊（**登录态才有真数据**：探针未登录 `bclRows=0` 属取证环境，列表渲染由离线测试覆盖）；三列一体等高、无「当前用户」条、列表/中列滚动条隐藏；手机三段与 `/bottle` 页零变化。**桌面专属改动，APK 不需重打**。


  - **轮 141 · 右栏去掉「海边来信」（2026-10-01，用户点名，**改动完成：**全量离线 **40 项 0 fail**（app-shell **56/56**，含新 T55）+ page-smoke 9/9 + undef/tdz 0 + build 0 + 探针/截图复核，已提交 `115789f` / 已部署 Version `8a440167` / 线上复核全绿**）：
     **需求（用户原话）**：「右边侧边栏把海边来信内容去掉」。
     **移除范围（模板/逻辑/样式/i18n **四清**，不留半套）**：
       · **模板**：`SideRails.vue` 右栏「治愈角」卡片内 `<template v-if="signedIn">` 整块（`rail.bottleTitle` 小标题 + `.bt` 三行：`rail.bottleLeft` / `rail.bottleHeld` / `rail.bottleGo` 去海边看看链接）。
       · **逻辑**：`signedIn` / `btLeft` / `btHeld` / `loadBottle()` / `onMounted(loadBottle)` / `watch(signedIn, loadBottle)` 全删（删后无其它引用）；连带清理导入 —— `import { cloud }`（supabase）、`bottleQuota/bottleHeld/BOTTLE_SEND_MAX/BOTTLE_FISH_MAX`（utils/bottle）、`bottleLeft`（railRules）、vue 的 `watch/onMounted`（该文件已无其它使用）。右栏从此**不再自己拉漂流瓶次数**（少一次登录态挂载请求）。
       · **样式**：删死规则 `.bt` / `.bt-line` / `.bt-line.bt-warn` / `.bt-go`。
       · **i18n**：删 4 键 × 中英各一（en `rail.bottleTitle/bottleLeft/bottleHeld/bottleGo`、zh 同四键），**成对删除**（i18n-test 19/19 仍绿）。
     **保留**：`utils/railRules.js` 的 `bottleLeft()` 纯函数 + `rail-test` T27–T31 5 条单测（产品侧本轮后**暂无调用方**，属通用工具；若要一并清死代码可下轮发话）。右栏「治愈角」现为：今日温柔签 → 跟我呼吸 → 心情速记。
     **新增断言**：`app-shell-test T55`（四清防回潮：模板无 `rail.bottleTitle`、无 `btLeft/btHeld/signedIn`、无 `.bt-line`、无 `bottleQuota/bottleHeld(` 调用，且 i18n 四键已不存在）。
     **验证**：build **0**（seo 20 页 / env-guard ✓）+ **全量离线 40 项 0 fail**（app-shell 56/56、i18n 19/19、rail 31/31、bottle 69/69、uifix 24/24）+ page-smoke **9/9** + undef/tdz **0** + 探针（1562 `/` 与 `/pet`）：右栏 `.rail-head` 列表 = `[伙伴角, 今日温柔任务, 治愈角, 心情速记]`、全文无「海边来信 / 还能投 / 手里有」、无任何 `.bt*` 节点；截图目检治愈角卡片只剩签/呼吸/心情三块。
     **待用户验收（亮屏）**：刷新任意桌面页 —— 右栏「治愈角」里不再出现「海边来信 / 还能投 N 封 · 回 M 封 / 手里有 N 封信 / 去海边看看」。**桌面专属改动，App 端零变化，APK 不需重打**。
     **部署记录（轮 139+140+141 一批，2026-10-01）**：3 个代码 commit（`bd27077` 轮139 / `ab0c6ff` 轮140 / `115789f` 轮141）+ 1 个文档 commit；`vite build` **EXIT=0**（seo 20 页 / env-guard ✓）→ `wrangler deploy` **EXIT=0** → Version **`8a440167`**（42 文件上传，Total 46.12 KiB / gzip 9.75 KiB，域 warmpaws.de5.net）→ live-check **LIVE ALL PASS (14)** + live-bundle-check 入口 `index-BILBFCh3.js` SHA16 **`33640cae6077d1ef`**（455163 字节，含 slug）**本地=线上** + 入口 CSS `index-D0m3Gg-f.css` SHA16 **`21f1809026a767d5`**（89371 字节）**本地=线上**。
     **线上逐条复核（抓真产物）**：`[轮140]` 线上 CSS `.sidenav--open{width:212px;background:transparent;border-color:transparent}` 逐属性 ✓、线上 JS 左导航顺序 漂流瓶(idx 388291) < 暖心墙(idx 388332) ✓、默认展开判据 `wp-nav-open`/`"0"` 在位 ✓；`[轮141]` 四串 `rail.bottleTitle` / `海边来信` / `去海边看看` / `手里有` 全部 **idx=-1**（已清）✓、CSS 无 `.bt-line` / `.bt-go` ✓；`[轮139]` CSS 无 `.settings-page` ✓、`.legal-page` 桌面 `max-width:none` ✓；`/bottle`、`/privacy` 分包 CSS 亦**本地=线上** ✓。复核备注：`还能投` 仍在线上，属 `bottle.leftSend`「今天还能投 {n}封」= **/bottle 页合法文案**，非右栏块。


  - **轮 140 · 左导航默认展开+透明 / 漂流瓶上移 / 桌面首页去漂流瓶（2026-10-01，用户三项点名，**改动完成：**全量离线 **40 套 0 fail**（app-shell **55/55**）+ page-smoke 9/9 + undef/tdz 0 + build 0 + 探针四档 + 截图目检，已提交 `ab0c6ff` / 已部署 Version `8a440167` / 线上复核全绿**）：
     **需求（用户原话）**：「1.左边侧边框，设置成默认展开。且展开的时候不要那个框的背景，弄成跟右边一样的透明 2.今天页面把最下面的漂流瓶相关内容去掉 3.左边侧边框把漂流瓶往上移到暖心墙上面」。
     **① 默认展开**：`uiStore` 判据由 `getItem(NAV_KEY) === "1"` 改 **`!== "0"`** —— 未存过 = 展开，只有用户**显式点过收起**才收起（否则「默认展开」会被上一次的 0 压住）。模块加载同步读，首帧即正确形态不闪。
     **② 展开态透明（与右栏同口径）**：`.sidenav--open` 由「只改宽」改为 `width: 212px; background: transparent; border-color: transparent;` —— 右栏 `.rail` 容器本就无底（只有内部 `.rail-card` 有底），故左栏展开时同样只留内容、不留框；**收起态保留原卡片质感**。
     **③ 导航顺序**：`items` 数组把 `{ to: "/bottle", ico: "🌊" }` 从暖心墙**之后**移到**之前** → 今天 | 我的宠物 | **漂流瓶** | 暖心墙 | 私信 | 设置（文字走既有 i18n 键，中英自动跟随）。
     **④ 桌面首页去漂流瓶**：`HomeView.vue` 桌面分支删 `<BottleView />`（原「今日联 + 漂流瓶联」上下排列 → 只剩今日），底部那一大块漂流瓶卡片彻底消失；**手机三联里的「漂流瓶」联保持不动**（TabBar ＋ 钮 / `?tab=bottle` 深链仍直达），漂流瓶走 `/bottle` 独立页 + 左导航直达。
     **同步的旧断言（产品代码无问题，纯口径搬移）**：`bottle-test`「HomeView 挂两处 BottleView」→ 改「只剩手机三联 1 处 + `/bottle` 页承载」；`home-panes-test T8`「桌面 TodayPane 后跟 BottleView」→ 改「桌面挂 TodayPane 且 **BottleView 必须不存在**（`assert.equal(bPos, -1)`，防回潮）」。
     **新增断言**：`app-shell-test T52`（展开态 `background/border-color: transparent` 逐字钉住）、`T53`（导航顺序漂流瓶在暖心墙之前）、`T54`（桌面首页 `<BottleView>` 只允许手机那 1 处）；`T44`/`T46` 同步为默认展开新判据（`width: 212px;` 前缀匹配，避免整串钉死）。
     **验证**：build **0**（seo 20 页 / env-guard ✓）+ **全量离线 40 套 0 fail**（app-shell 55/55）+ page-smoke **9/9** + undef/tdz **0** + 探针四档（1440/1562 桌面、393 移动端、`/bottle`）：**默认**（无 localStorage）`navOpen=true`、宽 **212**、`bg/border = rgba(0,0,0,0)`、labels `[今天,我的宠物,漂流瓶,暖心墙,私信,设置]`、shell 左让位 **240**、桌面首页 `.mail-card` **0**、「温暖漂流瓶」字样 **0**；393 移动端 `mobileNav=true`、侧栏不渲染、三联内漂流瓶联仍在（**零影响**）；`/bottle` 页同样默认展开且透明。截图目检：左栏无框、六项文字齐、品牌行「暖爪」在顶。
     **待用户验收（亮屏）**：刷新首页 —— 左栏默认就是展开且**无卡片框**；漂流瓶在暖心墙之上；首页底部不再有漂流瓶。**桌面专属改动，App 端零变化，APK 不需重打**。


  - **轮 139 · 旧断言三套同步 + style.css 死规则清理 + 政策页铺满（2026-10-01，用户发话「顺手同步」，**改动完成：**全量离线 **40 套首次 0 fail** + page-smoke 9/9 + undef/tdz 0 + build 0 + 政策页几何探针三档，已提交 `bd27077` / 已部署 Version `8a440167` / 线上复核全绿**）：
     **① 旧断言同步（只动测试文件，产品代码零改）**：轮 137 认定的 4 条漂移一次性收口 ——
       · `auth-test A95`：manifest scheme 断言还钉着 `net.de5.dale` → **`net.de5.warmpaws`**（轮 116 换 appId；先 grep AndroidManifest 确认现状再改，不瞎改断言）。
       · `privacy-test P5`：sitemap 结构断言钉着旧域 `dale.de5.net` → **`warmpaws.de5.net`**（轮 109/115 换域）；本项本意是「loc 后有 `</url>`」的结构断言，域只是顺带口径。
       · `app-shell-test T24`：删掉「桌面列表嵌 `<BottleRecords v-if="!isMobileNav">`」的过时子句，改为**反向断言** `!mv.includes('<BottleRecords v-if="!isMobileNav"')`（轮 134 决策：桌面列表不再嵌记录 → 钉住防回潮）；标题同步为实际顺序「漂流瓶|会话|通知」。
       · `app-shell-test T34`：过渡类名从 fade 扩成「fade 组 + page 组一起扫」（过渡 `name` 改 page 后补的），断言同步为正则「两组都在」。
     **② style.css 死规则清理**：删 `.settings-page` / `.settings-title` / `.set-block` / `.set-block.dimmed` —— 全仓**零模板引用**（设置页早已改用组件内 `.set-page`/`.set-row` 体系）；`.set-opts`/`.set-opt` 经查是**活的**（SettingsView 8 处）保留。
     **③ `/privacy` 拉满（用户拍板）**：`.legal-page` 加 `@media (min-width: 900px) { .legal-page { max-width: none; } }`，与轮 137 其余五页同口径；**明确接受行宽变长**（原 720 是「给 Google 审核读得下去」的口径，现改为全站一致）。
     **新增断言**：`privacy-test P28`（窄屏 720 基准 + 桌面铺满覆盖）、`app-shell-test T50`（死规则不得回潮）、`T51`（六个页面容器 ≥900 一律 `max-width:none` 的注册表式断言，覆盖轮 137 五处 + 政策页）。
     **验证**：**全量离线 40 套首次 0 fail**（auth 130/130、privacy 34/34、app-shell 52/52）+ undef/tdz **0** + build **0**（seo 20 页 / env-guard ✓）+ page-smoke **9/9** + 政策页几何探针：1440 `[118,1174]`、1562 `[118,1296]`（与其余页面同口径，右栏 [1334,1546] 零重叠）、393 移动端 w357 / `max-width:720px` **零变化**。
     **待用户验收（亮屏）**：刷新 `/privacy` —— 桌面下与其余页面同宽铺满；窄屏与 App 不变。

  - **轮 138 · 桌面左导航展开（用户方案 A：🐾 = 开关，64 → 212px 与右栏同宽 + 行内文字）（2026-10-01，已提交 `7404ee7`（代码）+ `ff36d73`（文档） / 已部署 Version **`bf3cc7fe`** / live-check **14/14** + live-bundle-check **本地=线上**（入口 `index-KA7Y5zAw.js`，SHA16 `47e71561710883fe`，456260 字节，含 slug）+ 线上入口 CSS **本地=线上**（`index-C6_pjsGo.css`，89610 字节，轮 138 十条规则逐项在位）✅；**桌面专属改动，App 端零变化，APK 不需重打**）**：
     **需求（用户原话）**：「当点击左上角第一关按钮的时候，左边的侧边栏向右扩张，跟右边侧边栏相同宽度，添加文字」→ 先出方案，用户拍板 **方案 A**：🐾 只当开关（不再回首页）、回首页交给展开后的品牌行；附加拍板 ② 展开且视口 <1480 时会话三栏收两栏 ③ 记住展开状态。
     **实现**：`uiStore` 加 `navOpen`（localStorage `wp-nav-open`，模块加载同步读 → 首帧即展开不闪）+ `setNavOpen/toggleNav`；`SideNav.vue` 🐾 由 `<router-link>` 改 `<button aria-expanded>`（tooltip 走新增键 `nav.expand/collapse`），顶部 `.sn-top` = 爪印开关 + `.sn-brand`「暖爪」回首页，每项加 `.sn-label`（收起 `display:none`，展开淡入），展开态整行胶囊 + 红点挪到行尾，栏宽 `transition: width .22s`（reduced-motion 关闭）；`App.vue` 壳挂 `shell--nav-open`；`style.css` 左让位改走 `--nav-w`（收起 92 / 展开 240，≥1600 居中公式同步换变量 + `margin-left` 过渡），并加「展开 + <1480 → `.dm-wrap` 两栏 + `.dm-info` 退场」。
     **几何实测（无头 Edge，收起 → 展开 → 再收起三态）**：1440：侧栏 64→**212**（[14,226]，= 右栏宽度）、壳 [92,1200]→[240,1200]、内容 [118,1174]→[266,1174]、右栏 [1212,1424] 不动；1562：展开后壳 [240,1322]、内容 [266,1296]、右栏 [1334,1546]（**38px 零重叠**）；1920：超宽屏封顶 1440 保持（展开 [240,1680]，内容仍 1388）；1000：壳 [240,1000]（该区间无右栏）；再点收回后**全部逐值回到收起态**。`aria-expanded=true`、`wp-nav-open=1/0` 落盘正确；三栏降级实测 1440→`300px 1074px`（资料卡隐藏）、1562→`300px 918px 264px`（保留）；393 移动端：侧栏不渲染、壳 margin 0（**零影响**）。
     **验证**：app-shell-test **50 项**（新增 T43–T49 全过：开关按钮化/212px/文字/`--nav-w`/记忆/降级/双语/减动效）+ i18n **19/19**（nav.expand·collapse zh/en 成对）+ 40 套离线（仍只有 3 套**旧**断言漂移）+ undef/tdz **0** + build **0** + page-smoke **9/9** + 截图目检（展开态：品牌行 + 六项文字 + 整行珊瑚激活胶囊）。
     **线上复核（部署后）**：① `live-check` 14/14；② `live-bundle-check` 入口 `index-KA7Y5zAw.js` 本地=线上（SHA16 `47e71561710883fe`）；③ 入口 CSS `index-C6_pjsGo.css` 本地=线上（89610B 逐字节）且十项规则在位 —— 侧栏 212px、`--nav-w` 92/240、`margin:0 0 0 var(--nav-w)`、`margin-left .22s` 过渡、`calc(var(--nav-w)+` 超宽屏公式、`.sn-brand` 品牌行、`.sn-label{display:none`、`.shell--nav-open .dm-wrap` 两栏、`.dm-info{display:none`。
     **探针踩坑（补坑）**：验证 CSS 时别先「去掉所有空白」再搜含空格的串 —— 后代选择器的空格与 `margin:0 0 0 var()` 简写会被一起吃掉，false 是探针的假警报（本轮就中了一次）；要么用容忍空白的正则，要么查无空白结构串（如 `--nav-w:92px`）。
     **待用户验收（亮屏）**：点左上角 🐾 → 左栏展开并显示文字；再点收回；刷新后保持上次状态。

  - **轮 137 · 全页面内容盒适配流式壳（2026-10-01，用户截图 /bottle：内容盒两侧大空洞 + 「按这张图改，每个页面都这样」；已提交 `028bb13`（代码）+ `db1d44e`（文档） / 已部署 Version **`97f1ab9d`** / live-check **14/14** + live-bundle-check **本地=线上**（入口 `index-JfT1XYzS.js`，SHA16 `f0fad616db81a2f8`，455575 字节，含 slug）✅；**桌面专属 CSS 改动，App 端零变化，APK 不需重打**）**：
     **真因**：轮 133 把 `.shell` 改成流式后，**只有自带 max-width 的页面容器**还停在窄盒居中——`.bottle-page` 900 / `.set-page` 860 / `.compose-page` 720 / `.pd` 640 / `.login-page` 560；其余页面（今天/宠物/暖心墙/私信/通知/我的/我的帖子/他人主页）早已铺满 → 观感不一致。
     **改法（各文件权威定义处，不在 style.css 另加一份）**：每处 base 规则保留（窄屏口径不变），紧跟一条 `@media (min-width: 900px) { … { max-width: none; } }` —— 桌面形态铺满左导航(92)与右栏(240)之间的整块宽度；**窄屏/App 形态零变化**（这些 max-width 在 <900px 视口本就触不到）。**为什么不写在 style.css**：轮 133 的教训（组件 `<style>` 注入晚于 style.css，同权重会反向压制；权威份必须留在定义文件）。
     **有意保留**：`/privacy` 的 `.legal-page` 720 **不动**（该页口径是「给 Google 审核读得下去」，行宽 68ch 优先）；`.crash-box` 460 / `.pet-notice-stack` 520 / `.tabbar` 640 属组件自身尺寸，不在本次范围；`.settings-page` 640（style.css:943）是**死规则**（无模板引用，待清理）。
     **验证**：undef **0** + tdz **0** + build **0**（seo 20 页 / env-guard ✓）+ **40 套离线**（唯一红：见下）+ page-smoke **9/9** + **探针实测**（`tools/web-probe.mjs --serve=dist --w=1562`，无头 Edge）：/bottle 容器 **[118,1296]（1178 宽）与 welcome 横幅逐像素对齐**，右缘距 rail(1334) 留 38px 零重叠；/settings、/compose、/login 同为 [118,1296]；截图目检两页（漂流瓶 guest 卡、设置页五段卡）铺满无空洞。
     **附带发现（与本次无关 · 经 git stash 对照确认 HEAD 上同样失败）**：`auth-test A95`（断言旧 appId `net.de5.dale`，manifest 实为轮 116 的 `net.de5.warmpaws`）、`privacy-test P5`（断言旧域 `dale.de5.net` 的 sitemap 结构）、`app-shell-test T24`（断言「会话中心」旧文案 + 已删的桌面 `<BottleRecords>`）、`T34`（断言过渡类名 `fade-*`，App.vue 实为 `page-*`）——**4 条全是断言漂移，产品代码无问题**；待用户发话再修（纯测试文件）。
     **待用户验收（亮屏）**：刷新网页看 /bottle、/settings、/compose、帖子详情、登录页——内容盒铺满左导航与右栏之间，不再两侧留白。

     **线上复核（部署后追加）**：页面容器样式在**按路由分包**的 chunk CSS 里（懒加载视图，不在入口 CSS）——5 个分包（BottlePageView / SettingsView / ComposeView / PostDetailView / LoginView）线上与本地 `dist` **逐字节一致**，且各自含 `@media(min-width:900px){…{max-width:none}}`（如 `.bottle-page{max-width:none}`、`.set-page[data-v-f99c5453]{max-width:none}`）；入口 `index-DHxzSSNB.css`(88230B) 亦线上=本地。**教训（补坑）**：验证网页 CSS 改动时，入口 CSS 查不到 ≠ 改动没上线——懒加载视图的样式在分包里（首次探测就踩了这个假警报）。

  - **轮 136 · 漂流瓶/设置页适配流式壳（2026-10-01，用户截图反馈两页窄容器靠左+右大空洞，已提交 `d27d539` / 已部署 Version `ddd214ff` / live-check 14/14 ✅）**：
     `.bottle-page` 640→**900**、`.set-page` 640→**860**，均 margin auto 居中——流式壳下不再靠左留大空洞。探针实测：/bottle 容器 900px 居中于 shell（150-1590）✓。
     验证：build 0 + 截图目检（bottle/settings 双页平衡）。

  - **轮 152 · 修复故事联返回丢失联位置（2026-10-02，用户实测「故事-我的点返回跑到今日/漂流瓶」，已提交 `1cdc500` / 已部署 Version `ab0e4887` / **APK `47E38A370936F124` 装机 + 冷启动确认** ✅）**：
     **真因**：首页联位置只存组件 ref、不进地址栏——从故事联进 /story/mine 后，任何返回路径（物理返回键的 ready 竞态回退到 history.back、或 App.vue 兜底）回首页时都按**默认联**重建 → 故事联位置丢失。轮 154 的 ready 窗口修复只收窄了竞态，兜底路径仍会丢。**修**：手机端 `setPane` 把 `?tab=` **replaceState 进地址栏**（不堆历史、切换/横滑即时同步）——回首页时按 `?tab=story` 重建 = 落回故事联继续（storyMounted 懒挂载重拉，滚动位置不保留——v1 可接受）。
     验证：探针实测（切故事联 → 地址栏 ?tab=story ✓；模拟返回 → 故事联显示 ✓）+ 37 套离线 **0 fail** + build 0 + page-smoke 12/12 + live 部署 + APK 装机冷启动。
     **教训**：轮 154 修的是「返回去错页」的竞态；「回对了页但页面状态丢了」是另一层——**SPA 页面态要么进 URL 要么进 sessionStorage，只靠 ref 必在返回重建时丢失**。

  - **轮 159 · 暖心墙「刷新没有用 + 每个人出现的都一样」（2026-10-03，用户实测点单，已提交 `4f232b2` / 已部署 Version `92f20d3f` / live-check 14/14 / **APK `3AF8916621ED769C`(5.2M) 装机 Success + 冷启动确认 PID 19616 CRASH_HITS=0** ✅）**：
     **双根因**：①轮 149 边缘缓存白名单 `/^\/api\/posts$/` 把 `sample=1` 随机批也缓存 30s——随机结果是按 URL（path+query）冻结的，同一边缘 POP 上**所有人拿到同一份「随机」**，30s 内刷新=原样回放（服务端明明是真随机：两端都是 `Math.random()` 起点，Worker samplePosts / supabase listPostsSample 均实锤）；②首屏挂载 fetcher 走的是**最新页**（确定性，latest-50 人人相同）——轮 66 注释声称「挂载也走随机批」但代码后来退回了最新页。
     **修**：①Worker 缓存闸门加 `searchParams.get("sample") !== "1"`——随机批每次回源（计数+随机起点两查，成本可接受），普通列表 30s 边缘缓存照旧（确定性内容，防冷启动抖动的初衷不变）；②CommunityView 挂载 fetcher 改 `cloudFetchPostsSample(FEED_PAGE)` 失败退回 `cloudFetchPosts(FEED_PAGE,0)` 兜底——首屏每人不同；触底续载照旧游标拉更早（loadMoreCloud 去重+跳页自愈，随机批与后续页交叠不会重复）；下拉刷新逻辑不动（有真新帖→最新页，否则→换一批，现在换一批真的会换了）。
     验证：undef 0 + **40 套离线 0 fail**（gateway-contract/feed-window 全绿）+ build 0 + page-smoke 12/12 + dist 断言（`sample=1` 在共享 chunk、worker 闸门 2 处 sample 探测）。
     **装机环境备忘**：本机 shell 无 JAVA_HOME（gradle 直接报错）——JDK 在 `D:/00ruanjiananzhuang/jdk-21/jdk-21`，构建命令 `JAVA_HOME="D:/00ruanjiananzhuang/jdk-21/jdk-21" ./gradlew assembleDebug`；adb 不在 PATH，用 `C:/Users/lin/AppData/Local/Android/Sdk/platform-tools/adb.exe`。五轮合并单提交 `4f232b2`（15 文件 +634/−80）。

  - **轮 160 · 「明明登录了却显示请先登录」（2026-10-03，用户桌面截图点单：顶栏 linyi 已登录、故事栏红字「请先登录。」，已提交 `697634b` / **已部署 Version `ae576162`** / live-check 14/14 / story-rank 200 ✅）**：
     **复现实锤**：带坏 JWT 打线上 `/api/story/rank` → PostgREST `PGRST301 "Expected 3 parts in JWT"`/401 → `storyErrKey` 的 `/story-auth|JWT|401/` 映射 → `story.errAuth`。**根因**：轮 36「ready 提前」让 boot 用【本地存储的会话】立刻点亮登录态（顶栏马上有头像/金币=用户看的「已登录」），但闭包 `accessToken` 是那个可能已过期的旧 JWT；`autoRefreshToken` 的后台刷新若失败（/sb 代理链路抖、长时间挂起），token 永远不更新 → 所有带身份请求持续 401 → 故事栏等处显示「请先登录」——**假登录态**。anon 打 rank 是 200（公开读没问题），只有带过期 JWT 才炸。
     **修**：①supabase.js 导出 `refreshAccessToken()`——单飞（并发 401 共享同一次 `sb.auth.refreshSession()`），成功后【直接落位 accessToken 闭包】不等 onAuthStateChange 事件回调（重试请求必带新 token）；②网关 `call()` 401 自愈：带过身份的请求吃 401 → 强制刷新 → 换新 token **重试一次**（`err.status` 记录状态码；刷新失败/仍 401 原样上抛，绝不循环；匿名请求 401 不触发）——**一层修复全站受益**（暖心墙/私信/故事/收藏所有 authed 调用）；③StoryFeed 拉取成功时清 `err`（自愈后红字不残留）；④测试可注入 `setGatewayTokenRefresher` 替身。
     验证：undef 0 + **40 套离线 0 fail**（gateway-contract 81→**85**：401→刷新→重试成功/重试带新 token/同端点原样重发/刷新失败原样上抛只打一发/匿名 401 不触发）+ build 0 + page-smoke 12/12。

  - **轮 161 · 主题换了配色不跟（故事栏 + 其他页面）（2026-10-03，用户实测点单「故事栏 UI 配色换主题不变、其他页面也没适配」，已提交 `697634b` / **已部署 Version `ae576162`** / live-check 14/14 / 线上 CSS 四主题块新变量+wash 71 处确认 ✅）**：

  - **轮 162 · 暖心墙刷新 10s 之痛 + 刷新提示重做（2026-10-03，用户实测点单「点一次刷新要 10s」+「刷新成功√的图标和动画改一下」+「尤其是手机端」，已提交 `8aa22e1` / 已部署 Version `54d13792` / live-check 14/14 / **线上复测 sample 9.6~15.8s→2.0~3.6s 全 200** / **APK `3DAD211A5C7F6157`(5.2M) 装机 Success + 冷启动 PID 12986 CRASH_HITS=0** ✅）**：
     **实测诊断（curl 线上）**：latest 2.3~**9.6s**（免费版 isolate 冷启动尖峰）、sample **9.6~15.8s 且频繁 502 upstream-unreachable**——sample 旧实现 = `count=exact`（墙表上 6s+）+ 随机 offset 页查询**两条串行上游查询**，慢查询窗口里一动就 502；顺带发现旧 sample 页面查询 `select=id` 只取 id 的暗病（网关换一批字段残缺）。轮 159 让 sample 绕开边缘缓存后每次回源，冷启动+慢计数全裸奔。
     **修（worker 侧）**：①samplePosts 重写为**随机时间锚点单查**——7 天窗口内随机取一时刻，一条走 `created_at` 索引的查询取「该时刻之前 N 条」：免计数、单查、每次锚点毫秒级随机；`select=*` 修暗病；锚点落空（窗口头部没货）兜底拉最新一批（**踩坑：空判断读 body 后又 text() → "Body has already been read"，文本只读一次复用**）；②export default 挂 `scheduled` 自 ping（`/api/posts?limit=1`）+ wrangler.jsonc `triggers.crons ["* * * * *"]`——每分钟保活 isolate 压冷启动尖峰，免费额度 1440/10 万次每天。
     **修（前端侧）**：③刷新/首屏批 50→**REFRESH_PAGE=20**（视口只露 16 张，50 条+两轮富化纯浪费；触底续载仍 50）；④刷新提示改**状态机** `""|busy|ok|batch|fail` + 新提示 UI；i18n 把 ✓ 移出文案；**手机下拉原来无条件显示「已刷新 ✓」**（失败也显示成功）——`loadCloud` 返回成败后如实提示。
     **轮 162b（用户追单「尤其是手机端，动画跟图标也很丑」）**：提示升级为**暖爪可爱版小药丸**（`--wash` 底+发丝线圆角胶囊，浮入动画）——ok=**主题色爱心弹出（过冲回弹）+ 扑通一跳**（SVG Material heart，transform-origin 60%），batch=**四角星花旋入+两次闪**（twinkle），fail=软红 ！摇摆，busy=主题色转圈；通用的「绿色圆环打勾」弃用（用户嫌丑）。手机端与桌面同一条 Worker 链路，worker 三修复装新包即受益。CSS 小坑：keyframes 收尾帧误写 `scale(1.06) scale(1)` 双函数叠加，已归位。

  - **轮 163 · 手机端横滑死区（2026-10-03，用户实测点单「故事页下方空白无法往左滑，消息页三个页面都有」，已提交 `8aa22e1` / 已部署 Version `54d13792` / **APK `3DAD211A5C7F6157` 装机 + 冷启动确认** ✅；真机横滑待用户验收）**：
     **根因**：横滑手势面 = 内容元素本身——①首页 `.home-track` 高度 = 当前联**内容高**（trackH 测的是 paneEls[idx].offsetHeight），故事联内容短 → track 下方空白在 track 外，touchstart 到不了；②私信页三段（漂流瓶/会话/通知）手势挂在 `aside.dm-list` 卡上，卡高随内容，空白同理。手指落在空白处 = 滑不动。
     **修（把空白区纳进手势面，不改手势逻辑）**：①HomeView `measure()` 改为 `trackH = max(联内容高, 视口剩余高)`——`window.innerHeight - track顶缘(getBoundingClientRect().top) - 96`（78=底部导航预留与 `.shell--mobile-nav main` 的 padding-bottom 同源 + 呼吸位）；窗口 resize 重测（挂/卸监听）。附带好处：矮联之间切换时 track 高度不再跳变。②`.shell--mobile-nav .dm-list` 加 `min-height: calc(100dvh - 106px - env(safe-area-inset-bottom,0px))`——列表卡拉满一屏（聊天打开时卡 v-show 隐藏，天然不会把聊天页滑走，零 JS 改动零回归）。桌面不受影响（规则都在 mobile shell 作用域 / measure 拿不到 refs 空转）。
     验证：undef 0 + **40 套离线 0 fail** + build 0 + page-smoke 12/12；真机横滑验收待装机。
     验证：undef 0 + **40 套离线 0 fail**（worker-test 250→**256**：sample 单查免 count/select=*/锚点条件/空池兜底/两次锚点不同/cron 挂载）+ build 0 + page-smoke 12/12；线上耗时对比待部署后复测。

  - **轮 164 · 评论框/私信框表情按钮（2026-10-03，用户截图点单「发送键左边加表情按钮，微信常用表情，评论框和消息会话框都要」，已提交 `8aa22e1` / 已部署 Version `54d13792` / **APK `3DAD211A5C7F6157` 装机 + 冷启动确认** ✅）**：
     **新组件** `src/components/EmojiPicker.vue`：笑脸 SVG 按钮（发送键左侧）+ 弹出面板（**微信常用 Unicode 表情 64 个**：常用脸/爱心/爪印/生活物，免资产零体积；🫶 这类 Unicode14 新字被排除防老 WebView 豆腐块）。面板 **position:fixed + teleport 到 body**、按按钮实时 rect 定位——绕开 overflow 裁剪与 transform 包含块（home-track 陷阱同类）两类坑；z=260 盖过评论弹窗。插入逻辑内置：picker 在**同行内**找 textarea/input 的 `selectionStart` 光标处插入（拿不到就追加），插入后焦点+光标归位；点选不收面板可连选，点外/再点按钮收起。API = `:text` + `@update:text` 直改父级草稿，五处接入一行搞定。
     **接入五处**：私信会话框（MessagesView）/ 漂流瓶聊天框（BottleChat）/ 帖子详情桌面评论框（PostDetail cmt-input-row）/ 暖心墙内联评论框（CommunityView）/ 手机评论底部输入条（CommunityView mainBar，**App 端评论就是它**）。**注意**：CommentComposer.vue 已被平行会话删除（评论输入统一为页内 mainBar 流），PostDetail 正被平行会话实时改动（本轮接入时文件从 1000+ 行缩到 767 行基线）——接入以当时盘面为准、带幂等保护。
     **i18n**：顶层新增 `emoji.title`（zh 表情 / en Emoji），zh/en 对称（i18n-test 19/19）。
     验证：undef 0 + **40 套离线 0 fail**（dm-test 308→**316**：光标插入/fixed+teleport/表情 ≥56 无重复/emoji.title/五处接入计数）+ build 0 + page-smoke 12/12 + dist 断言（EmojiPicker chunk 在包）。

  - **轮 165 · 用户三连报修（2026-10-04，截图×3：表情面板怪/暖心墙刷新炸页/故事详情还是「请先登录」，未提交未部署——等发话）**：
     **①「freshOk is not defined」炸整页（图2，轮 162 自己埋的雷）**：`let freshOk = true` 写在了 `if (fresh) {}` 块内，而函数尾 `return freshOk` 在块外 → 每次进暖心墙/点刷新都 ReferenceError → 冒泡到全局错误卡（猫猫+「这里好像有点小状况」）。**修**：声明提升到 loadCloud 函数作用域顶部。**教训**：往既有函数里加「函数尾才用」的变量时，声明必须放函数级；静态套件不执行视图代码，这类作用域雷只有跑起来才炸。
     **②故事详情「请先登录」+「这篇故事不在了」（图3）真因 = 僵尸会话**：刷新令牌已死（失效/被吊销/多端轮换竞态）时 refreshAccessToken 静默失败 → 顶栏仍显示已登录（本地会话对象还在），而**带失效 JWT 的请求连公开读都被 PostgREST 401 拒**（story_get 报 auth 错→「请先登录」、查无→「不在了」双误导）。轮 160 的 401 自愈重试后仍死（刷新令牌本身死了）。**修**：`deadSessionSignOut`——刷新失败且错误形似**死令牌**（session missing / invalid refresh / invalid grant / 401 / 403）→ 清空本地 accessToken/cloud.user 并 signOut，界面回到未登录态引导重登；**纯网络失败（Failed to fetch）不清理**，弱网误登出比多一次 401 更伤。用户需重新登录一次，此后 160+165 组合保持健康。
     **③表情面板（图1）**：手机端改为**贴底全宽微信式面板**（<640px：left/right 8px、width auto），不再按按钮位置浮在半空挡内容；表情面板开着时点面板外**只收面板**、不连带收评论底部条（mainBarDocClose 加 `.emo-panel` 在场守卫）。
     验证：undef 0 + **40 套离线 0 fail**（dm-test 316→**321**：freshOk 声明序回归断言/deadSessionSignOut 判定与清空/表情贴底/评论条守卫）+ build 0 + page-smoke 12/12。

  - **轮 167 · 登录页重设计（2026-10-04，用户点单「太丑了，不像正常 App 登录页」，三稿定调「纯白极简」，未提交未部署——等发话）**：
     **逻辑零改动**（Google/邮箱注册登录/忘记密码/重置密码/本地访客/redirect 回跳/锁定文案全保留），只重做 UI。**迭代史**：一稿米色卡+emoji 爪印被打回（丑）；二稿白卡+柔光斑被打回（「白边是什么鬼」——main 内边距漏出壳层白框）；三稿全屏渐变+毛玻璃+贴纸被打回（「我们是年轻人，不是五六十岁老年人 app」）→ **AskUserQuestion 定调** → 用户选**纯白极简**：白底+超大黑粗标题（28px/800）+居中小爪印（SVG 单色，弃 emoji）+极淡灰输入框（n-input 背景 #f6f6f5）+珊瑚色实底按钮（14px 圆角）+底部「第一次来？注册一个账号 **注册**」切换行（替代 tabs）。**同轮顺手**：①删「本地模式：数据保存在当前浏览器…」整行（用户点单）；②底部加「登录即代表同意 **用户协议与隐私政策**」链接 → /privacy（login.agreePre/agreeLink zh/en 新键）；③登录页 **tabbarSuppressed** 收掉底部 TabBar（全屏 App 形态）；④app-shell-test T51 豁免 .login-page 的「桌面铺满」旧口径（居中窄列=正式设计）。**调试基建**：浏览器 390×844 视口 + vite preview 实测（匿名态截图验收——登录页对已登录用户会自动回跳，测试前须清 localStorage）。
  - **轮 167b · 隐私政策补 App 覆盖（2026-10-04，用户追问「App 端隐私政策跟网页端不同吧」，未提交未部署——等发话）**：政策原文是纯网页口径（范围只提「本站」、本地存储只提「浏览器」）。**修**：①s1 范围节明确「本站**和暖爪安卓 App**（同一套服务的手机壳，数据只存设备和暖爪账号）」；②s7 本地存储节改「网页端=浏览器本地存储；**App 端=手机上 App 自己的私有存储**」；双语同步（i18n-test 19/19）。App 端 Google 登录走系统浏览器 CCT 的既有文案不动。
     验证：undef 0 + **40 套离线 0 fail**（app-shell 64/0、i18n 19/0、privacy 34/0）+ build 0 + page-smoke 12/12 + 浏览器匿名态截图验收。

  - **轮 172b · 表情面板改微信式贴底（2026-10-04，用户截图点单「表情要点开在下面，我们的在上面影响打字」，已提交 `ee2d050` / **已部署 Version `b1e1df56`** / live-check 14/14 / **APK `82F4178A87FB58F7`(5.2M) 装机 Success + 冷启动 PID 11211 CRASH_HITS=0** ✅；同包含轮 172 详情页炸页修复 `45eb735`）：
  - **轮 173 · 进会话落在聊天记录中间（2026-10-04，用户点单「记录多了之后点进聊天不在最底部，跑到中间还要往下拉」，未提交未部署——等发话）**：
     **诊断**：落地滚动只执行一次（nextTick 设 scrollTop=scrollHeight），但**字体/内容晚到会把已排好的消息撑高**——滚完之后内容又长高了，落点就从底部漂到中间（记录越长漂得越狠）。**修（聊天 App 标准做法「追底」）**：scrollBottom 落地后用 requestAnimationFrame 连续 20 帧重钉底部；`userScrolling` 标记（列表 touchstart/wheel 置位）——用户一开始上滑立即停追，不打扰回看历史；scrolBottom 入口清标记。MessagesView + BottleChat 同款。配合 172c：打开表情面板推输入行时内容高度变化，追底让最新消息始终钉底。
     验证：undef 0 + **40 套离线 0 fail**（dm-test 322：追帧/上滑停手/两视图接线断言）+ build 0 + page-smoke 12/12；真机待验收。
  - **轮 172c · 表情面板微信式二修（2026-10-04，用户实测 /messages/1「输入框应该还在表情上面 + 列表太长收短做下拉」，未提交未部署——等发话）**：
     172b 的贴底 sheet 用 `bottom` 锚定、面板**向上生长**，正好盖住输入栏（用户实测输入栏被吃掉）。**修**：打开面板时把所在输入行（.dm-compose/.cmt-main-bar 等最近匹配祖先）**向上推 34vh**（margin-bottom）——输入栏骑在面板头上；面板**上缘钉在行底缘、下缘贴屏幕底**（top/bottom 同时钉死，高度=行到屏幕底那一段），列表超出面板内滚动（短了不空、长了滚）；关面板/点外/卸载时清掉推行。收键盘、选完不拉键盘保持 172b 口径；桌面锚定不变。
     **轮 173b 追加（用户实测「进会话会停在中间一下再跳底部」）**：两段式落地 = 旧缓存先落底、网络回来新消息把底撑下去再跳。**修**：进会话开「钉底模式」——`pinning` 置位期间 rAF 持续重钉底部（不受 20 帧上限约束），新消息落进来视线跟着走**无停顿**；首屏数据落定收钉；**语义修正**：`userScrolling` 优先级最高——钉底期间用户上滑也立即停（此前初版钉底会盖过上滑）。
     验证：undef 0 + **40 套离线 0 fail**（dm-test 322：推行+钉位+贴底断言）+ build 0 + page-smoke 12/12；真机待装机验收。
  - **轮 173c · 新消息落下改平滑滑入（2026-10-04，用户实测 /messages/7「还是会跳」——173b 的钉底在新消息落下一帧内瞬时重钉 = 视觉上仍是跳；另用户测试页可能跑的是旧 bundle，需强刷），未提交未部署——等发话**：
     **修**：fresh 有新消息（added）时——先停钉底（pinning=false，下一帧起不再瞬时重钉）→ msgs 更新 → nextTick 里 `scrollTo({ behavior: "smooth" })` **平滑滑到新底**：微任务先于绘制，无 snap 帧；无新消息时钉底照旧无任何变化；loadMessages 返回 smoothed，调用方（openConv/onLetter）只在未平滑时才瞬时收尾滚。BottleChat 同款。
     验证：undef 0 + **40 套离线 0 fail**（dm-test 324：added 平滑/停钉时序断言）+ build 0 + page-smoke 12/12。
     **交付**：已提交 `4b27656` / **已部署 Version `dede6342`** / live-check 14/14 / **APK `5546E5BBB05D549B`(5.2M) 装机 Success + 冷启动 PID 21439 CRASH_HITS=0** ✅（同包含轮 174 聊天满幅 `ca316d1`）。


  - **轮 174 · App 聊天态满幅（2026-10-04，用户截图点单「难看，有这样设计的吗」——聊天卡内缩+左侧白边+与全屏表情 sheet 宽度错位，未提交未部署——等发话）**：
     **真因**：`.shell { padding: 0 18px }` + `.dm-thread` 的 `.card` 描边/圆角在手机聊天态原样保留 → 聊天是张内缩圆角卡（左侧露一条页面底色），而表情 sheet 是 fixed 全屏宽——一窄一宽错位散架。**修**：`.shell--mobile-nav.shell--chat` 壳与 main 横向 padding 归零；`.dm-thread` 去描边/圆角/阴影、背景改 var(--page-bg)、横向 padding 归零（头部/消息区/输入行各自内缩 12~14px）——聊天满幅，表情 sheet 同宽对齐；emoji 面板滚动条隐藏。**踩坑**：新规则先插后改，独立 dm-thread 块缺 width:100% 抢了 T20 正则的第一匹配 → 断言挂；合并进 T20 匹配的原块解决（app-shell 64/0）。
     验证：undef 0 + **40 套离线 0 fail**（app-shell 64/0）+ build 0 + page-smoke 12/12；真机待装机验收。

  - **轮 175 · 点红心整页变黑（2026-10-04，用户截图点单「点红心按钮页面就变黑，宠物页面也黑」，未提交未部署——等发话）**：
     **真因**：今日联右上角红心 = ShareCard 分享卡入口，而 ShareCard 的遮罩是 `position:fixed`，TodayPane 又渲染在带 transform 的 `.home-track` 里（首页横滑）——fixed 以轨道为定位基准：遮罩罩满整条轨道（今日+宠物两联一起黑，用户实测），卡片本体飞出屏外。与轮 151/152 领养弹窗是**同一个 transform 包含块陷阱的第三处**。**修**：TodayPane 的 ShareCard 包 `<teleport to="body">`（ShareCard 全局样式不受影响）。至此三处（PetView 弹层、SnackRain/ShareCard、TodayPane ShareCard）全部 Teleport 出轨。
     验证：浏览器 390×844 实测——点红心分享卡居中弹出、遮罩轻蒙、宠物与语录在卡上 ✓；undef 0 + **40 套离线 0 fail**（teleport 成对断言不受影响）+ build 0 + page-smoke 12/12。

     EmojiPicker 手机端（<640px）从「浮在输入框上方」改为**贴屏幕底的 sheet**：占键盘的位置、上圆角、safe-area 底垫、max-height 46vh；打开时顺手 blur 活动元素**把键盘收掉**（微信同款：面板与键盘互斥）；**选完表情不拉起键盘**（setSelectionRange 记录光标但不 focus，面板不被压住，用户点输入框才回键盘）；桌面（≥640px）保持按钮上方锚定不动。dm-test 表情断言同步（321 依旧全绿）。

  - **轮 169 · 暖心墙刷新请求合并（2026-10-04，用户追打「点刷新还是 10s，别的主流 app 很快」，未提交未部署——等发话）**：
     **10s 的真账本**：162 砍的是服务器端查询数，但刷新在网络上的**来回次数**没变——最新页→它的回应明细→随机批→它的回应→评论数 = 4~5 个串行 RTT，手机 4G 每个 RTT 1s+，加起来还是 10s。**修（合并请求，用户指南图的「请求合并」条）**：worker 新增 **`GET /api/wall/refresh?limit=N`** 合并包——Worker 内并行打上游（最新 20 + 随机锚点 20）→ 最新 4 条钉顶（新帖必现）+ 随机批去重 → 再并行拉这批帖的回应明细与评论 post_id 行 → **一个响应**回 `{posts, reactions, commentCounts}`；客户端 wall.js 新增 `cloudFetchWallRefresh`（聚合回应/rowsToPosts/计数组装），CommunityView 刷新与首屏都改走合并包——**网络来回 4~5 → 1**。双通道同形：db.gateway 一发直取；db.supabase 直连同形组合（客户端并行 4 查）。随机+含身份 → 不进边缘缓存（复用 165 sample 排除逻辑外的路径白名单缺省）。上游挂 → 502（并行两发都会出去，客户端 8s 超时兜底不变）。
     **测试**：worker-test 256→**262**（合并包 200+四上游查询/最新钉顶去重 1,2,3/回应透传+评论计数/最新页 select=* limit/上游挂 502；轮 170 部署后该断言升级为兜底两断言）；gateway-contract 85→**86**（wallRefresh 端点形状；探针被 160 块清了需重点亮——测试顺序坑）。**踩坑**：批量正则被 `=>` 坑过一次（轮 168），本轮锚点全用精确文本。
     验证：undef 0 + **40 套离线 0 fail** + build 0 + page-smoke 12/12。**预期效果**：刷新网络耗时 ≈ 1 个 RTT + 服务器 ~300ms；弱网从 10s 级降到 2s 级（待部署后真机复测）。

  - **轮 170 · 数据库层优化（2026-10-04，用户点单「索引/分页/JOIN 代替子查询/不要 select * 都做了吗」，未提交未部署——等发话）**：
     **审计结论**：已有=墙帖 keyset 分页（轮 62 id 游标走主键）、DM 聚合 RPC 免 N+1、各表大部分索引、边缘缓存、请求合并；**缺**=①`wall_reactions` **零索引**（每次刷新/详情/点回应的 post_id 查询全裸扫）②`wall_posts(user_id, created_at)` 缺（他人主页/我的帖子）③热点列表在用 `select=*` ④feed 富化是 4 查询编排而非 SQL JOIN。
     **修**：①`MIGRATION_perf_indexes.sql`：`wall_reactions(post_id)`、`wall_reactions(user_id, post_id)`、`wall_posts(user_id, created_at desc)`（全 IF NOT EXISTS）；②**`MIGRATION_wall_feed_page.sql`：`wall_feed_page(p_limit)` RPC**——一条 SQL 出整个刷新合并包：CTE（最新页 id 倒序 + 7 天池 random() 抽样排除重复）+ 回应按 kind 的 **GROUP BY 聚合 JOIN**（含 `filter (where user_id=auth.uid())` 的 mine）+ 评论计数 JOIN，返回 `{latest, random, react, comment}`；security definer 只读固定 removed=false，匿名 auth.uid() 空 → mine 空；③worker `wallRefresh` 从 4 查询编排改 **RPC 单查透传**（编排挪进数据库）；④热路径去 `select *`：worker listPosts/samplePosts、db.supabase listPosts 改显式列（id,user_id,author_name,body,image_path,created_at,views,dislikes,removed = rowsToPosts 消费字段全覆盖）；⑤SUPABASE_SETUP.sql 尾部同步轮 170 段。**用户需在 Supabase SQL Editor 跑两个迁移文件**（索引幂等可重复跑；RPC create or replace）。
     **测试**：worker-test 262→261（wall/refresh 块按 RPC 透传重写：单上游 POST rpc/wall_feed_page+p_limit 透传/jsonb 原样回/上游挂 502；4 处 listPosts URL 断言与 sample select 断言换显式列）；api-contract 85→**87**（listPosts 形状与 removed 退回两断言换显式列口径）。**踩坑**：python 串里写 `+ COLS +` 拼接想在 JS 里求值——落盘成字面量，断言必挂；改用解析后的列名直接写。
     验证：undef 0 + **40 套离线 0 fail**（worker-test 261、gateway-contract 86、api-contract 87、i18n 19、privacy 34）+ build 0 + page-smoke 12/12。**部署项**：本次 Worker 部署 + **两个 SQL 迁移要用户在 Supabase 面板执行**（不执行时 /wall/refresh 会 404 函数 → 客户端退回旧两段式兜底）。
     **部署后实测（同日）**：合并包接口在迁移未跑时 400（函数不存在）→ worker `wallRefresh` 立即加**兜底**：RPC 非 200 自动退回旧四查询编排并打包成**同形响应**（latest/random 数组 + react 聚合——mine 用 JWT payload 的 uid（不验签，仅展示标记，安全由 RLS 管）+ commentCounts），迁移前后都能用；worker-test 补「RPC 挂→旧编排兜底同形成功」「上游全挂→502」两断言（262 不变）。**线上复测**：/api/wall/refresh **200、1.2~1.26s ×3**（迁移未跑、走兜底编排已把 10s 级打下来）；用户跑完两个 SQL 后 RPC 单查询更快。
     **交付**：已提交 `49cf928`（166~170 主批 23 文件 +652/−154）+ `4ac8882`（兜底续）；**已部署 Version `24f04ecb`** / live-check 14/14 / 合并包线上 1.2~1.26s；**APK `F5CCFA17F53FAC9E`(5.2M) 装机 Success + 冷启动 PID 26066 CRASH_HITS=0** ✅。

  - **轮 171 · App 端今日/宠物联去网页卡片感（2026-10-04，用户点单「太像网页端了，不适合 app 端」，未提交未部署——等发话）**：
     **诊断（浏览器 390×844 截图）**：两联全是 `.card` 白框堆叠（框套框、细边框、小字）——典型的网页文档感。**修（纯 CSS 重构，逻辑零改动，桌面零影响——`.home3` 只在手机形态渲染）**：①今日联去卡框：问候/状态/心情三段透明化分区靠留白，问候语 25px/800；状态四卡改 wash 色块 20px 圆角（选中 accent-soft+inset 描边）、图标 29px、名称 700；心情脸 34→44px、文案 600；语录/故事改 accent-soft 色块 22px 圆角；②宠物联（嵌入 home3 + 独立 /pet 窄屏路由同口径 `@media <900px`）：主卡（舞台+动作+状态）`:has(.pet-stage)` 去框全宽，动作按钮 wash 色块 18px 圆角加粗、图标 23px，状态条加粗。**踩坑**：165 的锚点替换把 162b 的 CSS 注释嵌套重复了一次（`/*A/*B*/`），CSS 容忍但难看——清理。
     验证：浏览器 390×844 截图验收（今日联无框分区/宠物联舞台全宽）+ undef 0 + **40 套离线 0 fail** + build 0 + page-smoke 12/12。

  - **轮 172 · 帖子详情页炸页「p is not defined」（2026-10-04，用户截图点单；已提交 `45eb735` / **已部署 Version `b1e1df56`** / live-check 14/14 / 线上 /post/680 匿名实测渲染正常 / **APK `82F4178A87FB58F7` 装机 + 冷启动确认** ✅）**：
     **真因**：轮 158 把 load() 取数改 SWR 时，删了 `const p = await cloudFetchPost(...)` 但函数尾部的浏览计数还留着 `if (p.dbId)` → 每次进 /post/:id 都 ReferenceError → 冒泡到全局错误卡（与轮 165 freshOk 同类：**改写函数后遗留旧引用**，静态套件不执行视图代码所以测不出）。**修**：`p.dbId/p.dbId` → `post.value.dbId`（react 计数从 post.value 取）。**运行时验证**（此前两雷只做静态，这次升级）：本地 preview + 匿名真开 /post/680——帖子/回应/浏览数/评论框全渲染、无错误卡 ✓。**教训沉淀**：本轮起凡动过函数体的视图，验证必须包含至少一次真实路由运行时冒烟。

  - **轮 168 · 表情按钮嵌进输入框（2026-10-04，用户截图点单「像我这个截图一样，把表情包按钮放进输入框里面」——微信式，未提交未部署——等发话）**：
     **结构**：9 处接入点的「n-input 自闭合 + EmojiPicker」统一包进 `.emo-in` 相对定位壳——表情按钮（.emo-root）绝对定位叠在输入框右缘内侧（right 8px、垂直居中、28px），textarea/input 加 padding-right:44px 让文本避让；发送键留在外面。naive 的 textarea 不支持 suffix 槽，只能叠放。**踩坑**：批量正则被 EmojiPicker 属性里的箭头函数 `=>` 坑了（`[^>]` 过不了 `>`），改 `.+?` 钉住 `" />"` 结尾后 9 处全中（私信 1/瓶聊 1/暖心墙 4/帖子详情 3）。picker 的光标插入逻辑不变（.emo-in 内查 textarea）。
     验证：undef 0 + **40 套离线 0 fail** + build 0；真机观感待装机验收。

  - **轮 166 · 用户三连追修（2026-10-04，①网页端一/二级回复框没表情按钮 ②手机端输入行按钮挤占输入框 ③首页故事联下方空白仍不能横滑，未提交未部署——等发话）**：
     **①回复框表情补齐 4 处**：暖心墙一级回复框（repPlaceholder(p,cm)）/二级就地回复框（(p,cm,rp)）/帖子详情一级回复框（(cm)）/二级就地回复框（(cm,rp)）——至此评论域 7 处输入位 + 私信/瓶聊 2 处 = 9 处全有表情按钮。**②输入行挤压**：`.cmt-main-bar/.dm-input-row .n-input { flex:1 1 auto; min-width:0 }` + `.emo-root { flex:none; align-self:center }` + 手机端表情按钮 34→30px——输入框弹性占满、按钮收紧靠右。**③横滑死区真因（浏览器 390×844 实测复现）**：163 的 track 拉伸没用对地方——track 是普通块盒（宽 354=视口减边距），4 个联（flex:0 0 100%）**横向溢出 track 盒**，靠 transform 滑动；track 自身盒子 transform 后**在屏外**，命中测试永远落不到它，空白区命中 home3；而 `align-items: flex-start` 让联盒只有内容高（395px），联盒以下的空白谁都不盖 → 手势面死区。**修**：`align-items: flex-start→stretch`（联盒跟随 track 拉伸到 673px，空白进联盒→冒泡到 track 手势）+ measure() 改量联的**第一层内容子元素**（stretch 后 pane.offsetHeight=拉伸高会自锁）。**浏览器实测**：空白点命中链 home-pane→home-track ✓，空白区右滑 故事→漂流瓶 ✓、左滑 漂流瓶→故事 ✓（修正前命中链里根本没有 home-track）。
     验证：undef 0 + **40 套离线 0 fail** + build 0 + page-smoke 12/12 + 浏览器 390×844 视口合成触摸双向实测通过。

  - **轮 166b · 「去打卡后今日页下面那么长的空白」（2026-10-04，用户截图追修，未提交未部署——等发话）**：
     **真因**：轮 166 的 stretch 方案有副作用——联盒被拉到一屏高，联内卡片区域跟着拉出长条空白（用户在宠物联点「去打卡」切到今日联，内容短，拉伸的空白特别显眼）。**修（方案换骨架）**：①`.home-track` 回 `align-items: flex-start`，联恢复内容高（视觉与轮 163 之前完全一致）；②手势面**上移到 `.home3`**（它不做 transform、本来就全屏命中、背景透明）+ `.home3` 加 `min-height: calc(100dvh - 96px - safe-area)` 拉满一屏——内容以下的空白是透明的 home3，看着就是页面底，滑它却能切联；③measure() 恢复纯内容高（删 avail/stretch 补丁），resize 监听一并撤。
     验证：浏览器 390×844 实测——空白点命中 home3 ✓、空白区右滑 故事→漂流瓶 ✓、左滑 漂流瓶→故事 ✓、track 恢复内容高 ✓；undef 0 + **40 套离线 0 fail** + build 0 + page-smoke 12/12。

     **根因（双层）**：①轮 120 换 Claude 设计体系时 `:root` 新增了 `--card/--hairline/--lilac/--sky` 新变量组、body/html 底色写死 `#faf9f5`，但**五个 data-theme 块只覆盖旧变量组**（--ink/--accent/--glass/--shadow）——切樱花/薄荷/薰衣草/夜色时主卡面（.card=var(--card)）和发丝线永远停在奶油体系；②全站 67 处卡片/输入框用写死的 `rgba(255,255,255,.x)` 白水洗底（故事栏 st-card/st-search 重灾区）——夜色下还是白底刺眼。
     **修**：①`:root` 新增主题感知组 `--page-bg`（html/body 兜底底色改 var）+ 白水洗三档 `--wash(.5)/--wash-mid(.72)/--wash-strong(.9)`；②四主题块补全：sakura(--card #fdeef4/--hairline #f0d9e3/--page-bg #fdf1f6)、mint(#ebf6ef/#d4e7da/#eefaf4)、lavender(#f2eef9/#e0d8ec/#f5f1fc)、**night(#262c52/发丝线 rgba 蓝 .25/#171a33 + 三档水洗换暗蓝 rgba(139,156,232,.12/.17/.24))**；③style.css 67 处 `background: rgba(255,255,255,.x)` 按透明度三档换 var(--wash*)（≤.55→wash、≤.78→wash-mid、其余→wash-strong；夜主题专属覆盖行/主题定义行/图片白描边/危险红/精选金不碰）+ 2 条白色渐变改 var；④BottleRecords 暖橘水洗标签改 --hairline+--wash；⑤夜色下故事流骨架屏换暗蓝 shimmer。
     **踩坑**：替换脚本的透明度桶函数把「.45」捕获成「45」当整数比较 → 全判 wash-strong；`git checkout -- src/style.css` 回滚重跑修正（捕获组拼回小数再比）。
     验证：undef 0 + **40 套离线 0 fail**（bottle-test 玻璃卡断言升级到 var(--wash) token，76/0）+ build 0 + page-smoke 12/12 + dist 断言（四主题块 card/hairline/page-bg 全在、wash 用法 71 处、残余白水洗仅夜主题专属覆盖）。
  - **轮 158 · App 端全站加载优化（2026-10-03，用户再发 App 加载优化指南图点单「其他很多内容加载也很慢」，已提交 `4f232b2` / 已部署 Version `92f20d3f` / live-check 14/14 / **APK `3AF8916621ED769C`(5.2M) 装机 Success + 冷启动确认 PID 19616 CRASH_HITS=0** ✅）**：
     **盘点**（grep 全视图 SWR 覆盖面）：已有 SWR=暖心墙/通知/我的帖子/资料页/私信；**没有**=故事流（每次进联干等网络重拉首屏）、帖子详情（cloudFetchPost 每次裸拉）、他人主页（三路 RPC 排队）；启动只预热数据不预热路由 chunk（首次切联/切 tab 现下载）。
     **修**（按指南「本地缓存/骨架屏/预加载」三条）：①**StoryFeed** 首屏 SWR（`story:feed:latest`，公共内容不带用户域；翻页照旧拼尾；发布后父级调 load()=缓存先出新内容 fresh 纠正）+ 精选卡 SWR（`story:featured`）+ **骨架屏**（首访无缓存时三张 shimmer 卡，样式进 style.css 与 .st-hint 同源）；②**PostDetailView** 帖子主体 SWR（`wall:post:<uid>`——从墙/我的/主页点进来本地先出上次内容立刻能读；操作后 refetch 回写缓存；null=查无此帖保原 failed 口径）；③**WallerView** 资料+帖子+宠物家园三路聚合整体 SWR（`waller:home:<uid>`，二次进页零等待；两路全 null 仍走 failed）；④**App.vue** 首绘后 `requestIdleCallback`（4s 兜底）预热 6 个高频路由 chunk（社区/私信/我的/帖子详情/宠物/故事流）——切联/切 tab 不再现等 chunk 下载，不抢首屏带宽。
     **避让**：PetView/StoryRankView/StoryMineView/TodayPane 是平行会话未提交脏文件，本轮未动（它们的加载优化归并行会话）；漂流瓶托盘按轮 37 口径**故意不本地缓存**（手里的信必须以服务器为准），未改。
     验证：undef 0 + **40 套离线 0 fail** + build 0 + page-smoke 12/12 + dist bundle 断言（story:feed:latest/story:featured/wall:post/waller:home/requestIdleCallback 全部在包）。
  - **轮 156 · 英文四联文案瘦身（2026-10-02，用户实测 EN 满屏文字太丑，已提交 `57038b3` / 已部署 Version `5a42f22c` / live-check 复跑 14/14（首轮 1 项 fetch failed=本机网络抖动） / **APK `F5DB1A8E505C77AD` 装机 + 冷启动确认** ✅）**：
     只动 **en 值**（zh 不变）七处：heroSub 8→4 词、mood.subtitle 8→3、bottle.sub 20→6、**bottle.rules 33→7**（规则细节收进 placeholder/title，行内只留 {w}/{f} 两数）、story.feedSub 11→6、pet.tip 12→6、pet.subtitle 15→8。目检方式：i18n 临时强制 en → 四联逐屏截图 → 还原（探针切语言会被 headless 丢存储，改码最可靠）。
     验证：i18n **19/19**（键对称不动，只改值）+ 37 套 0 fail + build 0 + page-smoke 12/12 + EN 四联截图目检 + APK 装机冷启动。

  - **轮 157 · 聊天页加载/卡顿优化（2026-10-03，用户发聊天性能指南四图点单：「尤其是聊天页面」，已提交 `4f232b2` / 已部署 Version `92f20d3f` / live-check 14/14 / **APK `3AF8916621ED769C`(5.2M) 装机 Success + 冷启动确认 PID 19616 CRASH_HITS=0** ✅）**：
     **诊断（读码实证）**：①轮询每 5s 双请求——会话列表全量 200 行 + 消息尾 30 条，弱网下后台 chatter 跟用户操作抢带宽；②发送成功后 `loadMessages` 整段重载 30 条才把「发送中」转正——多一次往返；③「加载更早」prepend 后不补 scrollTop——内容凭空跳一页（指南第 3 条锚点缺失）；④轮询整段替换 `msgs=asc`——翻过的历史被冲掉（隐藏 bug）；⑤触顶只有手动按钮；⑥消息行无渲染减负。
     **修**（按指南落地）：①`mergeTail` 纯函数（dmRules）做尾部增量合并——已见行原位更新（撤回状态也能刷）、新行插到乐观临时消息之前、无变化同引用不重渲染；轮询消息尾 30→20 条、消息优先，会话列表降到每 3 拍（约 15s）一次、回前台当拍必刷、`tickBusy` 防弱网叠请求（双通道 RPC 形状已核对：dm_send 两条通道都回 `{msg_id, created_at}`）。②发送后就地落位：乐观行按 msg_id 直换正式行 + 首屏 SWR 缓存同步补条，异常网关无 msg_id 才回退整段重载。③锚点保持：prepend 前量 scrollHeight、下一帧 `scrollTop += 新旧差值`、临时关平滑滚动（BottleChat 同款）。④触顶 140px 自动翻历史：`@scroll.passive` + rAF 节流，「加载更早」按钮保留做可见 loading 兜底。⑤CSS：`.dm-line/.dm-day` `content-visibility:auto + contain-intrinsic-size`（离屏消息跳过布局/绘制）、`.dm-scroll` `overscroll-behavior:contain`。⑥openConv 从列表进入时不再单拉 conv_meta（列表行已带昵称/免打扰/拉黑/请求态），深链才拉——每次开聊天少一次 RPC。
     **改动面**：src/utils/dmRules.js（+mergeTail 纯函数）/ src/views/MessagesView.vue / src/components/BottleChat.vue（同款四件套）/ src/style.css（两条渲染规则）；i18n 零新键；双数据通道零改动（RPC 形状未动）。
     验证：undef 0 + **40 套离线 0 fail**（dm-test 286→**299**：mergeTail 六条逻辑断言 + 两视图「四件套」接线静态断言）+ build 0 + page-smoke 12/12。

     **轮 157b 追补（用户追问「聊天消息本地缓存、下次打开优先本地加载历史，没做吗」）**：首屏 SWR 本来就有（`dm:msgs` 键、最近 30 条本地直出），真缺的是两处——①**翻过的历史页不进缓存**，重进只剩 30 条；②全局缓存护栏 `CACHE_MAX_ENTRIES=60`，会话一多聊天快照被别的域挤出。**修**：dmRules 新增窗口缓存三助手（`dmMsgsKey`/`dmWin`/`dmCacheWindow`+`dmPeekWindow`，快照形状 `{rows 新→旧, more}`，旧纯数组快照兼容读、垃圾入参 null）；`loadMessages` 窗口化——首屏 fetcher 返回窗口包装让 swr 整窗落缓存，翻历史页 fresh 时并入缓存窗口（更旧页拼前面、本页拉不满 30 = more:false 落定），重开同会话 fresh 走 mergeTail 尾部并入保住窗口；乐观消息（负 id）在场时 fresh 不动视图；`msgsConv` 跟踪防跨会话误合并（切会话/回列表/换信都重置）；发送补条改走窗口助手；BottleChat 接入**同一个键**（手机聊过的桌面瓶聊秒开同一份）；`CACHE_MAX_ENTRIES` 60→120。dm-test 299→**308**（窗口兼容/读写闭环/超窗护栏/用户域隔离 + 接线断言更新）。

  - **轮 155 · 心情日历表情与打卡统一（2026-10-02，用户实测「日历里的心情跟改版后的表情不一样」，已提交 `7069945` / 已部署 Version `8bb00201` / live-check 14/14 / **APK `12BB9D43383F0C3E` 装机 + 冷启动确认** ✅）**：
     **真因**：轮 150 打卡按钮换 MoodFace 手绘脸后，我的页**心情日历还在用旧系统 emoji 数组**（MOOD[🤩🙂😌🌧️😔] 按 legacyIndex 取）——两套表情并存。**修**：日历格子改用 MoodFace 组件渲染；`MOOD_KIND = [happy, steady, calm, low, tired]` 按 legacyIndex 映射（与 home.mood.faceOrder 同源：0=happy 1=steady 2=calm 3=low 4=tired）；旧 emoji 字段保留（loggedDays/brightDays 判断用）；格子内 MoodFace 20px 适配。探针 seed+reload 验证方式挂死（reload 杀评估上下文）已放弃——signed-in 渲染待用户真机验收（结构改动确定性高）。
     验证：undef/tdz **0** + 37 套离线 **0 fail** + build 0 + page-smoke 12/12 + live-check 14/14 + APK 装机冷启动。

  - **轮 155b · 心情日历「实心黑点」修复（2026-10-03，用户截图「没改好啊」，已提交 `4f232b2` / 已部署 Version `92f20d3f` / live-check 14/14 / **APK `3AF8916621ED769C`(5.2M) 装机 Success + 冷启动确认 PID 19616 CRASH_HITS=0** ✅）**：
     **真因**：轮 155 只把日历格子换成 MoodFace 组件，但脸部件的描边样式（`.mf-ring/.mf-eye/.mf-mouth` 的 `fill:none + stroke`）全锁在 `.mood-face` 父类选择器下——那是轮 150 **打卡按钮**的容器类。日历格子直接渲染组件、没有该父类 → SVG path 落回浏览器默认**黑填充** = 每格一颗实心黑点。打卡按钮有 `.mood-face` 壳所以一直正常，两处同组件不同命。
     **修**：单源化——脸部件固有样式（fill/stroke/尺寸 34px 默认）搬进 **MoodFace.vue 自身 `<style>`**（独立 `.mood-svg .mf-*` 选择器，任何父级下都成立）；style.css 只留交互态（`.mood-face { --mf-ink }` 变量、`.is-on` 换强调色 + 放大）。日历 20px 适配靠 `.mood-cell .mood-svg`（特异性 0,2,0 > 组件 0,1,0）仍然赢。
     **教训**：组件固有外观必须随组件文件走——挂在「某个使用方的容器类」下的样式，第二个使用方一来就炸（轮 133 单源经验再次应验）。
     **提交注意**：`src/components/MoodFace.vue` 自轮 150 平行会话创建起**一直是未入库状态**，而轮 155 已提交的 ProfileView 引用它——本次必须随轮 155b 一起入库，否则全新 clone / CI 构建直接挂。style.css 本次只有这 7 行裁剪（其余脏文件属平行会话，不碰）。
     验证：dist CSS 断言（独立 `.mood-svg .mf-ring{fill:none` =1、旧 `.mood-face .mf-ring` =0）+ undef 0 + **40 套离线 0 fail** + build 0 + page-smoke 12/12。

  - **轮 136 · 故事栏按钮对去重（2026-10-01，已提交 `26ffa8f` / 已部署 Version `8b490429` / live-check 复跑 14/14 ✅；**APK `4BFF248D660F30E9` 装机 Success + 冷启动确认**——包内含轮 128-136 全部（收藏夹/猜拳/换肤字体/故事栏去重），历史包 E88AB4044FFB6924 作废）**：
     **双份机制**：轮 148 给故事栏页头加了一对（StoryView story-acts），轮 149 又给联内补了一对（StoryFeed st-feed-nav）——两轮叠加 = 同屏两对。**修**：页头对限定桌面（!isMobileNav）、联内对限定手机（isMobileNav）——手机 /story 与桌面 /story 各只一对（探针双端实测）。story-test 160/160（平行会话套件与本次改动兼容）。
     注意：本轮只动 StoryView/StoryFeed 两文件——工作区另有平行会话进行中的未提交改动（轮 150：storyBack/Story 两视图/TodayPane/style.css/测试），未触碰未提交。

  - **轮 135 · 入口改版修正（2026-10-01，用户指正「私信还在左边，通知移右上角」，已提交 `3761722` / 已部署 Version `fd1eecd4` / live-check 14/14 ✅）**：
     SideNav：**私信 ✉️ 回归**（带 dm+requests 红点）、通知移出；welcome 横幅右上圆钮：✉️私信 → **🔔通知**（badge.notif 红点）。漂流瓶 🌊/头像圆钮/金币胶囊不变。最终排布：**左导航 = 今天/宠物/暖心墙/漂流瓶/私信(+设置)；右上角 = 金币/通知/我的头像**。37 套 0 fail + 探针实测四项就位 + live-check 14/14。

  - **轮 134 · 漂流瓶独立页 + 右上角私信/我的入口（2026-10-01，已提交 `376bf41`+`68eb5ba` / 已部署 Version `dde0206c` / live-check 复跑 14/14 + bundle 一致 / **/bottle 与 /zh/bottle 线上 200** ✅；APK 需重打。**补课一次**：首部署 /bottle 404——新路由没进 vite.config seoRoutes 预渲染清单（wrangler 404-page 架构下无预渲染文件的路径=真 404），补 en+zh 两条预渲染（20 页）重部署解决——**以后每加一个前端路由都必须同步 seoRoutes**）**：
     用户发话「漂流瓶单开一个页面放左边按钮；我的页面跟私信按钮放右上角」（对照参考图 1 右上角圆钮组）。**落地**：① 新路由 `/bottle` + `BottlePageView.vue`（复用 BottleView 全量；记录里已建立会话的信 → 跳 /messages/:id；未登录显示 bottle.needSignIn 引导卡）② SideNav 加 **🌊 漂流瓶**（暖心墙之后），**移除私信/我的两项**（挪右上角）③ welcome 横幅右侧改三件套：💰金币 + **✉️私信圆钮（红点徽标）** + **头像圆钮（我的，取 displayName 首字）**（wb-round 42px 圆钮组，hover 抬升/按压缩放）④ MessagesView 桌面列表移除 BottleRecords（手机端漂流瓶段不动）；i18n nav.bottle + bottle.needSignIn zh/en 成对。
     验证：undef/tdz **0** + 37 套离线 **0 fail**（i18n 19/19）+ build 0 + page-smoke 9/9 + 1440px 截图目检（左导航六项含 🌊、右上角三件套、guest 访问 /bottle 显示引导卡）。

  - **轮 133 · 桌面改版两处视觉翻车修复（2026-10-01，用户截图打回轮 132，已提交 `5bb63ea` / 已部署 Version `8638b9af` / live-check 14/14 ✅）**：
     ① **内容 780 窄带居中 → 大空洞 + 会话三栏被压扁**：轮 132 只加了 SideNav 位移，没动 `.shell` 的 max-width 780——新布局里内容仍是一条窄带居中（左侧大空洞），会话三栏 276+232+间距挤进 780 后聊天列只剩 230px。**修**：桌面壳改**流式**——铺满 SideNav(92) 与右栏(240) 之间、超宽屏（≥1600）封顶 1440 居中；dm-wrap 三栏加宽 300/1fr/264。② **右栏位置不动**：rail 布局规则**双源漂移**——SideRails 组件 `<style>` 内有原始拷贝（注入晚于 style.css、同权重压制），style.css 里的新规则被压死（探针 rail 位置=旧 50%-622 口径实锤）。**修**：组件 `<style>` 内改权威份（fixed right:16px 上下贴边、断点 1280→1100），style.css 去重删拷贝（单源化）。
     验证：探针实测 rail [1212,1424]、内容右缘 1200、**零重叠**、双卡渲染 ✓ + 38 套离线 0 fail + build 0 + page-smoke 9/9 + live-check 14/14。
     **教训（新增踩坑候选）**：① 布局改版先改「内容宽度策略」再改导航——旧内容宽度不撤，新导航就是摆设；② 组件 `<style>` 与全局 style.css 的同名规则是双源——改样式先 grep 组件内 `<style>` 块（SideRails/ShareCard 等都有自带块）。

  - **轮 132 · 桌面布局改版（参考图 1）+ 会话三栏（参考图 2）（2026-10-01，已提交 `fcd874c` / 已部署 Version `92dd2bab` / live-check 复跑 14/14 + bundle 本地=线上（首轮 2 项 fetch failed 为本机网络抖动，curl 交叉验证全 200）✅；**备份分支/标签常驻可回退**；App 端不受影响无需重打）**：
     用户发话「整体布局换参考图 1、会话换参考图 2（Auroraqua-UI），UI 与动画不变，App 端不变，先备份」。**备份先行**：branch `backup/pre-layout-redesign` + tag `rollback-before-132`（当前 HEAD e6a42c8）。
     **桌面壳（参考图 1，≥900px）**：① 新组件 `SideNav.vue`——左图标导航（64px 固定贴左：🐾logo + 今天/宠物/暖心墙/我的/消息(红点)/通知(红点) + 底部设置；激活=珊瑚胶囊；44px 热区；按压缩放）② 顶栏桌面隐藏（移动端不动：品牌/导航/金币/信封全保留）③ **welcome 横幅**（参考图 1 顶部）：welcomeBack 小字 + 衬线大名 + 金币胶囊（i18n welcomeBack zh/en；displayName=云昵称>本地昵称>访客；补 getItem 导入）④ **SideRails 收拢右缘一列**：伙伴角+治愈角两卡竖排（原按中线定位会在 1280 溢出 8px——SideNav 吃掉左侧 92px 后右余量只剩 204<212），fixed right:16px 上下贴边、内部滚动隐藏滚动条，显示断点 1280→1100。
     **会话三栏（参考图 2，≥900px 登录后）**：`.dm-wrap` 276px|1fr|232px 三列：① 列表列=搜索+请求段+会话行+漂流瓶记录+**底部当前用户**（头像+名字+在线绿点——自己在线是事实，不违反诚实原则）② 聊天列=头部（对方头像+名字+静音/请求标签）+**气泡重排**（对方=左侧 30px 头像+奶油气泡+时间下置；我的=右对齐**珊瑚实底白字**+时间下置+召回钮同行；圆角定向 16/16/16/4）③ 右资料卡=大头像+名字+去TA主页+静音/拉黑（从聊天头部收纳于此，sticky）。dm-head 标题卡与 dm-back 链接桌面移除（SideNav 已覆盖导航）。
     **移动端零改动**（全部改动 !isMobileNav 门禁；dm-seg/返回/backToList 原样）。
     **事故一次**：i18n 键挂错组（home.welcomeBack→顶级 welcomeBack）+ App.vue 漏 import getItem——undef/i18n-test 抓到即修。会话模板重构锚点全部逐字核对后替换（轮 125 教训生效）。
     验证：undef/tdz **0** + **37 套离线 0 fail**（i18n 19/19）+ build 0 + page-smoke 9/9 + 1440px 截图目检（桌面壳三段成形/移动端消息页未动/guest 登录引导正确）。
     **待用户验收（部署后）**：桌面整体观感、会话三栏登录态气泡手感；不满意 = `git reset --hard rollback-before-132` 一键回退。

  - **轮 131 · 石头剪刀布 vs 宠物（清单 #20，2026-10-01，已提交 `8dd6d73` / 已部署 Version `7533b69d` ✅；**live-check 本机网络抖动**（三次试跑每次挂 1~3 项全是 ERR fetch failed、条目各不相同）→ 改用 **curl 全页实测 6 条路由全 200 + bundle 本地=线上（index-D2-IzbOu.js）** 判定部署成功；**APK 需重打**）**：
     用户点名清单 #20。**新组件 `RpsGame.vue`** 挂宠物页「照顾」标签（pet-actions 之后）：三枚大按钮 ✊✌️✋，宠物按**性格加权出拳**（rpsRules.PET_MOVE_WEIGHTS：高冷爱出石头 55%、元气好斗、温柔手下留情、粘人随和——键对齐 pets.js）；赢 +2 / 平 +1 金币（与「陪它玩」同档经济）、**每日前 10 局有彩头**（localStorage 按天计数，超限可玩但无奖励）；玩一局计入「陪它玩一次」任务（markTask 导出给组件，同一本任务账）；宠物用 say() 台词回应胜负平。
     动效：出拳换手用 **icon-swap 配方**（缩放+模糊+微旋转浮现），结果牌 win/lose/draw 语义色，金币 +N 过冲弹跳；reduced-motion 关闭。**纯前端零数据库**——未登录也可玩。
     新增：`src/utils/rpsRules.js` / `tools/rps-test.mjs`（14 项：出拳合法性/权重分布（高冷石头>45%、温柔偏布）/九宫格裁定/金币档/上限边界/rng 注入复现）。**事故一次**：rps-test 首跑缺 import 崩溃 → `&&` 链短路跳过了 petStore 导出编辑 → 构建报 markTask 未导出——拆开跑编辑与测试，勿用 && 串联有失败可能的步骤。
     验证：undef/tdz **0** + **38 套离线 0 fail**（worker-test 断言同步轮 129 新列名后 234/234）+ build 0 + page-smoke 9/9 + 探针实测（RPS 卡渲染、点击出拳、双方亮牌、计数 1/10）。

  - **轮 130 · 对方主页按钮横排（2026-10-01，已提交 `3173b50` / 已部署 Version `bf97df59` / live-check 14/14 ✅；**APK `6FFA8C46DF02C2FF` 已重打待装机**——手机 USB 断开）**：
     用户截图反馈「进入对方空间，发私信/拉黑两个按钮位置不对，太丑」——`.waller-dm` 原是 column 竖排挤在头像右侧窄列。修：column→row + gap 8px + wrap；dmMsg/blockedTip 提示语 width:100% 换行到按钮下方。待装机验收。

  - **轮 129 · 收藏夹两修 + 入口改版（2026-10-01，SQL 已由用户执行，已提交 `aeac7e1` / 已部署 Version `813fe946` / live-check 14/14 ✅；APK 需重打）**：
     用户执行迁移后实测两问题：① **「点击收藏之后，我的收藏里面出不来」**——线上探针实锤 `GET /api/fav` → 400 `column wall_posts_1.name does not exist`：embed 列名是我按前端映射名错猜的（真实列 = author_name/body/image_path，name/text/img 是 rowsToPosts 的输出名）。修：worker + db.supabase 的 embed 列对齐真实列；wall.js cloudFavListMine 行映射成 UI 形状（dbId/name/text/img(publicUrl)/ts/views）。② 「收藏入口放退出登录左边，去掉原来云端已登录的按钮，收藏卡不要放底部」：ProfileView 头部 actions 去 ☁️登录 n-tag，加「我的收藏」开关按钮（quaternary，退出登录左边）；收藏卡从页面底部挪到头部下方，`v-if="cloudSigned && showFavs"` 按按钮显隐。
     探针复核：匿名 GET /api/fav → 401（anon 权限按迁移设计；列解析已过=embed 列名正确），登录路径待用户验收。
     验证：undef/tdz **0** + 37 套离线 **0 fail** + build 0 + page-smoke 9/9。
     **教训**：① PostgREST embed 列名必须查 SUPABASE_SETUP.sql 的真实建表列，不能拿前端视图字段名反推；② 批量 sed/python 剪切模板段前，先 grep 锚文本与相对位置（本轮「改昵称」注释在收藏块之前，插入断言写反导致两次失败）。

  - **轮 128 · 帖子收藏夹 #13（2026-10-01，已提交 `600ec1d` / 已部署 Version `0ab12fd2` / live-check 14/14 ✅；**SQL 待用户执行**——未执行前收藏操作优雅降级提示失败，页面不炸；APK 需重打）**：
     用户点名清单 #13「帖子收藏夹」。**四层**：① DB：`MIGRATION_wall_favorites.sql`（wall_favorites 表：user_id **default auth.uid() 盖章**——客户端只传 post_id；unique(user_id,post_id) 幂等；RLS 私有 select/insert/delete 三策略；anon revoke；SETUP 同步）② Worker：`/api/fav` 四路由（GET 列表含 wall_posts 内嵌白名单列 / POST 收藏 / DELETE 取消 / GET check 批量查）——**事故一次**：fav POST 先 readJson 校验再调 insertSingle（内部又读一次 body）→ "Body already been read" → readJson 插桩定位 → 改内联插入一次读取；worker-test 224→**234**（新增 9 项 fav 断言）③ 数据层：db 双模式 `wallFavListMine/Check/Add/Remove`（直连 unique 冲突 23505 幂等；网关 check 回 {ids} 与直连数组在 wall.js 归一）+ wall.js `cloudFavListMine/Ids/Add/Remove` 包装（未登录/失败降级 null/[]/false）④ UI：暖心墙+详情页 ⋯ 菜单加「收藏/取消收藏」（未登录引导登录；快照进 moreTarget）；个人页新增**我的收藏**卡（最近 20 条，点卡进详情，就地取消；被下架帖不展示）；i18n fav 组 zh/en 成对 9 键（i18n-test 抓到误写 wall.fav* → 已归位 fav.*）。
     债务：gateway/api-contract 对 fav 4 方法的断言待补（worker-test 已钉 Worker 侧形状）。
     验证：undef/tdz **0** + 37 套离线 **0 fail**（worker 234/i18n 19/19）+ build 0 + page-smoke 9/9 + live-check 14/14。
     **待办**：① ~~SQL 执行~~（✅ 用户已执行，匿名 401=按设计私有；登录路径待用户验收收藏列表）② APK 重打（收藏进 App）③ gateway/api-contract fav 断言补齐。

  - **轮 127 · 修复从其它页进暖心墙评论数丢失（2026-09-29，已提交 `e1d65db` / 已部署 Version `5654f75a` / live-check 14/14 / **APK `E88AB4044FFB6924` 装机 + 冷启动确认** ✅）**：
     用户实测「从其他页面进入暖心墙，评论的数量会丢失」。**真因**：轮 95 的离场存档 `savedFeedPos` 存了帖子/游标/高度表但**漏了评论数表 `cloudCmtTotal`**；返回时 `restoreFeed()` 原样恢复列表、又刻意不重拉数据（防位置漂移）→ 新组件实例里 `cloudCmtTotal = {}` → 全部帖子「0 条评论」。**修**：存档补存 `cmtTotal`、恢复时一并还原（老存档无此字段回落空表）。**教训**：给「离场存档→恢复」机制加新状态字段时，同步检查存档清单是否要跟着扩（同类风险点：myReacts 在 rows 快照里 ✓）。
     验证：undef/tdz **0** + 37 套离线 **0 fail** + build 0 + page-smoke 9/9 + live-check 14/14（首轮 1 项 fetch failed 为本机网络抖动，复跑全过）。

  - **轮 126 · 动效库落地第二批：全站复查 + 十处补齐（2026-09-29，已提交 `ec1c48d` / 已部署 Version `0e8545f0` / live-check 14/14 + bundle 本地=线上 ✅；APK 需重打）**：
     用户反馈「动画没替换完/感觉没效果」→ 全面复查 + 把能上的全上（本轮 10 项）：① **按压缩放 scale(.95)** 全站可点元素（DESIGN.md 系统级微交互：btn/ra/mq/chip/nav/sort/cmt-react/modal-btn 等 :active）② **页面切换转场升级**：fade → slide-fade（上升+消模糊 220ms；App.vue transition 改名 page，scrubStuckFade 同步清理 page-* 类防冻结自愈失效）③ **首页 hero 入场错峰**（texts-reveal：标题/副题/按钮组依次升起消模糊，纯 CSS nth-child 延迟）④ **信息流骨架屏**（skeleton-reveal：首载无帖时 2 张脉冲骨架卡，刷新有帖仍走原提示）⑤ **宠物通知浮层**滑入堆叠（banner-stacking）⑥ **分享卡 3D 指针倾斜+光泽**（card-tilt：pointermove 换算 rx/ry + 双层 radial 光泽跟随，离开回平）⑦ **任务领取成功打勾**（success-check：描边绘制 24→0）⑧ **登录/表单错误抖动**（error-state-shake：notice.bad 复用 t-crack-shake）⑨ **详情页排序滑动胶囊**（tabs-sliding：量 active 按钮位移+定宽，切换/挂载/resize 三时同步；.sort-btn.on 残留渐变顺带平涂）⑩ reduced-motion 块扩展覆盖全部新动画。
     **复查结论**：轮 123 五项接线确认在位（like-button/红点/⋯菜单/文字换态/金币）；「没效果」体感主因 = ①动效多为状态触发（红点要新消息、金币要变化、提示要刷新才可见）②部分太细（160ms 菜单）。本轮补的全是高频可见位（每次切页/首屏/加载/领取/出错）。
     验证：undef/tdz **0** + **37 套离线 0 fail** + page-smoke **9/9** + build-until-good **BUILD_GOOD**（入口 `index-CcLeF8o1.js`）+ 探针实测（heroAnim=t-rise ✓ / 骨架屏结构 ✓ / 金币 pop ✓）。

  - **轮 125 · 💔点亮重设计终版（2026-09-29，已提交 `bf15564` / 已部署 Version `7f2101f9` / live-check 14/14 / **APK `9688ED97A018B0BC` 装机 + 冷启动确认** ✅）**：
     轮 124 修复被用户实测打回（「放屁，你改了个几把」）——裂纹填底色方案治标不治本：**💔 点亮后填色+同形状，看起来就是 ❤️**，裂纹 1.7px 在小图标上根本救不回。**终版方案（语义区分而非视觉补丁）**：❤️ 点亮 = 玫瑰填色 + 弹跳 + 粒子（不变）；💔 点亮 = **不填充**，心体+裂纹描边转心灰 `#6c6a64`，图标走 **t-crack-shake 抖动**（error-state-shake 配方节拍 400ms）——「心灰了、颤了一下」，与 ❤️ 在形状/颜色/动效三轴全部区分。CSS 填充规则限定 `[data-kind="heart"]`；8 按钮补 `data-kind` 标记（首轮正则只匹配 cm.dbId，漏了 rp 行的 rp.dbId——已补）；粒子 JS 仅 heart 触发。
     验证：强制点亮探针实测——broken：fill 透明 + 描边 rgb(108,106,100) + animation **t-crack-shake** ✓；heart：fill rgb(212,84,122) ✓。37 套离线 0 fail + build 0 + page-smoke 9/9 + live-check 14/14。
     **教训**：① 两个相近交互共用一套「点亮」视觉时，形状差异（描边 vs 填充）比颜色差异可靠——小尺寸下细线细节（裂纹）会被填充吞掉；② python 批量替换必须先 grep 验证锚文本逐字符一致（本轮 style.css 首次替换因注释行错位静默失败，探针抓到）；③ 正则批处理要覆盖全部变体（cm.dbId vs rp.dbId）。

  - **轮 124 · 修复💔点亮变♥（2026-09-29，已提交 `f5062a0` / 已部署 Version `a9aa2d55` / live-check 14/14 / **APK `E344684180289471` 装机 + 冷启动确认** ✅；**轮 125 已重设计替换本方案**）**：
     用户实测「不喜欢的♥点击之后便成了♥的形状」——**真因**：like-button 的填充规则 `.t-like[data-liked="true"] .t-like-heart path { fill: currentColor }` 把坏心 SVG 里的**第二条 path（裂纹线）也一起填满**，裂纹与心体同色即消失 → 💔 点亮后视觉上就是 ♥。**修**：裂纹 path 标记 `t-like-crack`（两视图 4 处），CSS 定两条规则——裂纹**永不填充**（fill:none !important）；点亮时裂纹改**底色描边**（`stroke: var(--card)`）= 在填色的心上真裂开。
     验证：build 0 + page-smoke 9/9 + live-check 14/14；规则进 dist CSS（t-like-crack 3 处）。手感待用户真机验收（点亮💔应看到裂纹）。

  - **轮 123 · 动效库落地第一批：五套配方替换全站交互（2026-09-29，已提交 `20f9b65`（含 transitions/ 32 配方入库） / 已部署 Version `9b607b0e` / live-check LIVE ALL PASS (14) + bundle 本地=线上（入口 `index-C-AjyKu1.js`） / **APK `B3D00F7291D6FFAD` 装机 Success + 冷启动前台 + 无崩溃** ✅）**：
     用户发话「把适合我们站的动画替换掉」。从 `transitions/` 选五套落地（配方源已入库，CSS 带规范要求的 prefers-reduced-motion 块）：① **like-button → 评论 ❤️/💔**（两视图 8 按钮）：t-like 语法（data-liked 驱动描边填充→#d4547a、HTML 包装层弹跳防 hi-DPI 栅格化、8 粒粒子扇形迸发错峰）；**点亮成功才放粒子**（fireReactBurst 700ms 窗口，取消/失败/未登录不放）；② **notification-badge → 消息红点**（顶栏 💬 + TabBar）：对角滑入+弹簧定格 500ms；③ **⋯菜单 scale-in**（两视图 more-pop）：原点感知 160ms 缩放淡入；④ **text-states-swap → 刷新提示/hint**：blur+位移交叉换态（Vue transition keyed）；⑤ **number-pop-in → 金币数字**：`:key=wallet.coins` 重挂载即重放，零 JS。**手术事故一次**：python 正则替换串用了 raw string，`\"` 原样进模板 → 构建失败（Unquoted attribute value）→ 清理 16 处转义修复（build-until-good 抓到）。
     验证：undef/tdz **0** + **37 套离线 0 fail** + page-smoke **9/9** + build-until-good **BUILD_GOOD**（入口 `index-C-AjyKu1.js`）+ 探针实测（未登录点击正确拒绝；强制点亮语法验证因本机网络抖动未跑完——DOM 结构上轮已确认 8 粒粒子+初始态正确，**登录态手感待用户真机/浏览器验收**）。
     **候选未上**（下轮按需）：tabs-sliding（排序 Tab 滑动指示条，需测量 JS）、success-check（领金币打勾）、accordion（评论区展开动画——评论系统刚稳，不动）、confetti（Pro 付费款）。

  - **轮 122 · 建立 `transitions/` 动效选型库（2026-09-29，本地文件+文档，**无代码改动**）**：
     用户发话「把免费款里的全下载，加到本地 peiban 文件夹，自己建一个文件夹，以后动画从这里面选，写到 jiaojie」。**落地**：新文件夹 `transitions/` ——用 transitions.dev 官方 CLI（`npx transitions-dev add --free`；npm 全局缓存有权限坑，带 `--cache D:\05ruanjian\npm-cache` 解决——T1 轮同款坑）拉取**全部 32 份免费动效配方**（.md：场景说明+HTML+可调变量表+CSS，Pro 付费款未包含）。新增 `transitions/README.md` 索引：32 行配方表（名称/动效/暖爪候选落点，如 like-button→评论回应、toast→提示条、tabs-sliding→排序 Tab、skeleton-reveal→信息流载入）+ 选型三原则（状态变化服务/一处一主转场/时长用配方默认区间）。
     **约定：以后全站做动画先从 `transitions/` 选配方**，CSS 搬入时保留 `t-` 前缀隔离与 `prefers-reduced-motion` 块。**未动任何站点代码**；本文件夹随下次提交一并入库。

  - **轮 121 · 字体层对齐 DESIGN.md（Claude 体系）第 2 步（2026-09-29，已提交 `c6bb9f6` / 已部署（现役 Version `9b607b0e`）；**APK `B3D00F7291D6FFAD` 装机 ✅**——EB Garamond/Inter/珊瑚 token 进包）**：
     按规范「衬线展示 + 人文正文」落地：① 字体加载：Google Fonts 从 Quicksand 换为 **Inter（400/500/600）+ EB Garamond（400/500）**（async 非阻塞模式保持，轮 84 口径），**霞鹜文楷保留**——它就是规范的中文版衬线答案；② style.css 新增 `--font-display`（"EB Garamond", "LXGW WenKai", serif）/ `--font-body`（"Inter", "LXGW WenKai", ...）两变量；body 字族换 `--font-body`、行高 1.65→**1.55**（规范 body-md）；③ **主标题 `.hero-title` 换衬线展示体**：EB Garamond（latin）/霞鹜文楷（zh）、字号 30→34px、字重 700→500、字距 -0.5px（规范：展示体 400/500 + 负字距，禁 700 炸眼）；④ **字重阶梯收敛**：全站 font-weight 800/700/900→500、600→500（规范 sans 上限 500），style.css + 组件/视图内联全部扫平；⑤ theme.js Naive 字体栈 → Inter 版。Quicksand 全退役（0 残留）。
     验证：undef/tdz **0** + **37 套离线 0 fail** + build-until-good **BUILD_GOOD**（入口 `index-0jxJgHrt.js`）+ page-smoke **9/9** + 1440px 双语探针实测（computed font：hero=**EB Garamond**、body=**Inter**、weight 500 ✓，zh 正文自动落霞鹜文楷）。
     **后续（第 3 步结构层，未开工）**：奶油→奶油卡→深卡节奏重排、深色页脚、珊瑚 callout 大卡；品牌资产（og-image/favicon 旧橙）重生成待定。

  - **轮 120 · 全站换肤对齐 DESIGN.md（Claude 体系）第一步换肤层（2026-09-29，已提交 `c6bb9f6` / 已部署（现役 Version `9b607b0e`，live-check 14/14 复跑全过——此前 6 项失败确认为本机网络抖动）；**APK `B3D00F7291D6FFAD` 装机 ✅**）**：
     用户放入 `DESIGN.md`（Claude/Anthropic 设计体系逆向 token）并拍板「先做第 1 步换肤层」。**核心 token 落地（:root）**：画布 `#faf9f5`（平涂，去 160deg 渐变+光斑装饰）、主色陶珊瑚 `#cc785c`（按下 `#a9583e`）、墨色 `#141413`/`#6c6a64`/`#8e8b82` 三阶、卡片改**实色奶油 `#efe9de` + 1px 发丝线 `#e6dfd8`**（新 `--card`/`--hairline` 变量；毛玻璃 blur 与阴影退役：`--shadow: none`，`--shadow-sm` 仅留 hover 级微影）、圆角分层 12px（卡）/8px（按钮输入）、语义色对齐（success #5db872 / warning #d4a017 / error #c64545）。**Naive 组件库**（theme.js）：墨色/边框/分割线对齐、borderRadius 8px、Button 8px + fontWeightStrong 500（规范禁 700/500 禁区见规范）、Card 12px、Dialog 16px、Dropdown/Message 12px、Input 珊瑚 15% 聚焦环、Progress 发丝线。**themes.js 默认皮肤**改名 Warm Cream/暖奶油，swatch+primary 对齐珊瑚（hover=primary：规范「按压加深、无 hover 变化」）。**硬编码清扫**：`rgba(255,159,90`→`rgba(204,120,92`、`rgba(255,146,87`→`rgba(169,88,62`（primary-active）、`rgba(160,110,60`→`rgba(140,128,112`（暖灰发丝）、全部橙色渐变（nav 选中/按钮/进度条/tab/chip/mood-cell/品牌爪印/首页 hero 紫渐变字）→ 平涂；index.html theme-color+启动页底色+manifest theme_color → #faf9f5（splash-test 断言同步）。
     **刻意保留**：顶栏胶囊外形、徽章 pill（规范：pill 只给徽章/动作）、白色小芯片（≈规范 pearl）、其余 4 套皮肤（sakura/mint/lavender/night 只覆盖自己的变量组，结构变化全局继承）。
     验证：undef/tdz **0** + **37 套离线 0 fail**（splash-test 断言同步后 21/21）+ page-smoke **9/9** + build-until-good **BUILD_GOOD**（入口 `index-DdDHH3Pf.js`）+ 1440px/393px 双截图目检（平涂画布/发丝卡/珊瑚交互色全站生效，光斑与滚动条均已消失）。**后续轮**：②字体层（EB Garamond 衬线标题 + Inter 正文，zh 保持霞鹜文楷）③结构层（奶油→奶油卡→深卡节奏、深色页脚、珊瑚 callout）。**品牌资产未动**：og-image/favicon/分享卡仍是旧橙（make-og 重生成待定）。

  - **轮 119 · 招待来访宠物不再要求画过食物（2026-09-29，已提交 `2ec4727`，随轮 120/123 批部署（现役 Version `9b607b0e`）；APK 随轮 123 批重打 `B3D00F7291D6FFAD` 装机 ✅）**：
     用户反馈「招待过来的宠物，不需要画的食物也能招待」。**真因**：`feedVisitor()` 的门槛 `|| !cookbook.length` 是纯摩擦——招待**从不消耗**任何菜品，只是形式上要求「画过至少一道」；没画过的用户遇到小客人只能干瞪眼。**修**：① petStore `feedVisitor()` 只留 `adventure.visitor` 存在性判断（奖励口径不变：💰6 +1 好感；有画菜=招待手绘料理，没有=家常茶点，纯本地演出无服务端概念）② PetView `offerFood()` 删 noDish 拦截分支 ③ i18n `adventure.noDish` zh/en 成对退役（**`rail.noDish` 保留**——那是喂**自己**宠物的真实消耗门槛）。App/网页同改（同一份 petStore）。
     验证：undef/tdz **0** + 全量 37 套离线 **0 fail** + build-until-good **BUILD_GOOD**（入口 `index-CCA_t9yo.js`）+ page-smoke **9/9**。

  - **轮 117 · 网页端两侧竖栏扩容：温柔任务/陪伴时长/今日温柔签/海边来信（2026-09-29，已提交 `5058950` / 已部署 Version `8419e629` / live-check LIVE ALL PASS (14) + live-bundle-check 本地=线上（入口 `index-BNbD4Izt.js` SHA16 `a79a320ee2c2fe00`）✅；**轮 118 视觉修复已随批部署 Version `f25e3ffa`**（滚动条隐藏/飘带退役，live-check 14/14 + bundle SHA16 `330b35158835a532` 本地=线上）；APK 无需重打，SideRails 仅桌面 ≥1280px 渲染）**：
     用户反馈「网页端两边太难看，一堆空的」→ 给 SideRails（伙伴角/治愈角）加四张新卡片，全部**复用既有数据层**（宠物任务/漂流瓶服务端次数/剪贴板），不造第二本账、零数据库改动：① **今日温柔任务**（左）：TASK_LIST 五任务逐行（图标+文案+💰+✓），可领取金币按钮=claimTasks()（与宠物页同一本账），完成后 say() 语音反馈；② **今日陪伴**（左）：挂页即陪伴，可见时每 30s 累计进 localStorage（wp-accomp-<dateKey>），strip 展示「今天已陪伴 X 分钟/X 小时 Y 分钟」；③ **今日温柔签**（右）：新增 `src/data/gentleSlips.js`（16 签 zh/en 双语，语气=温柔不评判落小动作），`railRules.slipFor` 按日期**确定性**抽签（同日同签、跨天轮换）+ 连集天数（bumpSlipStreak，跨月/跨年连续判定）+ 一键抄录（clipboard.js）；④ **海边来信**（右）：bottleQuota/bottleHeld（启动预热单飞合并，零额外请求）展示「还能投 X 封 · 回 Y 封 / 手里有 N 封信」，未登录整卡隐藏。
     新增文件：`src/data/gentleSlips.js` / `src/utils/railRules.js` / `tools/rail-test.mjs`（**31 项**：抽签确定性/范围/分布、脏数据兜底、连击跨月跨年、时长拆分、次数减法钳制）。i18n rail 块新键 zh/en 成对 10 个（slipTitle/slipStreak/slipCopied/bottleTitle/bottleLeft/bottleHeld/bottleGo/companionTime/timeHm/timeM）；任务文案复用既有 `tasks.*` 顶级块（**首版误写 pet.tasks.* 显示原始 key，桌面截图目检抓到后修正**——动态拼接 key undef/tdz/page-smoke 都测不到，目检是唯一防线）。
     **修真缺陷一枚**：slipIndexFor 首版用普通乘法做 FNV——超过 2^53 丢精度导致分布塌缩（30 天仅覆盖 <8 签，rail-test T3 抓到）→ `Math.imul` 修复。
     验证：undef/tdz **0** + **37 套离线 0 fail**（含新 rail-test 31/31）+ page-smoke **9/9** + build-until-good **BUILD_GOOD**（入口 `index-BNbD4Izt.js`）+ 桌面 1440px 截图目检（任务行/陪伴条/签卡/收集数全部如实渲染，未登录漂流瓶卡正确隐藏）。

  - **轮 116 · App applicationId 换新域倒写：`net.de5.dale` → `net.de5.warmpaws`（2026-09-29，已打包机 ✅）**：
     用户发话「app端那个appid，改成新的域名的倒写」。**改动六处**：① `capacitor.config.json` appId ② `android/app/build.gradle` applicationId ③ `AndroidManifest.xml` 深链 scheme（`net.de5.warmpaws://login`）④ `supabase.js` APP_SCHEME ⑤ `public/app-auth.html` SCHEME ⑥ `tools/auth-test.mjs` 样例串——**scheme 三处（manifest/JS/中转页）必须同轮同步**，谷歌登录回跳链路才不断；Supabase 白名单无需改（自定义 scheme 从不入白名单）。**刻意不动**：`namespace = "net.de5.dale"` 与 Java 包目录（applicationId ≠ namespace 是 Android 合法形态，零文件搬移、MainActivity/WpSharePlugin 原位）。
     **装机要点**：applicationId 变更 = 全新应用**并存安装**而非覆盖——MIUI 弹「USB 安装确认」需手机上点确认（首次尝试 INSTALL_FAILED_USER_RESTRICTED 即此）；装成后**卸载旧应用 `net.de5.dale`**（它指向已下线的旧域，本就断了）。**代价明示**：新应用是全新沙箱，手机上的登录态清空 → 用户需重新登录；云端数据（宠物/帖子/评论）不受影响，本机小数据（主题选择、本地游客档）重置。
     验证：undef/tdz **0** + 全量 36 套离线 **0 fail**（auth 130/130 含新 scheme 样例）+ build-until-good **BUILD_GOOD**（入口 `index-0ZPTRW7-.js`）+ page-smoke **9/9** + Gradle BUILD SUCCESSFUL（7s）→ **APK SHA16 `9167272BD3BE0662`** 装机 Success → 冷启动 `topResumedActivity=net.de5.warmpaws/net.de5.dale.MainActivity` 前台 + logcat 无崩溃 ✓。pm list packages 仅剩 `net.de5.warmpaws`。
     **待用户真机验收（亮屏）**：① 新 App（图标同名）打开正常 ② **重新登录**邮箱/谷歌均可（谷歌走新 scheme 回跳）③ 云端数据如常可见。

  - **轮 115 · 旧域 dale.de5.net 下线腾空（2026-09-29，已部署，用户要拿旧域另做静态页）**：
     前提链全部就绪后执行：① 面板三步用户确认完成（Supabase Site URL 已切新域 / Google Branding 两处已改 / GSC 新域资源已验证 + sitemap 已提交——首次「无法抓取」为谷歌侧瞬时状态，服务端实测 sitemap 200/110 条/Googlebot UA 1.2s 可抓）② **新 APK 先装机**（`16A59F578311CD3A`，包内 API_BASE 5 处全 warmpaws、0 处 dale，`adb install -r` Success + 冷启动前台 + 无崩溃——存量包不再依赖旧域）③ routes 删 `dale.de5.net` 条目重部署 → Version `6beaed3f`：warmpaws 200 / workers.dev 200 / dale 腾空（522=记录已删、公网缓存 ~30 分钟过期）。
     **旧域现状**：Worker 绑定解除 + 自家 DNS 记录已清；`dale.de5.net → tori/cesar.ns.cloudflare.com` 的 NS 委派仍在（dnshe 侧），**直接可在 Cloudflare 绑给下一个静态页项目**（Pages/Worker 均可）。
     **收尾提醒**：Supabase Redirect URLs 里 `https://dale.de5.net/**` 那条白名单已无用途，可在面板顺手删（留着无害）。
     验证：三址状态实测（见上）+ live-check / live-bundle-check 轮 114 批口径不变（唯一入口打新域）。

  - **轮 114 · 换域名 dale.de5.net → warmpaws.de5.net（2026-09-28，改动完成、测试全绿，**部署等发话**——部署即绑新域）**：
     用户发话换域名。**仓库层（22 文件 + .env）**：① `.env` `VITE_API_BASE=https://warmpaws.de5.net`——**最关键一处**：打 APK 时所有 API 请求与 App 端谷歌登录中转页地址都从这里出；② `src/utils/supabase.js` siteOrigin() 两处兜底域名；③ `vite.config.js` SITE 常量（构建期全部 canonical/OG/hreflang 从这出）；④ `index.html` canonical/og:url/og:image/twitter:image/JSON-LD；⑤ `public/robots.txt` Sitemap 行 + `public/sitemap.xml` 固定 5 条（线上动态 sitemap 按**请求域名**现生成，Worker 侧零改动自动跟新域）；⑥ `src/i18n.js` 隐私政策正文「本站 域名」中英两处（Google 审核口径）；⑦ `public/app-auth.html`/`PrivacyView.vue`/`authRules.js` 注释；⑧ tools 十个脚本 BASE（live-check/online-check/live-bundle-check/seo-test/privacy-test/worker-test/auth-test/bottle-e2e/status-e2e/img-cache-e2e/feed-window-live/web-probe）；⑨ README.md 全量替换。**wrangler.jsonc 新增 `routes: [{ pattern: "warmpaws.de5.net", custom_domain: true }]`——`wrangler deploy` 时自动在 de5.net zone 建 DNS + 绑定**；旧域 dale.de5.net 是面板绑的、不在配置里，deploy 不动它 → **双域并存，老 APK/老链接不断**。
     **外部平台待办（面板在用户手里）**：① Supabase → Authentication → URL Configuration：Site URL 改新域 + Redirect URLs 加 `https://warmpaws.de5.net/**`（旧的先留）——不改则谷歌登录回不来/重置邮件链旧站；② Google Cloud Console → OAuth Branding：home page + privacy policy link 改新域；③ Search Console：新域资源 + DNS TXT + 重提 sitemap；④ 旧域至少保留一两个月（老 APK 的 VITE_API_BASE 是旧域，靠它活着）。
     验证：undef/tdz **0** + 全量 36 套离线 **0 fail**（seo 50/50 / privacy 33/33 / i18n 19/19 / worker 224/224 含新域名断言）+ build-until-good **BUILD_GOOD** + page-smoke **9/9**。**顺序红线：先 deploy（绑新域）再打 APK**——APK 里的 VITE_API_BASE 指向新域，新域没绑就装机 = 全部请求失败。
     **交付（同日，用户发话「下一步」→ 提交 + 部署）**：① Supabase Redirect URLs 由用户在 Edge 手动加 `https://warmpaws.de5.net/**`（Site URL 未动，部署后切）② 提交 `2595a0a`（24 文件）③ `wrangler deploy` → **warmpaws.de5.net custom domain 自动建绑成功**，但**旧域 dale.de5.net 被顶掉 530**（踩坑 #42：config routes 整体替换绑定集合）→ 补 `"dale.de5.net"` 进 routes 重部署恢复；`workers_dev` 被默认关闭也一并恢复。最终 **Version `2c19d907`**，三址全 200：warmpaws.de5.net / dale.de5.net / warm-paws.yi1614351.workers.dev ④ 部署后验证：**live-check LIVE ALL PASS (14)**（打新域）+ **live-bundle-check 本地=线上**（入口 `index-DB_VH31X.js` SHA16 `17c724e8d667ad20` 两侧一致、443201 字节、含 slug）+ 动态 sitemap 自动跟新域 + 旧域内容=新元数据（8 处新域引用）。
     **余下待办**：① Supabase Site URL 切新域（用户，部署已完成随时可切）② Google Branding 两处改新域 ③ GSC 新域资源+TXT+重提 sitemap ④ **重打 APK 装机**（等发话）⑤ 旧域至少保留一两个月（存量 APK 靠它）。
     **待用户真机验收（部署后网页端立即可验）**：https://warmpaws.de5.net 打开正常、谷歌登录可用、暖心墙/详情页一切照旧。

  - **轮 108 · 暖心墙主评论两段式：卡内占位条 → 底部输入条（2026-09-28，改动完成、测试全绿，待提交待部署——攒批；**APK 必须重打**，手机形态改动）**：
     **用户原话（附图1/图2）**：「暖心墙主评论输入框：输入样式改成图片1的样子，点击之后底部出现打字输入框，改成图片2的样式」。
     **改法（只动手机形态 isMobileNav；桌面 Web 保持 cmt-box 首部的内联输入框——轮 106「两平台不同输入方式」定案）**：① 每张帖子卡 react-row/post-foot 之后、`N 条评论` 之前，新增卡内常驻占位条 `.cmt-entry`（圆角浅底灰字 `comment.placeholder`「说点温柔的话…」，图1样式）；② 点击 → 底部弹出固定输入条 `.cmt-main-bar`（flex 行：n-input autosize 1~4 行 + 发送键常驻右侧，图2样式；bottom=64px+safe-area 与 .reply-bar 同口径，z-index 150）；③ 云端帖未登录点占位条 → 只展开评论区看登录提示（cmt-login 不变）；④ 发送成功 → 收输入条 + 顺手展开评论区看到新评论；失败 → 草稿留着、输入条不收、cmtErr 在展开的评论区可见；⑤ 再点同一条占位条 = 收起输入条。占位条所有帖都有（示例/本地帖走 sendCmt 本地路径）；草稿沿用 `cmtDraft`（内联框与底部条同源，平台切换不丢字）。样式进全局 style.css（与 .reply-bar/.cmt-bar-fixed 同区）。
     **目检取证（web-probe 393px）**：占位条渲染 ✓；点击后 `.cmt-main-bar` 出现、输入框自动聚焦 ✓；手机端内联输入行已不渲染 ✓；1280px 桌面：无占位条、内联输入框原样 ✓（桌面零变化）。
     **环境坑（踩坑 #40）**：Git Bash 把 `--url=/community` 做 MSYS 路径转换成 `D:/.../Git/community` → web-probe 报 invalid URL；加 `MSYS_NO_PATHCONV=1` 解决。
     验证：undef **0** + tdz **0** + 全量 36 套离线 **0 fail** + page-smoke **9/9** + build-until-good **BUILD_GOOD**（入口 `index-3SecfCmD.js`，slug ✓）+ web-probe 手机/桌面双目检 ✓。
     **打包 v1 + 装机（2026-09-28 用户发话「只打包」「装机」）**：APK SHA16 `9B963CBE667710E5`（资产溯源 `index-3SecfCmD.js`）装机 Success + 冷启动确认 ✓——**该包因下方 tabbar 露头缺陷已作废**。
     **轮 108 续 · 输入条贴键盘修正（2026-09-28 用户真机反馈附截图，原话「这个红框要了干嘛，我前面没有给你发图2的样式吗，你抄都不会抄吗」）**：红框 = tabbar 露在输入条与键盘之间，而图2 要求输入条**直接压在键盘上、底下什么都没有**。两层真因：① `.cmt-main-bar` 原抄了 `.reply-bar` 的 `bottom: 64px+safe-area`（浮在 tabbar 上方——抄错了参照物）；② 改 `bottom:0` + z-index 150 后目检截图显示 **tabbar 仍盖在条上**——条在 route-wrap 内部、受父级堆叠上下文限制，z-index 压不过根级 tabbar（**轮 103 弹窗被盖同一陷阱**；getBoundingClientRect 量不出堆叠层级，只有目检截图能现形）。**修法（不玩堆叠，直接收 tabbar）**：uiStore 新增 `tabbarSuppressed`，App.vue 的 `TabBar v-if` 加 `&& !tabbarSuppressed`（聊天页 inChat 隐藏 tabbar 同款先例），CommunityView `watch(mainBarKey)` 同步开/关 + `onUnmounted` 兜底复位；`.cmt-main-bar` 定为 `bottom:0` + 实色 `#fff7ee`。探针断言：打开 → tabbar 消失 + 条贴视口底 ✓；再点占位条关闭 → tabbar 回来 ✓。
     **验证（轮 108 续后）**：undef/tdz **0** + 全量 36 套离线 **0 fail** + page-smoke **9/9** + build-until-good **BUILD_GOOD**（入口 `index-BXjk6tp8.js`）。
     **重打包机（同日）**：gradle **BUILD SUCCESSFUL 3s** → **APK SHA16 `A153921712171A2E`**（`apk/warm-paws-debug.apk`，拆包溯源 `index-BXjk6tp8.js` ✓）→ `adb install -r` **Success**（设备 `PBIJR8BM6D6HS8LV`）→ 冷启动前台确认 + logcat 无崩溃 ✓。**仍未部署未提交**（Worker 零改动，线上接口不受影响；等发话）。
     **轮 108 续2 · 点空白收起输入条（2026-09-28 用户反馈「点击空白的地方，下面的输入框要消失啊」）**：原先只有「再点占位条/发送成功」两个关闭路径。补**文档级点击收起**（与 ⋯ 菜单同模式）：`mainBarDocClose` —— 条内点击不关、`.cmt-entry` 上的点击不关（归 toggle/切换管）、其余一律收起；watch mainBarKey 挂/摘监听 + onUnmounted 兜底。**修掉一处真缺陷**：首版 mainBarDocClose 只清 `mainBarKey` 没清 `mainBarPost`，而条的 `v-if` 挂在 `mainBarPost` 上 → 条不卸载、tabbar 却先回来了（探针 four-step 断言抓到：blankCloses=false）。**四条行为探针全过**：点空白收起+tabbar 回 ✓ / 点条内不收 ✓ / 点别的占位条切换不关 ✓ / 再点同条收起 ✓。
     **验证（续2 后）**：undef/tdz **0** + 全量 36 套离线 **0 fail** + page-smoke **9/9** + build-until-good **BUILD_GOOD**（入口 `index-CxnBlg3i.js`）。
     **重打包机（续2，同日）**：gradle **BUILD SUCCESSFUL 2s** → **APK SHA16 `CF7C4E40F265A11C`**（拆包溯源 `index-CxnBlg3i.js` ✓）→ `adb install -r` **Success**（设备 `PBIJR8BM6D6HS8LV`）→ 冷启动前台 + logcat 无崩溃 ✓。**仍未部署未提交**。历史包：续1 `A153921712171A2E`（无点空白收起）→ v1 `9B963CBE667710E5`（tabbar 露头）均作废。
     **轮 108 续3 · 回复统一走底部输入条（2026-09-28 用户反馈附截图：「暖心墙一级评论，二级评论输入全都去掉：点击之后复用上面第一条改的底部打字输入框。只改apk端，网页端不改」）**：① 手机端两处内联回复框（一级 `cmt-input-rep` / 二级就地 `cmt-input-rep-in`）v-if 加 `!isMobileNav`（**条件顺序放在 `replyRpOf(...)` 之后**，保住 app-shell T39 的源码断言子串，T39 标题同步注明仅桌面）；② 底部条升级**双模式**：`mainBarReply = { cm, rp }` 回复目标——占位切「回复 xxx…」（同源 repPlaceholder）、草稿读写 repDraft（computed get/set，与内联框同 store、切模式不串字）、发送复用 `sendCmt(p, cm)` 全套逻辑（@ 署名走 atName）；③ 新增统一入口 `replyViaBar(p, cm, rp)`：手机端 = 底部条回复模式（再点同目标「回复」= 收起），桌面 = 原内联框原路，云端帖未登录 = 原 showWallMsg 拦截（两平台一致）；④ 四个回复入口（一级/二级正文点击 + 回复钮）全部改走 replyViaBar。
     **验证（续3 后）**：undef/tdz **0** + 全量 36 套离线 **0 fail**（app-shell 40/40 含 T39）+ page-smoke **9/9** + build-until-good **BUILD_GOOD** + 双探针（手机/桌面）✓。
     **续3-a · 真机反馈修复「点击之后不出现输入框」（用户原话，装机 `AE5F8329259BA298` 后实测）**：点回复/占位条开的条，**下一次点击评论任意处就被秒关**——「点空白收起」的 document 监听把回复/评论区的点击也当成了空白（点回复时：replyViaBar 先开条，同一击冒泡到 document 又把它关掉）。**修**：① 回复触发链 `stopPropagation`（replyViaBar 收 $event）；② document 收起监听排除 `.bar-reply-tap`（回复钮）；③ 后来按用户追加要求升级为**整条评论接管**（见下）。
     **续3-b · 整条评论点哪儿都弹输入条（用户原话：「不但是四个回复触发点，而是整个评论点击一下就要能弹出打字输入框」）**：点击接管从 4 个触发点升级到**整层**——一级 `.cmt-item` / 二级 `.cmt-rep` 各挂 `cmtItemTap(p, cm, $event, rp?)`（二级先于一级触发并 stopPropagation，点回复=回回复、点一级其余区域=回一级）；内部交互件（按钮/链接/…菜单/展开钮/输入框/作者名 `.clickable`）不算「点评论」；手机端点评论区任意空白处 → 底部条回复该条；**桌面不接管**——只有正文点击保持原「就地回复框」，其余不响应（网页端不改）。一/二级正文的直接 @click 摘掉（防双触发 toggle 秒关）。
     **验证（续3-a/b 后）**：undef/tdz **0** + 全量 36 套离线 **0 fail**（app-shell 40/40 含 T39）+ page-smoke **9/9** + build-until-good **BUILD_GOOD**（入口 `index-Dmtz-8td.js`）+ 双探针：手机 393px（正文点按 → 条「回复 xxx」✓ / 回复钮 toggle 开关不双触发 ✓ / 点空白收起 ✓ / tabbar 收起 ✓），桌面 1280px（正文 → 内联框 ✓ / 头部区点击无反应 ✓ / 无底部条无占位条 ✓）。
     **重打包机（续3-b，同日）**：gradle **BUILD SUCCESSFUL 2s** → **APK SHA16 `6AB1DB2D92AE1177`**（拆包溯源 `index-Dmtz-8td.js` ✓）→ `adb install -r` **Success**（设备 `PBIJR8BM6D6HS8LV`）→ 冷启动前台 + logcat 无崩溃 ✓。**仍未部署未提交**。作废包：`AE5F8329259BA298`(续3初) → `CF7C4E40F265A11C`(续2) → `A153921712171A2E`(续1) → `9B963CBE667710E5`(v1)。
     **待用户真机验收（续3-b，亮屏）**：① 点一级/二级评论**任意位置** → 底部条弹出、占位「回复 xxx…」、发送在右 ② 内联回复框手机端彻底消失 ③ 发送成功回复落对应线程 ④ 点空白收起 ⑤ 回应/删除/⋯菜单/展开回复等按钮照常 ⑥ 网页端回复行为不变。
     **轮 108 续4 · 详情页主评论同款两段式（2026-09-28 用户反馈附截图：「帖子详细页主评论输入框：放在帖子下面，所有的评论上面，跟上面1一样。网页端不改」）**：PostDetailView 手机端（isMobileNav）：① `cmt-box` 首部（帖子正文下、所有评论上——用户截图红框位置）新增 `.cmt-entry` 占位条（与暖心墙同款样式/类名，样式全局共享）；② 点击 → `.cmt-main-bar` 底部输入条（贴键盘、tabbar 收起、点空白收起、发送在右——复用轮 108 续全套交互：`detailBar` 状态 + detailBarDocClose + tabbarSuppressed + onUnmounted 兜底）；③ 悬浮底栏 `cmt-bar-fixed` 加 `!isMobileNav` 改桌面专属（barSignIn 断言字符串保留，post-detail-test 不破）；④ 未登录点占位条 → 跳 /profile 登录（详情页评论区常开、没有墙内那种展开看登录提示的路径）；⑤ 与回复条互斥：reply-bar 开着时底部条让位（v-if `!repActive`），开占位条先 cancelReply；发送成功草稿清空才收条，失败留草稿、cmtErr 可见。
     **验证（续4 后）**：undef/tdz **0** + 全量 36 套离线 **0 fail** + page-smoke **9/9** + build-until-good **BUILD_GOOD**（入口 `index-g9iKpNMQ.js`）+ 双探针：手机 393px（进 /post/:id → 占位条在 cmt-box 首位 ✓ / 悬浮底栏消失 ✓ / 未登录点占位跳 /profile ✓），桌面 1280px（无占位条 ✓ / cmt-bar-fixed 悬浮栏原样 ✓ / 无底部条 ✓）。
     **重打包机（续4，同日）**：gradle **BUILD SUCCESSFUL 2s** → **APK SHA16 `5853908213DE32AA`**（拆包溯源 `index-g9iKpNMQ.js` ✓）→ `adb install -r` **Success**（设备 `PBIJR8BM6D6HS8LV`）→ 冷启动前台 + logcat 无崩溃 ✓。**仍未部署未提交**。作废包：`6AB1DB2D92AE1177`(续3-b) → `AE5F8329259BA298`(续3初) → `CF7C4E40F265A11C`(续2) → `A153921712171A2E`(续1) → `9B963CBE667710E5`(v1)。
     **待用户真机验收（续4，亮屏，详情页）**：① 帖子下、评论上方出现「说点温柔的话…」占位条 ② 点击 → 底部条弹出（贴键盘、tabbar 收起）③ 发送成功评论出现在列表首 ④ 点空白收起 ⑤ 未登录点占位 → 登录页 ⑥ 桌面网页悬浮输入条不变。
     **轮 108 续5 · 详情页回复统一走底部输入条（2026-09-28 用户反馈附截图：「暖心墙一级评论，二级评论输入全都去掉：点击之后复用上面第1条改的的底部打字输入框，就是跟2改的一样。只改apk端」——截图实为详情页的 reply-bar）**：① `startReply` 加双分支：手机端 = 底部条回复模式（`detailBarReply={cm,rp}`，占位「回复 xxx…」、草稿按目标隔离存 `repDraft`、@ 署名走 atName、再点同目标=收起、stopPropagation 防点空白收起误杀）；桌面 = 就地内联框原路不变；② **reply-bar（轮 98 悬浮回复条）整块退役**，barCm/barRp/barInput/sendBar/repActive-watch 一并清掉；③ 四个回复入口（一/二级正文+回复钮）传 $event；④ sendDetailBar 双模式分发（sendCmt() / sendCmt(cm, rp)）；⑤ 点占位条在回复模式 = 切回主评论。post-detail-test startReply 签名断言同步（`e = null`）。
     **验证（续5 后）**：undef/tdz **0** + 全量 36 套离线 **0 fail** + page-smoke **9/9** + build-until-good **BUILD_GOOD**（入口 `index-C32E5Fed.js`）+ 双探针：手机 393px（进 /post/:id → reply-bar 不存在 ✓ / 占位条在 ✓ / 悬浮底栏无 ✓），桌面 1280px（cmt-bar-fixed 原样 ✓ / reply-bar 不存在 ✓）。未登录无法驱动回复分支（回复钮 v-if signedIn），登录后交互与已验证的暖心墙同构，真机验收兜底。
     **重打包机（续5，同日）**：gradle **BUILD SUCCESSFUL 2s** → **APK SHA16 `AA60666FBE4D9D8E`**（拆包溯源 `index-C32E5Fed.js` ✓）→ `adb install -r` **Success**（设备 `PBIJR8BM6D6HS8LV`）→ 冷启动前台 + logcat 无崩溃 ✓。**仍未部署未提交**。作废包：`5853908213DE32AA`(续4) → `6AB1DB2D92AE1177`(续3-b) → `AE5F8329259BA298`(续3初) → `CF7C4E40F265A11C`(续2) → `A153921712171A2E`(续1) → `9B963CBE667710E5`(v1)。
     **待用户真机验收（亮屏，详情页）**：① 一级/二级「回复」点击 → 底部条弹出（占位「回复 xxx…」、发送在右、tabbar 收起）② reply-bar 彻底消失 ③ 发送成功回复落对应线程 ④ 点空白收起 ⑤ 桌面网页回复行为不变。
     **待用户真机验收（亮屏）**：① 每张卡出现「说点温柔的话…」占位条（图1样式）② 点击 → 键盘弹出、底部输入条直接压在键盘上（图2样式，**tabbar 不再露头**）③ 发送成功评论出现在展开的评论区 ④ 桌面网页行为不变。
  - **轮 113 · 上传 / 部署 / 打包 / 装机 四链路（2026-09-28，用户发话「上传，部署，打包，装机」→ 轮 107-112 攒批一次性交付，全部 ✅）**：
     **① 上传（git）**：三个主题提交按轮次落（攒批制 0.6 第 2 条）——`bf7b2c2` 轮 107（删孤儿组件 CommentComposer.vue）/ `c194df0` 轮 108-112（评论输入两段式 + 网页端输入框四处定位修正）/ `8fecc0f` 轮 108-112 测试与文档。`git diff --check` 干净（`DIFFCHECK=0`）→ push 用**本机网络三参数** `git -c http.proxy= -c https.proxy= -c http.version=HTTP/1.1 push` 成功；复验 `git rev-parse HEAD origin/main` 两行同为 `8fecc0f055672c9aeed69cf40b2f459bd5554d62`、`git status -sb` = `## main...origin/main`（无 ahead/behind）、工作区除新截图外无脏文件。
     **② 部署（wrangler）**：`npx wrangler deploy` **EXIT=0**，Worker **Version ID `3a91942c-c8b8-4d1a-8fbc-4e7e06b93577`**，地址 https://warm-paws.yi1614351.workers.dev。线上验证：`node tools/live-check.mjs` → **LIVE ALL PASS (14)**，LIVE_EXIT=0；`node tools/live-bundle-check.mjs` → BUNDLE_EXIT=0，base `https://dale.de5.net/`，线上入口引 **`index-C5pZNGVS.js`**（443181 字节、含 slug），SHA256 前 16 位 `c6dbdbad5170f85f` **与本地 dist 逐字节一致**（坑 #25/#26 门禁过）。
     **③ 打包（Capacitor + Gradle）**：`npm run cap:sync` **CAPSYNC_EXIT=0**（Android 插件 app@8.1.1 / browser@8.0.4，update 67.01ms；`[cap-strip-hero]` 剥 SEO 占位 **×8**、放宽看门狗 ×0）；`$env:JAVA_HOME='D:\00ruanjiananzhuang\jdk-21\jdk-21'` + `.\gradlew assembleDebug` → **BUILD SUCCESSFUL in 30s**；APK 溯源脚本（`tools/_apkchk.ps1`）**APKCHK_EXIT=0**：5.21 MB、完整 SHA256 `A4852FA5763FAE05310CB0FEBE4B87E7830269AA6F74E9ACFE4EA080E8B8063B`（SHA16 **`A4852FA5763FAE05`**）、`in_apk_equals_assets: True`、包内入口 `assets/public/assets/index-C5pZNGVS.js` = 线上同一份、`style_open_close_in_apk: 2/2`、`cap_app_rules_in_apk: 1`；复制为 `apk/warm-paws-debug.apk`（5467180 字节，09/28 05:41）。
     **④ 装机（adb）**：包名 `net.de5.dale`；`adb install -r` → `Performing Streamed Install` / **`Success`**（INSTALL_EXIT=0）→ 冷启动（force-stop 后 monkey/am start）成功、`mWakefulness=Awake`（**亮屏状态**，否则 Chromium 冻结渲染会让 CDP 读数成假象）、进程存活；`logcat -d` 过滤 crash/FATAL/ANR **无异常**；截图 `tools/_shot113-app.png` 确认首页正常渲染。
     **待用户验收**：① 网页端（已上线 https://dale.de5.net）详情页一级评论点「回复」→ 输入框在该评论正文/操作行之下、二级评论之上 ② 二级评论回复框仍在被回复那条下面 ③ 「展开其他 N 条回复 ›」仍在线程最底 ④ 暖心墙主评论/回复框位置 ⑤ 详情页主评论输入框在「浏览次数 ↔ N 条评论」之间、底部悬浮条已消失 ⑥ App（已装机）两段式评论输入正常。



  - **轮 112 · 详情页一级评论回复框上移到「一级评论 ↔ 二级列表」之间（2026-09-28，改动完成、测试全绿，待提交待部署——攒批；**APK 无需重打**，桌面专属）**：
     **用户原话（附截图，红框标出目标位置）**：「帖子详细页面的一级评论输入框：把一级评论回复框点击后出现在一级评论下面，二级评论上面，你现在是一级评论最下面。二级评论输入框不改。app端不改」。
     **改法（纯 DOM 搬家：零 CSS 改动、零逻辑改动）**：`PostDetailView.vue` 里一级就地回复框（`.cmt-input cmt-input-in`，`v-if="!isMobileNav && repActive === cm.id"`）从「整条一级评论最底部（`.replies-toggle` 之后）」搬到**本评论 `.cmt-acts` 操作行之下、`.cmt-reps` 二级列表之上**（与暖心墙轮 110 同款同位，两个视图口径终于一致）；二级就地框（`repActive === cm.id + ':' + rp.id`）仍在被回复那条二级评论下面不动；「展开其他 N 条回复 ›」（`replies-toggle`）仍在整个线程最底下；手机端仍走底部输入条（`!isMobileNav` 门禁原样）→ **App 零变化**。
     **验证**：undef **0** + tdz **0** + 全量离线 **37 套 0 fail**（退出码全 0）+ post-detail **17/17**（新增 1 条顺序断言：源码 `cmt-acts < 一级框 < cmt-reps < 二级就地框 < replies-toggle`）+ app-shell **43/43** + page-smoke **9/9** + vite build **0**。
     **桌面运行时取证（web-probe；宽门禁仅取证：`startReply` 首行 `if (!signedIn.value) return;` → `if (false && !signedIn.value) return;`，跑完按 Buffer 原字节还原并复验 `RESTORE_OK / GATES_BACK_OK` + 重构建）**：
     - 真实路径：暖心墙挑「有评论」的帖 → 点正文进 `/post/637`（14 条评论）。
     - 点**二级**正文（压测员35）→ 二级就地框 `insideReps: true`、`afterReply: true`（仍在二级列表里、紧跟被回复那条）✓ **位置未改**。
     - 点**一级**正文（压测员34）→ 一级框在位（占位「回复 压测员34…」、textarea + 「发送」键）→ DOM 顺序 `cmt-acts(A) < 框(B) < cmt-reps(B) < replies-toggle(B)` ✓、几何 `actsBottom 479 < boxTop 487 < repsTop 542`（框紧贴操作行下 8px、二级列表在框下方、`boxAboveReps: true`）✓、`boxLeftAlignedWithActs: 0`（框与一级正文/操作行左对齐）、`.cmt-input-row` **仅 1 个**（无重复框）✓。
     - 截图肉眼顺序：「**压测员34 → 〔回复 压测员34…〕发送 → 压测员35 / 压测员36 两条二级评论 → 展开其他 5 条回复 › → 压测员37**」。
     - 手机 390×844：点一级正文 → 内联框 **0** 个、底部输入条（`.cmt-main-bar`）**1** 个、卡内主评论框 `#detail-cmtmain` **0** 个 ✓（App 零变化）。
     **踩坑（本轮）**：① 探针脚本用精确串 `  if (!signedIn.value) return;\n` 匹配门禁命中 **0 处** —— 该文件是 **CRLF 行尾**，必须改用行锚定正则 `/^ {2}if \(!signedIn\.value\) return;\r?$/m`（同文件 381 行还有一条带尾注释的同前缀语句，绝不能用裸 `includes`/`split`）。② 首版探针点评论正文**不出框** → 真因是 `startReply` 第一行 `if (!signedIn.value) return;`（匿名点正文不弹框是**设计口径**，不是 bug）——这也是本轮必须放宽门禁才能取证的原因。
     **待用户验收（网页端详情页）**：① 一级评论点「回复」→ 输入框出现在该评论正文/操作行之下、二级评论之上 ② 二级评论的回复框仍在被回复那条下面（不变）③ 「展开其他 N 条回复 ›」仍在整个线程最底部 ④ 手机/App 形态零变化。

  - **轮 111 · 详情页桌面主评论输入框上移到「浏览次数 ↔ N 条评论」之间（2026-09-28，改动完成、测试全绿，待提交待部署——攒批；**APK 无需重打**，桌面专属）**：
     **用户原话（附截图，红框标出目标位置）**：「帖子详细页主评论输入框：放在评论按钮跟浏览次数按钮中间。跟上面的网页端1条一样。app端不改」。
     **改法**：① 详情页桌面新增卡内常驻输入框（`#detail-cmtmain` / `.cmt-input cmt-input-top`，与暖心墙轮 109 同款同位：`.post-foot` 之后、`.cmt-bar`/`.cmt-toggle` 之前），已登录 = 胶囊输入 + 「发布」（走新函数 `sendTopCmt()`：空草稿不发，其余沿用 `sendCmt()` 全套）；未登录 = 同址给「登录后即可评论」入口（`bar-signin` → `/profile`，原底栏同款）；② **轮 93 的桌面悬浮底栏 `cmt-bar-fixed` 正式退役**（模板块 + 全部样式 + `.cmt-box { padding-bottom: 56px }` 让位一起撤；`.bar-signin` 抽成独立规则保留），否则同页两个输入框；③ 手机端不动（`!isMobileNav` 门禁）——仍走轮 108 续4 的卡内占位条 → 底部输入条（`cmt-main-bar`）；④ 桌面回复框（`.cmt-input-in` 就地框）与 `repActive` 逻辑一字未动。
     **验证**：undef **0** + tdz **0** + 全量 36 套离线 **0 fail**（退出码全 0）+ post-detail **16/16**（新增 1 条位置断言）+ page-smoke **9/9** + vite build **0**。
     **运行时取证（web-probe 直开 /post/637；宽门禁仅取证：`v-if="signedIn"` → `v-if="true"` 保住 v-else 结构，跑完按 Buffer 原字节还原并复验 `RESTORE_OK / GATES_BACK_OK` + 重构建）**：
     - 桌面 1280×900（放宽=已登录态）：`#detail-cmtmain` 在位（class `cmt-input cmt-input-top`、textarea 占位「说点温柔的话…」、右侧「发布」键、无登录链接）→ DOM 顺序 `post-foot(A) < 框(B) < cmt-bar(B) < cmt-toggle(B) < cmt-box(B)` ✓、几何 `footBottom 305 < topTop 315`（框在浏览次数之下、评论行之上）✓、`cmt-bar-fixed` 不存在 ✓；截图肉眼顺序「**20 次浏览 · 👎0 → 〔说点温柔的话…〕发布 → 💬 0 条评论 ▾（默认/最新） → 评论区**」。
     - 还原后（真实匿名态）：同址变成「登录后即可评论」链接、无 textarea、无底栏 ✓（未登录不丢入口）。
     - 还原后手机 393×852：`#detail-cmtmain` **0 个**、评论区首部仍是 `.cmt-entry` 占位条（且是 cmt-box 第一个子元素、「说点温柔的话…」）、`.cmt-main-bar` 未弹、无底栏 ✓（App 零变化）。
     **踩坑（本轮）**：取证脚本第一版把 `v-if="signedIn"` 直接删掉 → `<router-link v-else>` 失去相邻 v-if，**vite build 直接报 `v-else has no adjacent v-if`**（构建挡住，未进产物）；改 `v-if="true"` 即可保住结构。教训：临时放宽模板条件时别破坏 v-if/v-else 配对。
     **待用户验收（网页端详情页）**：① 帖子卡「N 次浏览」与「💬 N 条评论」之间常驻主评论输入框 ② 输入后点「发布」评论落到列表 ③ 未登录在同位置看到登录入口 ④ 底部悬浮输入条不再出现 ⑤ 手机/App 形态不变。

  - **轮 110 · 网页端一级评论回复框上移到「一级评论 ↔ 二级列表」之间（2026-09-28，改动完成、测试全绿，待提交待部署——攒批；**APK 无需重打**，桌面专属）**：
     **用户原话（附截图，红框标出目标位置）**：「暖心墙一级评论输入框：把一级评论回复框点击后出现在一级评论下面，二级评论上面，你现在是一级评论最下面。二级评论输入框不改。app端不改」。
     **改法（纯 DOM 搬家：零 CSS 改动、零逻辑改动）**：一级就地回复框（`.cmt-input-rep`，`id=repbox-<帖>:<一级评论>`）从「整条一级评论最底部（`.replies-toggle` 之后）」搬到**本评论 `.cmt-acts` 操作行之下、`.cmt-reps` 二级列表之上**——点「回复」后框紧贴该条一级评论出现、二级评论在其下方继续，视线不用往下跳。二级就地框（`.cmt-input-rep-in`，挂在被回复那条二级评论下面）位置不动；手机端仍走底部输入条（`!isMobileNav` 门禁原样）→ **App 零变化**。
     **顺带**：`focusSelector` 注释按新位置更新（原文「二级回复的框挂在整层线程末尾」已过时——一级框不再在最底部）；滚动居中逻辑保留（防卡顶把框压出视口）。
     **验证**：undef **0** + tdz **0** + 全量 36 套离线 **0 fail**（退出码全 0；app-shell **43/43**，新增 **T42** 锁源码顺序 `cmt-acts < cmt-input-rep < cmt-reps < cmt-input-rep-in < replies-toggle`）+ page-smoke **9/9** + vite build **0**。
     **桌面运行时取证（web-probe 点真实「回复」按钮；宽门禁仅为取证，跑完按 Buffer 原字节还原并复验 `RESTORE_OK / GATES_BACK_OK` + 重构建）**：点第一条一级评论「回复」→ 框出现（`id=repbox-c637:c1056`、占位「回复 压测员34…」、textarea + 发送键齐、二级就地框 0 个）→ DOM 顺序 `cmt-acts(A) < 框(B) < cmt-reps(B) < replies-toggle(B)` ✓、几何 `boxTop 427 < repsTop 482`（框确实在二级列表上方）✓、截图肉眼确认顺序「**压测员34 → 操作行 → 〔回复 压测员34…〕发送 → 压测员35/36 两条二级评论 → 查看全部 7 条回复 ›**」。
     **还原后复验**：手机 393×852（17 张卡：`post-foot < cmt-entry < cmt-toggle`、顶部主评论框 0、占位条 17）零变化 ✓；桌面匿名点「回复」→ **不出框**（轮 91 未登录口径保留）✓。
     **待用户验收（网页端）**：① 一级评论点「回复」→ 输入框出现在该评论正文下、二级评论之上 ② 二级评论的回复框仍在被回复那条下面（不变）③ 手机/App 形态零变化。

  - **轮 109 · 网页端暖心墙主评论输入框上移到「浏览次数 ↔ N 条评论」之间（2026-09-28，改动完成、测试全绿，待提交待部署——攒批；**APK 无需重打**，只动桌面分支）**：
     **用户原话**：「暖心墙主评论输入框：放在评论按钮跟浏览次数按钮中间，每条都是；app端不改，只改网页端」。
     **改法（只动 `!isMobileNav` 分支，App 端渲染路径一字未动）**：① 桌面主评论内联输入框从 `cmt-box`（评论区首部）整体上移到卡内 `.post-foot`（浏览次数/厌恶）之后、`.cmt-toggle`（「N 条评论」）之前——与 App 端 `.cmt-entry` 占位条**同位**，且**每条卡常驻**（不进评论区也能写主评论）；② 新增 `sendTopCmt(p)`：空草稿不发也不展开（防误触把评论区扒开），发完 `sendCmt(p)` 后展开评论区（成功见新评论 / 失败看见 `cmtErr`），与 App 端 `sendMainBar` 同款语义；③ 草稿仍走 `cmtDraft[cmtKey(p)]`（与手机底部条同源，切视口不丢字）；④ `id` 由 `cmtbox-*` 改 `cmtmain-*`，`cmtInputSel` 兜底串两者都列（未登录云端帖该框不渲染 → 仍查评论区内的输入位，老口径不变）；⑤ 新类 `.cmt-input-top` 只加 `margin-top:10px`，形态沿用轮 102 的统一胶囊 `.cmt-input-row`；⑥ `cmt-box` 内只剩轮 91 的「未登录」提示（原内联框整块搬走）。
     **门禁沿用**：`v-if="!isMobileNav && (!p.cloud || signedIn)"`——手机端走轮 108 占位条+底部条（**App 零变化**）；未登录的云端帖没有可写输入位，桌面也不渲染（点「N 条评论」展开照旧只给登录提示，轮 91 口径不变）。
     **顺手修（假失败）**：feed-perf T29「离场没还回锚定」——本视图 `onUnmounted` 不止一处（轮 108 给底部输入条/监听兜底先注册了一个），原断言用 `indexOf` 只抓第一处 → 改成切出每个 `onUnmounted` 块、任一处置回锚定即过。
     **验证**：undef **0** + tdz **0** + 全量 36 套离线 **0 fail**（退出码全 0；app-shell **42/42**，含新增 T40 位置断言）+ page-smoke **9/9** + vite build **0**（`env-guard` 通过）。
     **双目检取证（web-probe + 截图，宽门禁仅为取证、跑完按原字节还原并复验 `RESTORE_OK / GATE_BACK_OK` + 重构建）**：桌面 1280×900 → 每张卡 DOM 顺序 `post-foot(A) < .cmt-input-top(B) < .cmt-toggle(B)` ✓、输入框内含 textarea + 「发送」钮、`id=cmtmain-*`，截图肉眼确认「**16 次浏览 · 👎0 → 〔说点温柔的话…〕发送 → 14 条评论**」；手机 393×852 → `.cmt-entry` 17 个、`.cmt-input-top` 0 个，顺序 `post-foot < .cmt-entry < .cmt-toggle` 与轮 108 完全一致（截图同上）✓；还原后重跑手机探针结果不变 ✓。
     **未登录口径**：桌面匿名态该框**按设计不渲染**（本次探针 17 张卡全为云端帖；`post-foot` 也只在 `p.cloud && p.stats` 时渲染，与本轮无关），展开评论区只见 `cmt-login` 登录提示、`.cmt-box` 内可写输入框 0 个 —— 与改动前一致、零回归。
     **待用户验收（网页端）**：① 每条帖子卡「N 次浏览」与「N 条评论」之间常驻主评论输入框 ② 输入并点「发送」→ 评论区自动展开、新评论可见 ③ 手机端/App 形态与轮 108 完全一致。

  - **轮 107 · 死代码清理 + 文档断档补录（2026-09-28，改动完成、测试全绿，待提交待部署——攒批；APK 需重打才有变化）**：
     读代码审计发现三处，用户发话「你先改这三个」：① **删除 `CommentComposer.vue` 孤儿组件**——轮 105/106 回退后全仓库无 import；且模板 `@click="insertAt"` 的 `insertAt` 从未被定义（`git log -S` 确认连 310f12c「☺@图标接入」那次也只加了按钮没加函数，接回去点 @ 就是死按钮），头部注释「不用 Teleport」与模板实际用 Teleport 相反；git 历史可找回。② **删除 `PostDetailView.vue` 的 composer 弹窗残留**（`composer` ref + `openComposerMain/openComposerReply/onComposerSend` 三函数，310f12c 加了 script 侧、模板从没接线，轮 106 定案内联框后为死代码）。③ **本文件补录轮 101-106**（此前只记在 git 提交信息里，其中 00156e8/9a0de65 为**空提交**）——根因：轮 104 起交付记录改用空提交 message 承载、没落进本文件，违反「本文件是唯一权威进度记录」约定；本轮起文档记录必须落在文件内。
     验证：undef **0**（SCANNED=69，删一文件后）+ tdz **0** + **全量 36 套离线 0 fail** + page-smoke **9/9**（--serve=dist）+ build-until-good **BUILD_GOOD**（入口 `index-BM5rKTEf.js`，slug ✓）。

  - **轮 106 · 评论输入定案：恢复轮 98 基线（2026-09-28，已提交 `bb93875`+`310f12c` / 已部署 `a2c7fa48` live-check 14/14 / APK `0C95FE4486FA1934` 装机+冷启动确认 ✅）**：
     轮 103-105「四处输入位统一弹窗/统一胶囊」连续返工后，**用户定案：App 端弹窗 / Web 端内联框，两平台不同输入方式**——PostDetailView/CommunityView 恢复到轮 98 基线（内联评论框工作状态）+ post-detail-test barSignIn 断言同步。轮 105 续三笔：regex 批量编辑破坏 div 嵌套（PostDetailView Invalid end tag）→ 从 d782fda 基线恢复重验 36 套全绿（0468638）→ 未登录提示回退 community.commentSignIn + T39/T2 断言回轮 98 口径（033b088/2b5d38f）。310f12c 顺手修 CommentComposer 本体（Teleport + ☺@图标接入——组件当时已无视图引用，轮 107 删除）。
     **教训**：① regex 批量编辑 .vue 模板两次破坏 div 嵌套——改动落盘后 page-smoke 必跑；② 交付记录写空提交 message 不写本文件 = 接手人断档（轮 107 修正）。

  - **轮 105 · 详情页评论/回复输入统一为暖心墙同款（2026-09-27/28，已提交 `3f9b543` + 续 `212f895`/`0468638`/`033b088`/`2b5d38f`；最终口径被轮 106 回退定案）**：
     ① 主评论输入框从 v-for 内移到评论区最前 ② 二级回复区补回 cmt-acts（轮 103 regex 误删）③ div 嵌套修复 ④ CommentComposer 弹窗保留 ⑤ app-shell T39 改弹窗口径 + uifix T2 字数行退役 + privacy P31/P32 修复。后续续笔回退大部分口径（见轮 106）。

  - **轮 104 · 详情页评论/回复输入统一（2026-09-27，已提交 `4fb4b22` / 已部署 `06ac3672` live 14/14 入口 SHA16 `53656f63ce36e944` / APK `C235EDAB04B88BDE` 装机+冷启动确认 ✅）**：
     ① 主评论输入框移到评论区最前（cmt-bar-fixed 退役）② 内联回复框去 !isMobileNav 门禁 ③ 底部回复弹窗条（reply-bar）退役 ④ 未登录评论区最前显示登录提示。轮 106 定案时 ①③④ 的部分口径回退（reply-bar/cmt-bar-fixed 回归）。

  - **轮 103 · 统一评论输入弹窗 CommentComposer（2026-09-27，已提交 `9a5ac3a`+`5d724e8`+`d782fda`+`6b027c4`+`0dc5b4e` / 已部署 `2604ddd1` live 14/14 入口 SHA16 `51a8de23e705027b` / APK `588E209DF3E23415` 装机+冷启动确认 ✅）**：
     新增 CommentComposer.vue（底部滑出面板：☺@图标 + textarea autosize + 发送）：四处输入位（墙主评/墙回复/详情主评/详情回复）全部改为弹窗，内联框全退役。续笔反复：加 Teleport to body（弹窗被 tabbar 盖住的根因=组件在 route-wrap 内受父级堆叠上下文限制）→ 关闭三保险（mask click/touchend + ✕钮）→ 重写去 Teleport（WebView 事件不冒泡）→ 再修 Teleport + ☺@图标。方案后被轮 104-106 迭代回退，组件成孤儿（轮 107 删除）。

  - **轮 102 · 四处评论输入框统一为详情页底栏同款胶囊（2026-09-27，已提交 `5463275`）**：
     `.cmt-input-row` 升级白底胶囊（背景 .92 白 + 描边 + 全圆角 + 左 14px 内边距），四处输入位与详情页底栏完全同款；n-input 统一 `:bordered="false"`；字数提示行全退役（maxlength=200 仍硬限制，ufix T2 断言翻转）；**顺手修真 bug**：flex-wrap 容器里 `.cmt-input-row` 无宽度约束被压到 110px（输入框只剩 24px 圆圈）→ 补 `width:100%+box-sizing`。web-probe 393px 视口目检截图确认。

  - **轮 101 · App 图标更换 + 轮 98+100 装机收尾（2026-09-27，已提交 `924b92f` / 轮 98+100 同包：提交 `9824b6d` / 部署 `396d4259` live 14/14 / APK `859A1A654C07048C` 装机 Success + 冷启动前台确认 ✅）**：
     新增 `tools/make-app-icon.mjs`（参照 make-og 自包含生成器）：设计源图目检校准裁切 → 512 母版圆角蒙版 → 传统 ic_launcher 48~192（白底压平）+ 圆形裁切 + 自适应前景 108dp×5 密度（居中 66% 安全区）；背景色 #FF8E63→#FFF7EE（与主题一致）。**sharp 管线坑**：composite 在管线最后（resize 之后）才执行——蒙版必须按 resize 后尺寸生成，否则居中小蒙版把放大图裁成中间一小块。

  - **轮 100 · App 底栏「暖心墙」再点 = 刷新（2026-09-27，已提交 `9824b6d` / 已部署 `396d4259` / APK `859A1A654C07048C` 随轮 101 装机 ✅）**：
     **用户反馈**：App 在暖心墙页面时，点底栏「暖心墙」文字本来就是刷新，现在点了没反应。
     **根因**：底栏 tab 是普通 `router-link to="/community"`，已在 /community 时再点 = 同路径导航被 vue-router 忽略，什么都不会发生。
     **修法**：① TabBar 对 community tab 加 `onTabClick` —— 已在本页时 `preventDefault` 并推 `{ path: "/community", query: { refresh: 时间戳 } }`；② CommunityView 监听 `route.query.refresh` → `loadCloud({ fresh: true })` 强制取新第一页 + 平滑回顶部（与下拉刷新同一条 fresh 路径）。
     **验证**：全量 36 套离线 0 fail + undef/tdz **0** + page-smoke **9/9** + build 0。真机手感待装机验收。

  - **轮 98 · 回复框统一收尾（2026-09-27，改动完成、测试全绿，待提交待部署——攒批；APK 需重打）**：
     **用户反馈（附截图）**：墙内回复框（回复 压测员04 那个大框）也要改成目标样式——不是一点击就三行、去掉取消、去掉字数行。
     **改法**：① 墙内两个回复框（cmt-input-rep / cmt-input-rep-in）去「取消」+ 去字数行，与主评论框完全一致（textarea autosize 1~4 行 + 发送在右）；② 详情页回复弹窗条去「取消」+ 字数行，minRows 3→1（maxRows 4，一行起步自动扩行）；③ 关闭路径：openReply/openReplyTo/startReply 加 toggle —— 再点同一条的「回复」即收起该框（取消钮没了以后的无按钮关闭路径）。
     **验证**：全量 36 套离线 0 fail + undef/tdz **0** + page-smoke **9/9** + build 0。

  - **轮 97 · 四处评论输入框统一样式（2026-09-27，已提交 `89aa260` / 已部署 `e7531035` / 已装机 APK `EF08876CD66ACBC5`）**：
     **用户反馈（附截图）**：暖心墙所有评论输入框（①墙内帖子下 ②墙内评论下 ③详情页 ④详情页评论下）都改成截图那种——发送键常驻右侧，输入超过一行自动扩行。
     **改法**：四处的 n-input 统一为 `type="textarea" + :autosize="{ minRows: 1, maxRows: 4 }"`（手机回复弹窗条 minRows 3 / maxRows 6），发送键放在输入框右侧（`.cmt-input-row` 行内布局）；移除 Enter 误发送（Enter=换行）；轮 96 的点击展开态（cmtFocus/barFocus + .open 规则）退役——autosize 按内容自动扩行更符合直觉。
     **验证**：全量 36 套离线 0 fail + undef/tdz **0** + page-smoke **9/9** + build 0。

  - **轮 96 · 返回崩溃修复 + 评论输入点击展开（2026-09-27，已提交 `89aa260` / 已部署 `e7531035` / 已装机 APK `EF08876CD66ACBC5`）**：
     **用户反馈**：① 点详情页再返回出崩溃盒「这里有点小状况」，要点击刷新页面；② 评论输入框没点击一行没问题，点击之后还只有一行；③ 墙内评论发送键要像详情页一样放输入框右边。
     **真崩溃修复**：轮 95 的 `restoreTick`（恢复期拦自动重拉的开关）**漏声明** —— 4 处使用 0 处声明，ESM 严格模式赋值未声明标识符直接 ReferenceError，`restoreFeed()` 在返回挂载时必炸 → App.vue 错误边界接住 = 崩溃盒。**为什么 undef-check 没报**：赋值藏在函数声明内的嵌套 nextTick 回调里，2b 扫描存在盲区（待查/补样本）；page-smoke 也不覆盖「离开→返回」的交互路径。已补 `let restoreTick = false`。
     **输入框点击展开**：墙内发评输入框与详情页底栏都改 `type="textarea"` —— 未点击 1 行，点击/聚焦 3 行（失焦且有文字保持展开、空则收回一行）；详情页展开时胶囊变圆角矩形、「发布」键落右下；Enter=换行不误发送。墙内发送键改行内布局落输入框右下（与详情页一致）。
     **验证**：全量 36 套离线 0 fail + undef/tdz **0** + page-smoke **9/9** + build 0。返回路径的真机交互待装机验收。

  - **轮 95 · 详情页返回暖心墙恢复浏览位置（2026-09-27，已提交 `5876181` / 已部署 `0e7d5b2b` / 已装机 APK `F0573E2E5D439F52`）**：
     **用户反馈**：暖心墙点帖进详情页，点返回只回到暖心墙顶部，没有回到之前浏览的位置。
     **根因**：组件重挂载 → 列表只剩第一页、滚动归零、虚拟窗口高度表（实测高度）清空 —— 哪怕浏览器想恢复位置，内容高度也对不上。
     **修法（手动存/恢复，不用 keep-alive——避免动 App.vue 的转场/壳结构）**：① 模块级 `savedFeedPos`（plain `<script>` 块声明，跨实例存活）；② 离场（onUnmounted）存：scrollY / reveal / feedCursor / cloudDone / newestSeenTs / **整份已加载列表** / **实测高度表克隆**；③ 返回挂载时 `restoreFeed()`：整份列表+高度表+游标原样恢复（自动重拉被 restoreTick 拦两个 tick，存档列表不被第一页覆盖）→ holdAnchor 包住 `scrollTo(0, y)` → feedTick 按恢复的高度表重算窗口 —— 占位块零漂移，位置精确；④ 新发的帖/刷新照旧可用（恢复是一次性的，存档用后即清）。
     **验证**：全量 36 套离线 0 fail + feed-window **19/19** + undef/tdz **0** + page-smoke **9/9** + build 0。真机手感待装机验收。

  - **轮 94 · 评论透明化 + 底栏按截图微调（2026-09-27，已提交 `5876181` / 已部署 `0e7d5b2b` / 已装机 APK `F0573E2E5D439F52`）**：
     **用户反馈（附截图）**：① 帖子内部评论改成截图那种透明样式（不要评论卡片框）；② 底栏照截图微调。
     **改法**：① `.cmt-item` 去背景/描边（墙+详情页同改；回复的左缩进引导线保留）；② `cmt-bar-fixed` 去头像、「发布」键常驻右侧（复用 community.post 词条）、底栏改浅白半透明；轮 91 的展开钮透明保持。
     **验证**：全量 36 套离线 0 fail + post-detail **15/15** + undef/tdz **0** + page-smoke **9/9** + build 0。

  - **轮 93 · 详情页评论输入改常驻底部输入条（2026-09-27，已提交 `5876181` / 已部署 `0e7d5b2b` / 已装机 APK `F0573E2E5D439F52`）**：
     **用户反馈（附截图）**：帖子下面评论输入框改成截图那种——不要嵌在评论列表里的那种。
     **改法**：① 删除 cmt-box 内嵌的输入框/登录提示（轮 90 版）；② 新增 `cmt-bar-fixed` 固定底栏：头像 + 圆角输入（placeholder 说点什么吧…/comment.placeholder）+ 发送键（有文字才出现），未登录显示「登录后即可评论」入口（comment.barSignIn，中英成对）；③ 位置：移动端固定在 tabbar 之上 `calc(64px+safe-area+8px)`，桌面（≥900px）居中悬浮 bottom 16px、宽度对齐 .shell；④ 与回复弹窗条互斥（repActive 时输入条让位）；⑤ cmt-box 底部留 56px 让位，最后一条评论不被盖住。post-detail-test 未登录断言从 commentSignIn 改为 barSignIn。
     **验证**：全量 36 套离线 0 fail + post-detail **15/15** + i18n **19/19** + undef/tdz **0** + page-smoke **9/9** + build 0。

  - **轮 92 · 暖心墙下滑空白压小（2026-09-27，已提交 `5876181` / 已部署 `0e7d5b2b` / 已装机 APK `F0573E2E5D439F52`）**：
     **用户反馈**：App 几个页面下拉之后没有内容、到底部有大空隙。**真机 CDP 实测（临时探针 tools/_gap-probe.mjs，用完即删）**：/community 底部 feed-pad 一度 **13280px**（/pet /profile /messages /notifications /my-posts 均 scrollH≈内容底，无异常空隙）——「大空隙」只发生在暖心墙长列表，来源是轮 82 虚拟窗口：overscan=6 = 视口外上下各 6 张（约 2000px）渲染缓冲，App 快速甩动一次就冲出渲染区，落进几千像素的空白占位。
     **修法**：`DEFAULT_OVERSCAN` **6 → 14**（上下各约 4 屏缓冲，甩动后大概率落在已渲染内容上；DOM 卡片 ~37 张仍在 60 上限断言内，feed-window-live 的 WINDOW_MAX=60 不变）。
     **验证**：全量 36 套离线 0 fail + feed-window **19/19** + feed-perf **27/27** + undef/tdz **0** + page-smoke **9/9** + build 0。真机甩动手感待装机验收。**诊断附注**：真机 CDP 需亮屏（锁屏冻结渲染进程会超时/假数据），本次用 `svc power stayon usb` 保持常亮完成测量。

  - **轮 91 · 评论输入位置/样式统一（2026-09-27，已提交 `b5f7375` / 已部署 `f5b8e461` / 已装机）**：
     **用户反馈**：① 墙内点评论后输入框为什么不跟详情页一致；② 详情页点回复后输入条太小没法输入、样式丑；③ 「展开其他 N 条回复/查看更多评论」不要底色框，融入背景。**（⋯ 与帖子右侧对齐一条用户撤回不做）**
     **改法**：① 墙内 cmt-box 的输入框三态（登录提示/常驻输入）移到评论区最前（与轮 90 详情页同构），删除「写评论」解锁路径（cmtCompose/cmtComposeOpen/openComposer 退役）——手机端开箱即见输入框但不自动聚焦（轮 74 口径保留）；② reply-bar 输入改 `type="textarea" :rows="3"`、去掉 `size=small/round`、字号 14px、去 keyup.enter（Enter=换行不误发送），内边距加大；③ `.replies-toggle`/`.cmt-viewmore` 去底色（background: none、灰字 + › 箭头、hover 变暖）。
     **验证**：全量 36 套离线 0 fail + undef/tdz **0** + page-smoke **9/9** + build 0。

  - **轮 90 · 详情页微调（2026-09-27，改动完成、测试全绿，待提交待部署——攒批；APK 需重打）**：
     **用户反馈**：① 详情页点开评论后，发评论的输入框应该放最前面（原来在整列评论最底部，手机上要滑到底才能发言）；② 浏览次数先留着（撤回轮 90 初版的删除计划，未动任何 views 代码）；③ 评论的「默认」排序不应滤掉 7 天外的评论——「它又不是帖子」，推荐池是帖子信息的口径。
     **改法**：① cmt-box 内输入框（登录提示/发评输入二态）移到评论区最前，其后才是错误/载入/评论列表/查看更多/空态；② 无改动；③ `tops` 去掉 `recommendPosts`（import 一并移除）——默认 = 加载顺序直出（旧→新，与墙内评论一致），「最新」= 时间倒序；SORT_MODES 不变（["default","new"]）。
     **验证**：全量 36 套离线 0 fail + comment-test **35/35**（R6 文案更新）+ post-detail **15/15** + undef/tdz **0** + page-smoke **9/9** + build 0。

  - **轮 89 · 墙内回复跳详情定位 + 详情页展开/回复修复（2026-09-27，已提交 `b5f7375` / 已部署 `f5b8e461` / 已装机）**：
     **用户反馈**：①（早前需求补做）App 暖心墙里二级评论超过可见数时，「展开回复」应该跳到帖子详情页（带参数），详情页直接展开那一条一级评论的二级回复；② 详情页一级评论点「展开其他 N 条回复」展不开；③ 详情页点回复也没反应。
     **真因**：②③ 同源 —— `visibleReps` 在 script 作用域写成 `repOpen[cm.id]`（ref 当普通对象读，少 `.value`）→ 恒为 undefined → 回复列表永远只渲染前 2 条；展开钮标签会切换但列表不动；用户新发的回复（第 3 条起）也被藏住 → 看起来「回复失败」。这类「ref 少 .value」undef/tdz/page-smoke 都不执行组件交互，抓不到，靠真机交互验收。
     **修法**：① `repOpen.value[cm.id]` 修正；② 墙内按钮改「查看全部 {n} 条回复 ›」→ `goDetailReplies(p, cm)` 带 `?cid={dbId}` 跳详情页；③ 详情页 `focusTargetComment()`：切「最新」排序（推荐池会滤掉 7 天外评论）→ `repOpen` 展开目标线程 → `cmtReveal` 撑到目标位 → `scrollIntoView` 居中定位 + `.cmt-focus` 描边高亮；一级评论挂 `id="cmt-{dbId}"` 锚点。i18n comment.viewAllReplies 新增（中英成对）。
     **验证**：全量 36 套离线 0 fail + i18n **19/19** + undef/tdz **0** + page-smoke **9/9** + build 0。

  - **轮 88 · 回复展开/收起钮移到回复列表底部（2026-09-27，已提交 `b5f7375` / 已部署 `f5b8e461` / 已装机）**：
     **用户反馈（附参考截图）**：「N 条回复 ▾」原来挤在评论操作行里，要改成主流社区样式——移到回复列表底部，胶囊按钮「展开其他 N 条回复 ›」。
     **改法**：① 两个视图（墙 + 详情页）删操作行里的旧钮（cmt-acts 只留时间/回复/回应）；② 回复列表（cmt-reps）下方新增 `replies-toggle` 胶囊钮——收起态「展开其他 {n-2} 条回复 ›」（n=回复总数、可见 2 条），展开态「收起回复」，点击语义与轮 50 一致；③ i18n：comment.expandOthers/collapseReplies 新增（中英成对）、comment.replies 退役删除；④ post-detail-test 钉住的 comment.replies 断言同步为 expandOthers。
     **验证**：全量 36 套离线 0 fail + post-detail **15/15** + i18n **19/19** + undef/tdz **0** + page-smoke **9/9** + build 0。

  - **轮 87 · 暖心墙/详情页六项修复（2026-09-27，已提交 `928c79b` + 已部署 Version `7701fd8e` + 已打包 APK `C8F2D7F9AC4494E9`（未装机））**：
     **用户实测反馈六条**：① 帖子/评论 `⋯` 菜单点举报/拷贝无反应；② 心/碎心 emoji 太艳丽 → 改空心灰；③ 详情页「最热」去掉 → 「默认」=推荐模式（与暖心墙帖子排序同源）；④ 详情页评论默认展开 + 一级 15 条下滑续展 + 「查看更多评论」（二级仍默认两条）；⑤ 详情页二级评论 >1 条后无法评论；⑥ App 回复框逐条内联手机没法用 → 统一底部输入条。
     **修法**：① 真因 = 全屏遮罩被 `.card` 的 backdrop-filter 堆叠上下文盖住菜单（z-index 出不来，点击全被吞）→ 两个视图去掉遮罩，改 **document 级点击收起**（触发钮 `.stop` 不误关，菜单项动作后冒泡收起）；② emoji 换**内联 SVG 描边心 + 裂纹心**（灰、无 iconify CDN 依赖），点亮 = 深一档灰 + 细描边；③ SORT_MODES=["default","new"]，视图层默认用 `recommendPosts`（7 天池按天洗牌，与帖子同源），sortComments 去 hot 分支，i18n sortHot→sortDefault（中英成对）；④ `openCmt=true` + `load()` 自动拉取 + `cmtReveal=15` + scroll 被动监听接近底部续 15 条 + 「查看更多评论」按钮（二级回复轮 50 口径不变）；⑤⑥ 手机端（isMobileNav）点「回复」改**统一底部输入条**（固定 tabbar 之上 `calc(64px+safe-area)`，取消/发送在右下角，`repActive` 反查 cm/rp 目标，弹出自动聚焦）——回复数多少都不再影响，桌面保持就地内联框。
     **验证**：全量 36 套离线 0 fail + comment-test **35/35**（R6 改 SORT_MODES 口径）+ undef/tdz **0** + page-smoke **9/9** + build 0 + live-check **14/14**（部署后）。

  - **轮 86 · SEO ①c 帖子注入壳 + ⑥ /zh/* 中文预渲染+hreflang（2026-09-27，已提交 `5de652f` + 已部署 Version `754d910a`；前端有改 → **APK 需重打包机等发话**）**：
     **①c**：`/post/:id` 存在性检查升级为取整行（`getPostRow`，removed 400 降级口径不变）——Worker 把帖子标题/正文/作者/日期注入壳的 title/description/canonical/og:url/og:title/og:description（带图帖 og:image → Storage 公网 URL），正文包 `.seo-static`（真人首帧前隐藏、爬虫可读）；家页 hero 整块替换避免每帖带家页文案；HTML 全转义、标题压平换行；ROOT_DESC/ROOT_TITLE 与 vite.config 同源互指（坑 #28 口径）。**开发中真缺陷**：content 模板 `${img}` 引用了不存在的变量（实际叫 `imgUrl`）→ ReferenceError 被 catch 吞掉返回已消费的 body——undef-check 查不到（非导出符号），worker-test 读了响应体才现形。
     **⑥**：seoRoutes 抽 `bakePage` 装配器（en/zh 共用 title/canonical/og/desc/正文/hreflang），生成 `/zh` + `/zh/pet` + `/zh/community` + `/zh/profile` + `/zh/privacy`（html lang=zh-CN、中文 title/desc/canonical、隐私政策 zh 整页 `privacyStaticHtml("zh")`，文案全部取自 zh 词条）；en/zh 每页 hreflang en↔zh + x-default 全组（home 保留尾斜杠口径，T9）；router 加 `/zh/*` alias ×5；i18n.js 按 pathname 强制 zh（只影响本次视图，不覆盖 wp-lang 语言存档；Node 守卫）；sitemap 固定页加 5 条 /zh/*（共 10 固定 + 100 帖）。
     **线上探针实测**：`/zh/community` → `<title>暖爪 · 暖心墙</title>` + hreflang 全组；`/post/678` → `<title>啧啧啧 · Warm Paws</title>` + canonical `/post/678`；sitemap **110 条**；live-check **14/14**；入口 SHA16 `63a5a8c18511df67` 本地=线上。
     **验证**：worker-test **224/224**（①c 注入 8 项）+ seo-test **50/50**（T36~T43）+ privacy **33/33**（P1 正则放宽容忍 alias）+ page-smoke **9/9**（+ /zh/community）+ undef/tdz **0** + 全量 36 套 0 fail + build 0。

  - **轮 85 · SEO 组合三件套（2026-09-27，已提交 `1373421` + wrangler.jsonc 补 `/sitemap.xml` 后重部署 Version `f9db3563`；纯 Worker 侧，dist/APK 零变化无需重打）**：
     **背景（SEO 咨询的落地）**：站点已进 GSC+sitemap，但帖子详情 `/post/:id` 深链此前返回**真 404**（无预渲染文件、不在 run_worker_first）——帖子是站上最大的长尾内容，Google 一个字都收不到；/u/:id 他人主页是薄内容壳会稀释质量；sitemap 只有 5 个固定页。
     **改法**：①b `run_worker_first` 加 `/post/*`，Worker 回壳前**先查帖子存在性**（`postsQuery` 带 removed 列 400 降级重试，与单帖接口同口径）——查无/上游挂/非数字维持**真 404**（软 404 是轮 11 定案红线，绝不放水）；③ `/u/:id` 壳就地替换 robots meta 为 **noindex, follow** + 抹 etag（body 已变）；② `/sitemap.xml` Worker 拦截：固定 5 页 + 最新 100 帖 `/post/:id` 深链（lastmod=发帖日、order=id.desc、removed 过滤），origin 取请求本身（换域名零改动），上游挂降级为只含固定 5 页的合法 XML。
     **首次部署的翻车与修正**：`/sitemap.xml` 忘加进 `run_worker_first` → 静态资产优先直出、Worker 分支根本没跑（线上探针实测还是 5 条静态）→ 补上重部署。live-check 的「sitemap 恰好 5 条」断言同步改成动态口径。
     **线上探针实测**：`/sitemap.xml` **105 条**（5 固定 + 100 帖）；`/post/678` → 200 壳；`/post/999999999` → 404；`/u/test` → `noindex, follow` 注入 ✓；live-check **14/14**。
     **验证**：worker-test **214/214**（新增 13 项）+ seo **42/42** + 全量 36 套离线 0 fail + undef/tdz **0** + page-smoke **8/8** + build 0。**APK 无需重打**（纯 Worker 侧，dist 未变）。

  - **轮 84 · 评论互动与详情页（2026-09-27，已提交 `7271ce0` + 已部署 Version `5c82e4e9` + 已装机 APK `459BDEAFD36D346A`；迁移已执行——探针实测表 200/`RPC auth-required` 正常）**：
     **需求（用户原文口径，App 与网页端同改——同一份 dist，APK 等发话重打）**：① 墙内点帖进详情页；评论只显前 3 条一级评论，更多 → 「查看更多」跳详情。② 评论行：时间移到「回复」左侧，「回复」右边加 ❤️心/💔碎心（带计数）。③ 详情页评论排序「最新/最热」（最热=心最多；最新只看一级评论时间），按钮在评论标题右侧。④ 评论右上角 … → 举报（原入口迁入）+ 拷贝内容。⑤ 帖子右上角（昵称右）… → 举报 + 拷贝内容。
     **改法**：① 库：`MIGRATION_comment_reactions.sql`（⚠ **待用户在 SQL Editor 执行，幂等、整份粘贴**）——`wall_comments` 加去归一化计数列 `hearts/brokens` + 明细表 `wall_comment_reactions`（主键 (comment_id,user_id,kind) 天然去重）+ RLS（全员可读/登录写删自己的）+ RPC `wall_toggle_comment_reaction`（security definer，服务端算权威计数并回写列，返回 {ok,on,hearts,brokens}）+ `notify pgrst`；`SUPABASE_SETUP.sql` 已同步。② Worker：`/api/comments/reactions?ids=`（批量明细）、`/api/comments/reactions/mine?ids=&user_id=`（我点过的）、`/api/comments/react`（POST → RPC；非法 kind 400、缺 user_id 400）。③ db 双模式成对加三方法（`listCommentReactions`/`listMyCommentReactions`/`toggleCommentReaction`；supabase 侧 `T` 表名映射补 `commentReactions`——漏了会被 api-contract 抓成 from:undefined）+ `wall.js` 包装两层。④ `rowsToComments` 带出 `reacts:{heart,broken}`（旧库没跑迁移 → undefined，reactCount 归 0 不炸）。⑤ 纯函数（comments.js）：`reactCount`（脏数据归 0）/`hasReacted`/`toggleReact`（**修掉一处真缺陷**：初版只从被点击的 kind 重建 myReacts，会把另一种已点亮的悄悄丢掉——与 RPC 按 kind 独立切换的语义矛盾）/`sortComments`（hot：心→碎心→时间倒序）/`wallTopComments`/`hasMoreComments`/`postCopyText`/`commentCopyText`。⑥ CommunityView：正文/图加 `go-detail` 点击进详情（无 dbId 的示例/本地帖不响应）；`listFor` 截前 3 条 + 「查看更多」；评论行改版（时间入 acts 行首、❤️/💔、⋯ 菜单）；帖子/评论 `⋯` 菜单（举报迁入 + 拷贝，全屏透明遮罩点空白收起；post-foot 举报按钮移除——report-test 钉住的 openReport*/canReport* 函数全保留）。⑦ PostDetailView：`cmt-bar`（评论标题左 + 最新/最热右，`sortComments` 只排一级）；评论行改版同墙；帖子/评论 ⋯ 菜单。⑧ i18n zh/en 成对：comment.likeT/brokenT/sortNew/sortHot/more + common.copy/copied/copyFail + community.viewMore。⑨ 新增 `src/utils/clipboard.js`（navigator.clipboard → execCommand 兜底，App WebView 可用，坑 #27 同思路）。
     **顺手修**：字体 CDN 的阻塞样式挡脚本执行——jsdelivr/googleapis 慢/挂时 Vue 迟迟不挂载（page-smoke 全红复现，也是网页端「先见英文占位页」的根源之一），两个字体 `<link>` 改 `media="print" onload=this.media='all'` 异步化 + `<noscript>` 兜底（**改完 page-smoke 8/8 立即恢复**，见踩坑 #38）。
     **验证**：comment-test **35/35**（新增 R1~R9）+ api-contract **87/87** + gateway-contract **71/71** + worker-test **201/201**（新增 5 项）+ report **61/61** + post-detail **15/15** + app-shell **40/40** + i18n **19/19** + **全量 36 套离线 0 fail** + undef **0** + tdz **0** + page-smoke **8/8** + build 0。feed-window-live 未跑（需 dev 服务器+真机 CDP；本轮未动虚拟窗口逻辑）。
     **待办**：① ~~用户执行迁移~~（✅ 已执行，探针实测：`/api/comments/reactions?ids=1` → 200 `[]`、anon 调 RPC → `auth-required` 即函数就绪）② ~~攒批提交/部署/重打 APK~~（✅ `7271ce0` / `5c82e4e9` / APK `459BDEAFD36D346A` 装机 Success）③ 验收口径：离线+契约两层已过；线上端到端（真实点赞落库/权威计数回写/拷贝）待用户真机验收。

  - **轮 83 · 网页端刷新按钮 + 首帧静态占位修复（2026-09-26，已提交 `cd73fe2` + 已随批部署 `757a4fac` + 已装机 APK `307438B28DBA2143`）**：
     **背景**：轮 64-80 的下拉刷新只认 touch 事件，**桌面网页没有触屏够不着**；另外「打开网页先看到一段英文占位/裸链接才进正页」——那是构建期写进 `#app` 的 SEO 静态正文在 Vue 挂载前裸露（CSS 慢时更是无样式裸奔）。
     **改法**：① 排序行右端补刷新按钮（`class=wall-refresh`，`@click=manualRefresh` → 与下拉同一条 `loadCloud({ fresh: true })` 强制取新路径；`loadingCloud` 期间禁用），App 壳内隐藏（有原生下拉）——`html.cap-app` 规则，i18n `community.refreshBtn` 中英成对；② `index.html` 首帧前内联：`html.js .seo-static { display:none !important }` + `html.js body { background:#fff4e8 }`（CSS 未就绪窗口期不白屏），`vite.config.js` 把预渲染正文**包一层 `.seo-static`**——真人首帧前就隐藏、挂载后 Vue 接管，无 JS 的爬虫没有 `js` 类照常读到正文（SEO 不受影响）；**不能直接给 `<section>` 加类**（`cap-strip-hero` 按 `class="card seo-hero"` 原文匹配，动了 APK 剥离会静默失效）。
     **验证**：新增 web-refresh-test **6/6** + seo-test **42/42** + page-smoke **8/8** + i18n **19/19** + 本地 build 0。

  - **轮 82 · 动态流 B 档：虚拟窗口（2026-09-26，已提交 `43d3021` + 已随批部署 `757a4fac` + 已装机 APK `307438B28DBA2143`）**：
     **背景**：A 档只让屏外卡片「跳过渲染」，**几百条帖子仍全挂 DOM**（节点数、内存、滚动合成面积都随帖数线性长）。
     **改法**：只渲染视口附近 **~16 张卡**（`pageItems = shownPage.slice(winStart, winEnd)`），上下放 `.feed-pad` 占位块撑住滚动高度；高度表（前缀和 + 二分定位）按**真实 `getBoundingClientRect`** 长出来，只有深链跳转时吃 `DEFAULT_EST` 并按锚点位移补偿一次；近底续载从 `IntersectionObserver` 哨兵改为 **`nearEnd()` 计算**（有占位块后哨兵会被推到几万像素外，永不触发）；短列表（≤ `WINDOW_ON_THRESHOLD`）走回退分支（窗口 = 全部、占位清零）。
     **真机取证修掉三处真缺陷**（`tools/feed-window-live.mjs`，300 条本地帖分段下滚量几何）：① **卡距**：`POST_GAP` 写死 18，而 CSS 手机断点是 **12**（`.shell--mobile-nav .card`）→ 改从真卡片 `getComputedStyle().marginBottom` 现读、读不到才回落常量（几百条后累计串位）；② **估高**：写死 340 而 `.post-card` 的 `contain-intrinsic-size` 是 **320** → 20px × 窗口尾部十几张 = **138px 可见空档**，改成 `FEED_EST = DEFAULT_EST` 只留一条链（T17/T23 断言三者严格相等）；③ **`overflow-anchor`**：全局 `none` 关错了范围（真机 `scrollTo(0,0)` 被拽回 39k）→ 只在「程序式跳转」那一小段交出锚定、卸载时还原原值；顺带发现 `lastScrollAt` **从来没人写**（守卫恒为假 = 形同虚设）。
     **顺手补的防线**：`undef-check.mjs` 新增第 2b 类检查（「赋值给本文件从未声明的裸标识符」——**本轮真凶**：`prevAnchor = …` 漏了 `let`，ESM 严格模式下 `ReferenceError` 让 `onMounted` 整段中断，界面却「看着正常」只有首屏十几条）+ 自带 `--selftest` **10/10**（九类假红样本 + 一类真缺陷样本一起钉住：初版整文件扫刷出 365 条假警报）。
     **验证**：feed-window **19/19**（纯逻辑）+ feed-perf **27/27**（含 B 档接线 11 项）+ feed-window-live **10/10**（DOM 卡片 ≤16 张 / 视口内零空档 / A→B→A 复访同内容 / 回顶不白屏 / 控制台无异常）+ undef **0** + tdz **0** + page-smoke **8/8** + 全量 36 套离线全绿 + build 0。
     **待用户验收（亮屏，部署后）**：长列表快速上下滚**不白屏不跳位**、一直下滑始终能续新帖、从通知点「评论」跳回来能正确定位（不再拽回顶部）。

  - **轮 81 · 动态流 A 档性能（2026-09-26，已提交 `adc9974` + 已随批部署 `757a4fac` + 已装机 APK `307438B28DBA2143`）**：
     **改法**：① 屏外卡片跳过 style/layout/paint —— `.post-card { content-visibility:auto; contain-intrinsic-size:auto 320px }`（**必须写占位高度**，否则屏外卡片高度塌成 0、滚动条乱跳）；② 列表图 `loading="lazy"` + `decoding="async"` + `.pic` 未解码前给占位底色（无图帖仍受 `v-if="p.img"` 保护）；③ 时间文案记忆化 —— `memoWhen(fmtWhen)`（同一批帖子滚动时不再每帧重跑 `toLocaleString`，非法时间仍返回空串且可缓存）。
     **验证**：feed-perf-test **16/16**（A 档：CSS 断言 + 接线断言 + memoWhen 行为与参数透传 + 用例注册位置自检）。

  - **轮 80 · 陈旧 dist 系统性事故修复（2026-09-26，已部署 9946c57b + 已装机 APK 9DA84059319DDA50）**：
     **用户报障**：「sb，我他妈现在刷新根本不动」。CDP 连真机取证：/community 挂载后渲染 **0 张卡**（库里 520 条帖都在——CLEANUP SQL 未执行）。
     **系统真因（本会话最大事故）**：轮 77 的 try/finally 补丁在 CommunityView **函数闭合外留下孤儿代码块**（复制了一份评论数逻辑）→ **此后每次 vite build 都语法失败（Unexpected token 233:2）**，而构建输出被 grep 过滤只看到 env-guard 两行 → 误判成功；轮 73(崩溃修复)/轮 78(英文)/轮 79(换一批) 的**部署全部发的是 03:54 旧 dist**——jiaojie 里那些「已部署」记录为假。page-smoke 持续 8/8 的原因：旧 dist 能挂载（newestSeenTs 崩溃在异步 loadCloud 里，不触发 crash-box）。
     **修法**：①删孤儿块 → **build 成功**（新入口 chunk `index-CB4a4YgL.js`）→ 部署 **9946c57b**（live-check 14/14 + 入口 SHA16 `8c85a5957972063d` 本地=线上）→ cap sync → APK `9DA84059319DDA50` 装机 Success；②流程强制（写入 0.6）：**build 输出必须看完整 tail 或用 build-until-good.mjs**、deploy 后 bundle SHA 必须与本轮源码构建产物一致、jiaojie「已部署」必须附 chunk 名。
     **待用户验收（亮屏）**：①暖心墙下拉 → 「刷新中…」→ 换一批/新增提示，**内容真的会变**②下滑到底自动翻页③消息页无错误盒④发帖页信纸样式⑤英文 UI。

  - **轮 74 · 启动页语言跟随（2026-09-26，已部署 90f03aaf + 已装机 APK C3F39BE5B8E5CFF3）**：
     **用户原话**：「启动页，当语言是英文的时候，怎么还是中文启动页」。
     **根因**：启动页是 index.html 的**静态层**（i18n 加载前就要显示），全部文案硬编码中文——英文用户的启动页自然是中文。静态层无法调用 i18n，只能在渲染时自行判语言。
     **改法**：启动页标记后插入内联脚本——读 `wp-lang` 存档（用户手动选过优先），否则按系统语言（zh→中文、其余→英文）；英文时替换全部启动页文案：名称 Warm Paws / 副题 A gentle place to be / 口号 A gentle corner / 三条特性（Care for a little pet / Bottle up your thoughts / Meet gentle people on the Wall）/ 温柔话。脚本同步执行在首帧前，不会闪中文；任何异常保持中文默认。
     **验证**：splash-test 20→**21/21**（+语言跟随断言）+ i18n **19/19** + page-smoke **8/8** + build 0；已部署（live-check 14/14）+ APK 装机 Success。
     **待用户验收（亮屏，语言切英文）**：启动页全英文。

  - **轮 78 · 英文 UI 精修（2026-09-26，已部署 5df44dc8 + 已装机 APK 5E0F48A439E88AB2）**：
     **用户原话**：「英文的时候，整个ui简直不能看」。
     **审计工具坑（重要）**：自建审计探针的本地服务器**没设 content-type**——`type="module"` 的入口脚本被 Chromium 拒载，App 从未挂载，截的全是 SEO 占位卡（轮 76 的「带登录态审计」两度截到看门狗同源）。修探针（按扩展名映射 MIME）后才拿到真图。
     **实锤并修**：① 暖心墙卡面删「4+ dislikes or 0.5% hides it」审核规则行（每卡噪音，zh/en 卡面同删；规则本身在厌恶交互提示与文档保留）② 大厅人数「1 people」→ 单复数键 `peopleCount1`「1 person」（zh「1 人」不变）③ 排序钮 en 文案（Most 'same'→Most related、Most warm→Most warmth）。status-test 断言同步（单复数取键）。
     **验证**：status **49/49** + i18n **19/19** + wall **34/34** + undef/tdz **0** + page-smoke **8/8**×2 + build 0；已部署（live-check 14/14）。
     **待用户验收（亮屏，语言切英文）**：暖心墙卡面无规则行、排序钮正常、大厅人数单复数正确。

  - **轮 79 · 「换一批」取舍逻辑修复（2026-09-26，已部署 + 已装机 APK 同轮 78 包）**：
     **用户实测**：「下拉还是不刷新，只显示刷新了，实际上内容不刷新」。
     **真因（本轮最重要的发现）**：轮 77 修崩溃时重写 fresh 分支，把轮 64 的取舍逻辑弄丢了——随机批（samplePosts）照取，但 `refreshNote` 选完后**渲染的永远是最新的 50 条**；静态数据下最新 50 条不变 → 用户看到「内容不刷新」。提示却说「换了一批内容」= 谎报。
     **修法**：恢复取舍——最新页里有真新帖（ts > newestSeenTs）→ 用最新页提示「已刷新 ✓」；否则用随机批（换一批）提示「已刷新 ✓ 换了一批内容」。两分支都回写缓存（重开保持所见批次）。
     **验证**：wall 34/34 + undef/tdz 0 + page-smoke 8/8 + build 0。
     **待用户验收（亮屏）**：连续下拉每次换一批；有真新帖时显示新帖。

  - **轮 76 · 发帖页「信纸」重构（2026-09-26，已部署 + 已装机）**：
     **用户原话**：「发暖心贴那个发帖页面丑啊，你他妈不能改一下吗」。
     **审计**：CDP 注入 supabase 会话带登录态截屏（首版探针 3.5/9s 都截到看门狗卡——App 在探针里挂载慢，15s 版仍截到看门狗→放弃登录态截图，改按代码+游客壳重构）。
     **改法（ComposeView 样式层重构，类名/结构/数据层零改动，T36 断言全保留）**：发帖卡 = 「信纸」——`position:relative + 🐾水印(::before, opacity .12)`、暖色描边、radius 24、留白收紧（padding 16/12、gap 10）；textarea 字号 15.5→16、行高 1.9、min-height 42→38vh（内容更聚焦）；字数右移 accent 色；游客卡 min-height 46vh 居中。桌面同页（720 居中）不变破。
     **验证**：app-shell **40/40** + page-smoke **8/8** + build 0；已部署。
     **待用户验收（亮屏）**：＋ → 发暖心贴：信纸质感 + 沉浸输入区。

  - **轮 77 · 刷新死锁修复（2026-09-26，已部署 62f6ce18 + 已装机 APK 5E0F48A439E88AB2）**：
     **用户原话**：「sb，我他妈现在刷新根本不动」。
     **真因（轮 76 死锁）**：下拉的并行拉取里，任一请求失败（网络抖动即可）→ `box.posts = null` 仍被送进 `consume` → `filterBlocked(null)` 抛 TypeError → `loadCloud` 中断 → **`loadingCloud` 永久 true** → 之后所有刷新/触底被卫语句挡死，直到重启 App。用户视角 = 「刷新根本不动」。
     **修法**：① fresh 分支只接受**非空数组**的帖数据进 consume；失败/超时如实提示「没刷出来，再试一次」并保留旧列表；② `loadCloud` 整体 try/finally——`loadingCloud` 任何路径必复位；③ 评论数后台补迁入 finally 结构（不阻塞渲染的语义不变）。
     **验证**：undef **0** + tdz **0** + wall **34/34** + dm **286/286** + page-smoke **8/8** + build 0；已部署（live-check 14/14）+ APK 装机 Success。
     **待用户验收（亮屏）**：下拉 → 「刷新中…」→ 换一批/新帖；网络抖动时提示失败但**再拉仍可用**。

  - **轮 75 · 下拉刷新再提速 + 提示生命周期修复（2026-09-26，已部署 64277118 + 已装机 APK 961604ECB4A88573）**：
     **用户报障**：「太慢了」「老是刷新之后还不消失」。
     **根因**：①下拉要串行等「帖子+评论数」两个往返才渲染；②提示的隐藏定时器在连续下拉时互相覆盖，且拉取请求无超时——网络挂起时「刷新中…」永久钉住。
     **改法**：①下拉 = **1 个往返先渲染帖子**（最新页+随机批 Promise.all 并行），评论数**后台**并入并回写缓存（不再阻塞渲染）；②**8 秒超时保护**——Promise.race 超时后提示「没刷出来，再试一次」并复位 loadingCloud；③提示改**单定时器**管理（showNote 封装：新提示清旧定时器），连续下拉不再卡住。
     **验证**：i18n **19/19** + wall **34/34** + undef/tdz **0** + page-smoke **8/8** + build 0；已部署（live-check 14/14）+ APK 装机 Success。
     **待用户验收（亮屏）**：下拉 → 立刻「刷新中…」→ 1 个往返换内容；提示 2.5 秒必消失。

  - **轮 68 · 输入框体验三连（2026-09-26，已部署 5f788be6 + 已装机 APK 03CB8E95231EB180）**：
     **用户原话**：「漂流瓶的输入框能不能长一些…捞到信之后回信的那个框也太短了，需要随着用户输入的内容逐步变长」「会话聊天框，刚开始短一些，发送按钮需要在输入框旁边，像微信聊天框那样，以及输入框需要随着用户输入的内容逐步变长」。
     **改法**：全部用 Naive UI 原生 `:autosize="{ minRows, maxRows }"`（随内容自动长高，超过 maxRows 内部滚动）：① 投瓶框 (3,10)；② 捞信回信弹窗 (3,8)；③ 托盘回信框 (2,6) 与记录卡回信框 (3,8) 一并统一；④ 聊天输入：rows=2 定高 → autosize(1,6) **单行起**、随内容长高、发送键从下方独立行移到**输入框右侧**（flex-end 对齐多行末行，微信式），`dm-send-row` 退役 → `dm-input-row`（输入框 flex:1 + 按钮），Enter 发送/Shift+Enter 换行不变。
     **验证**：dm **286/286** + app-shell **40/40**（T21 断言同步新结构）+ bottle **69/69** + auth **130/130** + undef/tdz **0** + page-smoke **8/8** + build 0；已部署（live-check 14/14）+ APK 装机 Success。
     **待用户验收（亮屏）**：三处输入框随打字长高；聊天发送键在框右侧。

  - **轮 69 · 删暖心墙示例提示文字（2026-09-26，已部署 + 已装机）**：
     **用户原话**：「暖心墙，最下面的这是几条小小的实例那段文字去掉」。
     **改法**：CommunityView 尾部 `community.sampleNotice` 一行删除；i18n sampleNotice 双语键清干净（zh/en 成对删，唯一引用即此行）。示例帖本身保留。
     **验证**：i18n **19/19** + wall **34/34** + undef **0** + page-smoke **8/8** + build 0；已部署（live-check 14/14）+ APK 装机 Success。

  - **轮 62 · 万帖级游标分页（2026-09-25，已部署 176c967f + 已装机 APK 21AAA9660D9DE6E0，提交 6399dbc/c81d8ff 前后两笔）**：
     **背景**：用户问「推荐的算法是什么？几十万用户、7 天几百万帖怎样展示？」→ 容量评估新增**第 11 节**（现状=「7 天新帖稳定洗牌」三层、量级断点表、演进路线）并立即落地万帖级项。
     **改法（全链路五处）**：① `worker/api.js` `listPosts` 加 `before_id` → Supabase REST `id=lt.N`（**keyset 游标**：id 串行主键单调=发布序，主键索引，深翻页 O(log n) 恒定；offset 已扫行数线性恶化）；② 网关 `listPosts(limit, {offset, beforeId})`——beforeId 仅非 0 附 `&before_id=`，offset 兼容（旧断言不破）；③ 直连同款 opts（beforeId → `.lt("id", bid)`，链序保持 api-contract 形状）；④ `wall.js cloudFetchPosts(limit, beforeId)`；⑤ CommunityView `cloudOffset` 计数器 → `feedCursor`（末条 dbId）。
     **真机复验插曲（环境教训）**：装机后 CDP 复验时手机自动锁屏 → Chromium 冻结被遮挡渲染进程 → 点 Tab 后路由转场停摆（/community 不挂载、读数全 0）——轮 T7 已记录的「调试环境现象」在锁屏下的极端形态；**亮屏正常使用不受影响**（转场依赖 rAF，前台即恢复）。此前「100→0→14 坍缩」等怪读数亦多为此源+多会话交错。为绝后患，loadMoreCloud 改**自愈式去重**：追加前按 dbId 去重，整页重复=前进游标跳页续取（最多 3 页），任何缓存/游标错位都不会产生重复 key 或假到底。
     **验证**：gateway-contract **67/67**（+before_id 端点）+ worker-test **196/196**（+出站 URL `id=lt.623`）+ api-contract **83/83** + wall 34/34 + wall-rules 44/42 + undef/tdz 0 + page-smoke 8/8 + build 0；Node 直测 /sb 代理 Range 翻页 0-500 全部 50 行无缝。
     **待用户验收（亮屏）**：暖心墙下滑持续加载（游标版）；下拉刷新三态提示。

  - **轮 63 · 谷歌登录预期提示（2026-09-25，待提交待部署）**：
     **用户问**：「手机端谷歌账户登录要跳到浏览器去登录，不能在app内跳转吗」。
     **定位（实测）**：轮 31 的 CCT 方案代码在位（`skipBrowserRedirect` + `Browser.open` fullscreen + 中转页深链回跳）；**真机 `cmd package query-services -a android.support.customtabs.action.CustomTabsService` 返回 No services found**——设备只有小米浏览器和夸克浏览器（无 Chrome），二者都不提供 CCT 服务 → `Browser.open` 回退外部浏览器。**功能没坏**：外部浏览器登录完仍走中转页 → `net.de5.dale://login` 深链自动回 App。
     **改法（小）**：登录页谷歌按钮下加 `profile.googleAppHint`（仅 App 形态显示）：zh「将打开浏览器完成谷歌登录，完成后自动返回」/ en "Your browser will open for Google sign-in — you'll come right back." + `.oauth-hint` 样式（style.css，跟 .oauth-google 一起）。给用户预期，不再有「被甩出去」感。
     **给用户的口径**：想「App 内授权窗」→ 手机装 Chrome，装完零改动自动生效。
     **验证**：auth **130/130** + uifix **24/24** + i18n **19/19** + undef/tdz **0** + page-smoke **8/8** + build 0。
     **待发话**：提交 + 部署 + 重打包装机（可与轮 60-62 验收同批）。

  - **轮 62 · 万帖级游标分页（2026-09-25，待提交待部署——用户点名「现在改万帖级的」）**：
     **背景**：用户问「推荐的算法是什么？几十万用户、7 天几百万帖怎样展示？」→ 已答（容量评估第 11 节新增）并立即落地万帖级项。
     **现状回顾**：「推荐」= 服务器按 created_at 倒序给页 + 客户端 7 天窗口 mulberry32(UTC日) 稳定洗牌——同日全员同序。断点：万帖洗牌失去意义 / 十万帖 offset 线性变慢 / 百万帖客户端排序爆炸。
     **改法（全链路五处）**：① `worker/api.js` `listPosts` 加 `before_id` 参数 → Supabase REST `id=lt.N`（**keyset 游标**：id 串行主键单调=发布序，走主键索引，深翻页 O(log n) 恒定；offset 已扫行数线性恶化）；② `db.gateway.js` `listPosts(limit, {offset, beforeId})`——beforeId 仅非 0 附 `&before_id=`，offset 兼容保留（gateway-contract 旧断言不破）；③ `db.supabase.js` 同款 opts（beforeId → `.lt("id", bid)`，链序保持 api-contract 形状）；④ `wall.js` `cloudFetchPosts(limit, beforeId)`；⑤ CommunityView：`cloudOffset` 计数器 → `feedCursor`（末条 dbId），loadMoreCloud 传游标取下一页。**轮 60 的「缓存盒=展示快照」语义不变**（旧缓存不给游标）。
     **兼容性**：offset 路径全保留——旧 APK（offset 版前端）对新 Worker 照常工作；新前端（游标）**必须配新 Worker**（旧 Worker 忽略 before_id 会重发第 1 页造成重复）——`npm run deploy` 同时发布 Worker+静态资产，天然原子；**切记不要只发前端不发 Worker**（本仓库一体部署，正常操作不会踩）。
     **验证**：gateway-contract **67/67**（+before_id 端点断言）+ worker-test **196/196**（+出站 URL `id=lt.623` 断言）+ api-contract **83/83**（默认形状不破）+ wall 34/34 + wall-rules 44/42 + undef/tdz 0 + page-smoke 8/8 + build 0；README 计数同步（坑 #19）。
     **待发话**：提交 + 部署 + 重打包装机（部署即 Worker+前端原子上线）。

  - **轮 47 · 暖心墙手机端去标题浮卡（2026-09-25，待提交待部署——攒批）**：
     **用户原话**：「还有暖心墙最上面那个暖心墙的文字浮窗去掉。留在那儿干嘛」。
     **定位**：轮 35 头部压缩把「与 h2 重复的小标签」和副标题（收成桌面专属）拿掉、发布框也早已收成桌面专属后，手机端页顶那张 `card` 里**只剩 h2「暖心墙」三个字**——一块纯文字玻璃卡占着首屏第一屏。
     **改法（一行）**：该 `<section class="card">` 加 `v-if="!isMobileNav"`——手机端整卡不渲染，桌面端（副标题+发布框头部）原样保留。无 i18n 键增减。
     **验证**：uifix-test **24/24** + page-smoke **8/8** + 本地 build 0（env-guard slug ✓）。
     **待发话**：提交 + 部署。

  - **轮 34 续 · 迁移执行 + 线上闭环（2026-09-23，用户执行迁移后当日）**：
     **探针（坑 #7 判据）**：report_create / admin_report_page / admin_report_handle 匿名全 **42501**（存在无权）= 迁移生效实锤；wall_toggle_dislike 42501（新版权限收紧在位）；admin_overview 匿名 admin=false 提前返回（reports_pending 仅管理员可见，符合设计）。
     **线上 e2e（临时 _report-e2e.mjs，跑完已删）6/6**：注册 wp-report-* 账号 → 发测试帖(id=168) → report_create 真实举报 ✓ → 重复举报幂等（RLS 自查恰好 1 条 pending）✓ → 不存在目标报 target-gone（P0001）✓ → 删帖后举报条目留存（content_gone）✓。**管理端待处理队列现留 1 条测试举报**，等用户点「驳回」完成 处置→通知→已处理 闭环（通知发给 wp 测试账号，无真实用户影响）。

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


## [2026-10-02] 用户要求（最高优先级，未完成）
1. 手机端首页「故事」联（截图确认）：要去掉「故事」那个页面/这一整块，改成另一张图（图2）的布局。
   - 当前结构（按用户截图逐项对应，勿再猜）：
     顶部四联频道条：宠物 | 今日 | 漂流瓶 | 故事
     故事联内：排行��� / 我的 两个钮
     副标题「写下你的故事，也读读别人的。单篇最多 3 万字。」
     大卡容器：提示句 + 搜索框 + 故事卡列表（标题/作者/日期/标签/赞·阅读）
     底部 TabBar：首页 暖心墙 + 消息 我的
2. 手机端顶部故事栏/大标题的「故事」三个字去掉。
3. 【硬规则】以后用户每提一条要求，先写进本文件待办，再动代码，防止上下文压缩后丢失。

## [2026-10-02] 轮 149 · 故事联布局按用户手机端截图定稿（已完成）
- 联内顶部补回两枚大钮：**排行榜**(/story/rank) + **我的**(/story/mine)`.st-feed-nav / .st-feed-navbtn`，两列等宽暖橘描边胶囊）。
  背景：轮 148 曾撤掉联尾按钮（判为与底部 ＋ 重复），用户截图明确要这两枚 → 按截图恢复。
- 顶部副标题换文案：新增 i18n `story.feedSub`（zh/en 成对），旧的 discoverSub 保留未删。
- 手机端故事栏大标题「故事」三字去掉：轮 148 已改（`isMobileNav ? '' : h1`），本轮复核仍在。
- 频道条四联（宠物|今日|漂流瓶|故事）+ 横滑：轮 147/148 已有，本轮未动。
- 验证：vite build EXIT=0 / story-test 157 pass 0 fail / 部署 Version 17270f46-e90a-452d-ab18-a451771ff038 / live-check 14 PASS / 线上 StoryFeed-1WYmgX4N.js 与本地 SHA16 同为 7F982DE30DC238F4、线上 CSS 含 st-feed-navbtn / cap sync 0 / Gradle 0 / APK 5.14MB SHA16 90B18F61E7536D1B / 装机 Success / 冷启动 PID 21573 CRASH_HITS=0。
- 教训（用户第二次因同一问题发火）：用户截图即定稿，**不要自己重新设计联内布局**；要求一律先落进本文件再动手。

## [2026-10-02] 轮 150（用户手机端截图定稿）· 已部署 + 装机
**背景**：用户发来一张手机端首页截图，要求「今日联上半部分照这个改，不要太多文字」，心情打卡表情换更有设计感的。

1. **顶部问候块（新增）**：原来手机端根本没有问候块（第一张就是大厅）。现按截图加 `today-hi`：问候语 + 一行微文案（`home.hiThere`）+ 右上描边心形钮（分享今日卡片）。原来的长句散文与金币/等级 chip 一并撤掉 —— 用户原话「不要太多文字了」。
2. **此刻状态改 2×2 大卡**：`status-grid` / `status-card`，圆形 emoji 图标（圆形浅橘底）+ 状态名 + 一行短说明（新增 `companions.sub.*`）。选中态整卡染色 + 暖橘描边。i18n 按 `ico` / `name` / `sub` 三张子表拆开；emoji 只留在 `ico.*`，`name.*` 纯文字（列表更干净）。
3. **大厅此刻四格统计**：原来的「此刻大厅里」胶囊行换成 `hall-now` 四格（数字在上、标签在下），仍只出各状态人数、不出个人；我选中的状态在这排联动点亮。
4. **心情打卡表情重做**：emoji 胶囊 → `MoodFace.vue` 手绘线性脸（统一 24×24 视框、圆头描边、按情绪分眼/嘴/点缀）。选中态换成暖橘并轻微放大。修 `moodPicked` 只在初始化时赋值（点完不点亮）→ `moodPick` 里同步写；比较统一 `String()`（localStorage 存字符串，原 `=== f.legacyIndex` 永远不成立）。
5. **清死键**：`companions.tag/hall/choose/youSet/toggleHint/othersTitle/peopleCount/peopleCount1` 已无引用，zh/en 同删。
6. **测试同步**（都是有意重做后的断言更新，不是放松）：`status-test` 4 条 → 补 `ico/name/sub` 子表逐项覆盖断言（拼接 key 正则抓不到，必须单独验）；`uifix-test` T19 改为守「不谎报在线人数」本意。
7. **故事联顶部两枚钮**（用户截图同批）：`st-feed-nav` 排行榜/我的 —— 轮 148 曾误撤，按截图恢复。

**验证**：`vite build` EXIT=0；部署 Version `fb45c070-3fb0-4f82-9a47-d0cc198775bf`；线上 CSS 六项（status-grid/status-card/hall-now-cell/today-hi-heart/mood-svg/st-feed-navbtn）全 True、JS 三项全 True；status-test 56/0、i18n 19/0、uifix 24/0、mood 12/0、undef/tdz 0；39 套离线测试仅 uifix 一条失败（已修）；cap sync 0、Gradle 0、APK 5.14MB SHA16 `0E835174E5649287`、`adb install -r` Success、冷启动 PID 25610 CRASH_HITS=0。

## [2026-10-02] 轮 151（用户手机端截图）· 点「+ 领养新伙伴」只剩一层模糊蒙层
**症状**：手机端首页「宠物」页签，点「+ 领养新伙伴」后整页被 backdrop-filter 模糊，但弹窗本体不见了（截图只有蒙层）。

**根因（CSS 包含块陷阱）**：手机端 PetView 被挂在 `.home-track` 里，而该轨道有**内联 transform**（HomeView.vue:128，`transform: translateX(idx * -100%)`）。CSS 规定 transform / filter / backdrop-filter 的元素会成为后代 `position:fixed` 的**包含块**，于是：
- `.adopt-mask { position:fixed; inset:0 }` 不再相对视口，而是相对**宽 4 屏的轨道**定位
- 轨道第 1 屏时轨道左边缘刚好在视口内 → 蒙层 `inset:0` 恰好盖住视口，所以「看得见蒙层」
- 但 `.adopt-modal` 是 `position:absolute` 居中于这个 4 屏宽的轨道 → 被甩到屏幕外
- 结果就是截图那个现象：**只看得见蒙层的 backdrop-filter 模糊，完全看不见弹窗**

**修复**：PetView.vue 把 `.adopt-mask`、`ShareCard`、`SnackRain` 统一 `<Teleport to="body">`（第 648 行开 / 732 行闭），破掉 transform 包含块。CSS 变量（`--ink-soft` / `--accent-deep` / `--accent-soft` / `--shadow-sm`）定义在 `:root`（html 上），夜间主题选择器也是 `html[data-theme] .xxx` 形态，body 是 html 子孙 → Teleport 后样式与主题全部不受影响。

**排查过但无需改**：`RpsGame` / `PostcardCard` / `FoodPainter` 虽然也渲染在轨道内，但三个组件都没有 `position:fixed|absolute`，是普通流式内容，不受影响。

**回归测试**：新增 `tools/teleport-test.mjs`（5 项）静态扫描源码——① `.home-track` 内联 transform 仍在（陷阱存在，修复不能被回退）② PetView 的 fixed 弹层与 ShareCard/SnackRain 都在 Teleport 区块内 ③ 全 views 的 Teleport 标签成对 ④ 依赖变量仍在 `:root` ⑤ 复检领养弹层原始形态。
> 踩坑：T1 一开始去 style.css 找 `.home-track{transform}` 没找到而 FAIL —— transform 是模板内联样式，不在 CSS 里。已改成扫 HomeView.vue。

**验证**：`vite build` EXIT=0；40 套离线测试全绿（新增 teleport 5/0，原 39 套不受影响）。


## [2026-10-02] 轮 152 · 修「点 + 领养新伙伴 只剩模糊蒙层」· 已部署 + 装机
**症状**：手机端首页点「+ 领养新伙伴」后，整页被模糊蒙层罩住，但**弹窗内容不见了**，看起来像白屏/黑屏。
**根因**：领养弹层 `.adopt-mask` 是 `position:fixed`，但它渲染在首页横滑轨道 `.home-track` 内部。`.home-track` 上带 `transform`（横滑用），**一旦祖先有 transform，fixed 定位就改为相对该祖先**，弹层被顶到轨道可视区之外，屏幕上只剩 `backdrop-filter: blur(3px)` 的那层蒙层。
**修法**：给弹层包 `<Teleport to="body">`，脱离被 transform 的轨道（src/views/PetView.vue 644/648 开，732 闭）。
**验证**：`tools/teleport-test.mjs` 5/5 通过；`vite build` EXIT=0；`wrangler deploy` 成功，Version `92845712-ad3f-444b-a8ad-271565b91062`；线上 `/assets/PetView-DWQoB2dc.js` 35295 字节，含 `adopt-mask` 且含 `to:"body"`（=Teleport 已进包）；`gradlew assembleDebug` EXIT=0；`adb install -r` → Success；`am start -n net.de5.warmpaws/net.de5.dale.MainActivity` → PID 15253、焦点已在主界面、**CRASH_HITS=0**。
**踩坑备忘（重要）**：本项目 Android 真实 **包名 = `net.de5.warmpaws`，入口 Activity = `net.de5.dale.MainActivity`**（applicationId 与 namespace 不一致）。以后别再猜 `com.yi1614351.peiban/.MainActivity`，那是错的，会报 `Error type 3 / does not exist`。查法：`aapt2 dump packagename` + `aapt2 dump xmltree --file AndroidManifest.xml`。

## [2026-10-02] 轮 153 · App 端「排行榜」「我的」两页去掉「发现」按钮（网页端不动）· 已部署 + 装机
**要求**：app 端 首页→故事→排行榜 页面、以及 首页→故事→我的 页面，都去掉那枚「发现」按钮；**网页端不改**。
**改法**：那枚按钮就是两页顶部操作条里唯一的 `<nav class="story-acts">`（内容是 `story.tabDiscover`，全仓只有这两处渲染它）。给整条 nav 挂 `v-if="!isMobileNav"`（src/views/StoryRankView.vue、src/views/StoryMineView.vue），并从 `../stores/uiStore.js` 引入开关。
**为什么挂整条 nav**：条里只有这一枚钮，挂条即可不留空框；且不动桌面端（`isMobileNav = isApp || vw < 900`，`isApp = Capacitor.isNativePlatform()` → App 内恒 true 必藏；≥900px 桌面恒 false 必显）。
**不会困死**：顶部四联频道条在 rank/mine 页照旧渲染（StoryShell），点「故事」联即 `router.push("/story")` 回发现页；且 `useStoryBack` 仍在接管物理返回键（`utils/storyBack.js` 的 storyBack 按钮退场不等于返回通路退场）。
**副作用（已告知用户）**：手机浏览器窄屏（<900px）走的是同一套 App 布局判定，因此也会一起隐藏；这是双形态检测的既有口径（与 TabBar/SideRails 同源），不是额外改动。
**测试**：`tools/story-test.mjs` 新增 3 条断言（story-test 160/0）：①两页 `<nav v-if="!isMobileNav" class="story-acts">` 且确实 import 了 uiStore 开关（漏 import 会让 v-if 恒 undefined → 按钮照样显示）②反面守点：桌面端按钮未被连带删掉 + 频道条「故事」联回 /story 的代码仍在 + mine 页 `useStoryBack(router)` 仍在。
  > 写法坑：注释里也写着 `v-if="!isMobileNav"` 字样，断言必须走 `codeOnly()` 去注释，否则永远绿等于没测。
**验证**：模拟回退（去掉 v-if）后断言立刻 false（证明非空转）；`vite build` EXIT=0；**40 套离线测试全绿**（story 160、app-shell 64、back-stack 9、undef 0）；`wrangler deploy` Version `1a849bae-5cf6-44f6-9387-d29d13ac76bd`；`live-check` **14/14**；`live-bundle-check` 本地=线上（index SHA16 `2d007669e92fa161`）；线上 chunk 反编译核对：`StoryRankView-*.js` / `StoryMineView-*.js` 均为 `unref(X) ? 空注释 : (nav)`，且导出表里 `He as X` = `He=X(()=>Is||li.value<900)`（即 isMobileNav）——**不依赖 HTML 静态匹配，直接从字节码确认开关挂上了**；APK 5.14MB SHA16 `130D32A8FD4A7978` → `adb install -r` Success，冷启动 PID 21188、CRASH_HITS=0。
