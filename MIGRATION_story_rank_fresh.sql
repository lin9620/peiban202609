-- ─────────────────────────────────────────────────────────────
-- 轮 443 · 故事推荐榜：把「硬 30 天窗口」改成「阶梯放宽」
--
-- 问题：MIGRATION_story.sql 起 random 模式就硬卡
--         `s.published_at > now() - interval '30 days'`
--       内容少的时候（线上 15 篇里 3 篇超 30 天）这个条件不是「挑新的」，
--       而是直接把老内容从池子里删掉 —— 池子缩小到一页时「换一批」就翻空。
--       用户的要求很明确：**30 天优先，没有内容了就继续往后放宽**。
--
-- 改法：不加时间过滤，改成给每篇打一个「新鲜度档位」当第一排序键，
--       同档内再按质量加权随机（沿用原口径）。效果是：
--         · 30 天内有内容 → 它们永远排在最前面（新内容优先不变）；
--         · 30 天内不够 → 自动用 90 天内的补，再不够用一年内、再不够用更早的；
--         · 永远拿得到内容，除非整张表一条 published 都没有。
--
-- 顺带修的：质量分 q 对「零赞零浏览且超过 30 天」的老内容是 0（时间衰减项被
--       greatest(0,...) 截断），若仍用 `q * random()` 排序，这些行会全部并列 0，
--       分页时顺序不确定 → 翻页可能重复或漏掉。改成 `(q + 1) * random()`，
--       让基线为 0 的内容也有随机权重，分页是稳的。
--
-- 只动 random 分支。latest / monthly / tag 三种与原文逐字一致。
-- 返回类型没变 → 可以用 create or replace（能保住 grant，不必再补权限）。
-- 幂等：可重复执行。
-- 回滚：把 random 分支的 tier 列与 `order by p.tier, (q+1)*random()` 换回
--       `where published_at > now() - interval '30 days'` + `order by q*random()`；
--       注意 MIGRATION_content_lang.sql 的 ⑧ 节已同步成新逻辑，不能靠重跑它回滚。
-- ─────────────────────────────────────────────────────────────

create or replace function public.story_rank(
  p_mode text default 'random', p_tag text default null,
  p_period text default null, p_limit integer default 20, p_offset integer default 0
) returns table (id bigint, user_id uuid, nickname text, title text, tags text[], like_count integer,
                 view_count integer, word_count integer, read_minutes integer,
                 published_at timestamptz, score numeric, lang text)
language plpgsql security definer set search_path = public as $$
declare
  v_period text := coalesce(p_period, to_char(now(), 'YYYY-MM'));
  v_seed bigint := floor(extract(epoch from now()) / 300)::bigint; -- 5 分钟一换批
begin
  if p_mode not in ('random', 'latest', 'monthly', 'tag') then raise exception 'story-bad-mode'; end if;

  if p_mode = 'random' then
    perform setseed(((v_seed % 1000)::double precision / 1000.0) - 0.5); -- 确定性种子：同窗口内结果稳定
    return query
    with pool as (
      select s.*,
             (select pr.nickname from public.profiles pr where pr.id = s.user_id) as nickname,
             (s.like_count * 0.6 + s.view_count * 0.3
              + 10.0 * greatest(0, 1 - extract(epoch from (now() - s.published_at)) / 2592000)) as q,
             /* 轮 443：阶梯新鲜度 —— 0 = 30 天内，1 = 90 天内，2 = 一年内，3 = 更早。
                分档代替过滤：新内容永远优先，池子不够时逐级往后放宽，不会给出空榜。 */
             case
               when s.published_at > now() - interval '30 days'  then 0
               when s.published_at > now() - interval '90 days'  then 1
               when s.published_at > now() - interval '365 days' then 2
               else 3
             end as tier
        from public.stories s
       where s.status = 'published'
         and (p_tag is null or s.tags && array[p_tag])
    )
    select p.id, p.user_id, p.nickname, p.title, p.tags, p.like_count, p.view_count,
           p.word_count, p.read_minutes, p.published_at, p.q, p.lang
      from pool p
     /* tier 升序 = 新的在前；(q+1) 而非 q：老内容时间衰减被截断成 0，
        直接用 q 会让它们整档并列 0、分页顺序漂移（翻页重复/漏条）。 */
     order by p.tier, (p.q + 1) * (0.5 + random()) desc
     limit greatest(p_limit, 1) offset greatest(coalesce(p_offset, 0), 0);

  elsif p_mode = 'latest' then
    return query
    select s.id, s.user_id,
           (select pr.nickname from public.profiles pr where pr.id = s.user_id),
           s.title, s.tags, s.like_count, s.view_count,
           s.word_count, s.read_minutes, s.published_at, 0::numeric, s.lang
      from public.stories s
     where s.status = 'published' and (p_tag is null or s.tags && array[p_tag])
     order by s.published_at desc, s.id desc
     limit greatest(p_limit, 1) offset greatest(coalesce(p_offset, 0), 0);

  elsif p_mode = 'monthly' then
    return query
    select s.id, s.user_id,
           (select pr.nickname from public.profiles pr where pr.id = s.user_id),
           s.title, s.tags, s.like_count, s.view_count,
           s.word_count, s.read_minutes, s.published_at,
           count(l.user_id)::numeric as mlikes, s.lang
      from public.stories s
      join public.story_likes l on l.story_id = s.id
     where s.status = 'published'
       and to_char(l.created_at, 'YYYY-MM') = v_period
       and (p_tag is null or s.tags && array[p_tag])
     group by s.id
     order by mlikes desc, s.published_at desc
     limit greatest(p_limit, 1) offset greatest(coalesce(p_offset, 0), 0);

  else -- tag：热门标签云榜（按标签聚合的当期赞数+篇数，前端选标签后再拉该标签故事）
    return query
    select 0::bigint as id, '00000000-0000-0000-0000-000000000000'::uuid as user_id,
           null::text as nickname,
           t as title, array[t] as tags, sum(s.like_count)::integer as like_count,
           count(*)::integer as view_count, 0 as word_count, 0 as read_minutes,
           max(s.published_at) as published_at,
           count(l.user_id)::numeric,
           null::text as lang
      from public.stories s
      cross join lateral unnest(s.tags) t
      left join public.story_likes l on l.story_id = s.id
       and to_char(l.created_at, 'YYYY-MM') = v_period
     where s.status = 'published'
     group by t
     -- 排序列必须用限定名/别名：裸 score 会被 plpgsql 当 OUT 变量替换（NULL，排序静默失效）
     order by count(l.user_id) desc, count(*) desc, t
     limit greatest(p_limit, 1) offset greatest(coalesce(p_offset, 0), 0);
  end if;
end $$;

-- ── 自检 ──
-- 第 1 行应该 = 12（第一页满：池子已经能跨过 30 天边界补位，不再是 12 条卡死）；
-- 第 2、3 行应该**相等**（全量拉取时不再被 30 天窗口截掉，老故事也在池子里）。
select count(*) as 推荐第一页条数 from public.story_rank('random', null, null, 12, 0);
select count(*) as 推荐全量条数 from public.story_rank('random', null, null, 100000, 0);
select count(*) as published总数 from public.stories where status = 'published';
