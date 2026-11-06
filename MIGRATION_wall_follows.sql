-- ═══════════════════════════════════════════════════════════════
--  Warm Paws · 暖爪 — 增量迁移：暖心墙关注（轮447）
-- ═══════════════════════════════════════════════════════════════
--  需求（用户原话）：
--    「加一个关注功能，这个只关联暖心墙，然后我的页面可以看到我的关注，
--      但不显示我的粉丝（你觉得怎么样），以及暖心墙那里有个我的关注按钮，
--      可以看到我关注的博主的帖子」
--
--  设计（docs/PLAN-wall-follow.md）：关注 = 我的阅读列表，不是社交关系。
--    · 只关联暖心墙（漂流瓶 / 故事零改动）。
--    · 不显示粉丝数、不做粉丝列表、关注不产生任何通知。
--      → RLS 读策略写 follower_id = auth.uid()，**不是** or followee_id = auth.uid()。
--        后者等于把「谁关注了我」送出去，正是要堵的那条路。
--    · 上限 200 人，用 BEFORE INSERT 触发器拦（RLS 的 with check 不能查自己这张表，
--      且触发器不可被 REST 直写绕过）。
--
--  用法：Supabase Dashboard → SQL Editor → 粘贴本文件全部内容 → Run
--        （幂等，可重复执行）
--  前置：MIGRATION_owner_delete.sql（wall_posts.deleted_at）
--
--  不跑也能用（降级）：
--    关注按钮点了会报错 → 前端识别「函数/表不存在」后提示「功能未开通」，
--    暖心墙其余功能不受影响（关注状态全在本地内存，读不到就是空）。
-- ═══════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════
--  一、表
-- ═══════════════════════════════════════════════════════════════
--  为什么用复合主键而不是 id identity（wall_favorites 用的是后者）：
--    关注关系天然唯一 —— 一个人只能关注另一个人一次。复合主键直接给出幂等性
--    （on conflict do nothing），「是否已关注」= 主键命中，还省掉一个 unique 索引。
create table if not exists public.wall_follows (
  follower_id uuid not null default auth.uid()
              references auth.users (id) on delete cascade,
  followee_id uuid not null
              references auth.users (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (follower_id, followee_id),
  constraint wall_follows_no_self check (follower_id <> followee_id)
);

comment on table public.wall_follows is
  '轮447 暖心墙关注：follower_id 关注 followee_id。单向、静默 —— 被关注者读不到，
   也不会收到任何通知。只影响暖心墙（「我的关注」筛选），与漂流瓶/故事无关。';

comment on column public.wall_follows.follower_id is
  '关注者 = auth.uid()（default 盖章，客户端不传身份）';

-- ═══════════════════════════════════════════════════════════════
--  二、索引
-- ═══════════════════════════════════════════════════════════════
--  「我的关注」列表按关注时间倒序：主键 (follower_id, followee_id) 只覆盖前缀，
--  排序要 created_at，所以单独一条。
create index if not exists wall_follows_follower_idx
  on public.wall_follows (follower_id, created_at desc);

--  反向（谁关注了我）：本设计不开放查询，但「删号级联」「上限计数」会用到。
create index if not exists wall_follows_followee_idx
  on public.wall_follows (followee_id);

-- ═══════════════════════════════════════════════════════════════
--  三、RLS —— 隐私口径的技术兑现
-- ═══════════════════════════════════════════════════════════════
alter table public.wall_follows enable row level security;

--  读：只能读「我关注的」。这一句写错成 or followee_id = auth.uid()，
--  就等于全站开放「谁关注了我」，整套隐私设计立刻破产。
drop policy if exists "follows select own" on public.wall_follows;
create policy "follows select own" on public.wall_follows
  for select using (auth.uid() = follower_id);

--  关注：只能以本人身份关注（with check 防伪造 follower_id）
drop policy if exists "follows insert own" on public.wall_follows;
create policy "follows insert own" on public.wall_follows
  for insert with check (auth.uid() = follower_id);

--  取关：只能删自己的
drop policy if exists "follows delete own" on public.wall_follows;
create policy "follows delete own" on public.wall_follows
  for delete using (auth.uid() = follower_id);

--  匿名完全不可见（Supabase default privileges 会把表授给 anon，必须显式撤销）
revoke all on public.wall_follows from anon;

-- ═══════════════════════════════════════════════════════════════
--  四、关注上限 200 —— BEFORE INSERT 触发器
-- ═══════════════════════════════════════════════════════════════
--  为什么不用 RLS with check：策略表达式里查同一张表会被拒（无限递归）。
--  为什么不用 RPC 包装：包一层只能挡住「走 RPC」的调用，REST 直写照样能刷。
--  触发器是唯一不可绕过的位置。
--
--  ⚠ 顺序：before insert 触发器**先于** on conflict 判定执行。
--    不先判重的话，第 201 次重复关注一个已关注的人会误报「超限」。
create or replace function public.wall_follows_limit()
returns trigger language plpgsql security definer set search_path = public as $$
declare n int;
begin
  -- 自关注先判：check 约束也能拦，但报错早于它才会给出准确原因
  -- （关注满 200 时去关注自己，不先判这里就会误报「已达上限」）
  if new.follower_id = new.followee_id then
    raise exception 'wall-follow-self' using errcode = 'P0001';
  end if;

  -- 已关注：直接放行，交给 on conflict do nothing 收尾
  if exists (
    select 1 from public.wall_follows
    where follower_id = new.follower_id and followee_id = new.followee_id
  ) then
    return new;
  end if;

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

-- ═══════════════════════════════════════════════════════════════
--  五、我的关注清单 RPC
-- ═══════════════════════════════════════════════════════════════
--  为什么不分成两次查询（follows + profiles）：
--    · 一次往返；
--    · 能带上「帖子数 / 最近发帖时间」，让列表按「还在活跃」排序 ——
--      按关注时间排，用户会看到一屏「关注了但再也不发帖的人」；
--    · post_count / last_post_at 必须排除下架与作者自删，否则会出现
--      「显示最近 3 天发过帖，但关注流里空空如也」。
--
--  ⚠ security definer 绕过 RLS，所以 where f.follower_id = auth.uid() 是**唯一**
--    的安全边界。未登录时 auth.uid() 为 null → 0 行，天然安全。
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
         coalesce(nullif(p.nickname, ''), 'Guest') as nickname,
         f.created_at,
         coalesce(s.n, 0)::int,
         s.last_at
  from public.wall_follows f
  left join public.profiles p on p.id = f.followee_id
  left join lateral (
    select count(*) as n, max(w.created_at) as last_at
    from public.wall_posts w
    where w.user_id = f.followee_id
      and w.removed = false
      and w.deleted_at is null
  ) s on true
  where f.follower_id = auth.uid()
  order by s.last_at desc nulls last, f.created_at desc;
$$;

revoke all on function public.wall_following() from public, anon;
grant execute on function public.wall_following() to authenticated;

-- ═══════════════════════════════════════════════════════════════
--  六、权限收口（触发器函数不该能被直接调用）
-- ═══════════════════════════════════════════════════════════════
revoke all on function public.wall_follows_limit() from public, anon, authenticated;

commit;
