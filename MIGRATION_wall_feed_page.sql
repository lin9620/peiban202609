-- ═══════════ 轮 170 · 暖心墙 feed 单查询 RPC ═══════════
-- wall_feed_page(p_limit)：一次 SQL 拿「最新页 + 7 天随机批 + 每帖回应计数 + 我的回应 + 评论数」。
-- 之前：客户端/Worker 要打 4 个查询（最新页→回应明细→随机批→评论 post_id 行）再端上聚合；
-- 现在：SQL 内 CTE + GROUP BY 聚合后 JOIN 回帖子行（JOIN 代替逐行子查询），一个查询出整个合并包。
-- 口径与旧链路一致：
--   * removed = false 才可见（下架帖不出）；
--   * 最新页 = 按 id 倒序（id 串行 = 发布序，轮 62 keyset 同源）；
--   * 随机批 = 7 天池内 random() 抽样，不含最新页已有的帖；
--   * 厌恶数用权威列 wall_posts.dislikes（回应行聚合仅作旧库回退，见 rowsToPosts）；
--   * 评论数 = 该帖全部评论行（与 listCommentPostIds 现口径一致，不过滤 removed）；
--   * 匿名调用 auth.uid() 为空 → mine 为空对象，计数照常。
-- 安全：security definer 只为跨行聚合；查询固定 removed=false、只读、参数只有条数。

create or replace function public.wall_feed_page(p_limit int default 20)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_ids   bigint[];
  v_rnd   bigint[];
  v_latest jsonb;
  v_random jsonb;
  v_react  jsonb;
  v_comment jsonb;
begin
  -- ① 最新页（id 倒序 = 发布序），行 + id 数组一次取出
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', t.id, 'user_id', t.user_id, 'author_name', t.author_name,
           'body', t.body, 'image_path', t.image_path, 'created_at', t.created_at,
           'views', t.views, 'dislikes', t.dislikes, 'removed', false
         ) order by t.id desc), '[]'::jsonb),
         coalesce(array_agg(t.id), '{}'::bigint[])
    into v_latest, v_ids
    from (
      select id, user_id, author_name, body, image_path, created_at, views, dislikes
      from wall_posts
      where removed = false
      order by id desc
      limit greatest(p_limit, 1)
    ) t;

  -- ② 7 天池随机批（排除最新页已有的帖）
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', t.id, 'user_id', t.user_id, 'author_name', t.author_name,
           'body', t.body, 'image_path', t.image_path, 'created_at', t.created_at,
           'views', t.views, 'dislikes', t.dislikes, 'removed', false
           ) order by t.ord), '[]'::jsonb),
         coalesce(array_agg(t.id), '{}'::bigint[])
    into v_random, v_rnd
    from (
      select id, user_id, author_name, body, image_path, created_at, views, dislikes,
             row_number() over () as ord
      from wall_posts
      where removed = false
        and created_at > now() - interval '7 days'
        and not (id = any(v_ids))
      order by random()
      limit greatest(p_limit, 1)
    ) t;

  -- ③ 回应计数（按 kind 分组 JOIN）+ 我的回应；评论数——全部对并集一次聚合
  select coalesce(jsonb_object_agg(
           a.post_id,
           jsonb_build_object('hug', a.hug, 'warm', a.warm, 'relate', a.relate, 'mine', a.mine)
         ), '{}'::jsonb),
         coalesce(jsonb_object_agg(b.post_id, b.cmt), '{}'::jsonb)
    into v_react, v_comment
    from (
      select p.id
      from (select unnest(v_ids) as id union select unnest(coalesce(v_rnd, '{}'::bigint[])) as id) u
      join wall_posts p on p.id = u.id and p.removed = false
    ) pool
    left join (
      select r.post_id,
             count(*) filter (where r.kind = 'hug')    as hug,
             count(*) filter (where r.kind = 'warm')   as warm,
             count(*) filter (where r.kind = 'relate') as relate,
             coalesce(jsonb_object_agg(r.kind, true) filter (where r.user_id = auth.uid()), '{}'::jsonb) as mine
      from wall_reactions r
      where r.post_id in (select id from (select unnest(v_ids) as id union select unnest(coalesce(v_rnd, '{}'::bigint[])) as id) u)
      group by r.post_id
    ) a on a.post_id = pool.id
    left join (
      select c.post_id, count(*) as cmt
      from wall_comments c
      where c.post_id in (select id from (select unnest(v_ids) as id union select unnest(coalesce(v_rnd, '{}'::bigint[])) as id) u)
      group by c.post_id
    ) b on b.post_id = pool.id;

  return jsonb_build_object('latest', v_latest, 'random', v_random, 'react', v_react, 'comment', v_comment);
end;
$$;

grant execute on function public.wall_feed_page(int) to anon, authenticated;
