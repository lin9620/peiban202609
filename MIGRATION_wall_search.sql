-- ═══════════ 轮 252 · 暖心墙搜索 + 标签 + 图片尺寸 ═══════════
-- wall_posts 加三列（全部幂等，已有库重复执行无副作用）：
--   tags text[]        发帖时从正文解析的 #xxx# 标签（最多 5 个，见 wallRules.extractTags）
--   img_w / img_h int  发帖时图片的 naturalWidth/Height（渲染时 aspect-ratio 预留高度）
alter table public.wall_posts add column if not exists tags text[] not null default '{}';
alter table public.wall_posts add column if not exists img_w int;
alter table public.wall_posts add column if not exists img_h int;

-- 标签 GIN 索引（&& / @> 查询走索引）
create index if not exists wall_posts_tags_gin on public.wall_posts using gin (tags);
-- 正文三元组索引（ilike 模糊搜走索引；pg_trgm 扩展）
create extension if not exists pg_trgm;
create index if not exists wall_posts_body_trgm on public.wall_posts using gin (body gin_trgm_ops);

-- 搜索 RPC（复用 feed 的聚合形状，一次出合并包）：
--   p_q      关键词（正文 ilike %q%，空串 = 不筛正文）
--   p_tags   标签数组（帖 tags 与之有交集；空数组 = 不筛标签）
--   p_limit  条数；p_before id 游标（0 = 第一页，分页用 id < p_before 倒序）
-- 口径与 wall_feed_page 一致：removed=false 可见 + 回应计数 + 我的回应 + 评论数。
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
  select coalesce(jsonb_object_agg(
           a.post_id,
           jsonb_build_object('hug', a.hug, 'warm', a.warm, 'relate', a.relate, 'mine', a.mine)
         ), '{}'::jsonb),
         coalesce(jsonb_object_agg(b.post_id, b.cmt), '{}'::jsonb)
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
      group by c.post_id
    ) b on b.post_id = pool.id;
  return jsonb_build_object('posts', v_posts, 'react', v_react, 'comment', v_comment);
end;
$$;

grant execute on function public.wall_search_posts(text, text[], int, bigint) to anon, authenticated;
