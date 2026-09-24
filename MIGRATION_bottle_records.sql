-- ═══════════════════════════════════════════════════════════════
--  迁移：漂流瓶记录分类与分页（#17 引入；轮 45 按用户口径重写「我捞到的」）
--  bottle_records 两类过滤与每页条数：
--    p_mine = true  → 只看「我发布的」（user_id = 我），按发布时间新→旧
--    p_mine = false → 只看「我捞到的」，轮 45 口径：
--                       ① 只显示**已回信**的信（回信人 = 我）
--                       ② 已放回海里的、还押在手里的，都不再进记录列表
--                         （在守的信走首页顶部托盘回信/放回，不受影响）
--                       ③ 按「捞到时间」新→旧：回信后信是 answered 状态，
--                         held_at 保留为捞起那一刻（answered 不会再被放回/重捞，
--                         held_at 即捞到时间）
--    p_mine = null  → 原行为（我写的或我回过的），按发布时间新→旧
--    p_limit        → 每页条数（默认 30，兼容旧调用；首页传 10）
--  用法：Supabase Dashboard → SQL Editor → **粘贴本文件全部内容** → Run
--       （幂等，可重复执行；只粘片段会静默保留旧定义——踩坑 #21）
--  前置：已执行 MIGRATION_bottle.sql / _chat / _quota_fishfix / _reply_quota
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
       /* 我捞到的（轮 45）：只显示已回信的。只有捞到信的人能回信（bottle_reply
          要求 status='held' 且 holder=我），回信人 = 我 即「我捞到且已回信」；
          已放回的（status 回 sea、没回过信）与在守的（status=held）天然排除。 */
       or (p_mine is false and l.reply_by = auth.uid() and l.reply_at is not null)
     )
   order by
     /* 我捞到的按捞到时间新→旧；其余口径按发布时间新→旧 */
     (case when p_mine is false then l.held_at else l.created_at end) desc,
     l.id
   limit greatest(coalesce(p_limit, 30), 1)
   offset greatest(coalesce(p_offset, 0), 0)
$$;

-- 执行权限与续聊函数同口径：匿名不可执行，登录用户可用
revoke all on function public.bottle_records(uuid, integer, boolean, integer) from public, anon;
grant execute on function public.bottle_records(uuid, integer, boolean, integer) to authenticated;

commit;
