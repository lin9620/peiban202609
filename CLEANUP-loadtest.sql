-- ═══════════════════════════════════════════════════════════════
--  压测数据清理（测完「刷新功能」后由用户在 SQL Editor 执行；幂等可重跑）
--  作用：把压测帖（作者 = wp-load-* 测试号）整批**下架**（removed=true，假删除、
--        可恢复），压测评论**隐藏**（hidden=true）——不物理删除，后悔还有救。
--  范围：author 邮箱前缀 wp-load- 的全部测试号（含历次灌注，含只注册没发帖的空号——空号不影响）。
--  执行后：墙上不再显示这些帖/评；要彻底清掉需要 service_role 物理删除（不提供，防误伤）。
-- ═══════════════════════════════════════════════════════════════

-- 1) 下架压测帖
update public.wall_posts p
   set removed = true
  where p.user_id in (
    select u.id from auth.users u where u.email like 'wp-load-%'
  )
  and p.removed is not true;

-- 2) 隐藏压测评论
update public.wall_comments c
   set hidden = true, hidden_at = now()
  where c.user_id in (
    select u.id from auth.users u where u.email like 'wp-load-%'
  )
  and c.hidden is not true;

-- 3) 核对（应各返回 0 或极小值 = 清理干净）
select count(*) as remaining_visible_posts
  from public.wall_posts p
 where p.user_id in (select u.id from auth.users u where u.email like 'wp-load-%')
   and p.removed is not true;

select count(*) as remaining_visible_comments
  from public.wall_comments c
 where c.user_id in (select u.id from auth.users u where u.email like 'wp-load-%')
   and c.hidden is not true;
