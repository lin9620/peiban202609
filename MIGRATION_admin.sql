-- ═══════════════════════════════════════════════════════════════
--  Warm Paws · 暖爪 — 增量迁移：管理员（看板 + 内容治理）
--  用法：Supabase Dashboard → SQL Editor → 粘贴全部 → Run
--  幂等：可重复执行（IF NOT EXISTS / OR REPLACE / DROP+CREATE 策略）
--  依赖：先跑过 MIGRATION_wall_daily_view_dislike.sql（本文件引用 removed/views 列）
--  安全模型：数据权限全部由 RLS 与 security definer 函数把关，
--            前端管理页只是「壳」——拿到数据的前提是数据库认你是管理员。
-- ═══════════════════════════════════════════════════════════════

-- ── 1) 管理员名单 ─────────────────────────────────────────────
--    不给普通用户任何读取策略 → 客户端枚举不到「谁是管理员」；
--    管理员可以把别人加进来（管理页/SQL 均可），is_admin() 走 security definer 不受 RLS 限制。
create table if not exists public.admin_users (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.admin_users enable row level security;

drop policy if exists "admins manage admins" on public.admin_users;
create policy "admins manage admins" on public.admin_users
  for all using (public.is_admin()) with check (public.is_admin());

-- ── 2) 身份判定：全站唯一的管理员判断入口 ─────────────────────
create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admin_users where user_id = auth.uid());
$$;

grant execute on function public.is_admin() to anon, authenticated;

-- ── 3) 收紧帖子读取：已下架帖只有作者本人与管理员可见 ──────────
--    此前策略是 using(true)：任何人直查 REST API 都能看到已下架帖（前端只是不展示）。
--    收紧后：公开流/用户主页查询（removed=false 或本人）行为不变，管理页能看全部。
drop policy if exists "posts readable by all" on public.wall_posts;
drop policy if exists "posts visible or own or admin" on public.wall_posts;
create policy "posts visible or own or admin" on public.wall_posts
  for select using (removed = false or auth.uid() = user_id or public.is_admin());

-- ── 4) 治理动作（下架/恢复/删除）──────────────────────────────
--    update 允许管理员改任意列（可信角色）；删除帖子/评论时子行靠 FK 级联清掉。
drop policy if exists "posts admin update" on public.wall_posts;
create policy "posts admin update" on public.wall_posts
  for update using (public.is_admin()) with check (public.is_admin());

drop policy if exists "posts admin delete" on public.wall_posts;
create policy "posts admin delete" on public.wall_posts
  for delete using (public.is_admin());

drop policy if exists "comments admin delete" on public.wall_comments;
create policy "comments admin delete" on public.wall_comments
  for delete using (public.is_admin());

-- ── 5) 看板 RPC：一次返回全部总览数据 ─────────────────────────
--    非管理员调用只拿 {admin:false}（不泄露任何数字）；
--    security definer 让统计可以读 auth 侧与 storage.objects（bucket 计数/体积）。
create or replace function public.admin_overview()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (timezone('utc', now()))::date;
begin
  if not exists (select 1 from public.admin_users where user_id = auth.uid()) then
    return jsonb_build_object('admin', false);
  end if;

  return jsonb_build_object(
    'admin', true,

    'users_total',    (select count(*) from public.profiles),
    'users_today',    (select count(*) from public.profiles
                        where (timezone('utc', created_at))::date = v_today),
    'posts_total',    (select count(*) from public.wall_posts),
    'posts_today',    (select count(*) from public.wall_posts
                        where (timezone('utc', created_at))::date = v_today),
    'posts_removed',  (select count(*) from public.wall_posts where removed = true),
    'comments_total', (select count(*) from public.wall_comments),
    'comments_today', (select count(*) from public.wall_comments
                        where (timezone('utc', created_at))::date = v_today),
    'views_total',    (select coalesce(sum(views), 0) from public.wall_posts),

    'reactions', (select coalesce(jsonb_object_agg(kind, c), '{}'::jsonb)
                    from (select kind, count(*) as c
                            from public.wall_reactions group by kind) s),

    'pets_total',  (select count(*) from public.pet_profiles),
    'pats_total',  (select coalesce(sum(pats), 0) from public.pet_profiles),
    'feeds_total', (select coalesce(sum(feeds), 0) from public.pet_profiles),

    'storage_objects', (select count(*) from storage.objects where bucket_id = 'wall-images'),
    'storage_bytes',   (select coalesce(sum((metadata ->> 'size')::bigint), 0)
                          from storage.objects where bucket_id = 'wall-images'),

    'daily', (
      select jsonb_agg(jsonb_build_object(
               'day', d::date,
               'posts',    (select count(*) from public.wall_posts
                             where (timezone('utc', created_at))::date = d::date),
               'users',    (select count(*) from public.profiles
                             where (timezone('utc', created_at))::date = d::date),
               'comments', (select count(*) from public.wall_comments
                             where (timezone('utc', created_at))::date = d::date)
             ) order by d)
        from generate_series(v_today - 13, v_today, interval '1 day') g(d)
    ),

    'top_posts', (
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'author_name', p.author_name, 'body', left(p.body, 60),
               'views', p.views, 'removed', p.removed, 'created_at', p.created_at,
               'reactions', (select count(*) from public.wall_reactions r
                              where r.post_id = p.id and r.kind <> 'dislike')
             ) order by p.views desc, p.id desc)
        from (select * from public.wall_posts order by views desc, id desc limit 5) p
    ),

    'recent_users', (
      select jsonb_agg(jsonb_build_object(
               'id', u.id, 'nickname', u.nickname, 'created_at', u.created_at,
               'posts', (select count(*) from public.wall_posts p where p.user_id = u.id)
             ) order by u.created_at desc)
        from (select * from public.profiles order by created_at desc limit 8) u
    )
  );
end $$;

grant execute on function public.admin_overview() to anon, authenticated;

-- ── 6) 把自己设为管理员（改邮箱后执行；可重复跑）──────────────
-- insert into public.admin_users (user_id)
-- select id from auth.users where email = '你的邮箱@example.com'
-- on conflict (user_id) do nothing;

-- 完成 ✅ 前端访问 /admin（「我的」页会出现管理中心入口，仅管理员可见）

