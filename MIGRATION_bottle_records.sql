-- ═══════════════════════════════════════════════════════════════
--  迁移：漂流瓶记录分类与分页（#17）
--  bottle_records 增加两类过滤与每页条数：
--    p_mine = true  → 只看「我发布的」（user_id = 我）
--    p_mine = false → 只看「我捞到的」（我在 bottle_fishes 里捞起过；含放回海里的）
--    p_mine = null  → 原行为（我写的或我回过的）
--    p_limit        → 每页条数（默认 30，兼容旧调用；首页传 10）
--  排序统一按发布时间新→旧（用户口径：按发布最新排序）。
--  旧签名 bottle_records(uuid, integer) 被本函数取代（drop 后重建统一签名）。
--  用法：Supabase Dashboard → SQL Editor → 粘贴全部 → Run（幂等，可重复执行）
--  前置：已执行 MIGRATION_bottle.sql 与 MIGRATION_bottle_chat.sql
-- ═══════════════════════════════════════════════════════════════

begin;

drop function if exists public.bottle_records(uuid, integer);

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
       /* 默认（p_mine is null）：维持旧口径 —— 我写的或我回过的 */
       (p_mine is null and (l.user_id = auth.uid() or l.reply_by = auth.uid()))
       /* 我发布的 */
       or (p_mine is true and l.user_id = auth.uid())
       /* 我捞到的（捞起过就留痕：回过信、或放回海里都算；自己的信捞不到，天然排除） */
       or (p_mine is false and exists (
             select 1 from public.bottle_fishes f
              where f.user_id = auth.uid() and f.letter_id = l.id))
     )
   order by l.created_at desc, l.id
   limit greatest(coalesce(p_limit, 30), 1)
   offset greatest(coalesce(p_offset, 0), 0)
$$;

-- 执行权限与续聊函数同口径：匿名不可执行，登录用户可用
revoke all on function public.bottle_records(uuid, integer, boolean, integer) from public, anon;
grant execute on function public.bottle_records(uuid, integer, boolean, integer) to authenticated;

commit;
