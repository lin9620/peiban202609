-- ═══════════════════════════════════════════════════════════════
--  迁移：漂流瓶次数口径改为「捞到且回信了才扣 1 次」（轮 21）
--  用法：Supabase Dashboard → SQL Editor → 粘贴全部 → Run（幂等，可重复执行）
--  前置：已执行 MIGRATION_bottle.sql + MIGRATION_bottle_quota_fishfix.sql
--
--  旧口径（捞到就记一次）：用户反馈「没捞到也减次数」「捞一次就被锁死」。
--  新口径：
--    - 记次时机 = 回信成功那一刻（bottle_reply），一天最多回 7 封；
--    - 捞信本身不记次、不扣次（捞到不回也不扣）；
--    - 但「手里压着 ≥ 7 封未回」时拦捞（bottle-limit-hold），防无限囤信；
--    - 放回海里不返还、不记次；
--    - 计数只认 UTC 日（与写信口径一致），跨端显示同一本账。
-- ═══════════════════════════════════════════════════════════════

-- 1) 捞信日志加「回信时刻 / 回信日」两列（旧数据 replied_* 为 null = 从未回信，不计次）
alter table public.bottle_fishes add column if not exists replied_at  timestamptz;
alter table public.bottle_fishes add column if not exists replied_day date;

comment on column public.bottle_fishes.replied_at is  '回信时刻（null = 捞起后从未回信，不计入每日次数）';
comment on column public.bottle_fishes.replied_day is '回信日（UTC）：每日次数就是数这一列';

-- 2) 今日次数：已写几封 / 已回几封（UTC 日，服务端权威）
create or replace function public.bottle_quota()
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'sent',   (select count(*) from public.bottle_letters
                where user_id = auth.uid()
                  and created_day = (now() at time zone 'utc')::date),
    'fished', (select count(*) from public.bottle_fishes
                where user_id = auth.uid()
                  and replied_day = (now() at time zone 'utc')::date)
  )
$$;
revoke all on function public.bottle_quota() from public, anon;
grant execute on function public.bottle_quota() to authenticated;

-- 3) 捞信：不记次；只拦「今天回信额度用完」与「手里囤太多未回」
create or replace function public.bottle_fish()
returns public.bottle_letters
language plpgsql security definer set search_path = public as $$
declare
  v_replied int;
  v_held    int;
  v_row     public.bottle_letters;
  i         int;
begin
  if auth.uid() is null then raise exception 'bottle-auth'; end if;
  /* 捞起超 48h 未处理的信先放回海里（不让信卡死在谁手里） */
  update public.bottle_letters set status = 'sea', holder = null, held_at = null
    where status = 'held' and held_at < now() - interval '48 hours';
  /* 今日已回信数达到 7 → 今天不能再捞（捞了也回不了） */
  select count(*) into v_replied from public.bottle_fishes
    where user_id = auth.uid() and replied_day = (now() at time zone 'utc')::date;
  if v_replied >= 7 then raise exception 'bottle-limit-fish'; end if;
  /* 手里还压着 ≥7 封没处理 → 先回信或放回，别囤信（防无限捞） */
  select count(*) into v_held from public.bottle_letters
    where holder = auth.uid() and status = 'held';
  if v_held >= 7 then raise exception 'bottle-limit-hold'; end if;
  /* 随机挑一封 → 条件更新抢占（只在仍是 sea 时成立）。别人同一瞬间捞走
     同一封 → 命中 0 行 → 换一封重试；重试 3 次仍落空或海里已空 →
     明确抛 bottle-empty-sea（绝不返回 null：客户端只在拿到信时才计数） */
  for i in 1..3 loop
    select * into v_row from public.bottle_letters
      where status = 'sea' and user_id <> auth.uid()
      order by random() limit 1;
    if not found then raise exception 'bottle-empty-sea'; end if;
    update public.bottle_letters set status = 'held', holder = auth.uid(), held_at = now()
      where id = v_row.id and status = 'sea'
      returning * into v_row;
    if found then
      /* 捞信日志（供「我捞到的」记录）：同一封当天放回再捞不重复、不报错。
         注意：这里不写 replied_*，所以捞信本身不计次。 */
      insert into public.bottle_fishes (user_id, day, letter_id)
        values (auth.uid(), (now() at time zone 'utc')::date, v_row.id)
        on conflict (user_id, day, letter_id) do nothing;
      return v_row;
    end if;
  end loop;
  raise exception 'bottle-empty-sea';
end $$;

-- 4) 回信：成功那一刻给这封信的捞信日志盖上「已回信」→ 今日次数 +1
create or replace function public.bottle_reply(p_id uuid, p_reply text)
returns public.bottle_letters
language plpgsql security definer set search_path = public as $$
declare
  v_row public.bottle_letters;
begin
  if auth.uid() is null then raise exception 'bottle-auth'; end if;
  p_reply := btrim(coalesce(p_reply, ''));
  if p_reply = '' or char_length(p_reply) > 1000 then raise exception 'bottle-too-long'; end if;
  update public.bottle_letters
    set status = 'answered', reply = p_reply, reply_by = auth.uid(), reply_at = now()
    where id = p_id and status = 'held' and holder = auth.uid()
    returning * into v_row;
  if v_row is null then raise exception 'bottle-not-holder'; end if;
  /* 记次（幂等）：只给这封信**最新一条**捞信日志盖「已回信」。
     为什么不能只按 letter_id 全量更新：同一封信「捞起→放回→跨天再捞」会有
     多行日志（主键含 day），全量更新会把 N 行都盖成今天 → 一次回信扣 N 次
     （用户反馈的「捞一次扣好多」类问题就是这么来的）。取 day 最大的一行即可。 */
  update public.bottle_fishes f
    set replied_at = now(), replied_day = (now() at time zone 'utc')::date
    from (
      select user_id, day, letter_id from public.bottle_fishes
        where user_id = auth.uid() and letter_id = p_id and replied_at is null
        order by day desc limit 1
    ) t
    where f.user_id = t.user_id and f.day = t.day and f.letter_id = t.letter_id;
  return v_row;
end $$;

comment on table public.bottle_fishes is
  '漂流瓶捞信日志：每日**回信**最多 7 封（回信才计次），手里未回 ≥7 封时拦新捞（均按 UTC 日）';
