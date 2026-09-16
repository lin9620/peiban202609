-- ═══════════════════════════════════════════════════════════════
--  Warm Paws · 暖爪 — Supabase 一键建库脚本（第二批：云端暖心墙 + 登录）
--  用法：Supabase Dashboard → SQL Editor → 粘贴全部 → Run
--  幂等：可重复执行（全部用 IF NOT EXISTS / OR REPLACE）
-- ═══════════════════════════════════════════════════════════════

-- 1) 用户资料表（注册后由触发器自动创建一行）
create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  nickname   text not null default '',
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

-- 每个用户每天最多一条（触发器只拦新插入；老库里的历史数据不受影响）
create or replace function public.wall_daily_limit()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (
    select 1 from public.wall_posts p
    where p.user_id = new.user_id and p.created_day = new.created_day
  ) then
    raise exception 'wall_daily_limit' using errcode = 'P0001',
      hint = '每个用户每天最多发一条暖心墙内容';
  end if;
  return new;
end $$;

drop trigger if exists wall_posts_daily_limit on public.wall_posts;
create trigger wall_posts_daily_limit
  before insert on public.wall_posts
  for each row execute function public.wall_daily_limit();

do $$
begin
  begin
    create unique index if not exists wall_posts_one_per_day_idx
      on public.wall_posts (user_id, created_day);
  exception when others then
    raise notice '跳过唯一索引（历史数据存在同日多条）：%', sqlerrm;
  end;
end $$;

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

-- RPC：切换厌恶；厌恶数 ÷ 浏览数 ≥ 1% → 下架（假删除，不再自动恢复）
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

  if not v_rm and v_views > 0 and (v_dis::numeric / v_views) >= 0.01 then
    update public.wall_posts set removed = true, removed_at = now() where id = p_post;
    v_rm := true;
  end if;

  return jsonb_build_object('ok', true, 'on', v_on, 'views', v_views,
                            'dislikes', v_dis, 'removed', v_rm);
end $$;

grant execute on function public.wall_add_view(bigint, text) to anon, authenticated;
grant execute on function public.wall_toggle_dislike(bigint) to authenticated;

-- 7) 主页的伙伴（/u/:id）：宠物 + 手绘厨房镜像 + 访客互动
create table if not exists public.pet_profiles (
  user_id    uuid primary key references public.profiles (id) on delete cascade,
  data       jsonb not null default '{"pet":null,"dishes":[],"counts":{"pats":0,"feeds":0}}'::jsonb,
  updated_at timestamptz not null default now()
);

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
  v_counts  jsonb;
begin
  if p_kind not in ('pat', 'feed') then
    return jsonb_build_object('ok', false, 'reason', 'bad-kind');
  end if;

  insert into public.pet_interactions (owner_id, viewer_key, kind)
  values (p_owner, v_viewer, p_kind)
  on conflict do nothing;
  v_counted := found;

  if v_counted then
    /* 快照里的计数键是复数：pat → pats，feed → feeds（前端 wall.js 读 counts.pats / counts.feeds） */
    update public.pet_profiles
      set data = jsonb_set(data, array['counts', case p_kind when 'pat' then 'pats' else 'feeds' end],
                           to_jsonb(coalesce((data->'counts'->>(case p_kind when 'pat' then 'pats' else 'feeds' end))::int, 0) + 1))
      where user_id = p_owner;
  end if;

  select coalesce(data->'counts', '{"pats":0,"feeds":0}'::jsonb) into v_counts
    from public.pet_profiles where user_id = p_owner;

  return jsonb_build_object('ok', true, 'counted', v_counted,
                            'counts', coalesce(v_counts, '{"pats":0,"feeds":0}'::jsonb));
end $$;

grant execute on function public.pet_interact(uuid, text, text) to anon, authenticated;

-- 完成 ✅ 接下来在项目根目录配置 URL 和 anon key（见 README「Supabase 配置」）
