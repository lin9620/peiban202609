-- 故事栏批 3 补丁（轮 321 · 只修两个写 RPC 的空判断 bug）：
--   现象：story_set_like / story_set_bookmark 调了「成功返回」，但赞/藏根本没写进去
--         （计数不变、story_get.liked/marked 仍是 false）—— 也就是「点赞点了没反应」。
--   原因：plpgsql 的 `select true into had from ... where ...` 查不到行时，
--         目标变量 had 保持 NULL（不是 false）→ `if p_on and not had` 求值为 NULL
--         → IF 判定为假 → 写入分支永不执行；函数却正常返回了。
--         老函数 story_toggle_like 用的是 `if found then`（FOUND 特殊变量），
--         所以老函数没事，只有批 3 新写的两个 RPC 踩了这个坑。
--   修法：改用 exists(...)，它永远返回非 NULL 的 boolean。
-- 前置：MIGRATION_story_b3.sql 已执行过（否则这两个函数还不存在，跑本补丁也无妨，
--       但那样 story_get 仍缺 marked，详情页收藏星不会亮）。
-- 本补丁是整段事务，重复执行安全。

begin;

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

revoke all on function public.story_set_like(bigint, boolean) from public, anon;
revoke all on function public.story_set_bookmark(bigint, boolean) from public, anon;
grant execute on function public.story_set_like(bigint, boolean) to authenticated;
grant execute on function public.story_set_bookmark(bigint, boolean) to authenticated;

commit;