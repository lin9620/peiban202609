-- 故事栏（轮 391）：我的草稿箱删除草稿。
-- 只允许作者删自己的 status='draft'；已发布故事不走这里，避免误删公开内容。
-- 可重复执行（create or replace + revoke/grant），与 MIGRATION_story.sql 同库同表。
begin;

create or replace function public.story_delete_draft(p_id bigint)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception 'story-auth'; end if;
  delete from public.stories
   where id = p_id and user_id = me and status = 'draft';
  if not found then raise exception 'story-not-found'; end if;
  return true;
end $$;

revoke all on function public.story_delete_draft(bigint) from public, anon;
grant execute on function public.story_delete_draft(bigint) to authenticated;

commit;
