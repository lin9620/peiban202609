-- ═══════════════════════════════════════════════════════════════
--  Warm Paws · 暖爪 — 增量迁移：写入首位管理员
--  用法：Supabase Dashboard → SQL Editor → 粘贴全部 → Run
--  前提：库中已有 is_admin() / admin_users（MIGRATION_admin.sql 或 SUPABASE_SETUP.sql 的 8) 段）
--  幂等：可重复执行；成功后「我的」页出现管理中心入口（需刷新页面重判）
-- ═══════════════════════════════════════════════════════════════

-- 方式一（推荐）：按昵称定位（已探明 linyi 的 user_id，直接写死更稳）
insert into public.admin_users (user_id)
select id from public.profiles where nickname = 'linyi'
on conflict (user_id) do nothing;

-- 方式二（备选）：按注册邮箱定位（邮箱改动时用这个）
-- insert into public.admin_users (user_id)
-- select id from auth.users where email = 'linyi0123456@outlook.com'
-- on conflict (user_id) do nothing;

-- 验证（应返回 1 行，user_id = 37417df6-7531-434f-94e9-e7c0eb763413）：
-- select * from public.admin_users;

-- 完成 ✅ 回到网站刷新页面 → 「我的」页出现「管理中心」入口
