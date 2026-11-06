# 轮446 设计：作者删除自己的内容

> 覆盖两条线：**暖心墙帖子删除**、**漂流瓶信件撤回 / 隐藏**。
> 目标：用户能收回自己发出去的东西，同时不破坏别人的互动记录、不让额度被人刷。

---

## 0. 一句话结论

| 对象 | 能做 | 做法 | 用户看到 |
|---|---|---|---|
| 暖心墙帖子 | 作者随时删除 | **软删**（`deleted_at` + 置 `removed`） | 从所有列表消失，别人打不开 |
| 漂流瓶 · 还在海里 | 撤回 | **软删**（仅 `status='sea'` 可） | 从海里消失，不会被人捞到 |
| 漂流瓶 · 已被捞走 / 已回信 | 只能隐藏 | **隐藏**（`hidden_at`） | 只从「我发布的」消失，对方毫无感知 |

两条线都**不做物理删除**。原因见 2.1 与 3.2 —— 不是洁癖，是两个具体的坑。

---

## 1. 现状

### 1.1 暖心墙

- `public.wall_posts` 有 `removed boolean`（管理员下架 / 达阈值自动下架），**没有** `deleted_at`。
- RLS 已有 `posts delete own`（`for delete using (auth.uid() = user_id)`）—— 也就是说
  **数据库层面作者本来就能删**，只是前端从来没做入口。
- 但表上**没有 update 策略**（只有 `posts admin update` 给管理员）。所以想写软删标记，
  必须走 `security definer` RPC —— 与轮 285 删评论同一套路。
- `db.supabase.js` 里 `T.posts` 出现 **14 处**，其中 6 处带 `.eq('removed', false)` 过滤，
  另有 `wall_feed_page` / `wall_search_posts` 两个 RPC 和 Worker 网关各自一份逻辑。

### 1.2 漂流瓶

- `public.bottle_letters` 有 `status`（`sea` / `held` / `answered`）、`holder`、`reply_by`、
  `conv_id`、`chat_decision`（`pending` / `accepted` / `declined`），**没有**任何删除/隐藏列。
- 「我发布的」列表走 `bottle_records(p_mine => true)`，前端本地分页（最多取 200 条）。
- `bottle_fishes.letter_id` 是 **`on delete cascade`** —— 这是关键，见 3.2。

---

## 2. 暖心墙帖子删除

### 2.1 三种做法

| 做法 | 改动面 | 评论/回应 | 可恢复 | 主要风险 |
|---|---|---|---|---|
| **A. 硬删**（走现有 RLS） | 只加前端 | 级联物理消失 | 否 | 别人写的评论一起没了；举报队列留下指向空气的 `target_id` |
| **B. 纯软删**（只加 `deleted_at`） | 14 处查询 + 2 个 RPC + 网关 + RLS | 保留 | 是 | 改漏一处就"删了还在"（轮 439 吃过漏列 `lang` 的亏） |
| **C. 软删 + 顺手置 `removed = true`** | 1 个 RPC + RLS + 1 处统计 | 保留 | 是 | 管理端「已下架」口径要修（1 处 SQL） |

### 2.2 选型：C

**为什么借 `removed` 的车**：现有 6 处查询 + 2 个 RPC + 网关**全部已经**在过滤
`removed = false`。让删除动作同时写 `removed = true`，等于**白拿一整套过滤面**，
列表 / 详情 / 搜索 / 个人主页 / 我的帖子**一行代码都不用改**就立刻看不到。

**为什么还留 `deleted_at`**：`removed` 是"被下架"，`deleted_at` 是"作者不要了"。
两者语义不同，混成一个字段以后没法区分「被举报下架的」和「作者自删的」——
管理端复核、申诉、以后做"回收站"都要靠这个区分。

**代价（落地时改了做法）**：`admin_stats` 里的 `posts_removed` 本来会把作者自删算进"已下架"。
原计划改那句 SQL，实际执行时发现 `admin_stats` 在 `MIGRATION_admin.sql` / `_admin_dau.sql` /
`_reports.sql` / `SUPABASE_SETUP.sql` **各有一份完整定义**，整段重写的风险（覆盖掉后来加的
dau 与举报统计）远大于收益 —— 仪表盘一个数字而已。**最终不动统计**，改为在管理端「恢复」
时一并清 `deleted_at`（见 2.7），口径差异止于那个数字。

### 2.3 数据层

```sql
alter table public.wall_posts add column if not exists deleted_at timestamptz;

comment on column public.wall_posts.deleted_at is
  '轮446 作者自删时间：非空 = 作者删了这条帖子。行保留（评论/回应/举报不连带消失，可审计可恢复）；
   删除时同时置 removed = true，复用既有 removed 过滤面，列表与 RPC 无需改动。';

-- 列表页永远只查未删的：与既有 wall_posts_created_idx 对齐，避免软删后索引选择变差
create index if not exists wall_posts_live_idx
  on public.wall_posts (created_at desc) where deleted_at is null and removed = false;

-- 读策略：已删的只有作者本人和管理员能读到（否则直连 REST 仍能拿到正文）
drop policy if exists "posts visible or own or admin" on public.wall_posts;
create policy "posts visible or own or admin" on public.wall_posts
  for select using (
    (removed = false and deleted_at is null)
    or auth.uid() = user_id
    or public.is_admin()
  );
```

> 注意：`removed = false` 与 `deleted_at is null` 是**两个条件都要**。
> 只判 `removed = false` 会在"管理员把 `removed` 改回 false"时让已删帖复活 —— 见 6.4。

### 2.4 RPC

```sql
create or replace function public.wall_post_delete(p_id bigint)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
begin
  update public.wall_posts
     set deleted_at = now(),
         removed    = true          -- 借 removed 的过滤面：6 处查询 + 2 个 RPC + 网关全都不必改
   where id = p_id
     and user_id = auth.uid()       -- 只能删自己的（未登录 auth.uid() 为空 → 改不到任何行 → false）
     and deleted_at is null;        -- 幂等
  get diagnostics n = row_count;
  return n > 0;
end;
$$;

revoke all on function public.wall_post_delete(bigint) from public;
grant execute on function public.wall_post_delete(bigint) to authenticated;
```

- `security definer` 是必须的：表上没有作者可用的 update 策略。
- 只授 `authenticated`：匿名的 `auth.uid()` 恒空，授了也只会返回 false，不如不授。

### 2.5 前端

三个入口，同一个 `confirmDeletePost(p)`：

| 入口 | 文件 | 位置 |
|---|---|---|
| 暖心墙信息流卡片 | `CommunityView.vue` | 卡片右上 `⋯` 菜单（已有，现在只有 收藏 / 拷贝） |
| 帖子详情页 | `PostDetailView.vue` | 帖子 `⋯` 菜单（同上） |
| 我的帖子列表 | `MyPostsView.vue` | 卡片右上新增 `⋯`（现在整卡只有一个点击区） |

**菜单项的显示条件**：`p.userId === myUid`（作者本人）且 `p.dbId != null`。
现有 `canReportPost` 恰好是反向条件（`userId !== myUid`），两者互斥，菜单不会同时出现举报和删除。

**确认弹窗**（`useDialog`，与故事草稿删除同款）：

```
删除这条帖子？
删除后无法恢复，这条帖子下的评论也会一起消失。

[取消]  [删除]
```

**执行顺序（乐观 UI）**：

1. 用户确认 → 卡片立刻加 `.post-leaving`（透明 + 高度塌陷 220ms）
2. 动画结束从列表移除；详情页则 `router.back()`
3. 调 `wall_post_delete`
4. 成功 → toast「已删除」；**回写缓存**（`cachePatch` 标记删除 / 从 `cacheKey("wall:post", id)` 删掉），
   否则返回列表时 SWR 缓存会把刚删的帖子闪回来
5. 失败 → 卡片恢复（动画反向）+ toast「删除失败，请重试」

**为什么先动画后请求**：请求 200ms 到 2s 不等，先等请求会让按钮"点了没反应"。
失败回滚的成本是一次淡入，远小于一次"卡住不动"的观感损失。

### 2.6 降级（没跑迁移）

```
wall_post_delete → PGRST202 / 42883（函数不存在）
  ↓
退回 .delete().eq("id", id).eq("user_id", uid)   ← 现有 RLS "posts delete own" 放行
  ↓
硬删：帖子没了，评论级联没了，举报记录留在队列里显示「内容已删除」
```

这条降级必须保留 —— 与本仓库"不跑迁移也能用"的一贯口径一致，且硬删是用户本来
就预期得到的结果（帖子彻底消失）。差异只在"评论能否恢复"，不影响功能可用。

### 2.7 管理端联动

- 复核队列里作者已删的帖子：`target_id` 无外键（`MIGRATION_reports.sql` 第 19 行有明确注释），
  帖子行还在库（软删），所以**队列照常能显示原文**，比硬删还好 —— 硬删后只能显示「内容已删除」。
- 管理员「恢复」已删帖：`adminSetPostRemoved(id, false)` 会**同时清 `deleted_at`**
  （已实现，直连与网关两套）：只把 `removed` 改回 false，`deleted_at` 还在 → 读策略仍不通过 →
  列表依旧看不到，管理员会以为「恢复失败」。老库没有这一列时自动退回只改 `removed`
  （认 PGRST204 / 42703）。
- `admin_stats.posts_removed` **刻意不改**（原因见 2.2）：这个数字会把作者自删算进"已下架"，
  但管理端的操作行为是对的，只是仪表盘一个数偏大。

---

## 3. 漂流瓶撤回 / 隐藏

### 3.1 状态机（用户视角）

| 信的当前状态 | 含义 | 「我发布的」里的操作 |
|---|---|---|
| `sea` | 还在海里，没人捞到 | **撤回**（删除）、隐藏（可不要） |
| `held` | 被别人捞走了，还没回信 | 只能**隐藏** |
| `answered` + `chat_decision='pending'` | 收到回信，等我决定聊不聊 | **不给隐藏**（这是红点提醒的载体，藏了会漏掉回信） |
| `answered` + `accepted` + `conv_id` | 已同意，有会话 | **不给隐藏**（这是聊天入口，藏了进不去） |
| `answered` + `declined` | 我婉拒了 | 可以隐藏 |

> 规则一句话：**还在海里的能收回；已经进了别人手里的，只能自己眼不见为净。**
> 而任何"还有事等你做"或"还能点进去"的状态，一律不允许隐藏 —— 不给用户制造"东西不见了"的困惑。

### 3.2 为什么撤回也必须软删

不是洁癖，是两个具体的洞：

1. `bottle_fishes.letter_id` 是 `on delete cascade`。物理删一封被捞过的信 →
   捞信日志一起没 → **「同一封信 7 天内不会再发给你」的约束失效**。
2. `bottle_quota()` 的 `picked` 是 `count(*) from bottle_fishes`。删日志 →
   今日已捞次数回退 → **可以靠"投信→被捞→删信"刷捞瓶额度**。

所以：`deleted_at` 打标记 + `bottle_fish` 挑选时排除。行永远留着。

### 3.3 数据层

```sql
alter table public.bottle_letters add column if not exists deleted_at timestamptz;
alter table public.bottle_letters add column if not exists hidden_at  timestamptz;

comment on column public.bottle_letters.deleted_at is
  '轮446 作者撤回：仅 status=sea 可撤回。软删 —— bottle_fishes 是 on delete cascade，
   物理删会让「同一封 7 天内不再发给你」与捞瓶额度记账一起回退，等于开了刷额度口子。';

comment on column public.bottle_letters.hidden_at is
  '轮446 作者从「我发布的」隐藏：只影响写信人自己的列表，对方无感知，
   回信与已有会话都不受影响。hidden_at 非空的行不进 bottle_records(p_mine => true)。';

-- 「我发布的」列表：只查未隐藏未删的
create index if not exists bottle_letters_mine_live_idx
  on public.bottle_letters (user_id, created_at desc)
  where hidden_at is null and deleted_at is null;
```

### 3.4 三个 RPC

```sql
-- ① 撤回（只在还在海里时允许）
create or replace function public.bottle_letter_delete(p_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update public.bottle_letters
     set deleted_at = now()
   where id = p_id
     and user_id = auth.uid()
     and deleted_at is null
     and status = 'sea';            -- 已被捞走 → 命中 0 行 → 返回 false
  get diagnostics n = row_count;
  if n = 0 then
    -- 区分三种 false：不是我的 / 已经删了 / 已经被捞走了
    if exists (select 1 from public.bottle_letters
                where id = p_id and user_id = auth.uid() and deleted_at is null) then
      raise exception 'bottle-already-picked';
    end if;
    return false;
  end if;
  return true;
end $$;

-- ② 隐藏（只允许"没有待办"的信）
create or replace function public.bottle_letter_hide(p_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update public.bottle_letters
     set hidden_at = now()
   where id = p_id
     and user_id = auth.uid()
     and deleted_at is null
     and hidden_at is null
     and status <> 'sea'                      -- 海里的用「撤回」，不给藏
     and chat_decision <> 'accepted'          -- 已有会话 = 聊天入口，不许藏
     and not (status = 'answered' and chat_decision = 'pending');  -- 待我决定，不许藏
  get diagnostics n = row_count;
  return n > 0;
end $$;

-- ③ 恢复显示
create or replace function public.bottle_letter_unhide(p_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update public.bottle_letters set hidden_at = null
   where id = p_id and user_id = auth.uid() and hidden_at is not null;
  get diagnostics n = row_count;
  return n > 0;
end $$;

revoke all on function public.bottle_letter_delete(uuid)  from public, anon;
revoke all on function public.bottle_letter_hide(uuid)    from public, anon;
revoke all on function public.bottle_letter_unhide(uuid)  from public, anon;
grant execute on function public.bottle_letter_delete(uuid) to authenticated;
grant execute on function public.bottle_letter_hide(uuid)   to authenticated;
grant execute on function public.bottle_letter_unhide(uuid) to authenticated;
```

> 前端**也**按 3.1 的表判断是否显示按钮。数据库这边是第二道闸 —— 两边口径必须一致，
> 否则会出现"按钮点了没反应"（RPC 返回 false 但没有错误文案）。

### 3.5 必须连带改的两个函数

**① `bottle_fish`** —— 基线是 `MIGRATION_content_lang.sql` 里那一版（带 `p_lang`）：
在挑选条件 `where status = 'sea' and user_id <> auth.uid()` 后加 `and deleted_at is null`。
**并发防护（条件更新抢锁 + 重试 3 次 + 换 pass）一字不改。**

**② `bottle_records`** —— 基线是 `MIGRATION_bottle_records.sql`：
`p_mine = true` 分支加 `and l.hidden_at is null and l.deleted_at is null`。
`p_mine = false`（我捞到的）与 `null`（旧口径）**不加** —— 那是别人写的信，
写信人隐藏自己的列表不该影响捞信人。

两个函数都是 `create or replace`，但**都涉及新增条件**，必须整段重写函数体，
不能只 `alter`。落地时按既有踩坑记录：**整份文件贴进 SQL Editor**，只贴片段会静默保留旧定义。

### 3.6 前端

**位置**：`BottleView.vue`「我发布的」记录卡，`m-meta` 那一行右侧。

```
┌────────────────────────────────────────┐
│ 信文（钳 4 行）…                        │
│ 3 小时前 · 漂在海里          [撤回]     │  ← sea
└────────────────────────────────────────┘

┌────────────────────────────────────────┐
│ 信文（钳 4 行）…                        │
│ 3 小时前 · 已被捞起          [隐藏]     │  ← held / answered
└────────────────────────────────────────┘
```

- 按钮是**文字按钮**（不是实心按钮）：这是低频破坏性操作，不该和「回信 / 放回」抢视觉权重。
- 「撤回」用危险色（`--low` 系），「隐藏」用中性灰。
- 点击 → `useDialog` 二次确认：
  - 撤回：「撤回这封信？撤回后它从海里消失，不会再被捞到。今日投信次数不退还。」
  - 隐藏：「从列表隐藏？不影响对方，回信和聊天都在；可在列表底部「已隐藏」里恢复。」
- 成功 → 从 `recAll` 移除 → `setRecPage(recPage)` 重算分页（当前页可能空 → 自动回退一页）→ toast
- 失败 → toast（`bottleErrKey` 归类：`bottle-already-picked` → 「这封信刚被捞走了，只能隐藏」）

**已隐藏入口**：列表分页器下方一行小字

```
已隐藏 2 封 · 查看
```

点开展开一个折叠区，每条灰显信文摘要 + 时间 + 「恢复显示」。

**为什么保留恢复入口**：隐藏是"我看不到"，不是"没了"。没有恢复入口的话，
用户会以为隐藏 = 删除，然后去问客服要信 —— 小社区没有客服。

### 3.7 并发与边界

| 场景 | 处理 |
|---|---|
| 点撤回的同一瞬间被人捞走 | `update ... where status='sea'` 原子：谁先谁赢。撤回返回 `bottle-already-picked` → 前端提示"刚被捞走，只能隐藏"，并把该行就地刷成「已被捞起 + 隐藏按钮」 |
| 隐藏后对方同意聊天 | RPC 已禁止（`chat_decision='accepted'` 不许藏），不存在"藏了之后进不去会话" |
| 隐藏的信又收到新回信 | `answered` 后若变成 `pending`（待决定），`bottle_letter_unhide` 之外还要**自动取消隐藏**：`bottle_reply` 写回信时 `set hidden_at = null`。否则红点出现了、列表里却找不到那封信 |
| 撤回后额度 | **不退还**。投信额度是"投递动作"的成本，撤回是另一个动作，退还等于可以无限试写 |
| 管理员看漂流瓶 | 管理端不涉及漂流瓶，无需联动 |

> 「隐藏的信收到回信要自动取消隐藏」这条最容易被漏，但一旦漏了就是**用户收不到重要提醒**，
> 必须在 `bottle_reply` 函数里补一行 `hidden_at = null`。

---

## 4. i18n（五语各 ~12 条）

| key | 中文 |
|---|---|
| `post.delete` | 删除 |
| `post.deleteTitle` | 删除这条帖子？ |
| `post.deleteDesc` | 删除后无法恢复，这条帖子下的评论也会一起消失。 |
| `post.deleted` | 已删除 |
| `post.deleteFail` | 删除失败，请重试 |
| `bottle.withdraw` | 撤回 |
| `bottle.withdrawTitle` | 撤回这封信？ |
| `bottle.withdrawDesc` | 撤回后它从海里消失，不会再被捞到。今日投信次数不退还。 |
| `bottle.withdrawn` | 已撤回 |
| `bottle.alreadyPicked` | 这封信刚被捞走了，只能隐藏 |
| `bottle.hide` / `bottle.unhide` | 隐藏 / 恢复显示 |
| `bottle.hideTitle` / `bottle.hideDesc` | 从列表隐藏？ / 不影响对方，回信和聊天都在。 |
| `bottle.hiddenN` | 已隐藏 {n} 封 |

`admin.*` 整组照既有约定不翻（只站主用）。es / pt / fr 三份按各自语言风格写
（pt 用 você、fr 用 tu + 弯撇号，与既有文件一致）。

---

## 5. 测试

| 文件 | 覆盖 |
|---|---|
| `tools/owner-delete-test.mjs`（新） | 纯逻辑：菜单显示条件（作者/他人/游客/示例帖）、漂流瓶操作按钮的状态矩阵（5 态 × 2 按钮）、乐观删除的回滚、分页重算 |
| `tools/bottle-test.mjs`（改） | 加「撤回后从 recAll 移除」「隐藏后列表长度减 1」 |
| `tools/wall-test.mjs`（改） | 加「删除后列表移除」 |
| 迁移 | `pgsql-ast-parser` 语法预检 → 直连执行 → 查 `pg_proc` 验签名 + `pg_policy` 验证 RLS |
| 真实接口 | 三种身份调 RPC：匿名（应 42501）、他人（应 false）、作者（应 true）；撤回已捞走的信（应 `bottle-already-picked`）；隐藏待决定的信（应 false） |

---

## 6. 坑清单（实现时逐条对照）

1. **`removed` 与 `deleted_at` 两个条件都要判**。只判 `removed` 会在管理员"恢复"时复活。
2. **管理端恢复要清 `deleted_at`**，否则恢复了也看不见（6.4 同源）。
3. **`bottle_fish` 一改就必须整段重写**。只加一行 `and deleted_at is null` 也要
   `create or replace` 整个函数体 —— 而且基线是 `MIGRATION_content_lang.sql` 那版（带 `p_lang`），
   用错基线会把语言优先捞信覆盖掉（轮 439 差点犯的错）。
4. **`bottle_records` 只改 `p_mine = true` 分支**。改全局会让"我捞到的"里
   别人隐藏的信也消失 —— 那是别人的列表，不关我事。
5. **`bottle_reply` 要补 `hidden_at = null`**。见 3.7。
6. **缓存回写**。删帖后不写缓存 → 返回列表时 SWR 把帖子闪回来，用户会以为没删掉。
7. **维护模式**。删除/撤回/隐藏都是写操作，全部走 `guardWrite()`；错误归类走
   `errorKind` → maintenance，不能落进"通用失败"。
8. **网关模式**。`db.gateway.js` 需同步加这 4 个方法（`/api/posts/delete`、
   `/api/bottle/letter-delete|hide|unhide`）；Worker 没端点时静默降级 —— 与轮 444 维护模式同样的处理。

---

## 7. 落地顺序

1. `MIGRATION_owner_delete.sql`（1 个文件，9 节）→ 语法预检 → 直连执行 → 验收查询
2. `db.supabase.js`：`wallPostDelete` / `bottleLetterDelete` / `bottleLetterHide` / `bottleLetterUnhide`（含降级）
3. `db.gateway.js` 同步四个方法
4. `wall.js` / `bottle.js`：包装 + `guardWrite` + 错误归类
5. 三个前端入口 + 漂流瓶记录卡按钮 + 已隐藏折叠区
6. i18n 五语
7. `tools/owner-delete-test.mjs` + 三套既有测试补项
8. 全量 `node tools/all.mjs` → 打包 round446 → 真机验收（**这次务必在设备上点一遍**）
