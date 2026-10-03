-- ═══════════ 轮 170 · 热路径补索引 ═══════════
-- 1) wall_reactions 此前一个索引都没有：每次刷新/进详情/点回应都要按 post_id 查这张表，
--    数据量上来后是裸表扫。回应明细按帖聚合是最高频读路径 → post_id 单列索引；
--    「我点过哪些」判定（user_id + post_id）走复合索引。
-- 2) wall_posts(user_id, created_at desc)：他人主页 / 我的帖子 按作者拉帖（user_id=eq + created_at 倒序），
--    此前只有全表 created_at 索引，按人查要过滤全表。
-- 全部 IF NOT EXISTS，可重复执行。

create index if not exists wall_reactions_post_idx
  on public.wall_reactions (post_id);

create index if not exists wall_reactions_user_post_idx
  on public.wall_reactions (user_id, post_id);

create index if not exists wall_posts_user_idx
  on public.wall_posts (user_id, created_at desc);
