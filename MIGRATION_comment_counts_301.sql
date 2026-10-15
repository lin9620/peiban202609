-- ═══════════ 轮 301 · 评论计数口径对齐（软删行不计） ═══════════
-- 背景：轮 285 删评论改软删（deleted_at 置位、行保留），但计数没跟上——
--   wall_feed_page / wall_search_posts 的评论聚合仍 count(*) 全量，
--   前端点开明细后按 liveComments()（剔软删）显示 → 「标题 5 条、点开 3 条」。
-- 本迁移：两处聚合加 deleted_at is null，与渲染口径一致。
-- 幂等：create or replace，只换函数体，不动表、不动数据；执行权在用户（SQL Editor 跑一份）。
-- 未跑本迁移 = 老行为（标题数偏大，不挡用）；跑了 = 标题与明细一致。
-- 同源：SUPABASE_SETUP.sql 内同名两函数已同步改（新库建出来即对齐）。
--
-- ① wall_feed_page(p_limit)：评论聚合剔软删行（其余与 MIGRATION_wall_feed_page.sql 修后版一致）

--   生产实测 POST /rest/v1/rpc/wall_feed_page → 400 / 22023）。
--   本文件是修好后的版本，**原样重跑一次即可替换**：
--   create or replace function 只换函数体，不动表、不动数据、不动别的函数。
--   跑完后刷新会第一次真正走「最新 4 条钉顶 + 随机换一批」的合并包，
--   前端不用改任何代码（现在那条回退链路会自然失效）。
-- ─────────────────────────────────────────────────────────────────────────────

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
  --
  -- ⚠ 轮 295 修复（生产实测 400 / code 22023「field name must not be null」）：
  --   a.post_id、b.post_id 是 LEFT JOIN 出来的**可空列**。一条帖只要没有任何回应或评论，
  --   它就是 NULL —— 而 jsonb_object_agg 拿 NULL 当字典键会直接抛错，于是**整个函数失败**。
  --   外面那层 coalesce(..., '{}') 救不了：它包的是聚合的「结果」，可聚合在出结果之前就炸了。
  --   墙上绝大多数帖都是 0 回应 0 评论 → 本函数基本必炸。
  --   后果：前端每次刷新都回退到「只拉最新页」，轮 169/170 的「随机换一批 + 合并包」一直静默失效，
  --         且每次白等一次往返才兜底（生产实测该 RPC 烧掉 2.3s）。
  --   修法：给两个 jsonb_object_agg 各加 filter —— NULL 键根本不进聚合，也就无从抛错；
  --         没有匹配行时 coalesce 照旧给 {}，语义与「有回应/有评论时照常出包」完全一致。
  select coalesce(jsonb_object_agg(
           a.post_id,
           jsonb_build_object('hug', a.hug, 'warm', a.warm, 'relate', a.relate, 'mine', a.mine)
         ) filter (where a.post_id is not null), '{}'::jsonb),
         coalesce(jsonb_object_agg(b.post_id, b.cmt)
                  filter (where b.post_id is not null), '{}'::jsonb)
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
        and c.deleted_at is null
      group by c.post_id
    ) b on b.post_id = pool.id;

  return jsonb_build_object('latest', v_latest, 'random', v_random, 'react', v_react, 'comment', v_comment);
end;
$$;

grant execute on function public.wall_feed_page(int) to anon, authenticated;

-- ② wall_search_posts：评论聚合剔软删行（与上面同口径；其余与 MIGRATION_wall_search.sql 一致）
-- 口径与 wall_feed_page 一致：removed=false 可见 + 回应计数 + 我的回应 + 评论数（轮 301：软删不计）。
create or replace function public.wall_search_posts(p_q text default '', p_tags text[] default '{}', p_limit int default 20, p_before bigint default 0)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_ids     bigint[];
  v_posts   jsonb;
  v_react   jsonb;
  v_comment jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', t.id, 'user_id', t.user_id, 'author_name', t.author_name,
           'body', t.body, 'image_path', t.image_path, 'created_at', t.created_at,
           'views', t.views, 'dislikes', t.dislikes, 'removed', false,
           'tags', coalesce(t.tags, '{}'), 'img_w', t.img_w, 'img_h', t.img_h
         ) order by t.id desc), '[]'::jsonb),
         coalesce(array_agg(t.id), '{}'::bigint[])
    into v_posts, v_ids
    from (
      select id, user_id, author_name, body, image_path, created_at, views, dislikes, tags, img_w, img_h
      from wall_posts
      where removed = false
        and (p_before <= 0 or id < p_before)
        and (p_q is null or p_q = '' or body ilike '%' || p_q || '%')
        and (coalesce(array_length(p_tags, 1), 0) = 0 or tags && p_tags)
      order by id desc
      limit greatest(p_limit, 1)
    ) t;
  -- 轮 295 修法见上；轮 301：评论聚合加 deleted_at is null（软删不计，与渲染口径一致）。
  select coalesce(jsonb_object_agg(
           a.post_id,
           jsonb_build_object('hug', a.hug, 'warm', a.warm, 'relate', a.relate, 'mine', a.mine)
         ) filter (where a.post_id is not null), '{}'::jsonb),
         coalesce(jsonb_object_agg(b.post_id, b.cmt)
                  filter (where b.post_id is not null), '{}'::jsonb)
    into v_react, v_comment
    from (
      select p.id
      from (select unnest(v_ids) as id) u
      join wall_posts p on p.id = u.id and p.removed = false
    ) pool
    left join (
      select r.post_id,
             count(*) filter (where r.kind = 'hug')    as hug,
             count(*) filter (where r.kind = 'warm')   as warm,
             count(*) filter (where r.kind = 'relate') as relate,
             coalesce(jsonb_object_agg(r.kind, true) filter (where r.user_id = auth.uid()), '{}'::jsonb) as mine
      from wall_reactions r
      where r.post_id in (select id from (select unnest(v_ids) as id) u)
      group by r.post_id
    ) a on a.post_id = pool.id
    left join (
      select c.post_id, count(*) as cmt
      from wall_comments c
      where c.post_id in (select id from (select unnest(v_ids) as id) u)
        and c.deleted_at is null
      group by c.post_id
    ) b on b.post_id = pool.id;
  return jsonb_build_object('posts', v_posts, 'react', v_react, 'comment', v_comment);
end;
$$;

grant execute on function public.wall_search_posts(text, text[], int, bigint) to anon, authenticated;
