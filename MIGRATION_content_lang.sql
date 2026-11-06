-- ══════════ 轮 439 · 内容语言标记 ══════════
-- 背景：加西语/葡语/法语界面，并给用户一个「优先看我这种语言的内容」开关。
-- 要做到这件事，必须先知道**每条内容本身是什么语言**。
--
-- 三个刻意的设计选择：
--  ① 这个字段记录的是**文本本身的语言**，不是作者的界面语言。
--     中文界面用户发英文暖心墙帖子，标的是 en —— 因为读它的人在意的是内容写的是什么话。
--  ② 允许 'und'（undetermined）。检测不出来就说不出来，不要硬猜。
--     错标的代价是把内容塞给不该看的读者；不标只是不参与过滤。
--  ③ 语言偏好**不存数据库**，只存客户端本地。
--     它是设备级的内容偏好（这台手机想先看西语），跨设备同步没有意义，
--     存进来反而要多一层读写和冲突处理。
--
-- 幂等：全部 if not exists / drop + create，可重复执行。
-- 回滚：drop column lang（三张表）、drop index；bottle_fish/bottle_send/story_publish
-- 重跑各自的原始迁移文件即可（⑥⑦ 只多了可选参数，旧签名调用照旧）；
-- story_rank 需重跑 MIGRATION_story.sql 恢复不带 lang 的版本（列序只多一列在末尾，回滚也不会错位）。

-- ── ① 三张内容表加列 ──
alter table public.wall_posts     add column if not exists lang text not null default 'und';
alter table public.bottle_letters add column if not exists lang text not null default 'und';
alter table public.stories        add column if not exists lang text not null default 'und';

-- 只允许检测器会吐出来的值。ja/ko 目前产品不支持，但检测器靠字符集能认出来，
-- 留着这两个值，以后上日语不用改约束。
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'wall_posts_lang_chk') then
    alter table public.wall_posts add constraint wall_posts_lang_chk
      check (lang in ('zh', 'en', 'es', 'pt', 'fr', 'ja', 'ko', 'und'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'bottle_letters_lang_chk') then
    alter table public.bottle_letters add constraint bottle_letters_lang_chk
      check (lang in ('zh', 'en', 'es', 'pt', 'fr', 'ja', 'ko', 'und'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'stories_lang_chk') then
    alter table public.stories add constraint stories_lang_chk
      check (lang in ('zh', 'en', 'es', 'pt', 'fr', 'ja', 'ko', 'und'));
  end if;
end $$;

-- ── ② 索引：过滤都是「某语言 + 时间倒序」，联合索引才对得上 ──
create index if not exists wall_posts_lang_idx
  on public.wall_posts (lang, created_at desc);
create index if not exists bottle_letters_lang_idx
  on public.bottle_letters (lang, created_at desc) where status = 'sea';
create index if not exists stories_lang_idx
  on public.stories (lang, published_at desc) where status = 'published';

-- ── ③ 存量回填：中文用 SQL 直接判 ──
-- 汉字范围一匹配就是中文，不需要跑检测器。线上 536 条里 530 条走这条路径。
-- 剩下的（纯数字、键盘乱敲）保持 und —— 它们本来就判不出来。
-- 非中文的存量内容（目前为 0）留给 tools/backfill-lang.mjs，那个脚本用的是
-- 完整规则（变音符号 + 形态 + 功能词），比 SQL 正则准得多。
update public.wall_posts     set lang = 'zh' where lang = 'und' and body ~ '[一-龥]';
update public.bottle_letters set lang = 'zh' where lang = 'und' and body ~ '[一-龥]';
update public.stories        set lang = 'zh' where lang = 'und' and (title || ' ' || body) ~ '[一-龥]';

-- ── ④ 先清掉旧签名的两个函数 ──
-- 为什么要删：PG 选函数是「按参数类型精确匹配」优先。只 create or replace 的话，
-- 零参的旧 bottle_fish() 会继续存在，客户端发 rpc('bottle_fish') 命中旧函数，
-- 新加的语言参数永远不生效 —— 迁移看起来成功，功能一点没变。
-- 用 DO 块遍历而不是 `drop function f()`：既避开重载二义性，也保证重复执行不报错。
do $$
declare r text;
begin
  for r in
    select p.oid::regprocedure::text
      from pg_proc p
     where p.proname in ('bottle_fish', 'bottle_send', 'story_publish')
       and p.pronamespace = 'public'::regnamespace
  loop
    execute 'drop function ' || r;
  end loop;
end $$;

-- ── ⑤ 捞瓶 RPC 支持按语言优先 ──
-- 基线是 MIGRATION_bottle_quota_fishfix.sql 那一版（随机挑 → 条件更新抢锁 → 换一封重试 3 次 →
-- 捞信日志 on conflict do nothing），**并发防护一字不改**，只把「挑哪一封」的条件换成两轮：
--   pass 1 只在本语言池里挑；pass 2 退回全语言。
-- 关键：**必须退回**。库里 99% 是中文，西语用户严格只捞西语会直接
-- 报 bottle-empty-sea —— 那等于把「捞一个」关掉了。所以这里只做「优先」，不做「过滤」。
create or replace function public.bottle_fish(p_lang text default null)
returns public.bottle_letters
language plpgsql security definer set search_path = public as $$
declare
  v_count int;
  v_row   public.bottle_letters;
  v_lang  text;
  v_pass  int;
  v_from  int;
  i       int;
begin
  if auth.uid() is null then raise exception 'bottle-auth'; end if;
  /* 捞起超 48h 未处理的信先放回海里（不让信卡死在谁手里） */
  update public.bottle_letters set status = 'sea', holder = null, held_at = null
    where status = 'held' and held_at < now() - interval '48 hours';
  select count(*) into v_count from public.bottle_fishes
    where user_id = auth.uid() and day = (now() at time zone 'utc')::date;
  if v_count >= 7 then raise exception 'bottle-limit-fish'; end if;

  /* 用户偏好为「全部」时没有 pass 1，直接全语言 */
  v_lang := case when p_lang in ('zh','en','es','pt','fr','ja','ko') then p_lang else null end;
  v_from := case when v_lang is null then 2 else 1 end;

  for v_pass in v_from..2 loop
    /* 随机挑一封 → 条件更新抢占（只在仍是 sea 时成立）。别人同一瞬间捞走同一封
       → 命中 0 行 → 换一封重试；重试 3 次仍落空 → 进下一 pass */
    for i in 1..3 loop
      select * into v_row from public.bottle_letters
        where status = 'sea' and user_id <> auth.uid()
          and (v_pass = 2 or lang = v_lang)
        order by random() limit 1;
      if not found then exit; end if;   -- 本池空 → 下一 pass
      update public.bottle_letters set status = 'held', holder = auth.uid(), held_at = now()
        where id = v_row.id and status = 'sea'
        returning * into v_row;
      if found then
        /* 捞信日志：同一封当天放回再捞不重复计数、不报错（放回→再捞同一封会撞
           (user_id, day, letter_id) 唯一键——线上老版在这里炸 23505，用户看到报错） */
        insert into public.bottle_fishes (user_id, day, letter_id)
          values (auth.uid(), (now() at time zone 'utc')::date, v_row.id)
          on conflict (user_id, day, letter_id) do nothing;
        return v_row;
      end if;
    end loop;
  end loop;
  raise exception 'bottle-empty-sea';
end $$;

-- ── ⑥ 发信 RPC 接受语言 ──
-- 基线是 MIGRATION_bottle_fair_quota.sql 那一版（advisory lock + body_hash 去重 + 滚动 24h/5 封），
-- 只在末尾加一个可选 p_lang，**其余逻辑一字不改** —— 覆盖掉配额逻辑会让刷海防护失效。
-- p_lang 走默认值，旧客户端照旧只传 p_body 也能调（旧签名已在 ④ 里删掉）。
create or replace function public.bottle_send(p_body text, p_lang text default null)
returns public.bottle_letters
language plpgsql security definer set search_path = public as $$
declare
  v_count int;
  v_hash  text;
  v_row   public.bottle_letters;
begin
  if auth.uid() is null then raise exception 'bottle-auth'; end if;
  /* 同一用户的额度检查串行化：并发双击/多端同时投捞也不会把 30 瓶刷成 31 瓶 */
  perform pg_advisory_xact_lock(411, hashtext(auth.uid()::text));

  p_body := btrim(coalesce(p_body, ''));
  if char_length(p_body) < 10 then raise exception 'bottle-too-short'; end if;
  if char_length(p_body) > 1000 then raise exception 'bottle-too-long'; end if;

  v_hash := md5(lower(p_body));

  /* 同一用户 24h 内不能重复发同一段内容（防止复制粘贴刷海） */
  if exists (
    select 1 from public.bottle_letters
     where user_id = auth.uid()
       and body_hash = v_hash
       and created_at > now() - interval '24 hours'
  ) then
    raise exception 'bottle-duplicate';
  end if;

  /* 滚动 24h，不再按 UTC 自然日 */
  select count(*) into v_count
    from public.bottle_letters
   where user_id = auth.uid()
     and created_at > now() - interval '24 hours';
  if v_count >= 5 then raise exception 'bottle-limit-send'; end if;

  insert into public.bottle_letters (user_id, nickname, body, body_hash, lang)
    values (auth.uid(),
            coalesce((select nickname from public.profiles where id = auth.uid()), ''),
            p_body,
            v_hash,
            case when p_lang in ('zh','en','es','pt','fr','ja','ko','und') then p_lang else 'und' end)
    returning * into v_row;
  return v_row;
end $$;

-- ── ⑦ 故事发布接收语言 ──
-- 基线是 MIGRATION_story.sql 的 story_publish（标题/正文/标签校验、字数、阅读时长、
-- rev+1、published_at 幂等），**校验逻辑一字不改**，只在 insert/update 多写一列 lang。
-- 客户端不传 p_lang 时用汉字正则兜底（故事是长文，≥100 字，判中文几乎不会错）。
create or replace function public.story_publish(
  p_id bigint, p_title text, p_body text, p_tags text[] default '{}', p_lang text default null
) returns setof public.stories language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  v_tags text[];
  v_words integer;
  v_lang text;
  rec public.stories%rowtype;
begin
  if me is null then raise exception 'story-auth'; end if;
  if p_title is null or char_length(trim(p_title)) = 0 or char_length(p_title) > 100 then
    raise exception 'story-bad-title';
  end if;
  if p_body is null or char_length(p_body) = 0 or char_length(p_body) > 30000 then
    raise exception 'story-too-long';
  end if;
  -- 正文下限 100 字（只卡发布；草稿 story_save_draft 不受此限）。
  -- 注意：刻意不动表上的 check (char_length(body) between 1 and 30000) ——
  -- 库里可能有 <100 字的存量故事，改约束会让它们一被编辑就撞约束报错。
  if char_length(p_body) < 100 then
    raise exception 'story-too-short';
  end if;
  select coalesce(array_agg(distinct lower(trim(x))) filter (where length(trim(x)) between 1 and 20), '{}')
    into v_tags from unnest(coalesce(p_tags, '{}')) x;
  if array_length(v_tags, 1) is null or array_length(v_tags, 1) > 3 then
    raise exception 'story-bad-tags';
  end if;
  v_words := char_length(p_body);

  /* 语言：优先用客户端检测结果，没传则按汉字正则兜底 */
  v_lang := case
    when p_lang in ('zh','en','es','pt','fr','ja','ko','und') then p_lang
    when coalesce(p_title, '') || ' ' || coalesce(p_body, '') ~ '[一-龥]' then 'zh'
    else 'und'
  end;

  if p_id is null then
    insert into public.stories (user_id, title, body, tags, status, word_count, read_minutes, published_at, lang)
    values (me, trim(p_title), p_body, v_tags, 'published', v_words,
            greatest(1, ceil(v_words / 400.0)::int), now(), v_lang)
    returning * into rec;
  else
    update public.stories
       set title = trim(p_title), body = p_body, tags = v_tags, status = 'published',
           word_count = v_words, read_minutes = greatest(1, ceil(v_words / 400.0)::int),
           rev = rev + 1, updated_at = now(),
           published_at = coalesce(published_at, now()),
           lang = v_lang
     where id = p_id and user_id = me and status <> 'removed'
    returning * into rec;
    if not found then raise exception 'story-not-found'; end if;
  end if;
  return next rec;
end $$;

-- ── ⑧ 故事榜单把 lang 一并吐出来 ──
-- 为什么必须改：故事页的「优先看我这种语言」是在客户端排序的，前端只能排它拿到的字段。
-- story_rank 返回的是显式 table(...)，不含 lang 的话前端永远拿到 undefined → 排序和角标全部失效。
-- 为什么必须 drop：PostgreSQL 不允许 create or replace 改返回类型（会报
-- "cannot change return type of existing function"），改了还得 drop 重建。
-- 四种模式一个都没动排序/分页口径，只是每个 select 末尾多带一列：
--   random / latest / monthly 带 s.lang（monthly 的 group by s.id 是主键，取同表其它列合法）；
--   tag 模式是标签聚合、不对应单篇故事，lang 恒为 null。
-- 返回值里 lang 排在最后，前面的列序与旧版逐字一致 —— 老客户端按位置取值也不会错位。
do $$
declare r text;
begin
  for r in
    select p.oid::regprocedure::text
      from pg_proc p
     where p.proname = 'story_rank'
       and p.pronamespace = 'public'::regnamespace
  loop
    execute 'drop function ' || r;
  end loop;
end $$;

create function public.story_rank(
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
             /* 轮 443：阶梯新鲜度（详见 MIGRATION_story_rank_fresh.sql）。
                原来这里是 `where published_at > now() - interval '30 days'` —— 内容少时
                不是「挑新的」而是把老内容直接删出池子，池子缩到一页时「换一批」就翻空。 */
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

-- drop 会连带丢掉旧函数上的权限，重建后必须补回（否则故事页 403）。
revoke all on function public.story_rank(text, text, text, integer, integer) from public, anon;
grant execute on function public.story_rank(text, text, text, integer, integer) to authenticated, anon;

-- ── ⑨ 执行后自检 ──
-- 期望：三行都是 0（没有「含汉字却标成非 zh」的漏网），bad_lang 为 0（约束生效）。
select 'wall_posts 含汉字非 zh' as chk, count(*) as n
  from public.wall_posts where lang <> 'zh' and body ~ '[一-龥]'
union all
select 'bottle_letters 含汉字非 zh', count(*)
  from public.bottle_letters where lang <> 'zh' and body ~ '[一-龥]'
union all
select 'stories 含汉字非 zh', count(*)
  from public.stories where lang <> 'zh' and (title || ' ' || body) ~ '[一-龥]';
