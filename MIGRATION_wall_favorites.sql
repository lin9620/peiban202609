-- ═══════════════════════════════════════════════════════════════
--  迁移：帖子收藏夹（#13）
--  wall_favorites：登录用户收藏别人的暖心帖；收藏列表私有（RLS 只放行本人）。
--  user_id 由数据库 default auth.uid() 盖章——前端只传 post_id，不传身份。
--  用法：Supabase Dashboard → SQL Editor → 粘贴全部 → Run（幂等，可重复执行）
-- ═══════════════════════════════════════════════════════════════

create table if not exists public.wall_favorites (
  id         bigint generated always as identity primary key,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  post_id    bigint not null references public.wall_posts (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (user_id, post_id)
);

comment on table public.wall_favorites is
  '帖子收藏夹：user_id 默认 auth.uid()（客户端只传 post_id）；收藏列表私有，仅本人可读';

alter table public.wall_favorites enable row level security;

-- 收藏夹私有：只有本人能读自己的收藏（含内嵌的帖子数据）
drop policy if exists "favorites select own" on public.wall_favorites;
create policy "favorites select own" on public.wall_favorites
  for select using (auth.uid() = user_id);

-- 收藏：只能以本人身份收藏（with check 兜底，防伪造 user_id）
drop policy if exists "favorites insert own" on public.wall_favorites;
create policy "favorites insert own" on public.wall_favorites
  for insert with check (auth.uid() = user_id);

-- 取消收藏：只能删自己的
drop policy if exists "favorites delete own" on public.wall_favorites;
create policy "favorites delete own" on public.wall_favorites
  for delete using (auth.uid() = user_id);

-- 我的收藏列表：按收藏时间倒序
create index if not exists wall_favorites_user_idx
  on public.wall_favorites (user_id, created_at desc);

-- 匿名（未登录）完全不可见
revoke all on public.wall_favorites from anon;
