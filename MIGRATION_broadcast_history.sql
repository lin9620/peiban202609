-- ═══════════════════════════════════════════════════════════════
-- 轮 238 · 管理员公告：分批推送 + 断点续发 + 历史（v2，替代此前单发 5000 的版本）
-- ---------------------------------------------------------------
-- 为什么分批：单条语句插 10w 行会撞超时，旧实现 limit 5000 = 只有最早的 5000 人收到。
-- 新模型：
--   admin_broadcasts 表 —— 每条公告一行（body / total 目标快照 / sent 已送达）。
--   admin_broadcast_start(p_body)            建档：快照当时总人数，返回 bid。
--   admin_broadcast_step(p_bid, p_batch)     推一批（默认 2000，上限 5000）：
--       只插「还没有收到这条公告」的用户（meta->>'bid' 去重）→ 幂等、可断点续发；
--       无可插 = done。管理端循环调用直到 done；中途关页，历史面板可继续。
--   admin_broadcasts_list(p_limit, p_offset) 历史：未完成的标 done=false，可续发。
-- 新注册用户不会收到历史公告：目标 = start 时快照 + step 逐批覆盖当时已注册者；
-- 发送开始之后注册的用户不补发（行为同前，明确化）。
-- 安全：全部 security definer + 函数内校验 admin_users；表开 RLS、不给策略
--       （只有本批 RPC 能碰它）；通知去重走 (meta->>'bid') 表达式部分索引。
-- ═══════════════════════════════════════════════════════════════

create table if not exists public.admin_broadcasts (
  id         uuid primary key default gen_random_uuid(),
  body       text not null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  total      integer not null default 0,
  sent       integer not null default 0
);
alter table public.admin_broadcasts enable row level security;

-- 去重/续发的定位索引（部分索引：只有 system 通知带 bid）
create index if not exists notifications_system_bid_idx
  on public.notifications ((meta->>'bid'))
  where kind = 'system';

-- 旧的单发版下线（10w 用户下它会静默漏发 95%）
drop function if exists public.admin_broadcast(text);

-- ① 建档：新公告，快照当前总人数
create or replace function public.admin_broadcast_start(p_body text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me     uuid := auth.uid();
  v_body text;
  v_total integer;
  v_bid  uuid;
begin
  if not exists (select 1 from public.admin_users where user_id = me) then
    return jsonb_build_object('admin', false);
  end if;
  v_body := left(btrim(coalesce(p_body, '')), 1000);
  if char_length(v_body) = 0 then raise exception 'empty-body'; end if;
  select count(*)::integer into v_total from public.profiles;
  insert into public.admin_broadcasts (body, created_by, total)
    values (v_body, me, v_total)
    returning id into v_bid;
  return jsonb_build_object('admin', true, 'bid', v_bid::text, 'total', v_total, 'sent', 0, 'done', false);
end $$;

-- ② 推一批：只给还没收到的用户插（幂等）；插不动 = done
create or replace function public.admin_broadcast_step(p_bid text, p_batch integer default 2000)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me      uuid := auth.uid();
  b       public.admin_broadcasts%rowtype;
  v_batch integer := least(greatest(coalesce(p_batch, 2000), 100), 5000);
  v_ins   integer := 0;
begin
  if not exists (select 1 from public.admin_users where user_id = me) then
    return jsonb_build_object('admin', false);
  end if;
  select * into b from public.admin_broadcasts where id = p_bid::uuid;
  if not found then return jsonb_build_object('admin', true, 'missing', true); end if;
  with ins as (
    insert into public.notifications (user_id, actor_id, kind, meta)
      select p.id, b.created_by, 'system', jsonb_build_object('body', b.body, 'bid', b.id::text)
        from public.profiles p
       where not exists (
           select 1 from public.notifications n
            where n.kind = 'system'
              and n.meta ->> 'bid' = b.id::text
              and n.user_id = p.id)
       order by p.created_at asc
       limit v_batch
      returning 1
  )
  select count(*) into v_ins from ins;
  update public.admin_broadcasts set sent = sent + v_ins where id = b.id;
  return jsonb_build_object('admin', true, 'bid', b.id::text, 'total', b.total,
    'sent', b.sent + v_ins, 'done', v_ins = 0);
end $$;

-- ③ 历史：新→旧；done=false 的可续发
create or replace function public.admin_broadcasts_list(p_limit integer default 20, p_offset integer default 0)
returns table (id text, body text, created_at timestamptz, sent integer, total integer, done boolean)
language sql security definer set search_path = public as $$
  select b.id::text, b.body, b.created_at, b.sent, b.total,
         (b.sent >= b.total) as done
    from public.admin_broadcasts b
   where exists (select 1 from public.admin_users a where a.user_id = auth.uid())
   order by b.created_at desc
   limit least(greatest(coalesce(p_limit, 20), 1), 100)
   offset greatest(coalesce(p_offset, 0), 0)
$$;
