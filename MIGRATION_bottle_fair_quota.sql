-- ═══════════════════════════════════════════════════════════════
--  迁移：漂流瓶公平捞取 + 24h 滚动额度 + 内容质量 + 双向拉黑过滤
--  用法：Supabase Dashboard → SQL Editor → 粘贴全部 → Run（幂等，可重复执行）
--  前置：MIGRATION_bottle.sql + MIGRATION_bottle_reply_quota.sql
--
--  这一轮解决 8 件事：
--    1) 「放回→立刻重捞」不再能免费换一批：捞取单独记额度，24h 最多 30 瓶；
--       放回没有冷却，仍可立刻再捞，但每捞一次都计入 30 瓶额度。
--    2) 纯随机不公平：按 pickup_count 从小到大优先，未被捞过的信先出现；
--       last_picked_at 再兜底，最后才 random()。
--    3) 防止同一个人反复出现：7 天内捞过其信的作者降权（软降权，不硬封）。
--    4) 拉黑过滤是 P0：捞信、回信都双向检查 dm_is_blocked。
--    5) 规模优化：随机桶 + FOR UPDATE SKIP LOCKED，不再每次全海 order by random()。
--    6) 内容质量 / 冷启动：最少 10 字、24h 内同内容去重；空海引导由前端落地。
--       另：所有「每日」额度改成滚动 24 小时，避免跨时区/自然日边界争议。
--    7) 举报 / 隐藏：同一用户举报后不再捞到，3 个不同用户举报全局隐藏。
--    8) 额度并发：同一用户加事务级 advisory lock，双击/多端不会刷穿额度。
-- ═══════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────
-- 1) 信件表：公平字段 + 内容指纹
-- ─────────────────────────────────────────────────────────────
alter table public.bottle_letters
  add column if not exists pickup_count integer not null default 0;
alter table public.bottle_letters
  add column if not exists last_picked_at timestamptz;
alter table public.bottle_letters
  add column if not exists random_bucket smallint;
alter table public.bottle_letters
  add column if not exists body_hash text;
alter table public.bottle_letters
  add column if not exists hidden_at timestamptz;

-- 老库补随机桶 / 内容指纹（新库由函数写入；这里只补历史行）
update public.bottle_letters
   set random_bucket = floor(random() * 256)::smallint
 where random_bucket is null;
update public.bottle_letters
   set body_hash = md5(lower(btrim(body)))
 where body_hash is null;

alter table public.bottle_letters
  alter column random_bucket set default floor(random() * 256)::smallint;
alter table public.bottle_letters
  alter column random_bucket set not null;

comment on column public.bottle_letters.pickup_count is
  '被捞起次数；公平捞取优先选最小值的信（未被捞过的先出现）';
comment on column public.bottle_letters.last_picked_at is
  '最近一次被捞起时间；同 pickup_count 时更久没被捞的优先';
comment on column public.bottle_letters.random_bucket is
  '0..255 随机桶；大规模时只扫一个桶，避免全海 order by random()';
comment on column public.bottle_letters.body_hash is
  'md5(lower(btrim(body)))，同一用户 24h 内重复内容拦截用';
comment on column public.bottle_letters.hidden_at is
  '被举报达到阈值后的全局隐藏时刻；隐藏后不再被捞起';

-- 举报 / 隐藏：同一用户举报过的信不再发给他；3 个不同用户举报 → 全局隐藏
create table if not exists public.bottle_reports (
  id          bigserial primary key,
  reporter_id uuid not null references auth.users (id) on delete cascade,
  letter_id   uuid not null references public.bottle_letters (id) on delete cascade,
  reason      text not null default 'other',
  detail      text not null default '',
  created_at  timestamptz not null default now(),
  unique (reporter_id, letter_id)
);
alter table public.bottle_reports enable row level security;
create index if not exists bottle_reports_letter_idx
  on public.bottle_reports (letter_id);
create index if not exists bottle_reports_reporter_idx
  on public.bottle_reports (reporter_id, created_at desc);

-- ─────────────────────────────────────────────────────────────
-- 2) 捞信日志：增加「捞起时刻」
--    旧 replied_* 继续保留（回信额度）；picked_at 是新的捞取额度/近期信排除依据。
-- ─────────────────────────────────────────────────────────────
alter table public.bottle_fishes
  add column if not exists picked_at timestamptz;
-- 幂等兜底：即使只跑过最初的 MIGRATION_bottle.sql，也能直接跑本文件
alter table public.bottle_fishes
  add column if not exists replied_at timestamptz;
alter table public.bottle_fishes
  add column if not exists replied_day date;

-- 历史行按原来的 day（UTC）补一个近似时刻；之后的新捞信一律 now()
update public.bottle_fishes
   set picked_at = (day::timestamp at time zone 'utc')
 where picked_at is null;

-- 旧数据的 replied_day 已记过回信但 replied_at 可能为空；补上，滚动 24h 才不会漏算
update public.bottle_fishes
   set replied_at = (replied_day::timestamp at time zone 'utc')
 where replied_at is null and replied_day is not null;

alter table public.bottle_fishes
  alter column picked_at set default now();
alter table public.bottle_fishes
  alter column picked_at set not null;

comment on column public.bottle_fishes.picked_at is
  '捞起时刻；24h 捞取额度、7 天内同信不再发、作者近 7 天降权都看这一列';

-- ─────────────────────────────────────────────────────────────
-- 3) 索引：公平捞取 / 额度 / 去重
-- ─────────────────────────────────────────────────────────────
create index if not exists bottle_letters_sea_fair_idx
  on public.bottle_letters (pickup_count, last_picked_at)
  where status = 'sea';
create index if not exists bottle_letters_sea_bucket_idx
  on public.bottle_letters (random_bucket, pickup_count, last_picked_at)
  where status = 'sea';
create index if not exists bottle_letters_user_hash_idx
  on public.bottle_letters (user_id, body_hash, created_at desc);
create index if not exists bottle_fishes_user_pick_idx
  on public.bottle_fishes (user_id, picked_at desc);
create index if not exists bottle_fishes_user_letter_pick_idx
  on public.bottle_fishes (user_id, letter_id, picked_at desc);
create index if not exists bottle_fishes_user_reply_idx
  on public.bottle_fishes (user_id, replied_at desc);
create index if not exists bottle_letters_held_idx
  on public.bottle_letters (held_at)
  where status = 'held';
create index if not exists bottle_letters_holder_held_idx
  on public.bottle_letters (holder, held_at desc)
  where status = 'held';

-- ─────────────────────────────────────────────────────────────
-- 4) 投信：滚动 24h 5 封 + 最少 10 字 + 24h 同内容去重
-- ─────────────────────────────────────────────────────────────
create or replace function public.bottle_send(p_body text)
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

  insert into public.bottle_letters (user_id, nickname, body, body_hash)
    values (auth.uid(),
            coalesce((select nickname from public.profiles where id = auth.uid()), ''),
            p_body,
            v_hash)
    returning * into v_row;
  return v_row;
end $$;

-- ─────────────────────────────────────────────────────────────
-- 5) 次数探针：滚动 24h
--    sent = 已投，picked = 已捞（含放回），fished = 已回信（回信才计）
-- ─────────────────────────────────────────────────────────────
create or replace function public.bottle_quota()
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'sent',   (select count(*) from public.bottle_letters
                where user_id = auth.uid()
                  and created_at > now() - interval '24 hours'),
    'picked', (select count(*) from public.bottle_fishes
                where user_id = auth.uid()
                  and picked_at > now() - interval '24 hours'),
    'fished', (select count(*) from public.bottle_fishes
                where user_id = auth.uid()
                  and replied_at > now() - interval '24 hours')
  )
$$;
revoke all on function public.bottle_quota() from public, anon;
grant execute on function public.bottle_quota() to authenticated;

-- ─────────────────────────────────────────────────────────────
-- 6) 捞信：30 瓶/24h + 公平优先 + 双向拉黑 + 7 天同信排除 + 随机桶
-- ─────────────────────────────────────────────────────────────
create or replace function public.bottle_fish()
returns public.bottle_letters
language plpgsql security definer set search_path = public as $$
declare
  v_replied int;
  v_picked  int;
  v_held    int;
  v_min     int;
  v_bucket  smallint;
  v_row     public.bottle_letters;
  v_found   boolean := false;
  i         int;
begin
  if auth.uid() is null then raise exception 'bottle-auth'; end if;
  /* 同一用户的额度检查串行化：并发双击/多端同时投捞也不会把 30 瓶刷成 31 瓶 */
  perform pg_advisory_xact_lock(411, hashtext(auth.uid()::text));

  /* 捞起超 48h 未处理的信先放回海里（不让信卡死在谁手里） */
  update public.bottle_letters
     set status = 'sea', holder = null, held_at = null
   where status = 'held'
     and held_at < now() - interval '48 hours';

  /* 回信额度：滚动 24h 最多 7 封；额度用完就别再捞（捞了也回不了） */
  select count(*) into v_replied
    from public.bottle_fishes
   where user_id = auth.uid()
     and replied_at > now() - interval '24 hours';
  if v_replied >= 7 then raise exception 'bottle-limit-fish'; end if;

  /* 捞取额度：滚动 24h 最多 30 瓶；放回不返还，避免免费「换一批」 */
  select count(*) into v_picked
    from public.bottle_fishes
   where user_id = auth.uid()
     and picked_at > now() - interval '24 hours';
  if v_picked >= 30 then raise exception 'bottle-limit-pick'; end if;

  /* 手里还压着 ≥7 封没处理 → 先回信或放回，别囤信 */
  select count(*) into v_held
    from public.bottle_letters
   where holder = auth.uid() and status = 'held';
  if v_held >= 7 then raise exception 'bottle-limit-hold'; end if;

  /* 先找当前可捞信里最小的 pickup_count：没被捞过的信优先，保证不会永远轮不到 */
  select min(l.pickup_count) into v_min
    from public.bottle_letters l
   where l.status = 'sea'
     and l.user_id <> auth.uid()
     and l.hidden_at is null
     and not exists (
       select 1 from public.bottle_reports r
        where r.reporter_id = auth.uid() and r.letter_id = l.id
     )
     and not public.dm_is_blocked(auth.uid(), l.user_id)
     and not public.dm_is_blocked(l.user_id, auth.uid())
     and not exists (
       select 1 from public.bottle_fishes f
        where f.user_id = auth.uid()
          and f.letter_id = l.id
          and f.picked_at > now() - interval '7 days'
     );

  /* 规模优化：在最小 pickup_count 组里先随机挑 3 个桶；桶空再全量兜底。
     真正的公平由 pickup_count 保证，随机桶只负责减少候选扫描。 */
  if v_min is not null then
    for i in 1..3 loop
      v_bucket := floor(random() * 256)::smallint;
      select l.* into v_row
        from public.bottle_letters l
       where l.status = 'sea'
         and l.user_id <> auth.uid()
         and l.hidden_at is null
         and not exists (
           select 1 from public.bottle_reports r
            where r.reporter_id = auth.uid() and r.letter_id = l.id
         )
         and l.pickup_count = v_min
         and l.random_bucket = v_bucket
         and not public.dm_is_blocked(auth.uid(), l.user_id)
         and not public.dm_is_blocked(l.user_id, auth.uid())
         and not exists (
           select 1 from public.bottle_fishes f
            where f.user_id = auth.uid()
              and f.letter_id = l.id
              and f.picked_at > now() - interval '7 days'
         )
       order by
         /* 7 天内捞过这个作者的信 → 排后面（软降权，不硬封） */
         (exists (
           select 1
             from public.bottle_fishes f2
             join public.bottle_letters l2 on l2.id = f2.letter_id
            where f2.user_id = auth.uid()
              and l2.user_id = l.user_id
              and f2.picked_at > now() - interval '7 days'
         )) asc,
         l.last_picked_at asc nulls first,
         random()
       limit 1
       for update of l skip locked;
      v_found := found;
      if v_found then exit; end if;
    end loop;
  end if;

  /* 兜底：随机桶没命中（海小/桶空/候选都被锁）时，仍按公平顺序找一封 */
  if not v_found then
    select l.* into v_row
      from public.bottle_letters l
     where l.status = 'sea'
       and l.user_id <> auth.uid()
       and l.hidden_at is null
       and not exists (
         select 1 from public.bottle_reports r
          where r.reporter_id = auth.uid() and r.letter_id = l.id
       )
       and not public.dm_is_blocked(auth.uid(), l.user_id)
       and not public.dm_is_blocked(l.user_id, auth.uid())
       and not exists (
         select 1 from public.bottle_fishes f
          where f.user_id = auth.uid()
            and f.letter_id = l.id
            and f.picked_at > now() - interval '7 days'
       )
     order by
       (exists (
         select 1
           from public.bottle_fishes f2
           join public.bottle_letters l2 on l2.id = f2.letter_id
          where f2.user_id = auth.uid()
            and l2.user_id = l.user_id
            and f2.picked_at > now() - interval '7 days'
       )) asc,
       l.pickup_count asc,
       l.last_picked_at asc nulls first,
       random()
     limit 1
     for update of l skip locked;
    v_found := found;
  end if;

  if not v_found then raise exception 'bottle-empty-sea'; end if;

  /* 抢占式更新：只有仍是 sea 才成功；同时累计公平计数/最后捞起时刻 */
  update public.bottle_letters
     set status = 'held',
         holder = auth.uid(),
         held_at = now(),
         pickup_count = pickup_count + 1,
         last_picked_at = now()
   where id = v_row.id and status = 'sea'
   returning * into v_row;

  if not found then raise exception 'bottle-empty-sea'; end if;

  /* 捞取日志：picked_at 立刻记下，放回不删除、不返还额度 */
  insert into public.bottle_fishes (user_id, day, letter_id, picked_at)
    values (auth.uid(), (now() at time zone 'utc')::date, v_row.id, now())
    on conflict (user_id, day, letter_id) do update
      set picked_at = excluded.picked_at;

  return v_row;
end $$;

-- ─────────────────────────────────────────────────────────────
-- 7) 回信：双向拉黑拦截 + 回信额度兜底 + 只盖最新一条捞信日志
-- ─────────────────────────────────────────────────────────────
create or replace function public.bottle_reply(p_id uuid, p_reply text)
returns public.bottle_letters
language plpgsql security definer set search_path = public as $$
declare
  v_row     public.bottle_letters;
  v_replied int;
begin
  if auth.uid() is null then raise exception 'bottle-auth'; end if;
  /* 同一用户的额度检查串行化：并发双击/多端同时投捞也不会把 30 瓶刷成 31 瓶 */
  perform pg_advisory_xact_lock(411, hashtext(auth.uid()::text));

  p_reply := btrim(coalesce(p_reply, ''));
  if p_reply = '' then raise exception 'bottle-empty-body'; end if;
  if char_length(p_reply) > 1000 then raise exception 'bottle-too-long'; end if;

  /* 锁住这封信再检查归属/拉黑，避免同一瞬间被放回或换手 */
  select * into v_row
    from public.bottle_letters
   where id = p_id and status = 'held' and holder = auth.uid() and hidden_at is null
   for update;
  if v_row.id is null then raise exception 'bottle-not-holder'; end if;

  if public.dm_is_blocked(auth.uid(), v_row.user_id)
     or public.dm_is_blocked(v_row.user_id, auth.uid()) then
    raise exception 'bottle-blocked';
  end if;

  select count(*) into v_replied
    from public.bottle_fishes
   where user_id = auth.uid()
     and replied_at > now() - interval '24 hours';
  if v_replied >= 7 then raise exception 'bottle-limit-fish'; end if;

  update public.bottle_letters
     set status = 'answered',
         reply = p_reply,
         reply_by = auth.uid(),
         reply_at = now()
   where id = p_id and status = 'held' and holder = auth.uid() and hidden_at is null
   returning * into v_row;
  if v_row.id is null then raise exception 'bottle-not-holder'; end if;

  /* 记回信额度（幂等）：只给这封信最新一条未回信日志盖章；按 picked_at 取最新，
     避免同一封信跨天多行全量盖章导致「回一次扣 N 次」。 */
  update public.bottle_fishes f
     set replied_at = now(),
         replied_day = (now() at time zone 'utc')::date
    from (
      select user_id, day, letter_id
        from public.bottle_fishes
       where user_id = auth.uid()
         and letter_id = p_id
         and replied_at is null
       order by picked_at desc nulls last, day desc
       limit 1
    ) t
   where f.user_id = t.user_id
     and f.day = t.day
     and f.letter_id = t.letter_id;

  return v_row;
end $$;

-- ─────────────────────────────────────────────────────────────
-- 7b) 举报 / 隐藏：同一用户举报后不再捞到；3 人举报 → 全局隐藏
-- ─────────────────────────────────────────────────────────────
create or replace function public.bottle_report(p_id uuid, p_reason text default 'other', p_detail text default '')
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid    uuid := auth.uid();
  v_reason text := lower(coalesce(p_reason, 'other'));
  v_detail text := left(btrim(coalesce(p_detail, '')), 200);
  v_count  int;
  v_row    public.bottle_letters;
begin
  if v_uid is null then raise exception 'auth-required'; end if;
  perform pg_advisory_xact_lock(411, hashtext(v_uid::text));
  if p_id is null then raise exception 'bad-target'; end if;
  if v_reason not in ('spam','abuse','porn','illegal','false','other') then
    v_reason := 'other';
  end if;

  select * into v_row from public.bottle_letters where id = p_id for update;
  if v_row.id is null then raise exception 'target-gone'; end if;
  if v_row.user_id = v_uid then raise exception 'bad-target'; end if;

  select count(*) into v_count
    from public.bottle_reports
   where reporter_id = v_uid
     and created_at > now() - interval '24 hours';
  if v_count >= 10 then raise exception 'bottle-report-limit'; end if;

  insert into public.bottle_reports (reporter_id, letter_id, reason, detail)
    values (v_uid, p_id, v_reason, v_detail)
    on conflict (reporter_id, letter_id) do nothing;

  select count(*) into v_count
    from public.bottle_reports
   where letter_id = p_id;
  if v_count >= 3 then
    update public.bottle_letters
       set hidden_at = coalesce(hidden_at, now())
     where id = p_id;
  end if;

  return jsonb_build_object('ok', true);
end $$;

-- ─────────────────────────────────────────────────────────────
-- 8) 表和列注释（便于线上排查口径）
-- ─────────────────────────────────────────────────────────────
comment on table public.bottle_letters is
  '温暖漂流瓶：写信投海；24h 最多写 5 封 / 捞 30 瓶 / 回 7 封；按 pickup_count 公平轮转';
comment on table public.bottle_fishes is
  '漂流瓶捞信日志：picked_at 记捞取额度，replied_at 记回信额度；均按滚动 24h 计';

-- 权限保持与原函数一致
revoke all on function public.bottle_send(text) from public, anon;
revoke all on function public.bottle_fish() from public, anon;
revoke all on function public.bottle_reply(uuid, text) from public, anon;
revoke all on function public.bottle_report(uuid, text, text) from public, anon;
grant execute on function public.bottle_send(text) to authenticated;
grant execute on function public.bottle_fish() to authenticated;
grant execute on function public.bottle_reply(uuid, text) to authenticated;
grant execute on function public.bottle_report(uuid, text, text) to authenticated;
