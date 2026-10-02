-- 故事栏（轮 145 · 批 1）：投稿 / 故事流 / 四榜 / 点赞。
-- 前置：无（新功能独立建表）。重复执行安全（幂等）。
-- 字数口径：char_length（Unicode 码点），与前端 storyRules.countChars 同口径；正文 ≤30000。
begin;

-- ── 故事主表 ─────────────────────────────────────────────
create table if not exists public.stories (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  title         text not null check (char_length(title) between 1 and 100),
  body          text not null check (char_length(body) between 1 and 30000),
  tags          text[] not null default '{}',
  status        text not null default 'draft'
                check (status in ('draft', 'published', 'removed')),
  word_count    integer not null default 0,
  read_minutes  integer not null default 1,
  like_count    integer not null default 0,
  comment_count integer not null default 0,
  view_count    integer not null default 0,
  rev           integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  published_at  timestamptz,
  constraint stories_tags_len check (array_length(tags, 1) is null
                or array_length(tags, 1) between 1 and 3)
);
create index if not exists stories_feed_idx on public.stories (status, published_at desc);
create index if not exists stories_user_idx on public.stories (user_id, status, updated_at desc);
create index if not exists stories_tags_idx on public.stories using gin (tags);

-- ── 点赞（主键防重复；created_at 支撑「当月赞榜」实时聚合） ──
create table if not exists public.story_likes (
  story_id   bigint not null references public.stories(id) on delete cascade,
  user_id    uuid not null,
  created_at timestamptz not null default now(),
  primary key (story_id, user_id)
);
create index if not exists story_likes_month_idx on public.story_likes (created_at);

-- ── 故事评论（批 1 建表，功能批 2 启用，避免二次迁移） ──
create table if not exists public.story_comments (
  id         bigint generated always as identity primary key,
  story_id   bigint not null references public.stories(id) on delete cascade,
  user_id    uuid not null,
  body       text not null check (char_length(body) between 1 and 1000),
  created_at timestamptz not null default now()
);
create index if not exists story_comments_story_idx on public.story_comments (story_id, created_at);

-- ── 浏览去重（同人同故事同日只计一次，服务端权威） ──
create table if not exists public.story_views (
  story_id bigint not null references public.stories(id) on delete cascade,
  user_id  uuid not null,
  day      date not null default current_date,
  primary key (story_id, user_id, day)
);

-- ── RLS：published 全员可读；作者读写自己的 ──
alter table public.stories        enable row level security;
alter table public.story_likes    enable row level security;
alter table public.story_comments enable row level security;
alter table public.story_views    enable row level security;

drop policy if exists stories_read on public.stories;
create policy stories_read on public.stories for select
  using (status = 'published' or user_id = auth.uid());
drop policy if exists stories_write on public.stories;
create policy stories_write on public.stories for all
  to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists story_likes_read on public.story_likes;
create policy story_likes_read on public.story_likes for select using (true);
drop policy if exists story_likes_write on public.story_likes;
create policy story_likes_write on public.story_likes for all
  to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists story_comments_read on public.story_comments;
create policy story_comments_read on public.story_comments for select using (true);
drop policy if exists story_comments_write on public.story_comments;
create policy story_comments_write on public.story_comments for all
  to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists story_views_write on public.story_views;
create policy story_views_write on public.story_views for all
  to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ── RPC 1：发布（校验字数/标签；draft ↔ published 双向；编辑 rev+1） ──
-- 注意：p_id 不给默认值 —— PostgreSQL 42P13：有默认的参数之后不能跟无默认的。
create or replace function public.story_publish(
  p_id bigint, p_title text, p_body text, p_tags text[] default '{}'
) returns setof public.stories language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  v_tags text[];
  v_words integer;
  rec public.stories%rowtype;
begin
  if me is null then raise exception 'story-auth'; end if;
  if p_title is null or char_length(trim(p_title)) = 0 or char_length(p_title) > 100 then
    raise exception 'story-bad-title';
  end if;
  if p_body is null or char_length(p_body) = 0 or char_length(p_body) > 30000 then
    raise exception 'story-too-long';
  end if;
  -- 正文下限 100 字（只卡发布；草稿 story_save_draft 不受此限）。
  -- 注意：刻意不动表上的 check (char_length(body) between 1 and 30000) ——
  -- 库里可能有 <100 字的存量故事，改约束会让它们一被编辑就撞约束报错。
  if char_length(p_body) < 100 then
    raise exception 'story-too-short';
  end if;
  select coalesce(array_agg(distinct lower(trim(x))) filter (where length(trim(x)) between 1 and 20), '{}')
    into v_tags from unnest(coalesce(p_tags, '{}')) x;
  if array_length(v_tags, 1) is null or array_length(v_tags, 1) > 3 then
    raise exception 'story-bad-tags';
  end if;
  v_words := char_length(p_body);

  if p_id is null then
    insert into public.stories (user_id, title, body, tags, status, word_count, read_minutes, published_at)
    values (me, trim(p_title), p_body, v_tags, 'published', v_words,
            greatest(1, ceil(v_words / 400.0)::int), now())
    returning * into rec;
  else
    update public.stories
       set title = trim(p_title), body = p_body, tags = v_tags, status = 'published',
           word_count = v_words, read_minutes = greatest(1, ceil(v_words / 400.0)::int),
           rev = rev + 1, updated_at = now(),
           published_at = coalesce(published_at, now())
     where id = p_id and user_id = me and status <> 'removed'
    returning * into rec;
    if not found then raise exception 'story-not-found'; end if;
  end if;
  return next rec;
end $$;

-- ── RPC 2：存草稿（停手自动存；与发布同一张表，status=draft） ──
create or replace function public.story_save_draft(
  p_id bigint, p_title text, p_body text, p_tags text[] default '{}'
) returns setof public.stories language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  rec public.stories%rowtype;
begin
  if me is null then raise exception 'story-auth'; end if;
  /* 存草稿宽容：标题可空（占位「无标题」），正文 ≤30000 同口径 */
  if char_length(coalesce(p_body, '')) > 30000 then raise exception 'story-too-long'; end if;
  if p_id is null then
    insert into public.stories (user_id, title, body, tags, status, word_count)
    values (me, coalesce(nullif(trim(coalesce(p_title, '')), ''), '无标题'), coalesce(p_body, ''),
            coalesce(p_tags, '{}'), 'draft', char_length(coalesce(p_body, '')))
    returning * into rec;
  else
    update public.stories
       set title = coalesce(nullif(trim(coalesce(p_title, '')), ''), title),
           body = coalesce(p_body, body), tags = coalesce(p_tags, tags),
           word_count = char_length(coalesce(p_body, body)), rev = rev + 1, updated_at = now()
     where id = p_id and user_id = me and status = 'draft'
    returning * into rec;
    if not found then raise exception 'story-not-found'; end if;
  end if;
  return next rec;
end $$;

-- ── RPC 3：赞/取消赞（主键防重 + 维护 like_count，服务端权威） ──
create or replace function public.story_toggle_like(p_id bigint)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  had boolean;
begin
  if me is null then raise exception 'story-auth'; end if;
  select true into had from public.story_likes where story_id = p_id and user_id = me;
  if found then
    delete from public.story_likes where story_id = p_id and user_id = me;
    update public.stories set like_count = greatest(like_count - 1, 0) where id = p_id;
    return false;
  end if;
  insert into public.story_likes (story_id, user_id) values (p_id, me);
  update public.stories set like_count = like_count + 1
   where id = p_id and status = 'published';
  if not found then raise exception 'story-not-found'; end if;
  return true;
end $$;

-- ── RPC 4：浏览计数（同人同故事同日只计一次） ──
create or replace function public.story_add_view(p_id bigint)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then return; end if;
  insert into public.story_views (story_id, user_id) values (p_id, me)
    on conflict do nothing;
  if found then
    update public.stories set view_count = view_count + 1 where id = p_id and status = 'published';
  end if;
end $$;

-- ── RPC 5：四榜一条出（推荐=窗口内质量加权随机 / 最新 / 月赞 / 标签） ──
-- p_mode: random | latest | monthly | tag；p_tag 配合 tag 模式；p_period 'YYYY-MM'（现月，留周改口）。
-- 推荐口径：近 30 天 published 池，质量分 = like*0.6 + view*0.3 + 新鲜度*0.1，按分洗牌（setseed 可复现，5 分钟内稳定）。
create or replace function public.story_rank(
  p_mode text default 'random', p_tag text default null,
  p_period text default null, p_limit integer default 20, p_offset integer default 0
) returns table (id bigint, user_id uuid, nickname text, title text, tags text[], like_count integer,
                 view_count integer, word_count integer, read_minutes integer,
                 published_at timestamptz, score numeric)
language plpgsql security definer set search_path = public as $$
declare
  v_period text := coalesce(p_period, to_char(now(), 'YYYY-MM'));
  v_seed bigint := floor(extract(epoch from now()) / 300)::bigint; -- 5 分钟一换批
begin
  if p_mode not in ('random', 'latest', 'monthly', 'tag') then raise exception 'story-bad-mode'; end if;

  if p_mode = 'random' then
    perform setseed(((v_seed % 1000)::double precision / 1000.0) - 0.5); -- 确定性种子：同窗口内结果稳定
    return query
    with pool as (
      select s.*,
             (select pr.nickname from public.profiles pr where pr.id = s.user_id) as nickname,
             (s.like_count * 0.6 + s.view_count * 0.3
              + 10.0 * greatest(0, 1 - extract(epoch from (now() - s.published_at)) / 2592000)) as q
        from public.stories s
       where s.status = 'published' and s.published_at > now() - interval '30 days'
         and (p_tag is null or s.tags && array[p_tag])
    )
    select p.id, p.user_id, p.nickname, p.title, p.tags, p.like_count, p.view_count,
           p.word_count, p.read_minutes, p.published_at, p.q
      from pool p
     order by p.q * (0.5 + random()) desc
     limit greatest(p_limit, 1) offset greatest(coalesce(p_offset, 0), 0);

  elsif p_mode = 'latest' then
    return query
    select s.id, s.user_id,
           (select pr.nickname from public.profiles pr where pr.id = s.user_id),
           s.title, s.tags, s.like_count, s.view_count,
           s.word_count, s.read_minutes, s.published_at, 0::numeric
      from public.stories s
     where s.status = 'published' and (p_tag is null or s.tags && array[p_tag])
     order by s.published_at desc, s.id desc
     limit greatest(p_limit, 1) offset greatest(coalesce(p_offset, 0), 0);

  elsif p_mode = 'monthly' then
    return query
    select s.id, s.user_id,
           (select pr.nickname from public.profiles pr where pr.id = s.user_id),
           s.title, s.tags, s.like_count, s.view_count,
           s.word_count, s.read_minutes, s.published_at,
           count(l.user_id)::numeric as mlikes
      from public.stories s
      join public.story_likes l on l.story_id = s.id
     where s.status = 'published'
       and to_char(l.created_at, 'YYYY-MM') = v_period
       and (p_tag is null or s.tags && array[p_tag])
     group by s.id
     order by mlikes desc, s.published_at desc
     limit greatest(p_limit, 1) offset greatest(coalesce(p_offset, 0), 0);

  else -- tag：热门标签云榜（按标签聚合的当期赞数+篇数，前端选标签后再拉该标签故事）
    return query
    select 0::bigint as id, '00000000-0000-0000-0000-000000000000'::uuid as user_id,
           null::text as nickname,
           t as title, array[t] as tags, sum(s.like_count)::integer as like_count,
           count(*)::integer as view_count, 0 as word_count, 0 as read_minutes,
           max(s.published_at) as published_at,
           count(l.user_id)::numeric
      from public.stories s
      cross join lateral unnest(s.tags) t
      left join public.story_likes l on l.story_id = s.id
       and to_char(l.created_at, 'YYYY-MM') = v_period
     where s.status = 'published'
     group by t
     -- 排序列必须用限定名/别名：裸 score 会被 plpgsql 当 OUT 变量替换（NULL，排序静默失效）
     order by count(l.user_id) desc, count(*) desc, t
     limit greatest(p_limit, 1) offset greatest(coalesce(p_offset, 0), 0);
  end if;
end $$;

-- ── RPC 6：单篇详情（published 全员可读含未登录；自己的草稿自己可见；带 liked/mine 与作者昵称） ──
-- security definer 绕 RLS，故 where 里那句就是唯一权威：非本人且未发布 → 查不到（前端 404）。
create or replace function public.story_get(p_id bigint)
returns table (id bigint, user_id uuid, nickname text, title text, body text, tags text[],
               status text, like_count integer, comment_count integer, view_count integer,
               word_count integer, read_minutes integer, rev integer,
               published_at timestamptz, updated_at timestamptz, liked boolean, mine boolean)
language sql security definer set search_path = public as $$
  select s.id, s.user_id,
         (select pr.nickname from public.profiles pr where pr.id = s.user_id),
         s.title, s.body, s.tags, s.status, s.like_count, s.comment_count, s.view_count,
         s.word_count, s.read_minutes, s.rev, s.published_at, s.updated_at,
         exists (select 1 from public.story_likes l
                  where l.story_id = s.id and l.user_id = auth.uid()) as liked,
         (s.user_id = auth.uid()) as mine
    from public.stories s
   where s.id = p_id
     and (s.status = 'published' or s.user_id = auth.uid())
$$;

-- ── RPC 7：我的投稿（草稿箱 + 已发布；p_status 省略 = 全部；带正文供编辑器续写） ──
create or replace function public.story_mine(
  p_status text default null, p_limit integer default 30, p_offset integer default 0
) returns table (id bigint, user_id uuid, nickname text, title text, body text, tags text[],
                 status text, like_count integer, comment_count integer, view_count integer,
                 word_count integer, read_minutes integer, rev integer,
                 published_at timestamptz, updated_at timestamptz, liked boolean, mine boolean)
language sql security definer set search_path = public as $$
  select s.id, s.user_id, null::text,
         s.title, s.body, s.tags, s.status, s.like_count, s.comment_count, s.view_count,
         s.word_count, s.read_minutes, s.rev, s.published_at, s.updated_at,
         false, true
    from public.stories s
   where s.user_id = auth.uid()
     and s.status <> 'removed'
     and (p_status is null or s.status = p_status)
   order by s.updated_at desc, s.id desc
   limit greatest(p_limit, 1) offset greatest(coalesce(p_offset, 0), 0)
$$;

revoke all on function public.story_publish(bigint, text, text, text[]) from public, anon;
revoke all on function public.story_save_draft(bigint, text, text, text[]) from public, anon;
revoke all on function public.story_toggle_like(bigint) from public, anon;
revoke all on function public.story_add_view(bigint) from public, anon;
revoke all on function public.story_rank(text, text, text, integer, integer) from public, anon;
revoke all on function public.story_get(bigint) from public, anon;
revoke all on function public.story_mine(text, integer, integer) from public, anon;
grant execute on function public.story_publish(bigint, text, text, text[]) to authenticated;
grant execute on function public.story_save_draft(bigint, text, text, text[]) to authenticated;
grant execute on function public.story_toggle_like(bigint) to authenticated;
grant execute on function public.story_add_view(bigint) to authenticated;
grant execute on function public.story_rank(text, text, text, integer, integer) to authenticated, anon;
grant execute on function public.story_get(bigint) to authenticated, anon;
grant execute on function public.story_mine(text, integer, integer) to authenticated;

commit;

