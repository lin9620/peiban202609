-- ═══════════════════════════════════════════════════════════════
--  迁移：温暖漂流瓶（#6）
--  写信投进海里，其他用户随机捞起：回信 或 放回海里。
--  规则（明牌告知）：每日最多写 3 封 / 捞 7 封（UTC 日）；捞起 48h 不处理自动回海；
--  不能捞自己的信；回信只有写信人可见。
--  用法：Supabase Dashboard → SQL Editor → 粘贴全部 → Run（幂等，可重复执行）
-- ═══════════════════════════════════════════════════════════════

-- 1) 信件表：sea 漂流中 → held 被捞起独占 → answered 已收到回信
create table if not exists public.bottle_letters (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade, -- 写信人
  nickname    text not null default '',   -- 投瓶那一刻的昵称（落款）
  body        text not null,              -- 信的正文（≤1000 字由 RPC 把关）
  status      text not null default 'sea',
  holder      uuid references auth.users (id) on delete set null, -- 当前捞起的人
  held_at     timestamptz,
  reply       text,                       -- 回信正文
  reply_by    uuid references auth.users (id) on delete set null,
  reply_at    timestamptz,
  created_day date not null default (now() at time zone 'utc')::date, -- 每日 3 封按 UTC 日数
  created_at  timestamptz not null default now()
);
create index if not exists bottle_letters_sea_idx
  on public.bottle_letters (created_at desc) where status = 'sea';
create index if not exists bottle_letters_owner_idx
  on public.bottle_letters (user_id, created_at desc);

-- 2) 捞信日志：每日 7 封按 UTC 日数
create table if not exists public.bottle_fishes (
  user_id   uuid not null references auth.users (id) on delete cascade,
  day       date not null default (now() at time zone 'utc')::date,
  letter_id uuid not null references public.bottle_letters (id) on delete cascade,
  primary key (user_id, day, letter_id)
);

alter table public.bottle_letters enable row level security;
alter table public.bottle_fishes  enable row level security;

-- 读：写信人看自己的信；写过回信的人也能看到那封（捞信一律走 RPC，不开放直接查海）
drop policy if exists "bottle readable by owner or replier" on public.bottle_letters;
-- ══════════ RPC：服务端权威逻辑（限额 / 归属 / 48h 自动回海） ══════════

create or replace function public.bottle_send(p_body text)
returns public.bottle_letters
language plpgsql security definer set search_path = public as $$
declare
  v_count int;
  v_row   public.bottle_letters;
begin
  if auth.uid() is null then raise exception 'bottle-auth'; end if;
  p_body := btrim(coalesce(p_body, ''));
  if p_body = '' or char_length(p_body) > 1000 then raise exception 'bottle-too-long'; end if;
  select count(*) into v_count from public.bottle_letters
    where user_id = auth.uid() and created_day = (now() at time zone 'utc')::date;
  if v_count >= 3 then raise exception 'bottle-limit-send'; end if;
  insert into public.bottle_letters (user_id, nickname, body)
    values (auth.uid(),
            coalesce((select nickname from public.profiles where id = auth.uid()), ''),
            p_body)
    returning * into v_row;
  return v_row;
end $$;

create or replace function public.bottle_fish()
returns public.bottle_letters
language plpgsql security definer set search_path = public as $$
declare
  v_count int;
  v_id    uuid;
  v_row   public.bottle_letters;
begin
  if auth.uid() is null then raise exception 'bottle-auth'; end if;
  /* 捞起超 48h 未处理的信先放回海里（不让信卡死在谁手里） */
  update public.bottle_letters set status = 'sea', holder = null, held_at = null
    where status = 'held' and held_at < now() - interval '48 hours';
  select count(*) into v_count from public.bottle_fishes
    where user_id = auth.uid() and day = (now() at time zone 'utc')::date;
  if v_count >= 7 then raise exception 'bottle-limit-fish'; end if;
  select id into v_id from public.bottle_letters
    where status = 'sea' and user_id <> auth.uid()
    order by random() limit 1;
  if v_id is null then raise exception 'bottle-empty-sea'; end if;
  insert into public.bottle_fishes (user_id, day, letter_id)
    values (auth.uid(), (now() at time zone 'utc')::date, v_id);
  update public.bottle_letters set status = 'held', holder = auth.uid(), held_at = now()
    where id = v_id and status = 'sea'
    returning * into v_row;
  return v_row;
end $$;

create policy "bottle readable by owner or replier" on public.bottle_letters
  for select using (user_id = auth.uid() or reply_by = auth.uid());

-- 写路径全部收口在 security definer RPC（下面的函数），客户端不直接增删改
-- （bottle_letters 不建 insert/update/delete 策略；bottle_fishes 不建任何策略，均默认拒绝）

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
  return v_row;
end $$;

create or replace function public.bottle_release(p_id uuid)
returns public.bottle_letters
language plpgsql security definer set search_path = public as $$
declare
  v_row public.bottle_letters;
begin
  if auth.uid() is null then raise exception 'bottle-auth'; end if;
  update public.bottle_letters
    set status = 'sea', holder = null, held_at = null
    where id = p_id and status = 'held' and holder = auth.uid()
    returning * into v_row;
  if v_row is null then raise exception 'bottle-not-holder'; end if;
  return v_row;
end $$;

create or replace function public.bottle_mine()
returns setof public.bottle_letters
language sql security definer set search_path = public as $$
  select * from public.bottle_letters
    where user_id = auth.uid() or reply_by = auth.uid()
    order by created_at desc limit 30
$$;

create or replace function public.bottle_held()
returns setof public.bottle_letters
language sql security definer set search_path = public as $$
  select * from public.bottle_letters
    where holder = auth.uid() and status = 'held'
    order by held_at desc limit 10
$$;

comment on table public.bottle_letters is
  '温暖漂流瓶：写信投进海里，其他用户捞起回信或放回；每日写 3 捞 7（UTC 日）';
comment on table public.bottle_fishes is
  '漂流瓶捞信日志：每日最多 7 封，按 UTC 日计';
