-- ============================================================
-- 迁移：暖心墙每日发帖上限 1 → 7（与前端 wallRules.WALL_POST_DAILY_LIMIT = 7 同步）
-- ------------------------------------------------------------
-- 背景：旧版「每天最多一条」由触发器 wall_daily_limit + 唯一索引
--       wall_posts_one_per_day_idx 双保险实现。
-- 用户反馈：改成每天最多 7 条。
-- 前置：已执行 MIGRATION_wall_daily_view_dislike.sql；幂等，可重复执行。
-- 前端（src/utils/wallRules.js）已经把计数口径换成 7，这里把数据库拦子上调，
-- 并把唯一索引拆掉（索引还按 (user_id, created_day) 唯一的话，第 2 条起全被打回）。
-- 用法：Supabase Dashboard → SQL Editor → 粘贴全部 → Run
-- ============================================================
begin;

-- 1) 触发器改成按 7 条计数
create or replace function public.wall_daily_limit()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (
    select count(*) from public.wall_posts p
    where p.user_id = new.user_id and p.created_day = new.created_day
  ) >= 7 then
    -- 固定暗号不变：前端 wallRules.errorKind 靠它显示「今天发满了」
    raise exception 'wall_daily_limit' using errcode = 'P0001',
      hint = '每个用户每天最多发 7 条暖心墙内容';
  end if;
  return new;
end $$;

-- 2) 拆掉「一天一条」唯一索引（存在才拆，幂等）
drop index if exists public.wall_posts_one_per_day_idx;

commit;

-- ============================================================
-- 执行完毕。无需其它步骤；前端与数据库现在同口径：每天 7 条。
-- ============================================================
