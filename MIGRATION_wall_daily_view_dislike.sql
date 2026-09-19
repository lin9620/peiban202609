-- ═══════════════════════════════════════════════════════════════
--  Warm Paws · 暖爪 — 增量迁移：每日限额 + 浏览数 + 厌恶与自动下架
--  用法：Supabase Dashboard → SQL Editor → 粘贴全部 → Run
--  幂等：可重复执行（IF NOT EXISTS / OR REPLACE / DROP+CREATE 策略）
--  已建过库的老用户跑这一份即可；新用户跑 SUPABASE_SETUP.sql（已含同样内容）
-- ═══════════════════════════════════════════════════════════════

-- ── 1) wall_posts 补列 ───────────────────────────────────────
--    views        浏览次数（服务器端累加）
--    dislikes     厌恶数（服务器端维护，不信前端）
--    removed      假删除标记：达到下架线后置 true，前台不再展示（数据仍在库里）
--    created_day  UTC 日，用于「每个用户每天最多一条」的判断
alter table public.wall_posts add column if not exists views       integer     not null default 0;
alter table public.wall_posts add column if not exists dislikes    integer     not null default 0;
alter table public.wall_posts add column if not exists removed     boolean     not null default false;
alter table public.wall_posts add column if not exists removed_at  timestamptz;
alter table public.wall_posts add column if not exists created_day date        not null
  default (timezone('utc', now()))::date;

create index if not exists wall_posts_visible_idx on public.wall_posts (created_at desc)
  where removed = false;

-- ─ 2) 每个用户每天最多一条（数据库层权威约束）─────────────────
--    用触发器而不是唯一索引：老库里可能已存在「同一用户同一天多条」的历史数据，
--    直接建唯一索引会失败；触发器只拦新插入，历史数据不受影响。
create or replace function public.wall_daily_limit()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (
    select 1 from public.wall_posts p
    where p.user_id = new.user_id and p.created_day = new.created_day
  ) then
    -- 固定暗号：前端据此显示「今天已经发过啦」而不是笼统的失败
    raise exception 'wall_daily_limit' using errcode = 'P0001',
      hint = '每个用户每天最多发一条暖心墙内容';
  end if;
  return new;
end $$;

drop trigger if exists wall_posts_daily_limit on public.wall_posts;
create trigger wall_posts_daily_limit
  before insert on public.wall_posts
  for each row execute function public.wall_daily_limit();

-- 历史数据里若没有同日重复，再补一个唯一索引（双保险，能建就建）
do $$
begin
  begin
    create unique index if not exists wall_posts_one_per_day_idx
      on public.wall_posts (user_id, created_day);
  exception when others then
    raise notice '跳过唯一索引（历史数据存在同日多条）：%', sqlerrm;
  end;
end $$;

--  3) wall_reactions 允许 kind = 'dislike'（厌恶）─────────────
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

-- ─ 4) 浏览去重表：同一访客对同一条帖，一天只算一次 ────────────
--    viewer_key：登录用户 = uid；游客 = 本机匿名 id（前端 localStorage 生成）
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
-- 不开放直接 insert/update：写入只能走下面的 wall_add_view()（防刷计数）

-- ─ 5) RPC：记一次浏览（幂等：同人同帖同日只 +1）──────────────
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
  v_counted := found;                       -- 真的插进去了才算一次浏览

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

-- ─ 6) RPC：切换厌恶 + 达 #26 双档下架线自动下架（假删除）──────────────
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

  -- 服务端重新数一遍（不信前端传来的计数）
  select count(*) into v_dis from public.wall_reactions
    where post_id = p_post and kind = 'dislike';
  update public.wall_posts set dislikes = v_dis where id = p_post
    returning views, removed into v_views, v_rm;

  if v_views is null then
    return jsonb_build_object('ok', false, 'reason', 'not-found');
  end if;

  -- 下架线（#26 新规，双档；与前端 wallRules.shouldRemove 口径一致）：
  --   浏览 < 100 → 厌恶 > 3 个（即 ≥ 4 人）就下架；
  --   浏览 ≥ 100 → 厌恶数 ÷ 浏览数 > 0.5% 就下架
  -- 一旦下架就不再自动恢复：避免「比例来回摆动」让帖子忽隐忽现
  if not v_rm and (
       (v_views < 100 and v_dis > 3)
       or (v_views >= 100 and (v_dis::numeric / v_views) > 0.005)
     ) then
    update public.wall_posts set removed = true, removed_at = now() where id = p_post;
    v_rm := true;
  end if;

  return jsonb_build_object('ok', true, 'on', v_on, 'views', v_views,
                            'dislikes', v_dis, 'removed', v_rm);
end $$;

-- ─ 7) 授权：浏览计数匿名也要能走（游客浏览同样算数）──────────
grant execute on function public.wall_add_view(bigint, text) to anon, authenticated;
grant execute on function public.wall_toggle_dislike(bigint) to authenticated;

-- 完成 ✅ 前端会自动识别：浏览数 / 厌恶按钮 / 每日一条 全部生效

-- ═══════════════════════════════════════════════════════════════
--  增量迁移 2：主页的伙伴（/u/:id 展示宠物 + 手绘厨房 + 访客互动）
--  同样幂等：老库再跑一次这份即可；新库跑 SUPABASE_SETUP.sql 已含
-- ═══════════════════════════════════════════════════════════════

-- ── 1) 宠物档案镜像：主人登录后由前端自动同步（jsonb 存展示快照）──
--    data = { pet:{species,name,personality,level,sleeping,custom}, dishes:[{id,name,img,effort}], updated }
--    只放「公开面」字段，亲密度/金币/心情日记等私人数据不进云端。
--    访客互动计数单独占列（pats / feeds）：主人同步是整体覆盖 data，
--    计数若放在 data 里会被覆盖成 0（本次修复的根因）。
create table if not exists public.pet_profiles (
  user_id    uuid primary key references public.profiles (id) on delete cascade,
  data       jsonb not null default '{"pet":null,"dishes":[],"updated":0}'::jsonb,
  pats       integer not null default 0,
  feeds      integer not null default 0,
  updated_at timestamptz not null default now()
);

-- 老库补列（幂等）：早期版本把计数写在 data.counts 里，会被主人镜像覆盖
alter table public.pet_profiles add column if not exists pats  integer not null default 0;
alter table public.pet_profiles add column if not exists feeds integer not null default 0;

alter table public.pet_profiles enable row level security;

drop policy if exists "pet profiles readable by all" on public.pet_profiles;
create policy "pet profiles readable by all" on public.pet_profiles
  for select using (true);

drop policy if exists "pet profiles owner writes" on public.pet_profiles;
create policy "pet profiles owner writes" on public.pet_profiles
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ── 2) 互动去重：同一访客对同一主人，每种互动每天只计一次 ──────
--    viewer_key：登录用户 = uid；游客 = 前端本机匿名 id（与浏览去重同款）
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
-- 不开放直接写：计数只能走下面的 pet_interact()（防刷）

-- ── 3) RPC：访客互动（摸摸头 / 投喂），去重后把计数累进主人档案的独立列 ──
--    只动 pats / feeds 两列，绝不碰 data（主人镜像 upsert 会整体覆盖 data）
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
  v_counted := found;                      -- 真的插进去了才算一次（同人同日同类型只一次）

  if v_counted then
    /* 主人还没推过快照也先建好行，保证计数不丢（主人之后的 upsert 只改 data / updated_at） */
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

-- 游客也要能互动（去重与防刷都在服务端）
grant execute on function public.pet_interact(uuid, text, text) to anon, authenticated;

-- 完成 ✅ 主页区块会自动出现：宠物 + 手绘厨房 + 摸摸头/投喂