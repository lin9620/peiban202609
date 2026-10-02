-- 故事栏（轮 145 · 批 2）：评论 / 书架（收藏）/ 每日精选 / 我的数据面板。
-- 前置：批 1 的 MIGRATION_story.sql 必须已成功执行（本文件依赖 stories / story_comments / is_admin）。
-- 重复执行安全（幂等）。字数口径与批 1 一致：char_length（Unicode 码点）。
--
-- ★ 参数默认值铁律（PostgreSQL 42P13）：一旦某个参数带 default，
--   其后所有参数都必须带 default。批 1 就栽在这（p_id default null 后面跟无默认的 p_title），
--   整单回滚。下面每个函数都按「无默认参数全部在前、带默认的排在后」书写。
begin;

-- ── 书架（收藏）：主键防重复；story_id 级联删 ──
create table if not exists public.story_bookmarks (
  story_id   bigint not null references public.stories(id) on delete cascade,
  user_id    uuid not null,
  created_at timestamptz not null default now(),
  primary key (story_id, user_id)
);
create index if not exists story_bookmarks_user_idx on public.story_bookmarks (user_id, created_at desc);

-- ── 每日精选标记（批 1 没这列，这里补；一列布尔足够，不做多篇编排） ──
alter table public.stories add column if not exists featured boolean not null default false;
create index if not exists stories_featured_idx on public.stories (featured, published_at desc)
  where featured;

-- ── RLS：书架行本人读写 ──
alter table public.story_bookmarks enable row level security;
drop policy if exists story_bookmarks_read on public.story_bookmarks;
create policy story_bookmarks_read on public.story_bookmarks for select using (true);
drop policy if exists story_bookmarks_write on public.story_bookmarks;
create policy story_bookmarks_write on public.story_bookmarks for all
  to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ══════════ RPC 8：评论列表 ══════════
create or replace function public.story_comment_list(p_story_id bigint, p_limit integer default 50)
returns table (id bigint, user_id uuid, nickname text, body text, created_at timestamptz, mine boolean)
language sql security definer set search_path = public as $$
  select c.id, c.user_id,
         (select pr.nickname from public.profiles pr where pr.id = c.user_id),
         c.body, c.created_at, (c.user_id = auth.uid()) as mine
    from public.story_comments c
   where c.story_id = p_story_id
     and exists (select 1 from public.stories s
                  where s.id = c.story_id
                    and (s.status = 'published' or s.user_id = auth.uid()))
   order by c.created_at asc, c.id asc
   limit greatest(p_limit, 1)
$$;

-- ══════════ RPC 9：发评论 ══════════
create or replace function public.story_add_comment(p_story_id bigint, p_body text)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  v_body text;
  v_id bigint;
begin
  if me is null then raise exception 'story-auth'; end if;
  v_body := btrim(coalesce(p_body, ''));
  if char_length(v_body) < 1 then raise exception 'story-comment-empty'; end if;
  if char_length(v_body) > 1000 then raise exception 'story-comment-long'; end if;

  insert into public.story_comments (story_id, user_id, body)
  values (p_story_id, me, v_body)
  returning id into v_id;

  -- 目标必须是已发布故事：否则删掉刚插的那条，保持计数与实际条数一致
  if not exists (select 1 from public.stories where id = p_story_id and status = 'published') then
    delete from public.story_comments where id = v_id;
    raise exception 'story-not-found';
  end if;

  update public.stories set comment_count = comment_count + 1 where id = p_story_id;
  return v_id;
end $$;

-- ══════════ RPC 10：删评论 ══════════
create or replace function public.story_delete_comment(p_id bigint)
returns void language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  v_story bigint;
begin
  if me is null then raise exception 'story-auth'; end if;
  select c.story_id into v_story from public.story_comments c where c.id = p_id;
  if not found then raise exception 'story-not-found'; end if;
  if not exists (select 1 from public.story_comments c
                   where c.id = p_id
                     and (c.user_id = me
                          or exists (select 1 from public.stories s
                                      where s.id = c.story_id and s.user_id = me)))
  then raise exception 'story-auth'; end if;

  delete from public.story_comments where id = p_id;
  update public.stories set comment_count = greatest(comment_count - 1, 0) where id = v_story;
end $$;

-- ══════════ RPC 11：收藏/取消收藏 ══════════
create or replace function public.story_toggle_bookmark(p_id bigint)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception 'story-auth'; end if;
  if not exists (select 1 from public.stories where id = p_id and status = 'published')
  then raise exception 'story-not-found'; end if;

  if exists (select 1 from public.story_bookmarks where story_id = p_id and user_id = me) then
    delete from public.story_bookmarks where story_id = p_id and user_id = me;
    return false;
  end if;
  insert into public.story_bookmarks (story_id, user_id) values (p_id, me);
  return true;
end $$;

-- ══════════ RPC 12：我的书架 ══════════
create or replace function public.story_bookmark_list(
  p_limit integer default 30, p_offset integer default 0
) returns table (id bigint, user_id uuid, nickname text, title text, tags text[],
                 like_count integer, view_count integer, word_count integer,
                 read_minutes integer, published_at timestamptz, saved_at timestamptz)
language sql security definer set search_path = public as $$
  select s.id, s.user_id,
         (select pr.nickname from public.profiles pr where pr.id = s.user_id),
         s.title, s.tags, s.like_count, s.view_count, s.word_count, s.read_minutes,
         s.published_at, b.created_at
    from public.story_bookmarks b
    join public.stories s on s.id = b.story_id
   where b.user_id = auth.uid()
     and s.status = 'published'
   order by b.created_at desc, s.id desc
   limit greatest(p_limit, 1) offset greatest(coalesce(p_offset, 0), 0)
$$;

-- ══════════ RPC 13：每日精选（当前那篇） ══════════
create or replace function public.story_featured()
returns table (id bigint, user_id uuid, nickname text, title text, tags text[],
               like_count integer, view_count integer, word_count integer,
               read_minutes integer, published_at timestamptz)
language sql security definer set search_path = public as $$
  select s.id, s.user_id,
         (select pr.nickname from public.profiles pr where pr.id = s.user_id),
         s.title, s.tags, s.like_count, s.view_count, s.word_count, s.read_minutes,
         s.published_at
    from public.stories s
   where s.status = 'published' and s.featured
   order by s.published_at desc, s.id desc
   limit 1
$$;

-- ══════════ RPC 14：设/撤每日精选（仅管理员） ══════════
create or replace function public.story_set_featured(p_id bigint, p_on boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'story-auth'; end if;
  if p_on then
    if not exists (select 1 from public.stories where id = p_id and status = 'published')
    then raise exception 'story-not-found'; end if;
    update public.stories set featured = false where featured;   -- 单一精选：先全撤
    update public.stories set featured = true where id = p_id;
  else
    update public.stories set featured = false where id = p_id;
  end if;
end $$;

-- ══════════ RPC 15：我的数据面板 ══════════
create or replace function public.story_my_stats()
returns table (published_count bigint, draft_count bigint, total_likes bigint,
               total_views bigint, total_comments bigint, bookmark_count bigint,
               best_id bigint, best_title text, best_likes integer)
language sql security definer set search_path = public as $$
  with mine as (
    select s.id, s.title, s.status, s.like_count, s.view_count, s.comment_count, s.published_at
      from public.stories s
     where s.user_id = auth.uid() and s.status in ('draft', 'published')
  ),
  best as (
    select m.id, m.title, m.like_count
      from mine m
     where m.status = 'published'
     order by m.like_count desc, m.published_at desc nulls last, m.id desc
     limit 1
  )
  select (select count(*) from mine where status = 'published'),
         (select count(*) from mine where status = 'draft'),
         (select coalesce(sum(like_count), 0) from mine where status = 'published'),
         (select coalesce(sum(view_count), 0) from mine where status = 'published'),
         (select coalesce(sum(comment_count), 0) from mine where status = 'published'),
         (select count(*) from public.story_bookmarks b where b.user_id = auth.uid()),
         (select id from best), (select title from best), (select like_count from best)
$$;

-- ══════════ 授权（写操作只给登录，读操作给匿名） ══════════
revoke all on function public.story_comment_list(bigint, integer) from public, anon;
revoke all on function public.story_add_comment(bigint, text) from public, anon;
revoke all on function public.story_delete_comment(bigint) from public, anon;
revoke all on function public.story_toggle_bookmark(bigint) from public, anon;
revoke all on function public.story_bookmark_list(integer, integer) from public, anon;
revoke all on function public.story_featured() from public, anon;
revoke all on function public.story_set_featured(bigint, boolean) from public, anon;
revoke all on function public.story_my_stats() from public, anon;
grant execute on function public.story_comment_list(bigint, integer) to authenticated, anon;
grant execute on function public.story_add_comment(bigint, text) to authenticated;
grant execute on function public.story_delete_comment(bigint) to authenticated;
grant execute on function public.story_toggle_bookmark(bigint) to authenticated;
grant execute on function public.story_bookmark_list(integer, integer) to authenticated;
grant execute on function public.story_featured() to authenticated, anon;
grant execute on function public.story_set_featured(bigint, boolean) to authenticated;
grant execute on function public.story_my_stats() to authenticated;

commit;
