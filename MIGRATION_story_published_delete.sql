-- 故事栏：作者删除自己已发布的故事。
-- 硬删除：story_likes / story_comments / story_bookmarks / story_views
-- 都是 on delete cascade，会随故事行一起清掉。
-- 只允许 status='published'；草稿仍走 MIGRATION_story_draft_delete.sql。
-- 可重复执行（create or replace + revoke/grant）。
begin;

create or replace function public.story_delete_published(p_id bigint)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception 'story-auth'; end if;
  delete from public.stories
   where id = p_id and user_id = me and status = 'published';
  if not found then raise exception 'story-not-found'; end if;
  return true;
end $$;

revoke all on function public.story_delete_published(bigint) from public, anon;
grant execute on function public.story_delete_published(bigint) to authenticated;

commit;
