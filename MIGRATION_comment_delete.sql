-- ═══════════════════════════════════════════════════════════════
--  Warm Paws · 暖爪 — 增量迁移：删评论改软删（保住下面的二级回复）
-- ═══════════════════════════════════════════════════════════════
--  背景（用户原话）：a 的帖下 b 发了一条一级评论，c/d/e 在它下面回了几条；
--        b 删掉自己那条一级评论后，c/d/e 的回复**全被连带删没了**，不合适。
--        正确做法：b 的评论显示成「已被删除」，下面的二级评论照常保留。
--
--  根因：wall_comments.parent_id 是 `on delete cascade`
--        （SUPABASE_SETUP.sql 建表语句 / MIGRATION_two_level_comments.sql 第 22 行）——
--        删一级评论时**数据库直接把它的回复一起物理删除**，前端改不动这件事。
--
--  本迁移：**软删**（与 wall_posts.removed 同款套路）
--    · 删评论不再 DELETE 行，改成写 deleted_at；
--    · 级联因此永不触发，二级回复原样保留；
--    · 前端把已删的一级评论渲染成「该评论已删除」占位，下面的回复照常显示；
--    · 正文仍留在库里（软删标准做法：可审计、误删可恢复）——界面上不再展示。
--
--  用途：**已经建过库**的用户，在 Supabase → SQL Editor 里跑这一份
--        （新库不用管：直接用 SUPABASE_SETUP.sql 建库即含本迁移）
--  幂等：可重复执行，已迁移过再跑不会有副作用
--
--  不跑也能用（降级可用，务必保留这条）：
--        前端删评论先调下面的 wall_comment_delete，函数不存在（PGRST202 / 42883）
--        就退回旧的硬删 —— 行为与迁移前**完全一致**（只是回复照旧会没）。
--        网关模式同理：Worker 把上游 404 原样透传，前端据消息认出「没这个函数」再回退。
--        所以：**没跑迁移 = 老行为，跑了 = 新行为**，任何一种都不挡删除。
-- ═══════════════════════════════════════════════════════════════

-- 1) 补一列：软删时间戳（空 = 没删）
alter table public.wall_comments add column if not exists deleted_at timestamptz;

comment on column public.wall_comments.deleted_at is
  '轮 285 软删标记：作者删自己的评论时写入。行保留（on delete cascade 因此不触发，二级回复活下来），正文留库供审计/恢复；界面渲染成「该评论已删除」占位。';

-- 2) 删评论 RPC —— security definer：
--    wall_comments 只有 select / insert / delete 策略，**没有 update 策略**（RLS 对未定义的操作一律拒绝）；
--    照本仓库一贯做法把写路径收口到函数里，函数内仍按 auth.uid() 卡「只能删自己的」，
--    口径与原策略 "comments delete own" 完全一致。
create or replace function public.wall_comment_delete(p_id bigint)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
begin
  update public.wall_comments
     set deleted_at = now()
   where id = p_id
     and user_id = auth.uid()        -- 本人（未登录时 auth.uid() 为空 → 改不到任何行 → 返回 false）
     and deleted_at is null;         -- 幂等：已经删过的不再动
  get diagnostics n = row_count;
  return n > 0;
end;
$$;

-- 3) 只授给「能带用户 JWT」的两个角色（表本身 RLS 开着，函数按 auth.uid() 把关）
revoke all on function public.wall_comment_delete(bigint) from public;
grant execute on function public.wall_comment_delete(bigint) to anon, authenticated;

-- 4) 计数口径（本轮**未**改动，记录在这里以免后人以为是 bug）：
--    MIGRATION_wall_feed_page.sql / MIGRATION_wall_search.sql 的「每帖评论条数」聚合，
--    以及 worker/api.js 的 listCommentPostIds，仍然按表内**全部行**计（含软删行）；
--    前端点开评论明细后改按明细口径（不含软删行）显示。
--    差值 = 该帖被软删的条数，小社区量级可忽略；要彻底对齐得改那三处计数
--    （其中两个是整函数 create or replace，会跟原迁移文件产生两份定义，权衡后本轮不做）。
