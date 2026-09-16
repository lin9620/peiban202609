-- ═══════════════════════════════════════════════════════════════
--  Warm Paws · 暖爪 — 增量迁移：评论改为二级（回复）结构
--  用途：**已经建过库**的用户，只需在 Supabase → SQL Editor 里跑这一份
--        （新库不用管：直接用 SUPABASE_SETUP.sql 建库即为二级结构）
--  幂等：可重复执行，已迁移过再跑不会有副作用
-- ═══════════════════════════════════════════════════════════════

-- 1) 补两列：parent_id（挂在哪条一级评论下）、reply_to_name（二级里 @谁）
alter table public.wall_comments add column if not exists parent_id     bigint;
alter table public.wall_comments add column if not exists reply_to_name text;

-- 2) 自关联外键 + 级联删除：删掉一级评论，它下面的回复自动一起删
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'wall_comments_parent_id_fkey'
      and conrelid = 'public.wall_comments'::regclass
  ) then
    alter table public.wall_comments
      add constraint wall_comments_parent_id_fkey
      foreign key (parent_id) references public.wall_comments (id) on delete cascade;
  end if;
end $$;

-- 3) 查询索引：按帖拉评论、按一级评论数回复都用得上
create index if not exists wall_comments_post_idx   on public.wall_comments (post_id);
create index if not exists wall_comments_parent_idx on public.wall_comments (parent_id);

-- 4) 旧数据无需回填：parent_id 为 null 的行本身就是一级评论，前端照常显示
--    校验：应输出 0 行（没有指向不存在父评论的悬挂数据）
-- select count(*) from public.wall_comments c
--   where c.parent_id is not null
--     and not exists (select 1 from public.wall_comments p where p.id = c.parent_id);

-- 完成 ✅ 前端刷新后即生效：评论数进页面就有值，一级评论下可「回复」