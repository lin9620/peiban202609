-- ═══════════════════════════════════════════════════════════════
--  Warm Paws · 暖爪 — Supabase 一键建库脚本（第二批：云端暖心墙 + 登录）
--  用法：Supabase Dashboard → SQL Editor → 粘贴全部 → Run
--  幂等：可重复执行（全部用 IF NOT EXISTS / OR REPLACE）
-- ═══════════════════════════════════════════════════════════════

-- 1) 用户资料表（注册后由触发器自动创建一行）
create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  nickname   text not null default '',
  status     text,                        -- 陪你大厅状态 key（working/studying/sleepless/chilling）；null = 未设置
  status_at  timestamptz,                 -- 状态更新时间；大厅与主页只显示近 24h 的状态
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profiles readable by all"    on public.profiles;
drop policy if exists "profiles self insert"        on public.profiles;
drop policy if exists "profiles self update"        on public.profiles;

create policy "profiles readable by all" on public.profiles
  for select using (true);
create policy "profiles self insert" on public.profiles
  for insert with check (auth.uid() = id);
create policy "profiles self update" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- 老库补列（幂等）：陪你大厅状态上云（#4；详见 MIGRATION_profile_status.sql）
alter table public.profiles add column if not exists status    text;
alter table public.profiles add column if not exists status_at timestamptz;
create index if not exists profiles_status_at_idx on public.profiles (status_at desc);

-- 注册后自动建档（昵称先取注册时填的 metadata.nickname）
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, nickname)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'nickname', ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 2) 暖心墙帖子
create table if not exists public.wall_posts (
  id          bigserial primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  author_name text not null default 'Guest',
  body        text not null check (char_length(body) between 1 and 1000),
  image_path  text,                       -- Storage 内路径，可空（纯文字帖）
  created_at  timestamptz not null default now()
);

alter table public.wall_posts enable row level security;

drop policy if exists "posts readable by all" on public.wall_posts;
drop policy if exists "posts insert by auth"  on public.wall_posts;
drop policy if exists "posts delete own"      on public.wall_posts;

create policy "posts readable by all" on public.wall_posts
  for select using (true);
create policy "posts insert by auth" on public.wall_posts
  for insert with check (auth.uid() = user_id);
create policy "posts delete own" on public.wall_posts
  for delete using (auth.uid() = user_id);

-- 3) 暖心墙评论（支持二级回复：parent_id 指向同帖的一级评论，最多两层）
create table if not exists public.wall_comments (
  id            bigserial primary key,
  post_id       bigint not null references public.wall_posts (id) on delete cascade,
  parent_id     bigint references public.wall_comments (id) on delete cascade,  -- 可空：空 = 一级评论
  reply_to_name text,                                                          -- 二级里「@谁」的昵称，可空
  user_id       uuid not null references auth.users (id) on delete cascade,
  author_name   text not null default 'Guest',
  body          text not null check (char_length(body) between 1 and 200),
  created_at    timestamptz not null default now()
);

-- 已建过库的用户：补 parent_id / reply_to_name 列（幂等，重复执行无副作用）
alter table public.wall_comments add column if not exists parent_id bigint;
alter table public.wall_comments add column if not exists reply_to_name text;
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'wall_comments_parent_id_fkey' and conrelid = 'public.wall_comments'::regclass
  ) then
    alter table public.wall_comments
      add constraint wall_comments_parent_id_fkey
      foreign key (parent_id) references public.wall_comments (id) on delete cascade;
  end if;
end $$;

create index if not exists wall_comments_post_idx   on public.wall_comments (post_id);
create index if not exists wall_comments_parent_idx on public.wall_comments (parent_id);

alter table public.wall_comments enable row level security;

drop policy if exists "comments readable by all" on public.wall_comments;
drop policy if exists "comments insert by auth"  on public.wall_comments;
drop policy if exists "comments insert own or reply" on public.wall_comments;
drop policy if exists "comments delete own"      on public.wall_comments;

create policy "comments readable by all" on public.wall_comments
  for select using (true);
/* 写入：user_id 必须是自己（parent_id 是否同帖由前端保证 + FK 兜底；
   策略里不复查本表，避免 Postgres "infinite recursion detected in policy" ） */
create policy "comments insert by auth" on public.wall_comments
  for insert with check (auth.uid() = user_id);
create policy "comments delete own" on public.wall_comments
  for delete using (auth.uid() = user_id);

-- 4) 回应（抱抱/暖暖/同感）：每人每帖每种一次
create table if not exists public.wall_reactions (
  post_id   bigint not null references public.wall_posts (id) on delete cascade,
  user_id   uuid   not null references auth.users (id) on delete cascade,
  kind      text   not null check (kind in ('hug', 'warm', 'relate')),
  created_at timestamptz not null default now(),
  primary key (post_id, user_id, kind)
);

alter table public.wall_reactions enable row level security;

drop policy if exists "reactions readable by all" on public.wall_reactions;
drop policy if exists "reactions write by auth"   on public.wall_reactions;
drop policy if exists "reactions remove own"      on public.wall_reactions;

create policy "reactions readable by all" on public.wall_reactions
  for select using (true);
create policy "reactions write by auth" on public.wall_reactions
  for insert with check (auth.uid() = user_id);
create policy "reactions remove own" on public.wall_reactions
  for delete using (auth.uid() = user_id);

-- 5) 图片存储桶（公开读，登录上传，只能改/删自己路径下的对象）
insert into storage.buckets (id, name, public)
values ('wall-images', 'wall-images', true)
on conflict (id) do nothing;

drop policy if exists "wall images public read"   on storage.objects;
drop policy if exists "wall images auth upload"   on storage.objects;
drop policy if exists "wall images own update"    on storage.objects;
drop policy if exists "wall images own delete"    on storage.objects;

create policy "wall images public read" on storage.objects
  for select using (bucket_id = 'wall-images');
create policy "wall images auth upload" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'wall-images' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "wall images own update" on storage.objects
  for update to authenticated
  using (bucket_id = 'wall-images' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "wall images own delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'wall-images' and (storage.foldername(name))[1] = auth.uid()::text);

-- 6) 暖心墙进阶：每日限额 + 浏览数 + 厌恶与自动下架
--    views/dislikes 由服务端维护（RPC 里数），removed 是假删除标记（数据仍在库里）
--    created_day = UTC 日，用于「每个用户每天最多一条」
alter table public.wall_posts add column if not exists views       integer     not null default 0;
alter table public.wall_posts add column if not exists dislikes    integer     not null default 0;
alter table public.wall_posts add column if not exists removed     boolean     not null default false;
alter table public.wall_posts add column if not exists removed_at  timestamptz;
alter table public.wall_posts add column if not exists created_day date        not null
  default (timezone('utc', now()))::date;

create index if not exists wall_posts_visible_idx on public.wall_posts (created_at desc)
  where removed = false;

-- 每个用户每天最多 7 条（触发器只拦新插入；老库里的历史数据不受影响）
-- 与 MIGRATION_wall_daily_7.sql / 前端 wallRules.WALL_POST_DAILY_LIMIT = 7 同口径
create or replace function public.wall_daily_limit()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (
    select count(*) from public.wall_posts p
    where p.user_id = new.user_id and p.created_day = new.created_day
  ) >= 7 then
    raise exception 'wall_daily_limit' using errcode = 'P0001',
      hint = '每个用户每天最多发 7 条暖心墙内容';
  end if;
  return new;
end $$;

drop trigger if exists wall_posts_daily_limit on public.wall_posts;
create trigger wall_posts_daily_limit
  before insert on public.wall_posts
  for each row execute function public.wall_daily_limit();

-- 每日上限 7 条由上面的触发器负责；不再建「一天一条」唯一索引
-- （历史版本曾建 wall_posts_one_per_day_idx，升级请跑 MIGRATION_wall_daily_7.sql 拆掉）

-- 回应种类增加「厌恶」（每人每帖一次，RPC 里切换）
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'wall_reactions_kind_check' and conrelid = 'public.wall_reactions'::regclass
  ) then
    alter table public.wall_reactions drop constraint wall_reactions_kind_check;
  end if;
  begin
    alter table public.wall_reactions
      add constraint wall_reactions_kind_check
      check (kind in ('hug', 'warm', 'relate', 'dislike'));
  exception when duplicate_object then null;
  end;
end $$;

-- 浏览去重：同一访客对同一条帖，一天只算一次（防刷新刷浏览量）
create table if not exists public.wall_post_views (
  post_id    bigint not null references public.wall_posts (id) on delete cascade,
  viewer_key text   not null,
  day        date   not null default (timezone('utc', now()))::date,
  created_at timestamptz not null default now(),
  primary key (post_id, viewer_key, day)
);

create index if not exists wall_post_views_post_idx on public.wall_post_views (post_id);

alter table public.wall_post_views enable row level security;

drop policy if exists "post views readable by all" on public.wall_post_views;
create policy "post views readable by all" on public.wall_post_views
  for select using (true);
-- 不开放直接 insert/update：写入只能走 wall_add_view()（防刷计数）

-- RPC：记一次浏览（同人同帖同日只 +1）；游客也能走（匿名 id）
create or replace function public.wall_add_view(p_post bigint, p_viewer text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_viewer  text := coalesce(nullif(trim(coalesce(p_viewer, '')), ''),
                             coalesce(auth.uid()::text, 'anon'));
  v_counted boolean;
  v_views   integer;
  v_dis     integer;
  v_rm      boolean;
begin
  insert into public.wall_post_views (post_id, viewer_key)
  values (p_post, v_viewer)
  on conflict do nothing;
  v_counted := found;

  if v_counted then
    update public.wall_posts set views = views + 1 where id = p_post
      returning views, dislikes, removed into v_views, v_dis, v_rm;
  else
    select views, dislikes, removed into v_views, v_dis, v_rm
      from public.wall_posts where id = p_post;
  end if;

  if v_views is null then
    return jsonb_build_object('ok', false, 'reason', 'not-found');
  end if;
  return jsonb_build_object('ok', true, 'counted', v_counted,
                            'views', v_views, 'dislikes', v_dis, 'removed', v_rm);
end $$;

-- RPC：切换厌恶；达 #26 双档下架线 → 下架（假删除，不再自动恢复）
create or replace function public.wall_toggle_dislike(p_post bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid   uuid := auth.uid();
  v_on    boolean;
  v_views integer;
  v_dis   integer;
  v_rm    boolean;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'reason', 'auth-required');
  end if;

  if exists (
    select 1 from public.wall_reactions
    where post_id = p_post and user_id = v_uid and kind = 'dislike'
  ) then
    delete from public.wall_reactions
      where post_id = p_post and user_id = v_uid and kind = 'dislike';
    v_on := false;
  else
    insert into public.wall_reactions (post_id, user_id, kind)
    values (p_post, v_uid, 'dislike')
    on conflict do nothing;
    v_on := true;
  end if;

  select count(*) into v_dis from public.wall_reactions
    where post_id = p_post and kind = 'dislike';
  update public.wall_posts set dislikes = v_dis where id = p_post
    returning views, removed into v_views, v_rm;

  if v_views is null then
    return jsonb_build_object('ok', false, 'reason', 'not-found');
  end if;

  if not v_rm and (
       (v_views < 100 and v_dis > 3)                    -- #26 低浏览档：超过 3 个（≥4）就下架
       or (v_views >= 100 and (v_dis::numeric / v_views) > 0.005)  -- 高浏览档：> 0.5% 就下架
     ) then
    update public.wall_posts set removed = true, removed_at = now() where id = p_post;
    v_rm := true;
    -- 轮 33：下架即进「待复核」队列，让管理员看到（处理完后再次下架可再排队）
    insert into public.reports (reporter_id, target_type, target_id, reason, source)
    values (null, 'post', p_post, 'auto', 'auto')
    on conflict do nothing;
  end if;

  return jsonb_build_object('ok', true, 'on', v_on, 'views', v_views,
                            'dislikes', v_dis, 'removed', v_rm);
end $$;

grant execute on function public.wall_add_view(bigint, text) to anon, authenticated;
grant execute on function public.wall_toggle_dislike(bigint) to authenticated;

-- 7) 主页的伙伴（/u/:id）：宠物 + 手绘厨房镜像 + 访客互动
--    data = 展示快照（pet/dishes/updated）；互动计数单独占列 pats/feeds，
--    这样主人同步时整体覆盖 data 也不会把访客的计数冲掉。
create table if not exists public.pet_profiles (
  user_id    uuid primary key references public.profiles (id) on delete cascade,
  data       jsonb not null default '{"pet":null,"dishes":[],"updated":0}'::jsonb,
  pats       integer not null default 0,
  feeds      integer not null default 0,
  updated_at timestamptz not null default now()
);

-- 老库补列（幂等）：早期版本把计数写在 data.counts 里，会被主人镜像覆盖成 0
alter table public.pet_profiles add column if not exists pats  integer not null default 0;
alter table public.pet_profiles add column if not exists feeds integer not null default 0;

alter table public.pet_profiles enable row level security;

drop policy if exists "pet profiles readable by all" on public.pet_profiles;
create policy "pet profiles readable by all" on public.pet_profiles
  for select using (true);

drop policy if exists "pet profiles owner writes" on public.pet_profiles;
create policy "pet profiles owner writes" on public.pet_profiles
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table if not exists public.pet_interactions (
  owner_id   uuid not null references public.profiles (id) on delete cascade,
  viewer_key text  not null,
  day        date  not null default (timezone('utc', now()))::date,
  kind       text  not null check (kind in ('pat', 'feed')),
  created_at timestamptz not null default now(),
  primary key (owner_id, viewer_key, day, kind)
);

alter table public.pet_interactions enable row level security;

drop policy if exists "pet interactions readable by all" on public.pet_interactions;
create policy "pet interactions readable by all" on public.pet_interactions
  for select using (true);

create or replace function public.pet_interact(p_owner uuid, p_kind text, p_viewer text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_viewer  text := coalesce(nullif(trim(coalesce(p_viewer, '')), ''),
                             coalesce(auth.uid()::text, 'anon'));
  v_counted boolean;
  v_pats    integer;
  v_feeds   integer;
begin
  if p_kind not in ('pat', 'feed') then
    return jsonb_build_object('ok', false, 'reason', 'bad-kind');
  end if;

  insert into public.pet_interactions (owner_id, viewer_key, kind)
  values (p_owner, v_viewer, p_kind)
  on conflict do nothing;
  v_counted := found;

  if v_counted then
    /* 只动 pats / feeds 列，绝不碰 data（主人镜像 upsert 会整体覆盖 data） */
    insert into public.pet_profiles (user_id) values (p_owner)
      on conflict (user_id) do nothing;

    update public.pet_profiles
      set pats  = pats  + case when p_kind = 'pat'  then 1 else 0 end,
          feeds = feeds + case when p_kind = 'feed' then 1 else 0 end
      where user_id = p_owner;
  end if;

  select pats, feeds into v_pats, v_feeds
    from public.pet_profiles where user_id = p_owner;

  return jsonb_build_object('ok', true, 'counted', v_counted,
                            'counts', jsonb_build_object('pats',  coalesce(v_pats, 0),
                                                         'feeds', coalesce(v_feeds, 0)));
end $$;

grant execute on function public.pet_interact(uuid, text, text) to anon, authenticated;

-- 8) 管理员（看板 + 内容治理）
--    名单表不给普通用户任何读取策略 → 客户端枚举不到「谁是管理员」；
--    数据权限全部由 RLS 与 security definer 函数把关，前端管理页只是「壳」。
--    依赖：wall_posts 的 removed/views 列（上方 3) 幂等补列，先于本段执行）。
create table if not exists public.admin_users (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.admin_users enable row level security;

-- 身份判定：全站唯一的管理员判断入口（先建函数，下面的策略才能引用它）
create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admin_users where user_id = auth.uid());
$$;

grant execute on function public.is_admin() to anon, authenticated;

drop policy if exists "admins manage admins" on public.admin_users;
create policy "admins manage admins" on public.admin_users
  for all using (public.is_admin()) with check (public.is_admin());

-- 收紧帖子读取：已下架帖只有作者本人与管理员可见（公开流/主页行为不变）
drop policy if exists "posts readable by all" on public.wall_posts;
drop policy if exists "posts visible or own or admin" on public.wall_posts;
create policy "posts visible or own or admin" on public.wall_posts
  for select using (removed = false or auth.uid() = user_id or public.is_admin());

-- 治理动作（下架/恢复/删除）；删除帖子/评论时子行靠 FK 级联清掉
drop policy if exists "posts admin update" on public.wall_posts;
create policy "posts admin update" on public.wall_posts
  for update using (public.is_admin()) with check (public.is_admin());

drop policy if exists "posts admin delete" on public.wall_posts;
create policy "posts admin delete" on public.wall_posts
  for delete using (public.is_admin());

drop policy if exists "comments admin delete" on public.wall_comments;
create policy "comments admin delete" on public.wall_comments
  for delete using (public.is_admin());

-- 看板 RPC：一次返回全部总览数据；非管理员调用只拿 {admin:false}（不泄露任何数字）；
-- security definer 让统计可以读 auth 侧与 storage.objects（bucket 计数/体积）。
create or replace function public.admin_overview()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (timezone('Asia/Shanghai', now()))::date;
begin
  if not exists (select 1 from public.admin_users where user_id = auth.uid()) then
    return jsonb_build_object('admin', false);
  end if;

  return jsonb_build_object(
    'admin', true,

    'users_total',    (select count(*) from public.profiles),
    'users_today',    (select count(*) from public.profiles
                        where (timezone('Asia/Shanghai', created_at))::date = v_today),
    'posts_total',    (select count(*) from public.wall_posts),
    'posts_today',    (select count(*) from public.wall_posts
                        where (timezone('Asia/Shanghai', created_at))::date = v_today),
    'posts_removed',  (select count(*) from public.wall_posts where removed = true),
    'comments_total', (select count(*) from public.wall_comments),
    'comments_today', (select count(*) from public.wall_comments
                        where (timezone('Asia/Shanghai', created_at))::date = v_today),
    'views_total',    (select coalesce(sum(views), 0) from public.wall_posts),
    'reports_pending', (select count(*) from public.reports where status = 'pending'),

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
                             where (timezone('Asia/Shanghai', created_at))::date = d::date),
               'users',    (select count(*) from public.profiles
                             where (timezone('Asia/Shanghai', created_at))::date = d::date),
               'comments', (select count(*) from public.wall_comments
                             where (timezone('Asia/Shanghai', created_at))::date = d::date)
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

-- 用户名单分页 RPC：邮箱只在 DB 侧 join auth.users 提供（REST 读不到 auth.users）；
-- 内部 is_admin() 把关，非管理员拿到 {admin:false, users:[]}。
create or replace function public.admin_users_page(p_offset integer default 0, p_limit integer default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_total bigint;
begin
  if not exists (select 1 from public.admin_users where user_id = auth.uid()) then
    return jsonb_build_object('admin', false, 'total', 0, 'users', '[]'::jsonb);
  end if;

  select count(*) into v_total from public.profiles;

  return jsonb_build_object(
    'admin', true,
    'total', v_total,
    'users', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id,
               'nickname', p.nickname,
               'email', coalesce(u.email, ''),
               'created_at', p.created_at
             ) order by p.created_at desc, p.id desc)
        from (select *
                from public.profiles
               order by created_at desc, id desc
               limit least(greatest(coalesce(p_limit, 100), 1), 500)
              offset greatest(coalesce(p_offset, 0), 0)) p
        join auth.users u on u.id = p.id
    ), '[]'::jsonb)
  );
end $$;

grant execute on function public.admin_users_page(integer, integer) to anon, authenticated;

-- 首位管理员：把邮箱换成你自己的，取消注释后执行（可重复跑）
-- insert into public.admin_users (user_id)
-- select id from auth.users where email = '你的邮箱@example.com'
-- on conflict (user_id) do nothing;

-- 完成 ✅ 接下来在项目根目录配置 URL 和 anon key（见 README「Supabase 配置」）

-- ============================================================
-- 9) 私信与通知中心（阶段 4：DM + Notifications）
--    与 MIGRATION_dm_notifications.sql 正文一致（tools/dm-test.mjs 校验覆盖）
-- ============================================================

-- 1) 拉黑（先建：dm_open / dm_send 都要查它）
create table if not exists public.dm_blocks (
  blocker    uuid not null references public.profiles (id) on delete cascade,
  blocked    uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker, blocked)
);

-- 2) 会话
create table if not exists public.dm_conversations (
  id              bigserial primary key,
  user_a          uuid not null references public.profiles (id) on delete cascade,
  user_b          uuid not null references public.profiles (id) on delete cascade,
  last_message_at timestamptz,
  last_preview    text not null default '',
  created_at      timestamptz not null default now(),
  constraint dm_conv_pair_key unique (user_a, user_b),
  constraint dm_conv_sorted    check (user_a < user_b)
);
create index if not exists dm_conv_b_idx    on public.dm_conversations (user_b);
create index if not exists dm_conv_sort_idx on public.dm_conversations (user_a, created_at desc);

-- 3) 消息（撤回 = deleted_at 置位并清空内容；预览改写见 dm_recall）
create table if not exists public.dm_messages (
  id         bigserial primary key,
  conv_id    bigint not null references public.dm_conversations (id) on delete cascade,
  sender     uuid not null references public.profiles (id) on delete cascade,
  body       text not null default '',
  image_path text,
  edited_at  timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  constraint dm_msg_body_len  check (char_length(body) <= 2000),
  constraint dm_msg_not_empty check (deleted_at is not null or char_length(body) > 0 or image_path is not null)
);
create index if not exists dm_msg_conv_idx on public.dm_messages (conv_id, id desc);
-- 撤回会把正文清空（deleted_at 置位）—— 约束必须放行「已撤回的空消息」；
-- 跑过旧版迁移的库重跑本文件时在此重建，完成自愈。
alter table public.dm_messages drop constraint if exists dm_msg_not_empty;
alter table public.dm_messages add constraint dm_msg_not_empty
  check (deleted_at is not null or char_length(body) > 0 or image_path is not null);
-- (待续1)

-- 4) 每人每会话状态（已读水位 last_read_id：读到的最大消息 id，微信/IG 式）
create table if not exists public.dm_states (
  conv_id      bigint not null references public.dm_conversations (id) on delete cascade,
  user_id      uuid not null references public.profiles (id) on delete cascade,
  last_read_id bigint not null default 0,
  accepted     boolean not null default false,   -- false = 待处理的「消息请求」
  hidden_until timestamptz,                      -- 隐藏；'infinity' = 拒绝/拉黑后永久藏
  muted        boolean not null default false,   -- 免打扰：不产生 dm 通知，红点照常
  primary key (conv_id, user_id)
);
create index if not exists dm_states_user_idx on public.dm_states (user_id, accepted);

-- 5) 通知（actor_id 为空 = 系统通知；meta 携带反应种类 / 预览文本等）
create table if not exists public.notifications (
  id         bigserial primary key,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  actor_id   uuid references public.profiles (id) on delete cascade,
  kind       text not null,
  post_id    bigint references public.wall_posts (id) on delete cascade,
  comment_id bigint references public.wall_comments (id) on delete cascade,
  conv_id    bigint references public.dm_conversations (id) on delete cascade,
  meta       jsonb not null default '{}'::jsonb,
  read_at    timestamptz,
  created_at timestamptz not null default now(),
  constraint notif_kind check (kind in ('comment','reply','reaction','pet','dm','system'))
);
create index if not exists notif_user_idx         on public.notifications (user_id, id desc);
create index if not exists notif_user_unread_idx  on public.notifications (user_id) where read_at is null;

-- 6) 通知偏好（行不存在 = 四类全开；RPC 读取时统一补默认值）
create table if not exists public.notification_prefs (
  user_id    uuid primary key references public.profiles (id) on delete cascade,
  comments   boolean not null default true,
  reactions  boolean not null default true,
  pets       boolean not null default true,
  dms        boolean not null default true,
  updated_at timestamptz not null default now()
);
-- (待续2)

-- ══════════════════ RLS：先开行级安全，再建策略 ══════════════════

alter table public.dm_blocks          enable row level security;
alter table public.dm_conversations   enable row level security;
alter table public.dm_messages        enable row level security;
alter table public.dm_states          enable row level security;
alter table public.notifications      enable row level security;
alter table public.notification_prefs enable row level security;

-- 拉黑：只看 / 只管自己发出的拉黑（直接表写，无需 RPC）
drop policy if exists "blocks read own" on public.dm_blocks;
create policy "blocks read own" on public.dm_blocks
  for select using (auth.uid() = blocker);
drop policy if exists "blocks insert own" on public.dm_blocks;
create policy "blocks insert own" on public.dm_blocks
  for insert with check (auth.uid() = blocker and blocked <> blocker);
drop policy if exists "blocks remove own" on public.dm_blocks;
create policy "blocks remove own" on public.dm_blocks
  for delete using (auth.uid() = blocker);

-- 会话：只有参与者可读；写入一律走 RPC（无 insert/update/delete 策略 = 直写被拒）
drop policy if exists "convs read participant" on public.dm_conversations;
create policy "convs read participant" on public.dm_conversations
  for select using (auth.uid() = user_a or auth.uid() = user_b);

-- 消息：参与者可读；写入只走 dm_send RPC
drop policy if exists "messages read participant" on public.dm_messages;
create policy "messages read participant" on public.dm_messages
  for select using (
    exists (
      select 1 from public.dm_conversations c
       where c.id = conv_id and (auth.uid() = c.user_a or auth.uid() = c.user_b)
    )
  );

-- 状态：只读自己的行；水位 / 隐藏 / 免打扰 / 接受 全走 RPC
drop policy if exists "states read own" on public.dm_states;
create policy "states read own" on public.dm_states
  for select using (auth.uid() = user_id);

-- 通知：收件人可读、可清空（删自己 = 通知页「清空」）；标记已读走 notif_mark RPC
drop policy if exists "notifs read recipient" on public.notifications;
create policy "notifs read recipient" on public.notifications
  for select using (auth.uid() = user_id);
drop policy if exists "notifs remove recipient" on public.notifications;
create policy "notifs remove recipient" on public.notifications
  for delete using (auth.uid() = user_id);

-- 偏好：只读自己的行；写走 notif_prefs_set RPC
drop policy if exists "prefs read own" on public.notification_prefs;
create policy "prefs read own" on public.notification_prefs
  for select using (auth.uid() = user_id);
-- (待续3)

-- ══════════════════ 私信 RPC（全部 security definer，前端不直写） ══════════════════

-- 小工具：a 是否拉黑了 b（security definer：RPC 内要跨行读 dm_blocks）
create or replace function public.dm_is_blocked(a uuid, b uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.dm_blocks where blocker = a and blocked = b)
$$;

-- 小工具：两人之间的会话 id（无则 null）
create or replace function public.dm_find_conv(a uuid, b uuid)
returns bigint language sql stable security definer set search_path = public as $$
  select id from public.dm_conversations
   where (user_a = a and user_b = b) or (user_a = b and user_b = a)
   limit 1
$$;

-- 打开会话：找或建（并发重复建由唯一约束兜底）；返回 { conv_id }
create or replace function public.dm_open(p_other uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me   uuid := auth.uid();
  v_id bigint;
begin
  if me is null then raise exception 'auth-required'; end if;
  if p_other is null or p_other = me then raise exception 'bad-target'; end if;
  if not exists (select 1 from public.profiles where id = p_other) then
    raise exception 'no-user';
  end if;
  -- 对方拉黑了我 → 拒绝发起（不暴露更多信息）
  if exists (select 1 from public.dm_blocks where blocker = p_other and blocked = me) then
    raise exception 'blocked';
  end if;
  select public.dm_find_conv(me, p_other) into v_id;
  if v_id is null then
    begin
      insert into public.dm_conversations (user_a, user_b)
        values (least(me, p_other), greatest(me, p_other))
        returning id into v_id;
    exception when unique_violation then
      v_id := public.dm_find_conv(me, p_other);
    end;
  end if;
  -- 状态行：发起者视为已接受；对方保持「消息请求」待处理（已有状态不动）
  insert into public.dm_states (conv_id, user_id, accepted)
    values (v_id, me, true), (v_id, p_other, false)
    on conflict (conv_id, user_id) do nothing;
  return jsonb_build_object('conv_id', v_id);
end $$;
-- (待续4)

-- 发消息（一个事务内：插消息 + 会话冗余 + 双方状态 + 对方通知）
-- 错误码：auth-required / bad-conv / empty-message / forbidden / blocked / blocked-by-me
create or replace function public.dm_send(p_conv bigint, p_body text default '', p_image text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me      uuid := auth.uid();
  v_other uuid;
  v_mid   bigint;
  v_body  text := coalesce(p_body, '');
  v_muted boolean := false;
  v_dms   boolean := true;
  v_prev  text;
begin
  if me is null then raise exception 'auth-required'; end if;
  if p_conv is null then raise exception 'bad-conv'; end if;
  v_body := left(btrim(v_body), 2000);
  if char_length(v_body) = 0 and coalesce(p_image, '') = '' then
    raise exception 'empty-message';
  end if;
  select case when user_a = me then user_b else user_a end into v_other
    from public.dm_conversations where id = p_conv;
  if v_other is null then raise exception 'forbidden'; end if;  -- 不是参与者
  if exists (select 1 from public.dm_blocks where blocker = me and blocked = v_other) then
    raise exception 'blocked-by-me';   -- 我拉黑了对方：先去解除拉黑
  end if;
  if exists (select 1 from public.dm_blocks where blocker = v_other and blocked = me) then
    raise exception 'blocked';         -- 对方拉黑了我
  end if;

  -- #22 首次会话限制：对方从没回过时，先发起的一方最多发 3 条（防骚扰；对方一回复即解锁）。
  -- 漂流瓶续聊导入的会话双方各有一条消息，天然解锁，不受影响；已撤回的不计数。
  if not exists (
    select 1 from public.dm_messages
     where conv_id = p_conv and sender = v_other and deleted_at is null
  ) then
    if (select count(*) from public.dm_messages
         where conv_id = p_conv and sender = me and deleted_at is null) >= 3 then
      raise exception 'first-limit';
    end if;
  end if;

  insert into public.dm_messages (conv_id, sender, body, image_path)
    values (p_conv, me, v_body, nullif(coalesce(p_image, ''), ''))
    returning id into v_mid;

  -- 预览：正文截 80 字；纯图片用 📷
  v_prev := case when char_length(v_body) > 0 then left(v_body, 80) else '📷' end;
  update public.dm_conversations
     set last_message_at = now(), last_preview = v_prev
   where id = p_conv;

  -- 我方状态：回复即接受消息请求；发送意味着读到了自己的消息（抬水位）
  insert into public.dm_states (conv_id, user_id, accepted, last_read_id)
    values (p_conv, me, true, v_mid)
    on conflict (conv_id, user_id) do update
      set accepted = true,
          last_read_id = greatest(public.dm_states.last_read_id, excluded.last_read_id);
  -- 确保对方状态行存在（防御：老会话状态行缺失时补齐）
  insert into public.dm_states (conv_id, user_id, accepted)
    values (p_conv, v_other, false)
    on conflict (conv_id, user_id) do nothing;
  -- 新消息让两边被隐藏的会话重新出现（WhatsApp 行为；拉黑时 dm_send 已拒绝，不会复活）
  update public.dm_states set hidden_until = null where conv_id = p_conv;

  -- 通知对方：看对方偏好（dms 开关）与免打扰
  -- 注意：PL/pgSQL 的 SELECT INTO 在「无行」时把 NULL 赋给目标 —— 必须在赋值后再兜底，
  -- 否则没建偏好行的新用户（select 无行 → v_dms=NULL → if NULL 走 else）永远收不到私信通知。
  select coalesce(s.muted, false) into v_muted
    from public.dm_states s where s.conv_id = p_conv and s.user_id = v_other;
  v_muted := coalesce(v_muted, false);
  select p.dms into v_dms
    from public.notification_prefs p where p.user_id = v_other;
  v_dms := coalesce(v_dms, true);
  if not v_muted and v_dms then
    insert into public.notifications (user_id, actor_id, kind, conv_id, meta)
      values (v_other, me, 'dm', p_conv, jsonb_build_object('preview', v_prev));
  end if;

  return jsonb_build_object('msg_id', v_mid, 'conv_id', p_conv, 'created_at', now());
end $$;
-- (待续5)

-- 会话列表：对方昵称 + 未读数 + 预览 + 我方状态，一次聚合（无 N+1）
-- 返回 [{conv_id, other_id, nickname, last_message_at, last_preview, created_at,
--        accepted, muted, hidden, blocked, unread}]，按最近动静新→旧
create or replace function public.dm_list_convs(p_limit integer default 100, p_offset integer default 0)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'auth-required'; end if;
  return coalesce((
    select jsonb_agg(q.x order by q.sort_at desc)
    from (
      select jsonb_build_object(
        'conv_id',        c.id,
        'other_id',       case when c.user_a = me then c.user_b else c.user_a end,
        'nickname',       p.nickname,
        'last_message_at', c.last_message_at,
        'last_preview',   c.last_preview,
        'created_at',     c.created_at,
        'accepted',       coalesce(s.accepted, true),
        'muted',          coalesce(s.muted, false),
        'hidden',         coalesce(s.hidden_until > now(), false),
        'blocked',        public.dm_is_blocked(me, case when c.user_a = me then c.user_b else c.user_a end),
        'unread', (select count(*) from public.dm_messages m
                    where m.conv_id = c.id and m.sender <> me
                      and m.deleted_at is null
                      and m.id > coalesce(s.last_read_id, 0))
      ) as x,
      coalesce(c.last_message_at, c.created_at) as sort_at
      from public.dm_conversations c
      join public.dm_states s on s.conv_id = c.id and s.user_id = me
      join public.profiles  p on p.id = (case when c.user_a = me then c.user_b else c.user_a end)
      where coalesce(s.hidden_until, '-infinity'::timestamptz) <= now()
        and not public.dm_is_blocked(me, case when c.user_a = me then c.user_b else c.user_a end)
      order by coalesce(c.last_message_at, c.created_at) desc
      limit least(coalesce(p_limit, 100), 200) offset greatest(coalesce(p_offset, 0), 0)
    ) q
  ), '[]'::jsonb);
end $$;

-- 消息分页：游标（p_before = 上一页最小 id）向上翻历史；返回新→旧，客户端反转
create or replace function public.dm_list_messages(p_conv bigint, p_before bigint default null, p_limit integer default 30)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'auth-required'; end if;
  if not exists (
    select 1 from public.dm_conversations c
     where c.id = p_conv and (c.user_a = me or c.user_b = me)
  ) then raise exception 'forbidden'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id',         m.id,
      'sender',     m.sender,
      'nickname',   p.nickname,
      'body',       case when m.deleted_at is null then m.body else '' end,
      'image_path', case when m.deleted_at is null then m.image_path else null end,
      'edited_at',  m.edited_at,
      'deleted_at', m.deleted_at,
      'created_at', m.created_at
    ) order by m.id desc)
    from (
      select * from public.dm_messages
       where conv_id = p_conv and (p_before is null or id < p_before)
       order by id desc
       limit least(coalesce(p_limit, 30), 100)
    ) m
    join public.profiles p on p.id = m.sender
  ), '[]'::jsonb);
end $$;

-- 单个会话的元信息（深链 /messages/:id 直接进入时用）
create or replace function public.dm_conv_meta(p_conv bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me      uuid := auth.uid();
  v_other uuid;
  s       public.dm_states;
begin
  if me is null then raise exception 'auth-required'; end if;
  select case when user_a = me then user_b else user_a end into v_other
    from public.dm_conversations where id = p_conv;
  if v_other is null then raise exception 'forbidden'; end if;
  select * into s from public.dm_states
   where conv_id = p_conv and user_id = me;
  return jsonb_build_object(
    'conv_id',  p_conv,
    'other_id', v_other,
    'nickname', (select nickname from public.profiles where id = v_other),
    'accepted', coalesce(s.accepted, true),
    'muted',    coalesce(s.muted, false),
    'hidden',   coalesce(s.hidden_until > now(), false),
    'blocked',  public.dm_is_blocked(me, v_other)
  );
end $$;
-- (待续6)

-- 已读水位：读到本会话最新一条（进入会话 / 收到新消息时调用）
create or replace function public.dm_mark_read(p_conv bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me    uuid := auth.uid();
  v_max bigint;
begin
  if me is null then raise exception 'auth-required'; end if;
  if not exists (
    select 1 from public.dm_conversations c
     where c.id = p_conv and (c.user_a = me or c.user_b = me)
  ) then raise exception 'forbidden'; end if;
  select coalesce(max(id), 0) into v_max from public.dm_messages where conv_id = p_conv;
  insert into public.dm_states (conv_id, user_id, last_read_id)
    values (p_conv, me, v_max)
    on conflict (conv_id, user_id) do update
      set last_read_id = greatest(public.dm_states.last_read_id, excluded.last_read_id);
  return jsonb_build_object('ok', true, 'last_read_id', v_max);
end $$;

-- 会话状态三件套：隐藏 / 取消隐藏 / 免打扰 / 接受请求（拒绝 = 隐藏，前端映射）
create or replace function public.dm_hide(p_conv bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'auth-required'; end if;
  update public.dm_states set hidden_until = 'infinity'::timestamptz
   where conv_id = p_conv and user_id = me;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.dm_unhide(p_conv bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'auth-required'; end if;
  update public.dm_states set hidden_until = null
   where conv_id = p_conv and user_id = me;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.dm_mute(p_conv bigint, p_on boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'auth-required'; end if;
  update public.dm_states set muted = coalesce(p_on, true)
   where conv_id = p_conv and user_id = me;
  return jsonb_build_object('ok', true, 'muted', coalesce(p_on, true));
end $$;

create or replace function public.dm_accept(p_conv bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'auth-required'; end if;
  update public.dm_states set accepted = true, hidden_until = null
   where conv_id = p_conv and user_id = me;
  return jsonb_build_object('ok', true);
end $$;

-- 撤回：作者本人、发出后 15 分钟内；清空内容并把（若仍是最新一条的）预览改成 ⟲
create or replace function public.dm_recall(p_msg bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me        uuid := auth.uid();
  v_conv    bigint;
  v_sender  uuid;
  v_created timestamptz;
  v_deleted timestamptz;
begin
  if me is null then raise exception 'auth-required'; end if;
  select conv_id, sender, created_at, deleted_at
    into v_conv, v_sender, v_created, v_deleted
    from public.dm_messages where id = p_msg;
  if not found then raise exception 'no-message'; end if;
  if v_sender <> me then raise exception 'forbidden'; end if;
  if v_deleted is not null then return jsonb_build_object('ok', true); end if;
  if v_created < now() - interval '15 minutes' then raise exception 'too-late'; end if;

  update public.dm_messages set deleted_at = now(), body = '', image_path = null
   where id = p_msg;
  -- 只有当它仍是最新一条活消息时才改预览，避免把别人刚回的内容盖掉
  update public.dm_conversations c
     set last_preview = '⟲'
   where c.id = v_conv
     and not exists (
       select 1 from public.dm_messages m2
        where m2.conv_id = v_conv and m2.id > p_msg and m2.deleted_at is null
     );
  return jsonb_build_object('ok', true, 'conv_id', v_conv);
end $$;
-- (待续7)

-- 拉黑 / 解除拉黑 / 名单（硬墙：双向禁发；我这边永久隐藏相关会话）
create or replace function public.dm_block(p_user uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'auth-required'; end if;
  if p_user is null or p_user = me then raise exception 'bad-target'; end if;
  insert into public.dm_blocks (blocker, blocked) values (me, p_user)
    on conflict (blocker, blocked) do nothing;
  -- 我这边把与该用户的会话永久隐藏（解除拉黑时恢复可见）
  update public.dm_states s set hidden_until = 'infinity'::timestamptz
    from public.dm_conversations c
   where c.id = s.conv_id and s.user_id = me
     and ((c.user_a = me and c.user_b = p_user) or (c.user_a = p_user and c.user_b = me));
  return jsonb_build_object('ok', true, 'blocked', p_user);
end $$;

create or replace function public.dm_unblock(p_user uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'auth-required'; end if;
  delete from public.dm_blocks where blocker = me and blocked = p_user;
  -- 解除隐藏（回到列表；对方仍看不到我，除非TA也解除）
  update public.dm_states s set hidden_until = null
    from public.dm_conversations c
   where c.id = s.conv_id and s.user_id = me
     and ((c.user_a = me and c.user_b = p_user) or (c.user_a = p_user and c.user_b = me));
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.dm_blocks()
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'auth-required'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'user_id', b.blocked, 'nickname', p.nickname, 'created_at', b.created_at
    ) order by b.created_at desc)
    from public.dm_blocks b
    join public.profiles p on p.id = b.blocked
    where b.blocker = me
  ), '[]'::jsonb);
end $$;

-- 未读总览（导航角标轮询用）：total + 待处理的「消息请求」数
create or replace function public.dm_unread_total()
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then return jsonb_build_object('total', 0, 'requests', 0); end if;
  return jsonb_build_object(
    'total', coalesce((
      select count(*) from public.dm_messages m
        join public.dm_states s on s.conv_id = m.conv_id and s.user_id = me
        join public.dm_conversations c on c.id = m.conv_id
       where m.sender <> me and m.deleted_at is null
         and m.id > coalesce(s.last_read_id, 0)
         and coalesce(s.hidden_until, '-infinity'::timestamptz) <= now()
         and not public.dm_is_blocked(me, case when c.user_a = me then c.user_b else c.user_a end)
    ), 0),
    'requests', coalesce((
      select count(*) from public.dm_states s
        join public.dm_conversations c on c.id = s.conv_id
       where s.user_id = me and coalesce(s.accepted, true) = false
         and coalesce(s.hidden_until, '-infinity'::timestamptz) <= now()
         and not public.dm_is_blocked(me, case when c.user_a = me then c.user_b else c.user_a end)
    ), 0)
  );
end $$;
-- (待续8)

-- ══════════════════ 通知中心 RPC ══════════════════

-- 分页：p_kinds = 逗号分隔的类型白名单（如 'comment,reply'；空 = 全部）；p_unread 只看未读
-- 返回 [{id, kind, actor_id, actor_name, post_id, comment_id, conv_id, meta,
--        read_at, created_at, post_body, comment_body, removed}]
create or replace function public.notif_page(p_offset integer default 0, p_limit integer default 30,
                                             p_kinds text default null, p_unread boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me      uuid := auth.uid();
  v_kinds text[];
begin
  if me is null then raise exception 'auth-required'; end if;
  if p_kinds is not null and btrim(p_kinds) <> '' then
    select array_agg(btrim(x)) into v_kinds
      from unnest(string_to_array(p_kinds, ',')) x where btrim(x) <> '';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id',           n.id,
      'kind',         n.kind,
      'actor_id',     n.actor_id,
      'actor_name',   ap.nickname,
      'post_id',      n.post_id,
      'comment_id',   n.comment_id,
      'conv_id',      n.conv_id,
      'meta',         n.meta,
      'read_at',      n.read_at,
      'created_at',   n.created_at,
      'post_body',    left(pp.body, 80),
      'comment_body', left(pc.body, 80),
      'removed',      coalesce(pp.removed, false)
    ) order by n.id desc)
    from (
      select * from public.notifications
       where user_id = me
         and (v_kinds is null or kind = any(v_kinds))
         and (coalesce(p_unread, false) = false or read_at is null)
       order by id desc
       limit least(coalesce(p_limit, 30), 100)
       offset greatest(coalesce(p_offset, 0), 0)
    ) n
    left join public.profiles      ap on ap.id = n.actor_id
    left join public.wall_posts    pp on pp.id = n.post_id
    left join public.wall_comments pc on pc.id = n.comment_id
  ), '[]'::jsonb);
end $$;

-- 各分类未读数（通知页角标 + 总角标；dm 红点以 dm_unread_total 为准）
create or replace function public.notif_unread()
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then
    return jsonb_build_object('total',0,'comments',0,'reactions',0,'pets',0,'dms',0,'system',0);
  end if;
  return jsonb_build_object(
    'total',     (select count(*) from public.notifications where user_id = me and read_at is null),
    'comments',  (select count(*) from public.notifications where user_id = me and read_at is null and kind in ('comment','reply')),
    'reactions', (select count(*) from public.notifications where user_id = me and read_at is null and kind in ('reaction','pet')),
    'pets',      (select count(*) from public.notifications where user_id = me and read_at is null and kind = 'pet'),
    'dms',       (select count(*) from public.notifications where user_id = me and read_at is null and kind = 'dm'),
    'system',    (select count(*) from public.notifications where user_id = me and read_at is null and kind = 'system')
  );
end $$;

-- 标记已读：p_all = 全部；否则按 id 列表（只动自己的行）
create or replace function public.notif_mark(p_ids bigint[] default null, p_all boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'auth-required'; end if;
  if coalesce(p_all, false) then
    update public.notifications set read_at = now()
     where user_id = me and read_at is null;
  elsif p_ids is not null and array_length(p_ids, 1) > 0 then
    update public.notifications set read_at = now()
     where user_id = me and read_at is null and id = any(p_ids);
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- 清空我的全部通知（通知页「清空」按钮；返回删除条数）
create or replace function public.notif_clear()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  v_n integer := 0;
begin
  if me is null then raise exception 'auth-required'; end if;
  with del as (
    delete from public.notifications where user_id = me returning 1
  )
  select count(*) into v_n from del;
  return jsonb_build_object('ok', true, 'removed', v_n);
end $$;

-- 通知偏好：读（缺行 = 全开）+ 写
create or replace function public.notif_prefs_get()
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'auth-required'; end if;
  return jsonb_build_object(
    'comments',  coalesce((select p.comments  from public.notification_prefs p where p.user_id = me), true),
    'reactions', coalesce((select p.reactions from public.notification_prefs p where p.user_id = me), true),
    'pets',      coalesce((select p.pets      from public.notification_prefs p where p.user_id = me), true),
    'dms',       coalesce((select p.dms       from public.notification_prefs p where p.user_id = me), true)
  );
end $$;

create or replace function public.notif_prefs_set(p_comments boolean default true, p_reactions boolean default true,
                                                  p_pets boolean default true, p_dms boolean default true)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'auth-required'; end if;
  insert into public.notification_prefs (user_id, comments, reactions, pets, dms, updated_at)
    values (me, coalesce(p_comments, true), coalesce(p_reactions, true),
            coalesce(p_pets, true), coalesce(p_dms, true), now())
    on conflict (user_id) do update
      set comments   = excluded.comments,
          reactions  = excluded.reactions,
          pets       = excluded.pets,
          dms        = excluded.dms,
          updated_at = now();
  return jsonb_build_object('ok', true);
end $$;

-- 管理员公告 → 全员 system 通知（复用 is_admin()；上限 5000 人防误伤）
create or replace function public.admin_broadcast(p_body text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me     uuid := auth.uid();
  v_n    integer := 0;
  v_body text;
begin
  if not exists (select 1 from public.admin_users where user_id = me) then
    return jsonb_build_object('admin', false);
  end if;
  v_body := left(btrim(coalesce(p_body, '')), 1000);
  if char_length(v_body) = 0 then raise exception 'empty-body'; end if;
  with ins as (
    insert into public.notifications (user_id, actor_id, kind, meta)
      select id, me, 'system', jsonb_build_object('body', v_body)
        from public.profiles
       order by created_at asc
       limit 5000
      returning 1
  )
  select count(*) into v_n from ins;
  return jsonb_build_object('admin', true, 'sent', v_n);
end $$;
-- (待续10)

-- ══════════════════ 通知触发器（挂现有表，AFTER INSERT） ══════════════════

-- 评论 / 回复：回复优先（@ 被回复者），帖主不重复收（同一人只发一条）
create or replace function public.notify_on_comment()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_owner       uuid;
  v_parent_user uuid;
  v_pref        boolean;
  v_actor       uuid := new.user_id;
  v_targets     uuid[] := array[]::uuid[];
  v_target      uuid;
begin
  select user_id into v_owner from public.wall_posts where id = new.post_id;
  if v_owner is null then return new; end if;
  if new.parent_id is not null then
    select user_id into v_parent_user from public.wall_comments where id = new.parent_id;
  end if;
  if v_parent_user is not null and v_parent_user <> v_actor then
    v_targets := v_targets || v_parent_user;
  end if;
  if v_owner <> v_actor and not (v_owner = any(v_targets)) then
    v_targets := v_targets || v_owner;
  end if;
  foreach v_target in array v_targets loop
    select coalesce(p.comments, true) into v_pref
      from public.notification_prefs p where p.user_id = v_target;
    if coalesce(v_pref, true) then
      insert into public.notifications (user_id, actor_id, kind, post_id, comment_id, meta)
        values (v_target, v_actor,
                case when v_target = v_parent_user then 'reply' else 'comment' end,
                new.post_id, new.id,
                jsonb_build_object('preview', left(new.body, 80)));
    end if;
  end loop;
  return new;
end $$;

drop trigger if exists notify_wall_comment_trg on public.wall_comments;
create trigger notify_wall_comment_trg
  after insert on public.wall_comments
  for each row execute function public.notify_on_comment();
-- (待续11)

-- 回应（抱抱/暖暖/同感）：只通知帖主、只在新回应时（toggle 的删除不触发）
create or replace function public.notify_on_reaction()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid;
  v_pref  boolean;
begin
  select user_id into v_owner from public.wall_posts where id = new.post_id;
  if v_owner is null or v_owner = new.user_id then return new; end if;
  select coalesce(p.reactions, true) into v_pref
    from public.notification_prefs p where p.user_id = v_owner;
  if coalesce(v_pref, true) then
    insert into public.notifications (user_id, actor_id, kind, post_id, meta)
      values (v_owner, new.user_id, 'reaction', new.post_id,
              jsonb_build_object('reaction', new.kind));
  end if;
  return new;
end $$;

drop trigger if exists notify_wall_reaction_trg on public.wall_reactions;
create trigger notify_wall_reaction_trg
  after insert on public.wall_reactions
  for each row execute function public.notify_on_reaction();

-- 宠物互动（摸摸头/投喂）：只通知主人、只统计登录访客（匿名 key 无归属）
create or replace function public.notify_on_pet()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_viewer uuid := auth.uid();
  v_pref   boolean;
begin
  if v_viewer is null or v_viewer = new.owner_id then return new; end if;
  select coalesce(p.pets, true) into v_pref
    from public.notification_prefs p where p.user_id = new.owner_id;
  if coalesce(v_pref, true) then
    insert into public.notifications (user_id, actor_id, kind, meta)
      values (new.owner_id, v_viewer, 'pet', jsonb_build_object('pet_kind', new.kind));
  end if;
  return new;
end $$;

drop trigger if exists notify_pet_interaction_trg on public.pet_interactions;
create trigger notify_pet_interaction_trg
  after insert on public.pet_interactions
  for each row execute function public.notify_on_pet();

-- ============================================================
-- 温暖漂流瓶（#6；与 MIGRATION_bottle.sql 同源）
-- ============================================================
create table if not exists public.bottle_letters (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  nickname    text not null default '',
  body        text not null,
  status      text not null default 'sea',   -- sea 漂流中 | held 被捞起 | answered 已有回信
  holder      uuid references auth.users (id) on delete set null,
  held_at     timestamptz,
  reply       text,
  reply_by    uuid references auth.users (id) on delete set null,
  reply_at    timestamptz,
  created_day date not null default (now() at time zone 'utc')::date,
  created_at  timestamptz not null default now(),
  conv_id     bigint references public.dm_conversations (id) on delete set null,
  chat_decision text not null default 'pending'
    check (chat_decision in ('pending', 'accepted', 'declined'))
);
-- 老库补列（幂等）：漂流瓶续聊（#6；详见 MIGRATION_bottle_chat.sql）
alter table public.bottle_letters add column if not exists conv_id bigint
  references public.dm_conversations (id) on delete set null;
alter table public.bottle_letters add column if not exists chat_decision text
  not null default 'pending' check (chat_decision in ('pending', 'accepted', 'declined'));
create index if not exists bottle_letters_sea_idx
  on public.bottle_letters (created_at desc) where status = 'sea';
create index if not exists bottle_letters_owner_idx
  on public.bottle_letters (user_id, created_at desc);

create table if not exists public.bottle_fishes (
  user_id   uuid not null references auth.users (id) on delete cascade,
  day       date not null default (now() at time zone 'utc')::date,
  letter_id uuid not null references public.bottle_letters (id) on delete cascade,
  primary key (user_id, day, letter_id)
);

/* 轮 21：次数口径改为「捞到且回信才扣 1 次」——捞信日志上加回信时刻/回信日。
   replied_day 才是 bottle_quota() 数的列；replied_at is null = 捞起后从未回信，不计次。 */
alter table public.bottle_fishes add column if not exists replied_at  timestamptz;
alter table public.bottle_fishes add column if not exists replied_day date;


alter table public.bottle_letters enable row level security;
alter table public.bottle_fishes  enable row level security;
drop policy if exists "bottle readable by owner or replier" on public.bottle_letters;
create policy "bottle readable by owner or replier" on public.bottle_letters
  for select using (user_id = auth.uid() or reply_by = auth.uid());

-- 写路径收口在 RPC（每日 3 封 / 7 瓶、48h 自动回海、不能捞自己的信）
create or replace function public.bottle_send(p_body text)
returns public.bottle_letters
language plpgsql security definer set search_path = public as $$
declare
  v_count int;
  v_row   public.bottle_letters;
begin
  if auth.uid() is null then raise exception 'bottle-auth'; end if;
  p_body := btrim(coalesce(p_body, ''));
  if p_body = '' or char_length(p_body) > 1000 then raise exception 'bottle-too-long'; end if;
  select count(*) into v_count from public.bottle_letters
    where user_id = auth.uid() and created_day = (now() at time zone 'utc')::date;
  if v_count >= 3 then raise exception 'bottle-limit-send'; end if;
  insert into public.bottle_letters (user_id, nickname, body)
    values (auth.uid(),
            coalesce((select nickname from public.profiles where id = auth.uid()), ''),
            p_body)
    returning * into v_row;
  return v_row;
end $$;

-- 漂流瓶次数探针（轮 18；轮 21 口径：sent=今天已写信数，fished=今天**已回信**数，捞信本身不计次）
create or replace function public.bottle_quota()
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'sent',   (select count(*) from public.bottle_letters
                where user_id = auth.uid()
                  and created_day = (now() at time zone 'utc')::date),
    'fished', (select count(*) from public.bottle_fishes
                where user_id = auth.uid()
                  and replied_day = (now() at time zone 'utc')::date)
  )
$$;
revoke all on function public.bottle_quota() from public, anon;
grant execute on function public.bottle_quota() to authenticated;

create or replace function public.bottle_fish()
returns public.bottle_letters
language plpgsql security definer set search_path = public as $$
declare
  v_replied int;
  v_held    int;
  v_row     public.bottle_letters;
  i         int;
begin
  if auth.uid() is null then raise exception 'bottle-auth'; end if;
  /* 捞起超 48h 未处理的信先放回海里（不让信卡死在谁手里） */
  update public.bottle_letters set status = 'sea', holder = null, held_at = null
    where status = 'held' and held_at < now() - interval '48 hours';
  /* 今日已回信数达到 7 → 今天不能再捞（捞了也回不了） */
  select count(*) into v_replied from public.bottle_fishes
    where user_id = auth.uid() and replied_day = (now() at time zone 'utc')::date;
  if v_replied >= 7 then raise exception 'bottle-limit-fish'; end if;
  /* 手里还压着 ≥7 封没处理 → 先回信或放回，别囤信（防无限捞） */
  select count(*) into v_held from public.bottle_letters
    where holder = auth.uid() and status = 'held';
  if v_held >= 7 then raise exception 'bottle-limit-hold'; end if;
  /* 随机挑一封 → 条件更新抢占（只在仍是 sea 时成立）。别人同一瞬间捞走
     同一封 → 命中 0 行 → 换一封重试；重试 3 次仍落空或海里已空 →
     明确抛 bottle-empty-sea（绝不返回 null：客户端只在拿到信时才计数） */
  for i in 1..3 loop
    select * into v_row from public.bottle_letters
      where status = 'sea' and user_id <> auth.uid()
      order by random() limit 1;
    if not found then raise exception 'bottle-empty-sea'; end if;
    update public.bottle_letters set status = 'held', holder = auth.uid(), held_at = now()
      where id = v_row.id and status = 'sea'
      returning * into v_row;
    if found then
      /* 捞信日志（供「我捞到的」记录）：同一封当天放回再捞不重复、不报错。
         这里不写 replied_*，所以捞信本身不计次（轮 21 口径）。 */
      insert into public.bottle_fishes (user_id, day, letter_id)
        values (auth.uid(), (now() at time zone 'utc')::date, v_row.id)
        on conflict (user_id, day, letter_id) do nothing;
      return v_row;
    end if;
  end loop;
  raise exception 'bottle-empty-sea';
end $$;

create or replace function public.bottle_reply(p_id uuid, p_reply text)
returns public.bottle_letters
language plpgsql security definer set search_path = public as $$
declare
  v_row public.bottle_letters;
begin
  if auth.uid() is null then raise exception 'bottle-auth'; end if;
  p_reply := btrim(coalesce(p_reply, ''));
  if p_reply = '' or char_length(p_reply) > 1000 then raise exception 'bottle-too-long'; end if;
  update public.bottle_letters
    set status = 'answered', reply = p_reply, reply_by = auth.uid(), reply_at = now()
    where id = p_id and status = 'held' and holder = auth.uid()
    returning * into v_row;
  if v_row is null then raise exception 'bottle-not-holder'; end if;
  /* 轮 21：记次时机 = 回信成功这一刻。只给这封信**最新一条**捞信日志盖章：
     同一封信「捞起→放回→跨天再捞」会有多行日志（主键含 day），全量更新会把
     N 行都盖成今天 → 一次回信扣 N 次；取 day 最大的一行即幂等一次。 */
  update public.bottle_fishes f
    set replied_at = now(), replied_day = (now() at time zone 'utc')::date
    from (
      select user_id, day, letter_id from public.bottle_fishes
        where user_id = auth.uid() and letter_id = p_id and replied_at is null
        order by day desc limit 1
    ) t
    where f.user_id = t.user_id and f.day = t.day and f.letter_id = t.letter_id;
  return v_row;
end $$;

create or replace function public.bottle_release(p_id uuid)
returns public.bottle_letters
language plpgsql security definer set search_path = public as $$
declare
  v_row public.bottle_letters;
begin
  if auth.uid() is null then raise exception 'bottle-auth'; end if;
  update public.bottle_letters
    set status = 'sea', holder = null, held_at = null
    where id = p_id and status = 'held' and holder = auth.uid()
    returning * into v_row;
  if v_row is null then raise exception 'bottle-not-holder'; end if;
  return v_row;
end $$;

create or replace function public.bottle_mine()
returns setof public.bottle_letters
language sql security definer set search_path = public as $$
  select * from public.bottle_letters
    where user_id = auth.uid() or reply_by = auth.uid()
    order by created_at desc limit 30
$$;

create or replace function public.bottle_held()
returns setof public.bottle_letters
language sql security definer set search_path = public as $$
  select * from public.bottle_letters
    where holder = auth.uid() and status = 'held'
    order by held_at desc limit 10
$$;

-- ---- 续聊扩展（#6；与 MIGRATION_bottle_chat.sql 同源）----
-- 回复事件与通知在同一事务中；不依赖页面是否在线。不为历史回信补发通知。
create or replace function public.bottle_notify_reply()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'answered' and old.status <> 'answered' and new.reply_by is not null then
    if not public.dm_is_blocked(new.user_id, new.reply_by)
       and not public.dm_is_blocked(new.reply_by, new.user_id)
       and coalesce((select dms from public.notification_prefs where user_id = new.user_id), true) then
      insert into public.notifications(user_id, actor_id, kind, meta)
      values (new.user_id, new.reply_by, 'dm', jsonb_build_object(
        'event', 'bottle_reply', 'bottle_id', new.id, 'preview', left(new.reply, 80)));
    end if;
  end if;
  return new;
end $$;
drop trigger if exists bottle_reply_notification on public.bottle_letters;
create trigger bottle_reply_notification after update on public.bottle_letters
  for each row execute function public.bottle_notify_reply();

-- 只有原信作者能决定是否续聊。锁信件行，事务失败则消息/状态整体回滚。
create or replace function public.bottle_chat_decide(p_id uuid, p_accept boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  letter public.bottle_letters;
  cid bigint;
  opened jsonb;
begin
  if me is null then raise exception 'bottle-auth'; end if;
  if p_accept is null then raise exception 'bottle-bad-decision'; end if;
  select * into letter from public.bottle_letters where id = p_id for update;
  if not found or letter.user_id <> me then raise exception 'bottle-not-owner'; end if;
  if letter.status <> 'answered' or letter.reply_by is null or letter.reply_by = me then
    raise exception 'bottle-not-answered';
  end if;
  if letter.chat_decision = 'accepted' and letter.conv_id is not null then
    return jsonb_build_object('conv_id', letter.conv_id, 'decision', 'accepted');
  end if;
  if letter.chat_decision = 'declined' then
    return jsonb_build_object('conv_id', null, 'decision', 'declined');
  end if;
  if not p_accept then
    update public.bottle_letters set chat_decision = 'declined' where id = p_id;
    return jsonb_build_object('conv_id', null, 'decision', 'declined');
  end if;
  if public.dm_is_blocked(me, letter.reply_by) or public.dm_is_blocked(letter.reply_by, me) then
    raise exception 'bottle-chat-blocked';
  end if;
  opened := public.dm_open(letter.reply_by);
  cid := (opened->>'conv_id')::bigint;
  -- 同一对用户的多个瓶子按会话串行导入，不会交叉更新会话预览。
  perform 1 from public.dm_conversations where id = cid for update;
  insert into public.dm_messages(conv_id, sender, body, created_at)
    values (cid, me, letter.body, letter.created_at);
  insert into public.dm_messages(conv_id, sender, body, created_at)
    values (cid, letter.reply_by, letter.reply, letter.reply_at);
  update public.dm_conversations set last_message_at = now(), last_preview = left(letter.reply, 80)
    where id = cid;
  insert into public.dm_states(conv_id, user_id, accepted)
    values (cid, me, true), (cid, letter.reply_by, true)
    on conflict (conv_id, user_id) do update set accepted = true, hidden_until = null;
  update public.bottle_letters set conv_id = cid, chat_decision = 'accepted' where id = p_id;
  if coalesce((select dms from public.notification_prefs where user_id = letter.reply_by), true)
     and not coalesce((select muted from public.dm_states where conv_id = cid and user_id = letter.reply_by), false) then
    insert into public.notifications(user_id, actor_id, kind, conv_id, meta)
      values (letter.reply_by, me, 'dm', cid, jsonb_build_object(
        'event', 'bottle_chat', 'bottle_id', p_id, 'preview', left(letter.body, 80)));
  end if;
  return jsonb_build_object('conv_id', cid, 'decision', 'accepted');
end $$;

-- 独立记录分页，深链按 ID 取单条；只返回参与者自己的信件。
create or replace function public.bottle_records(
  p_id     uuid default null,
  p_offset integer default 0,
  p_mine   boolean default null,
  p_limit  integer default 30
)
returns setof public.bottle_letters language sql stable security definer set search_path = public as $$
  select l.* from public.bottle_letters l
   where (p_id is null or l.id = p_id)
     and (
       (p_mine is null and (l.user_id = auth.uid() or l.reply_by = auth.uid()))
       or (p_mine is true and l.user_id = auth.uid())
       or (p_mine is false and exists (
             select 1 from public.bottle_fishes f
              where f.user_id = auth.uid() and f.letter_id = l.id))
     )
   order by l.created_at desc, l.id
   limit greatest(coalesce(p_limit, 30), 1)
   offset greatest(coalesce(p_offset, 0), 0)
$$;

-- 执行权限：与既有函数一致（anon 可达但一律被 auth-required 拦下）
grant execute on all functions in schema public to anon, authenticated;

-- 漂流瓶续聊/记录函数收权：只给登录用户（与各 MIGRATION 一致）
revoke all on function public.bottle_notify_reply() from public, anon, authenticated;
revoke all on function public.bottle_chat_decide(uuid, boolean) from public, anon;
revoke all on function public.bottle_records(uuid, integer, boolean, integer) from public, anon;
grant execute on function public.bottle_chat_decide(uuid, boolean) to authenticated;
grant execute on function public.bottle_records(uuid, integer, boolean, integer) to authenticated;

-- ══════════════════ 改昵称同步旧内容署名（轮 9 · 昵称修改） ══════════════════
-- 详情见 MIGRATION_nickname_sync.sql。墙上的帖子/评论把作者名冗余存成 author_name，
-- 只改 profiles 会出现「我改名了、旧帖还是旧名」；此 RPC 一个事务里两处一起改。
-- 未跑时前端退回「只改 profiles」（旧帖留旧名，不报错）。
create or replace function public.rename_me(p_nick text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me         uuid := auth.uid();
  v_nick     text;
  v_posts    integer := 0;
  v_comments integer := 0;
begin
  if me is null then raise exception 'auth-required'; end if;
  v_nick := btrim(coalesce(p_nick, ''));
  if v_nick = '' then raise exception 'empty-nickname'; end if;
  if char_length(v_nick) > 24 then raise exception 'nick-too-long'; end if;

  update public.profiles set nickname = v_nick where id = me;
  if not found then raise exception 'no-profile'; end if;

  update public.wall_posts    set author_name = v_nick where user_id = me;
  get diagnostics v_posts = row_count;
  update public.wall_comments set author_name = v_nick where user_id = me;
  get diagnostics v_comments = row_count;

  return jsonb_build_object('nickname', v_nick, 'posts', v_posts, 'comments', v_comments);
end $$;

revoke all on function public.rename_me(text) from public, anon;
grant execute on function public.rename_me(text) to authenticated;

-- ══════════════════ 私信退出通知中心（#23；与 MIGRATION_notifications_drop_dm.sql 同步） ══════════════════
-- ① 历史 dm 通知清理；② BEFORE INSERT 触发器把 kind='dm' 静默丢弃（dm_send /
--    漂流瓶触发器不用改，通知行不再落表）；notif_unread 的 total 从此自然不含 dm。
delete from public.notifications where kind = 'dm';

create or replace function public.notifications_drop_dm()
returns trigger language plpgsql as $$
begin
  if new.kind = 'dm' then
    return null;   -- 私信有自己的入口（💬 + /messages），不再进通知中心
  end if;
  return new;
end $$;

drop trigger if exists notifications_drop_dm on public.notifications;
create trigger notifications_drop_dm
  before insert on public.notifications
  for each row execute function public.notifications_drop_dm();

-- ══════════════════ 应用内自助删号（App 轨道 T3；与 MIGRATION_delete_account.sql 同步） ══════════════════
-- Play 2024 政策硬门槛：登录用户可在设置页一键删除账号与全部个人数据。
-- 图片路径恒为两段 <uid>/<file>（Worker safeImagePath 保证）→ wall-images/<uid>/ 前缀删除即可；
-- 业务表外键全部 cascade（漂流瓶 holder/reply_by 为 set null：信保留、摘除作者身份）→ 删 auth.users 一行即清全部。
create or replace function public.delete_my_account()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid;
  removed bigint;
begin
  uid := auth.uid();
  if uid is null then
    raise exception 'not-signed-in';
  end if;

  -- 1) Storage：wall-images/<uid>/ 前缀全删（失败不阻塞，返回 removed = -1）
  begin
    with del as (
      delete from storage.objects
      where bucket_id = 'wall-images'
        and name like uid::text || '/%'
      returning 1
    )
    select count(*) into removed from del;
  exception when others then
    removed := -1;
  end;

  -- 2) 业务数据：删 auth.users 一行 → 外键级联清理全部（单语句，原子）
  delete from auth.users where id = uid;

  return jsonb_build_object('ok'::text, true, 'storage_removed', removed);
end;
$$;

-- 执行权限（必须显式 revoke anon：旧库可能带 grant all to anon 的显式授权，revoke from public 撤不掉）
revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

comment on function public.delete_my_account() is
'自助删号：删除 wall-images/<uid>/ 存储对象 + 级联删除全部业务数据。仅限删除自己的账号（auth.uid() 校验）。';

-- ════════════════════════════════════════════════════════════
-- 轮 33 · 举报 / 审核（MIGRATION_reports.sql 同源）
--   reports 队列 + 评论 hidden + report_create / admin_report_page / admin_report_handle
--   （wall_toggle_dislike 与 admin_overview 的扩展已就地更新到上方原定义处）
-- ════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────
-- 1) 举报 / 待复核队列表
--    target_id 故意不挂外键：内容被删（作者自删或管理员删）后举报记录要留下来审计，
--    队列里显示「内容已删除」即可；帖子/评论二选一由 target_type 区分。
-- ─────────────────────────────────────────────
create table if not exists public.reports (
  id          bigserial primary key,
  reporter_id uuid references public.profiles (id) on delete set null,  -- null = 系统自动条目（下架复核）
  target_type text not null check (target_type in ('post','comment')),
  target_id   bigint not null,
  reason      text not null default 'other',   -- spam|abuse|porn|illegal|false|other|auto
  detail      text not null default '',        -- 举报人补充说明（≤200 字）
  source      text not null default 'report' check (source in ('report','auto')),
  status      text not null default 'pending' check (status in ('pending','handled')),
  handled_by  uuid references public.profiles (id) on delete set null,
  handled_at  timestamptz,
  action      text,                            -- dismiss|remove_post|restore_post|delete_comment|unhide_comment
  note        text not null default '',        -- 管理员处理备注（≤200 字）
  created_at  timestamptz not null default now()
);

create index if not exists reports_status_idx on public.reports (status, id desc);
create index if not exists reports_target_idx on public.reports (target_type, target_id);

-- 同一人对同一目标只能举报一次（系统条目 reporter 为 null，不受此约束）
create unique index if not exists reports_reporter_target_uniq
  on public.reports (reporter_id, target_type, target_id)
  where reporter_id is not null;
-- 同一目标的「待复核」条目只排一次（处理完后再下架可以再排）
create unique index if not exists reports_auto_pending_uniq
  on public.reports (target_type, target_id)
  where source = 'auto' and status = 'pending';

alter table public.reports enable row level security;

drop policy if exists "reports own or admin select" on public.reports;
create policy "reports own or admin select" on public.reports
  for select using (reporter_id = auth.uid() or is_admin());
-- 写入/修改不做任何直连策略：全部收口在 security definer RPC（report_create / admin_report_handle）。

-- ─────────────────────────────────────────────
-- 2) 评论隐藏（≥3 人举报自动隐藏）
--    读策略升级：hidden 的评论只有作者本人与管理员能读到
--    （is_admin() 在本文件上方 admin 段已定义；本段整体可重复执行）
-- ─────────────────────────────────────────────
alter table public.wall_comments add column if not exists hidden   boolean     not null default false;
alter table public.wall_comments add column if not exists hidden_at timestamptz;

drop policy if exists "comments readable by all" on public.wall_comments;
drop policy if exists "comments readable unless hidden" on public.wall_comments;
create policy "comments readable unless hidden" on public.wall_comments
  for select using (hidden = false or user_id = auth.uid() or is_admin());

-- ─────────────────────────────────────────────
-- 3) 举报创建（用户侧；防刷 + 评论阈值自动隐藏）
--    错误码：auth-required / bad-target / target-gone / report-limit
-- ─────────────────────────────────────────────
create or replace function public.report_create(p_target_type text, p_target_id bigint, p_reason text, p_detail text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid    uuid := auth.uid();
  v_reason text := lower(coalesce(p_reason, 'other'));
  v_detail text := left(btrim(coalesce(p_detail, '')), 200);
  v_alive  boolean;
begin
  if v_uid is null then raise exception 'auth-required'; end if;
  if p_target_type not in ('post','comment') then raise exception 'bad-target'; end if;
  if v_reason not in ('spam','abuse','porn','illegal','false','other') then v_reason := 'other'; end if;

  -- 目标必须活着：已下架的帖子 / 已隐藏的评论不再收举报（前端也看不到它们）
  if p_target_type = 'post' then
    select true into v_alive from public.wall_posts where id = p_target_id and removed = false;
  else
    select true into v_alive from public.wall_comments where id = p_target_id and hidden = false;
  end if;
  if v_alive is null or not v_alive then raise exception 'target-gone'; end if;

  -- 防刷：每人每个 UTC 日最多 10 条举报
  if (select count(*) from public.reports
       where reporter_id = v_uid
         and created_at >= date_trunc('day', now() at time zone 'utc')) >= 10 then
    raise exception 'report-limit';
  end if;

  -- 同人同目标去重：重复举报视为成功（幂等，前端不给报错）
  insert into public.reports (reporter_id, target_type, target_id, reason, detail, source)
  values (v_uid, p_target_type, p_target_id, v_reason, v_detail, 'report')
  on conflict do nothing;

  -- 评论：≥3 人举报过（同人同目标唯一，行数 = 人数）→ 自动隐藏待复核。
  -- hidden_at is null = 只自动隐藏一次；管理员恢复后即使再被举报也不再自动隐藏（交人工）。
  if p_target_type = 'comment' then
    update public.wall_comments wc
       set hidden = true, hidden_at = now()
     where wc.id = p_target_id
       and wc.hidden = false
       and wc.hidden_at is null
       and (select count(*) from public.reports rr
             where rr.target_type = 'comment' and rr.target_id = wc.id) >= 3;
  end if;
  -- 帖子：不因举报数下架（用户拍板）——下架只走厌恶阈值，且下架时插「待复核」（见第 4 段）。

  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.report_create(text, bigint, text, text) from public, anon;
grant execute on function public.report_create(text, bigint, text, text) to authenticated;

-- ─────────────────────────────────────────────
-- 4) 管理端：举报/复核分页（pending / handled 两档）
--    非管理员 → {admin:false}；items 带被举报内容正文/作者与「几人举报过」聚合
-- ─────────────────────────────────────────────
create or replace function public.admin_report_page(p_status text default 'pending', p_offset integer default 0, p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_status text := lower(coalesce(p_status, 'pending'));
  v_total  bigint;
begin
  if not exists (select 1 from public.admin_users where user_id = auth.uid()) then
    return jsonb_build_object('admin', false, 'total', 0, 'items', '[]'::jsonb);
  end if;
  if v_status not in ('pending','handled') then v_status := 'pending'; end if;

  select count(*) into v_total from public.reports where status = v_status;

  return jsonb_build_object(
    'admin', true,
    'total', v_total,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', r.id,
               'source', r.source,
               'target_type', r.target_type,
               'target_id', r.target_id,
               'reason', r.reason,
               'detail', r.detail,
               'status', r.status,
               'created_at', r.created_at,
               'handled_at', r.handled_at,
               'action', r.action,
               'note', r.note,
               'reporter_name', rp.nickname,              -- null = 系统复核条目（前端显示「系统」）
               'reporters', (select count(*) from public.reports rr
                              where rr.target_type = r.target_type and rr.target_id = r.target_id),
               'content_gone', case when r.target_type = 'post'
                                  then not exists (select 1 from public.wall_posts wp where wp.id = r.target_id)
                                  else not exists (select 1 from public.wall_comments wc where wc.id = r.target_id) end,
               'post_id', case when r.target_type = 'post' then r.target_id
                               else (select wc.post_id from public.wall_comments wc where wc.id = r.target_id) end,
               'body', case when r.target_type = 'post'
                            then (select wp.body from public.wall_posts wp where wp.id = r.target_id)
                            else (select wc.body from public.wall_comments wc where wc.id = r.target_id) end,
               'author_name', case when r.target_type = 'post'
                                   then (select wp.author_name from public.wall_posts wp where wp.id = r.target_id)
                                   else (select wc.author_name from public.wall_comments wc where wc.id = r.target_id) end,
               'author_id', case when r.target_type = 'post'
                                  then (select wp.user_id from public.wall_posts wp where wp.id = r.target_id)
                                  else (select wc.user_id from public.wall_comments wc where wc.id = r.target_id) end,
               'removed', (select wp.removed from public.wall_posts wp
                            where wp.id = r.target_id and r.target_type = 'post'),
               'hidden', (select wc.hidden from public.wall_comments wc
                           where wc.id = r.target_id and r.target_type = 'comment'),
               'content_created_at', case when r.target_type = 'post'
                                   then (select wp.created_at from public.wall_posts wp where wp.id = r.target_id)
                                   else (select wc.created_at from public.wall_comments wc where wc.id = r.target_id) end
             ) order by r.created_at desc, r.id desc)
        from (select *
                from public.reports
               where status = v_status
               order by created_at desc, id desc
               limit least(greatest(coalesce(p_limit, 20), 1), 100)
              offset greatest(coalesce(p_offset, 0), 0)) r
        left join public.profiles rp on rp.id = r.reporter_id
    ), '[]'::jsonb)
  );
end $$;

revoke all on function public.admin_report_page(text, integer, integer) from public, anon;
grant execute on function public.admin_report_page(text, integer, integer) to authenticated;

-- ─────────────────────────────────────────────
-- 5) 管理端：处理一条举报/复核
--    动作：dismiss 驳回 | remove_post 下架帖子 | restore_post 恢复帖子
--          | delete_comment 删评论 | unhide_comment 恢复评论
--    处理完给举报人发 system 通知（前端按 event=report_handled 本地化渲染）。
--    重复处理幂等成功（already:true），防止连点/并发双写。
-- ─────────────────────────────────────────────
create or replace function public.admin_report_handle(p_report bigint, p_action text, p_note text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me       uuid := auth.uid();
  v_action text := lower(coalesce(p_action, 'dismiss'));
  v_note   text := left(btrim(coalesce(p_note, '')), 200);
  v_rep    public.reports%rowtype;
begin
  if not exists (select 1 from public.admin_users where user_id = me) then
    return jsonb_build_object('admin', false);
  end if;
  if v_action not in ('dismiss','remove_post','restore_post','delete_comment','unhide_comment') then
    v_action := 'dismiss';
  end if;

  select * into v_rep from public.reports where id = p_report;
  if v_rep.id is null then
    return jsonb_build_object('admin', true, 'ok', false, 'reason', 'not-found');
  end if;
  if v_rep.status = 'handled' then
    return jsonb_build_object('admin', true, 'ok', true, 'already', true);
  end if;

  -- 内容动作（目标可能已被作者自删：动作落空不算失败，记录照常闭环）
  if v_action = 'remove_post' and v_rep.target_type = 'post' then
    update public.wall_posts set removed = true, removed_at = now() where id = v_rep.target_id;
  elsif v_action = 'restore_post' and v_rep.target_type = 'post' then
    update public.wall_posts set removed = false, removed_at = null where id = v_rep.target_id;
  elsif v_action = 'delete_comment' and v_rep.target_type = 'comment' then
    delete from public.wall_comments where id = v_rep.target_id;   -- 二级回复级联删除
  elsif v_action = 'unhide_comment' and v_rep.target_type = 'comment' then
    update public.wall_comments set hidden = false where id = v_rep.target_id;
  end if;

  update public.reports
     set status = 'handled', handled_by = me, handled_at = now(), action = v_action, note = v_note
   where id = p_report;

  if v_rep.reporter_id is not null then
    insert into public.notifications (user_id, actor_id, kind, meta)
    values (v_rep.reporter_id, me, 'system',
            jsonb_build_object('event', 'report_handled', 'target_type', v_rep.target_type));
  end if;

  return jsonb_build_object('admin', true, 'ok', true);
end $$;

revoke all on function public.admin_report_handle(bigint, text, text) from public, anon;
grant execute on function public.admin_report_handle(bigint, text, text) to authenticated;

-- ============================================================
-- 执行完毕。请在 Supabase SQL Editor 运行本文件，然后跑：
--   node tools/dm-test.mjs && node tools/notify-test.mjs && node tools/bottle-test.mjs
-- ============================================================

