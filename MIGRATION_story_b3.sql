-- 故事栏（轮 321 · 批 3）：点赞/收藏的「幂等设置」语义 + 详情页带 marked 字段。
-- 前置：批 1（MIGRATION_story.sql）与批 2（MIGRATION_story_b2.sql）必须已成功执行。
-- 重复执行安全（幂等）。
--
-- ★ 为什么需要这一批 ──────────────────────────────────────
--   旧的 story_toggle_like / story_toggle_bookmark 是【翻转】语义：
--   「服务端当前是赞 → 调一次就取消」。前端若做乐观更新并在失败时重试，
--   同一个请求发两次会把状态翻转两次（点一下赞 → 又变回没赞）。
--   详情页为了「跟手」必须做乐观更新 + 重试 + 幂等，于是需要【设置】语义：
--   「把点赞状态设成 true/false」—— 重复执行多少次，结果都一样。
--   同时 story_get 不返回 marked 字段 → 收藏星永远不亮、刷新后状态丢失，
--   这里给它补上，并顺手带上权威 like_count（详情页首次进入就能画对）。
begin;

-- ── RPC 9：点赞「设成目标态」（幂等；返回权威 like_count）──
-- ★ 这里必须用 exists(...) 而不是「select true into had ... 再 not had」——
--   plpgsql 的 SELECT INTO 查不到行时目标变量保持 NULL（不是 false），
--   于是 `if p_on and not had` 求值成 NULL → IF 判定为假 → 写入分支永不执行，
--   函数却「成功返回」了（计数不变、liked 不变）—— 表现就是「点赞点了没反应」。
--   exists(...) 永远返回非 NULL 的 boolean，不会踩这个坑。
create or replace function public.story_set_like(p_id bigint, p_on boolean)
returns integer language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  n integer;
begin
  if me is null then raise exception 'story-auth'; end if;
  if not exists (select 1 from public.stories where id = p_id) then
    raise exception 'story-not-found';
  end if;
  if p_on and not exists (select 1 from public.story_likes where story_id = p_id and user_id = me) then
    insert into public.story_likes (story_id, user_id) values (p_id, me);
    update public.stories set like_count = like_count + 1 where id = p_id and status = 'published';
  elsif (not p_on) and exists (select 1 from public.story_likes where story_id = p_id and user_id = me) then
    delete from public.story_likes where story_id = p_id and user_id = me;
    update public.stories set like_count = greatest(like_count - 1, 0) where id = p_id and status = 'published';
  end if;
  select like_count into n from public.stories where id = p_id;
  if n is null then raise exception 'story-not-found'; end if;
  return n;
end $$;

-- ── RPC 10：收藏「设成目标态」（幂等；返回收藏总数）──
-- ★ 同 story_set_like：这里用 exists(...)，别用「select true into had ... 再 not had」
--   （查不到行时 had 是 NULL，not had 是 NULL，IF 判假 → 分支永不执行）。
create or replace function public.story_set_bookmark(p_id bigint, p_on boolean)
returns integer language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  n integer;
begin
  if me is null then raise exception 'story-auth'; end if;
  if not exists (select 1 from public.stories where id = p_id) then
    raise exception 'story-not-found';
  end if;
  if p_on and not exists (select 1 from public.story_bookmarks where story_id = p_id and user_id = me) then
    insert into public.story_bookmarks (story_id, user_id) values (p_id, me);
  elsif (not p_on) and exists (select 1 from public.story_bookmarks where story_id = p_id and user_id = me) then
    delete from public.story_bookmarks where story_id = p_id and user_id = me;
  end if;
  select count(*) into n from public.story_bookmarks where story_id = p_id;
  return n;
end $$;

-- ── RPC 11：详情页取「我赞了哪些 / 我收藏了哪些」（批量，一次往返）──
-- 详情页首屏要画对赞/藏状态。以前靠 story_get 里的 exists（只能带 liked），
-- marked 缺失只能再发一次 RPC —— 这里一次拿两把「钥匙」。
create or replace function public.story_my_flags(p_ids bigint[])
returns table (story_id bigint, liked boolean, marked boolean)
language sql security definer set search_path = public as $$
  select s.id,
         exists (select 1 from public.story_likes l
                  where l.story_id = s.id and l.user_id = auth.uid()),
         exists (select 1 from public.story_bookmarks b
                  where b.story_id = s.id and b.user_id = auth.uid())
    from unnest(coalesce(p_ids, '{}')) s(id)
$$;

-- ── 详情页：给 story_get 补 marked 字段 ──────────────────────────
-- ★ 必须先 DROP 再 CREATE（不能 create or replace）——
--   story_get 的返回类型（RETURNS TABLE 的 OUT 参数行类型）变了（多一列 marked），
--   PostgreSQL 不允许 CREATE OR REPLACE 改函数返回类型，会报：
--     ERROR: 42P13: cannot change return type of existing function
--     DETAIL: Row type defined by OUT parameters is different.
--   DROP 之前要先确认没人依赖它（本项目里 story_get 只被 RPC 调用，没有视图/函数依赖它），
--   且它在事务里 drop+create，外部看不到中间态。
--   （story_mine 之类的同族函数返回同样的列，但它们是各自独立的函数体，不受影响。）
drop function if exists public.story_get(bigint);
create function public.story_get(p_id bigint)
returns table (id bigint, user_id uuid, nickname text, title text, body text, tags text[],
               status text, like_count integer, comment_count integer, view_count integer,
               word_count integer, read_minutes integer, rev integer,
               published_at timestamptz, updated_at timestamptz, liked boolean, marked boolean, mine boolean)
language sql security definer set search_path = public as $$
  select s.id, s.user_id,
         (select pr.nickname from public.profiles pr where pr.id = s.user_id),
         s.title, s.body, s.tags, s.status, s.like_count, s.comment_count, s.view_count,
         s.word_count, s.read_minutes, s.rev, s.published_at, s.updated_at,
         exists (select 1 from public.story_likes l
                  where l.story_id = s.id and l.user_id = auth.uid()) as liked,
         exists (select 1 from public.story_bookmarks b
                  where b.story_id = s.id and b.user_id = auth.uid()) as marked,
         (s.user_id = auth.uid()) as mine
    from public.stories s
   where s.id = p_id
     and (s.status = 'published' or s.user_id = auth.uid())
$$;

revoke all on function public.story_set_like(bigint, boolean) from public, anon;
revoke all on function public.story_set_bookmark(bigint, boolean) from public, anon;
revoke all on function public.story_my_flags(bigint[]) from public, anon;
grant execute on function public.story_set_like(bigint, boolean) to authenticated;
grant execute on function public.story_set_bookmark(bigint, boolean) to authenticated;
grant execute on function public.story_my_flags(bigint[]) to authenticated;

-- story_get 是上面 drop + create 的（返回类型变了没法 create or replace），
-- 权限要重新给一遍 —— 否则 drop 会把 anon/authenticated 的执行权一起带走，
-- 详情页会直接报权限拒绝（老调用方包括匿名读故事）。
revoke all on function public.story_get(bigint) from public, anon;
grant execute on function public.story_get(bigint) to authenticated, anon;

commit;
