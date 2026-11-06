# 暖心墙关注功能 · 设计方案（轮 447）

> 一句话：关注是**我的阅读列表**，不是社交关系。对方永远不知道，我也不显示粉丝。

---

## 一、先回答「不显示粉丝，你觉得怎么样」

**我同意，而且这比我一开始想的更正确 —— 但理由可能和你想的不一样。**

### 1. 表面理由：怕攀比

粉丝数一旦出现，它就不是数字而是评分。这个小 app 的调性是「陪伴」，
「TA 有 20 个粉丝我只有 2 个」这种念头一旦产生，写帖子的动机就从「我想说」变成「我要涨粉」。

### 2. 真正的理由是数据结构上的：**粉丝数只要存在，就必然要能点进去**

一个点不进去的数字是纯攀比燃料，没有任何用处。而一旦允许查看「谁关注了我」，
就等于给每个用户开了一个公开看板：「我认识谁、谁认识我」全部可查。

这会把现有的隐私口径撕开一个口子。目前这个 app 的隐私是一致的：

| 现有能力 | 隐私口径 |
|---|---|
| 拉黑 | 对方完全不知情，无任何通知 |
| 漂流瓶 | 匿名，捞信的人不知道写信人是谁 |
| 收藏 | 只有本人能读自己的收藏夹 |
| 私信拉黑名单 | 只有本人可见 |

**「谁关注了我」是唯一一个「别人对我做的、且我能看见」的关系**。它一旦开放，
就与上面四条全部不一致 —— 用户会开始预期「那我拉黑他，他是不是也能看到」这类连锁疑问。

所以「不显示粉丝」不是做减法，而是**守住了整条隐私线**。这是我支持你的核心理由。

### 3. 但必须补一个东西，否则会出问题

不做粉丝，用户一定会问：**「我关注了他，他知道吗？」**

如果不回答这个问题，用户会默认「他应该知道」，然后期待对方回关、期待被记住 —— 落空后产生怨气。

**解法**：「我的关注」页顶部常驻一句小字：

> *你关注的人不会收到通知 —— 这是你的阅读列表，不是社交关系。*

一句话，把所有预期差抹平。这是整套设计的支点。

### 4. 我额外建议的两条限制

| 限制 | 值 | 理由 |
|---|---|---|
| 关注上限 | 200 人 | 防脚本批量关注；也保证「我的关注」这个流的质量（关注 5000 人的流等于全部） |
| 关注不产生通知 | 是 | 通知表不加任何 follow 触发器 |

### 5. 我不建议做的（一并说清）

- ❌ **不做「TA 的关注数 / 粉丝数」显示** —— 作者主页不加这两个数字，保持极简
- ❌ **不做「互相关注」标识** —— 需要知道对方是否关注我，与隐私口径冲突
- ❌ **不做关注流红点 / 未读数** —— 「我的关注」是主动查看的筛选，不是消息流；做红点会变成推送焦虑
- ❌ **不做关注推荐 / 「你可能认识」** —— 这个 app 不需要增长手段

---

## 二、数据模型

### 2.1 表：`wall_follows`

```sql
create table if not exists public.wall_follows (
  follower_id uuid not null default auth.uid()
              references auth.users (id) on delete cascade,
  followee_id uuid not null
              references auth.users (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (follower_id, followee_id),
  constraint wall_follows_no_self check (follower_id <> followee_id)
);
```

**为什么用复合主键而不是 `id identity`**

关注关系天然唯一（一个人只能关注另一个人一次）。用复合主键：
- 「重复关注」不需要额外判断，`on conflict do nothing` 直接幂等
- 「是否已关注」= 主键命中，走索引
- 不用维护一个没用的自增序列

参照 `wall_favorites`（它用了 identity + unique），但这里是**多对多关系表**，
复合主键更贴切，也少一个索引。

### 2.2 索引

```sql
-- 我的关注列表（按关注时间倒序）：主键 (follower_id, followee_id) 只覆盖前缀，
-- 排序要 created_at，所以单独建一条
create index if not exists wall_follows_follower_idx
  on public.wall_follows (follower_id, created_at desc);

-- 反向查询（谁关注了我）：本设计不开放，但拉黑自动取关、删号清理会用到
create index if not exists wall_follows_followee_idx
  on public.wall_follows (followee_id);
```

### 2.3 RLS：只有本人能读自己的关注

```sql
alter table public.wall_follows enable row level security;

-- 读：只能读「我关注的」，读不到「谁关注了我」← 这条是隐私口径的技术兑现
create policy "follows select own" on public.wall_follows
  for select using (auth.uid() = follower_id);

-- 关注：只能以自己的身份关注（with check 防伪造 follower_id）
create policy "follows insert own" on public.wall_follows
  for insert with check (auth.uid() = follower_id);

-- 取关：只能删自己的
create policy "follows delete own" on public.wall_follows
  for delete using (auth.uid() = follower_id);
```

> ⚠️ **关键**：`select` 策略里写的是 `follower_id = auth.uid()`，**不是** `or followee_id = auth.uid()`。
> 后者等于允许被关注者读到「谁关注了我」——正是要堵的那条路。

匿名完全不可见（与 `wall_favorites` 同款）：

```sql
revoke all on public.wall_follows from anon;
alter table public.wall_follows force row level security;  -- 连表主也走 RLS
```

### 2.4 上限 200：用 BEFORE INSERT 触发器（不可绕过）

RLS 的 `with check` 不能查自己这张表（会递归/被拒），
所以数量上限必须放在触发器里 —— 这样**任何写入路径**（REST 直写、RPC、脚本）都拦得住。

```sql
create or replace function public.wall_follows_limit()
returns trigger language plpgsql security definer set search_path = public as $$
declare n int;
begin
  select count(*) into n from public.wall_follows where follower_id = new.follower_id;
  if n >= 200 then
    raise exception 'wall-follow-limit' using errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists wall_follows_limit_trg on public.wall_follows;
create trigger wall_follows_limit_trg
  before insert on public.wall_follows
  for each row execute function public.wall_follows_limit();
```

> 幂等重入（已关注时再点一次）会先命中 `on conflict` 吗？**不会** ——
> `before insert` 触发器在冲突判定之前执行，所以第 201 次关注已关注的人会误报超限。
> 解法：触发器里先判重，已存在直接 `return new`（让 `on conflict do nothing` 收尾）。
>
> ```sql
> if exists (select 1 from public.wall_follows
>             where follower_id = new.follower_id and followee_id = new.followee_id) then
>   return new;   -- 交给 on conflict do nothing
> end if;
> ```

### 2.5 RPC：`wall_following()` 一次拿全「我的关注」

```sql
create or replace function public.wall_following()
returns table (
  user_id      uuid,
  nickname     text,
  followed_at  timestamptz,
  post_count   int,
  last_post_at timestamptz
)
language sql security definer set search_path = public stable as $$
  select f.followee_id,
         coalesce(nullif(p.nickname, ''), 'Guest'),
         f.created_at,
         coalesce(s.n, 0)::int,
         s.last_at
  from public.wall_follows f
  left join public.profiles p on p.id = f.followee_id
  left join lateral (
    select count(*) as n, max(w.created_at) as last_at
    from public.wall_posts w
    where w.user_id = f.followee_id
      and w.removed = false and w.deleted_at is null
  ) s on true
  where f.follower_id = auth.uid()
  order by s.last_at desc nulls last, f.created_at desc;
$$;

revoke all on function public.wall_following() from public, anon;
grant execute on function public.wall_following() to authenticated;
```

**为什么用 RPC 而不是两次查询**

- 一次往返拿到「人 + 昵称 + 帖子数 + 最近发帖时间」
- 排序用 `last_post_at desc`：**有内容的人排在前面**，比按关注时间排更有用
  （按关注时间排，用户会看到一屏「关注了但再也不发帖的人」）

**为什么不返回粉丝数 / 是否互关** —— 见第一节第 5 条。

> ⚠️ `security definer` 函数**绕过 RLS**，所以 `where f.follower_id = auth.uid()`
> 这一句是唯一的安全边界，必须写成硬条件，不能依赖调用方传参。
> 若 `auth.uid()` 为 null（未登录），返回 0 行 —— 天然安全。

---

## 三、四条链路

### 3.1 关注

```
前端: followUser(uid, nickname)
  → 乐观更新 followState.ids / rows（按钮立刻变「已关注」）
  → db.followInsert(uid)          // insert, on conflict do nothing
  → 失败: 回滚 + 抛错（按钮变回「关注」+ 一句话提示）
```

- 按钮点击后立刻变「已关注」，不等待网络（与 `blockUser` 同款乐观先行）
- 失败回滚用 token 防「连点两次，第一次失败把第二次的结果抹掉」（复用 `userBlocks` 的 `opTokens` 模式）
- 自己关注自己：按钮不渲染（`isSelf` 时整行按钮都不显示）

### 3.2 取关

```
取关: 需要二次确认（两步点击，复用 WallerView 现有 blockArm 的交互）
  → 乐观移除 → db.followDelete(uid) → 失败回滚
```

**为什么取关要确认而关注不用**：关注可以随时反悔（再点一次），
取关之后列表里这个人就没了，想找回得重新去主页搜 —— 手滑的代价不对称。

### 3.3 我的关注（列表页 `/following`）

新建 `FollowingView.vue`：

- 顶部：说明条（那句「不会收到通知」）
- 列表：头像（`avatarUrlFor`）+ 昵称 + 「N 篇 · 最近 X」 + 「已关注」按钮（点击=取关，两步确认）
- 点击整行 → `/u/:id` 主页
- 空状态、未登录态见第四节

**不进 KeepAlive**（与 `FavoritesView` 同款），每次进入重新拉。

### 3.4 关注流（暖心墙「我的关注」筛选）

不是排序，是**数据源切换**。

```
followOnly = true
  → ids = followState.ids
  → ids 为空 → 空状态（不发请求）
  → 拉取：db.listPosts(limit, { beforeId, userIds: ids })
  → 渲染：复用现有 rowsToPosts + 回应聚合 + filterBlocked
```

#### 为什么走前端 `.in()` 而不是新写一个 RPC

现有 `wall_feed_page` / `wall_search_posts` 每个都有 100+ 行，
里面缠着 `removed`、`deleted_at`、`lang`、回应聚合、评论数聚合、我的回应 ——
复制一份改 where 条件，**漏一处就是一个线上 bug**（轮 439 漏 `lang` 已经吃过一次）。

改 `db.listPosts` 加一个可选参数，风险最小：

```js
// db.supabase.js listPosts(limit, opts)
const uids = Array.isArray(opts.userIds) ? opts.userIds.filter(Boolean) : null;
// q() 里：
if (uids && uids.length) base = base.in("user_id", uids);
```

- 不传 `userIds` 时**链式调用完全不变** → `api-contract-test` 里 listPosts 的形状断言不受影响
- 200 人上限保证了 `.in()` 的 URL 长度可控（uuid 36 字符 × 200 ≈ 7KB，远低于 PostgREST 限制）

#### 关注流固定按时间倒序，不给排序按钮

理由：
1. 关注的人通常是个位数到几十个，全部按时间看是最自然的
2. 「推荐」模式的 7 天随机窗在关注流里没意义（关注的正是「我想看他所有内容」）
3. 「同感/抱抱/暖暖最多」需要时间范围筛，两层筛选叠在一起用户算不过来

所以：**关注模式下排序行 + 时间范围行整体隐藏**，换成一条细提示：

> *只看你关注的 N 位博主 · 按发布时间*

---

## 四、UI 落点（5 处 · 按你 2026-11-07 的调整改定）

> 你的原话：「帖子详情页 ⋯ 菜单 — 取消关注可以放那里；关注直接在暖心墙帖子的用户名旁边加一个按钮」。
> 据此把「关注」从详情页菜单挪到信息流卡片，详情页菜单只保留「取消关注」。

### 4.1 暖心墙帖子卡片 —— 作者名旁（主入口）

`.post-head` 里、`post-meta` 之后、`⋯` 之前：

```
[头像] 昵称                       [+ 关注]  [⋯]
       3 小时前 · EN
```

- **只对「未关注 + 不是自己 + 不是本地帖」的人显示** —— 已关注的不显示按钮。
  满屏「已关注」是纯噪音，而按钮存在的意义就是「一次可做的动作」，关注完动作就没了。
  想取关去主页或详情页菜单。
- 点完 600ms 内保留「✓ 已关注」过渡态再消失 —— 否则按钮瞬间不见，用户以为点空了。
- 必须 `@click.stop`：否则冒泡到卡片，点关注顺带打开了详情页。
- 样式刻意做轻（半透明描边，不用实心品牌色）：信息流里一排实心按钮看起来像在推销关注。

### 4.2 作者主页 `/u/:id` —— 第二入口

在现有按钮行（发私信 / 拉黑）里，**关注排第一**：

```
[ + 关注 ]  [ ✉️ 发私信 ]  [ 拉黑 ]
```

- `isSelf`（自己的主页）、已拉黑的人 → 不渲染关注按钮
- 未登录 → 渲染按钮，点击引导登录（带 `?next=` 回跳）
- 已关注 → `[ ✓ 已关注 ]`，再点一次进入待确认态，**第二次点击才真取关**
  （关注可以随时反悔，取关后这个人就从列表里没了，手滑代价不对称）

### 4.3 帖子详情页 `⋯` 菜单 —— 只放「取消关注」

```
举报  /  收藏  /  复制  /  取消关注
                          ↑ 只有「我关注了作者」时出现
```

菜单是「更多操作」，放一个正向的「关注 TA」既别扭又容易被忽略；
真正的关注动作在 4.1 / 4.2 已经触手可及，这里只补「怎么取消」。

### 4.4 暖心墙 —— 「我的关注」按钮

位置：**搜索栏下方、排序行上方**，独立一行 pill：

```
[ 👥 我的关注 ]        ← 未选中：描边
[ 👥 我的关注 12 ]     ← 选中：实心 + 数字
```

点一下进入关注流，再点一下（或点右侧 ✕）退出。选中后排序行、时间范围行、搜索栏
**整体隐藏**，换成一条细提示「只看你关注的 12 位博主」。

**为什么不塞进排序行**：排序行的语义是「同样这批内容，换个排法」，
而「我的关注」换的是**内容本身**。混在一起，用户会以为「关注」是一种排序，
点了还能看到别人的帖子 —— 点了发现内容整个变了才反应过来，这是认知错位。

**为什么关注流不给排序/时间范围**：关注几十个人，全部按时间看最自然；
「推荐」的 7 天随机窗在关注流里毫无意义（关注正是因为「我想看他所有内容」）。

### 4.5 「我的」页面 —— 关注入口

在「我的收藏」旁边加一个：

```
[ 我的收藏 ]  [ 关注 12 ]  [ 退出登录 ]
```

- 数字 = `followState.ids.length`，0 也显示「关注 0」
- 点击 → `/following`
- **不做内嵌头像横排** —— 你上一轮明确拍板「我的收藏不要在我的页面下面显示，
  去单独一个页面」，关注同理

### 4.6 不做的地方（明确写出来，免得以后被当成遗漏）

| 位置 | 为什么不做 |
|---|---|
| 关注流红点 / 未读数 | 「我的关注」是主动查看的筛选，不是消息流；做红点会变成推送焦虑 |
| 通知页 | 关注不产生通知（这是设计的核心，不是遗漏） |
| 作者主页统计区 | 不显示 TA 的关注数 / 粉丝数 |
| 漂流瓶 / 故事 | 你说了「只关联暖心墙」，这两个模块零改动 |

## 五、空状态：三种，必须分开

这三个如果文案混用，用户不知道该怎么办。

| 场景 | 判据 | 文案方向 | 动作 |
|---|---|---|---|
| 未登录 | `!cloud.user` | 「登录后可以关注喜欢的博主」 | → `/login` |
| 关注 0 人 | `ids.length === 0` | 「你还没关注任何人 —— 在帖子里点作者头像，就能关注 TA」 | 关闭筛选，回全部 |
| 关注了但没内容 | `ids.length > 0 && rows.length === 0` | 「你关注的 N 位博主还没发过帖子」 | 关闭筛选，回全部 |

第三种最容易被忽略：用户关注了三个人，点进去一片空白，会以为功能坏了。

---

## 六、边界与坑（8 条）

### 坑 1 · 拉黑与关注的关系

用户拉黑 A，但之前关注了 A → 关注流里还会出现 A 的帖子吗？

**两道防线**：
1. `blockUser` 时**尽力取关**（`unfollow(A)` 失败也忽略，不影响拉黑成功）
2. 渲染层再过一遍 `filterBlocked`（现有机制，已经按 `userId` 剔除）

为什么不「取关失败就回滚拉黑」：拉黑是主操作，取关是副作用。
让副作用失败回滚主操作，等于「清理没做好，所以拉黑也无效」。

### 坑 2 · 不自动取关的话，列表里会有「幽灵」

如果只靠渲染层过滤而不取关，用户在 `/following` 里会看到 A（因为列表是 RPC 直出，
`filterBlocked` 不在 RPC 里）。点进去是 A 的主页，显示「已拉黑」。

→ 所以坑 1 的第 1 条（真的取关）不是优化，**是必需的**。

### 坑 3 · `wall_following()` 的 `security definer` 绕过 RLS

函数体内 `where follower_id = auth.uid()` 是**唯一的安全边界**。
写错成 `or` 条件、或者忘了写，就是全站关注关系泄漏。

→ 验收时必须测：用户 A 调 `wall_following()`，**只能**看到 A 自己的关注。

### 坑 4 · 关注的人发帖被下架/自删

`wall_following()` 里 `post_count` / `last_post_at` 必须带
`removed = false and deleted_at is null`，否则会出现「显示最近 3 天发过帖，
但关注流里空空如也」（那帖子被下架了）。

### 坑 5 · 乐观更新 + 连点

复用 `userBlocks` 的 `opTokens` 模式：
每次操作发一个 token，回滚前检查是否仍是最新一次 —— 否则
「快速点 关注→取关，关注的响应迟到失败」会把取关的结果抹掉。

### 坑 6 · 关注模式与分页状态

`followOnly` 切换时必须重置：
- `beforeId` 游标
- `cloudDone` 标志
- `reveal`（已展开条数）

否则会带着全部流的游标去查关注流，第一页直接空。

### 坑 7 · 关注流和「已看过的帖子」缓存

`CommunityView` 有「已见过」去重逻辑（`seen`），关注流共用同一个 store 会出问题：
全部流里看过的帖子，在关注流里会被当成"已看过"而不显示。

→ 关注流**不走去重**。（关注流本来就是「我想看我关注的人的全部内容」，
去重反而让用户找不到刚看过的帖子。）

### 坑 8 · `.in()` 空数组

PostgREST 的 `in.()` 传空数组在部分版本会返回**全表**而不是空集。

→ 前端在 `ids.length === 0` 时**直接不请求**，走空状态。这条必须写死在代码里。

---

## 七、i18n 键清单（5 语 × 22 条）

```
follow.title            关注
follow.following        已关注
follow.follow           + 关注
follow.unfollow         取消关注
follow.unfollowArm      再点一次取消关注
follow.self             不能关注自己
follow.busy             处理中…
follow.fail             操作失败，请重试
follow.limit            关注已达上限（200 人），先取消一些再关注

follow.listTitle        我的关注
follow.listNote         你关注的人不会收到通知 —— 这是你的阅读列表，不是社交关系。
follow.listEmpty        你还没关注任何人
follow.listEmptyHint    在暖心墙点作者头像进入主页，就能关注 TA
follow.listCount        {n} 位
follow.postsCount       {n} 篇
follow.lastPost         最近 {d}

follow.feedBtn          我的关注
follow.feedNote         只看你关注的 {n} 位博主 · 按发布时间
follow.feedEmpty        你关注的博主还没发过帖子
follow.feedNeedLogin    登录后可以关注喜欢的博主

wall.follow / wall.unfollow   （详情页 ⋯ 菜单复用 follow.follow / follow.unfollow）
```

---

## 八、落地顺序

| # | 内容 | 产出 |
|---|---|---|
| 1 | 迁移 `MIGRATION_wall_follows.sql`：表 + 索引 + RLS + 上限触发器 + `wall_following()`，直连执行并验收 | SQL |
| 2 | `db.supabase.js` 加 `followInsert/followDelete/following`；`listPosts` 加 `userIds` 参数；网关同步 | 数据层 |
| 3 | `src/utils/follows.js`：`followState` 单例（乐观 + token 防连点 + 本地快照） | 状态层 |
| 4 | `WallerView` 关注按钮 + `PostDetailView` ⋯ 菜单项 | 入口 A/B |
| 5 | `FollowingView.vue` + 路由 `/following` + `ProfileView` 入口 | 入口 C |
| 6 | `CommunityView` 「我的关注」pill + 关注流取数 + 三种空状态 | 入口 D |
| 7 | 五语 i18n + `styles` | 文案 |
| 8 | `tools/follow-test.mjs`（纯逻辑 + 源码断言）+ 真实接口验证（扮演多用户） | 测试 |
| 9 | 全量测试 → 构建 → `apk/warm-paws-1.0.2-round447.apk` | 交付 |

---

## 九、验收清单（真实接口，事务内扮演多用户后 rollback）

- [ ] A 关注 B → 成功；再关注一次 → 成功但只有一行（幂等）
- [ ] A 调 `wall_following()` → 只看到 B；B 调 → 只看到自己关注的（**看不到 A**）
- [ ] 匿名调 `wall_following()` → `permission denied`
- [ ] A 直查 `wall_follows` → 只有自己的行；B 查 → 读不到 A 关注了谁
- [ ] A 关注自己 → 被 check 约束拒绝
- [ ] A 关注第 201 人 → `wall-follow-limit`
- [ ] A 取关 B → 行消失，`wall_following()` 里也没了
- [ ] B 发帖 → 出现在 A 的关注流；B 删帖 → 从关注流和 `post_count` 一起消失
- [ ] A 拉黑 B → A 的关注列表里 B 消失
- [ ] 前端：关注 0 人时点「我的关注」**不发请求**，直接空状态
