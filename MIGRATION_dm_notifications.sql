-- ============================================================
-- Warm Paws 阶段 4 迁移：私信（DM）+ 通知中心（Notifications）
-- ------------------------------------------------------------
-- 前置：SUPABASE_SETUP.sql 已执行（profiles / wall_posts / wall_comments /
--       wall_reactions / pet_profiles / pet_interactions / admin_users 已存在）。
-- 幂等：可重复执行（create if not exists / create or replace / drop policy if exists）。
-- 模型（六张新表）：
--   dm_blocks           拉黑 —— 硬墙：双向禁发；我的会话列表隐藏对方
--   dm_conversations    会话 —— user_a < user_b 有序对（唯一约束防并发重复建）；
--                       last_message_at / last_preview 冗余列，列表一次查询出全量
--   dm_messages         消息 —— 软删除即撤回；正文与图片至少其一
--   dm_states           每人每会话状态 —— 已读水位 / 消息请求(accepted) / 隐藏 / 免打扰
--   notifications       通知 —— 由触发器与 RPC 写入；收件人只能读自己的
--   notification_prefs  通知偏好 —— 缺行视为全开
-- 写路径：全部收口在 security definer RPC（前端不直插任何行）；
--         评论/回应/宠物互动的通知由 AFTER INSERT 触发器生成，现有 RPC 一行不改。
-- 已读模型：水位 dm_states.last_read_id（微信/IG 式），不是逐条已读表。
-- 通知类型：comment | reply | reaction | pet | dm | system（管理员公告走 admin_broadcast）。
-- 约定常量：会话预览里 '📷' = 纯图片消息；'⟲' = 最新一条被撤回（与 dmRules.js 同源）。
-- （本文件正文与 SUPABASE_SETUP.sql 第 9 节保持同步，tools/dm-test.mjs 会校验覆盖）
-- ============================================================

-- 1) 拉黑（先建：dm_open / dm_send 都要查它）
create table if not exists public.dm_blocks (
  blocker    uuid not null references public.profiles (id) on delete cascade,
  blocked    uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker, blocked)
);

-- 2) 会话
create table if not exists public.dm_conversations (
  id              bigserial primary key,
  user_a          uuid not null references public.profiles (id) on delete cascade,
  user_b          uuid not null references public.profiles (id) on delete cascade,
  last_message_at timestamptz,
  last_preview    text not null default '',
  created_at      timestamptz not null default now(),
  constraint dm_conv_pair_key unique (user_a, user_b),
  constraint dm_conv_sorted    check (user_a < user_b)
);
create index if not exists dm_conv_b_idx    on public.dm_conversations (user_b);
create index if not exists dm_conv_sort_idx on public.dm_conversations (user_a, created_at desc);

-- 3) 消息（撤回 = deleted_at 置位并清空内容；预览改写见 dm_recall）
create table if not exists public.dm_messages (
  id         bigserial primary key,
  conv_id    bigint not null references public.dm_conversations (id) on delete cascade,
  sender     uuid not null references public.profiles (id) on delete cascade,
  body       text not null default '',
  image_path text,
  edited_at  timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  constraint dm_msg_body_len  check (char_length(body) <= 2000),
  constraint dm_msg_not_empty check (char_length(body) > 0 or image_path is not null)
);
create index if not exists dm_msg_conv_idx on public.dm_messages (conv_id, id desc);
-- (待续1)

-- 4) 每人每会话状态（已读水位 last_read_id：读到的最大消息 id，微信/IG 式）
create table if not exists public.dm_states (
  conv_id      bigint not null references public.dm_conversations (id) on delete cascade,
  user_id      uuid not null references public.profiles (id) on delete cascade,
  last_read_id bigint not null default 0,
  accepted     boolean not null default false,   -- false = 待处理的「消息请求」
  hidden_until timestamptz,                      -- 隐藏；'infinity' = 拒绝/拉黑后永久藏
  muted        boolean not null default false,   -- 免打扰：不产生 dm 通知，红点照常
  primary key (conv_id, user_id)
);
create index if not exists dm_states_user_idx on public.dm_states (user_id, accepted);

-- 5) 通知（actor_id 为空 = 系统通知；meta 携带反应种类 / 预览文本等）
create table if not exists public.notifications (
  id         bigserial primary key,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  actor_id   uuid references public.profiles (id) on delete cascade,
  kind       text not null,
  post_id    bigint references public.wall_posts (id) on delete cascade,
  comment_id bigint references public.wall_comments (id) on delete cascade,
  conv_id    bigint references public.dm_conversations (id) on delete cascade,
  meta       jsonb not null default '{}'::jsonb,
  read_at    timestamptz,
  created_at timestamptz not null default now(),
  constraint notif_kind check (kind in ('comment','reply','reaction','pet','dm','system'))
);
create index if not exists notif_user_idx         on public.notifications (user_id, id desc);
create index if not exists notif_user_unread_idx  on public.notifications (user_id) where read_at is null;

-- 6) 通知偏好（行不存在 = 四类全开；RPC 读取时统一补默认值）
create table if not exists public.notification_prefs (
  user_id    uuid primary key references public.profiles (id) on delete cascade,
  comments   boolean not null default true,
  reactions  boolean not null default true,
  pets       boolean not null default true,
  dms        boolean not null default true,
  updated_at timestamptz not null default now()
);
-- (待续2)

-- ══════════════════ RLS：先开行级安全，再建策略 ══════════════════

alter table public.dm_blocks          enable row level security;
alter table public.dm_conversations   enable row level security;
alter table public.dm_messages        enable row level security;
alter table public.dm_states          enable row level security;
alter table public.notifications      enable row level security;
alter table public.notification_prefs enable row level security;

-- 拉黑：只看 / 只管自己发出的拉黑（直接表写，无需 RPC）
drop policy if exists "blocks read own" on public.dm_blocks;
create policy "blocks read own" on public.dm_blocks
  for select using (auth.uid() = blocker);
drop policy if exists "blocks insert own" on public.dm_blocks;
create policy "blocks insert own" on public.dm_blocks
  for insert with check (auth.uid() = blocker and blocked <> blocker);
drop policy if exists "blocks remove own" on public.dm_blocks;
create policy "blocks remove own" on public.dm_blocks
  for delete using (auth.uid() = blocker);

-- 会话：只有参与者可读；写入一律走 RPC（无 insert/update/delete 策略 = 直写被拒）
drop policy if exists "convs read participant" on public.dm_conversations;
create policy "convs read participant" on public.dm_conversations
  for select using (auth.uid() = user_a or auth.uid() = user_b);

-- 消息：参与者可读；写入只走 dm_send RPC
drop policy if exists "messages read participant" on public.dm_messages;
create policy "messages read participant" on public.dm_messages
  for select using (
    exists (
      select 1 from public.dm_conversations c
       where c.id = conv_id and (auth.uid() = c.user_a or auth.uid() = c.user_b)
    )
  );

-- 状态：只读自己的行；水位 / 隐藏 / 免打扰 / 接受 全走 RPC
drop policy if exists "states read own" on public.dm_states;
create policy "states read own" on public.dm_states
  for select using (auth.uid() = user_id);

-- 通知：收件人可读、可清空（删自己 = 通知页「清空」）；标记已读走 notif_mark RPC
drop policy if exists "notifs read recipient" on public.notifications;
create policy "notifs read recipient" on public.notifications
  for select using (auth.uid() = user_id);
drop policy if exists "notifs remove recipient" on public.notifications;
create policy "notifs remove recipient" on public.notifications
  for delete using (auth.uid() = user_id);

-- 偏好：只读自己的行；写走 notif_prefs_set RPC
drop policy if exists "prefs read own" on public.notification_prefs;
create policy "prefs read own" on public.notification_prefs
  for select using (auth.uid() = user_id);
-- (待续3)

-- ══════════════════ 私信 RPC（全部 security definer，前端不直写） ══════════════════

-- 小工具：a 是否拉黑了 b（security definer：RPC 内要跨行读 dm_blocks）
create or replace function public.dm_is_blocked(a uuid, b uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.dm_blocks where blocker = a and blocked = b)
$$;

-- 小工具：两人之间的会话 id（无则 null）
create or replace function public.dm_find_conv(a uuid, b uuid)
returns bigint language sql stable security definer set search_path = public as $$
  select id from public.dm_conversations
   where (user_a = a and user_b = b) or (user_a = b and user_b = a)
   limit 1
$$;

-- 打开会话：找或建（并发重复建由唯一约束兜底）；返回 { conv_id }
create or replace function public.dm_open(p_other uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me   uuid := auth.uid();
  v_id bigint;
begin
  if me is null then raise exception 'auth-required'; end if;
  if p_other is null or p_other = me then raise exception 'bad-target'; end if;
  if not exists (select 1 from public.profiles where id = p_other) then
    raise exception 'no-user';
  end if;
  -- 对方拉黑了我 → 拒绝发起（不暴露更多信息）
  if exists (select 1 from public.dm_blocks where blocker = p_other and blocked = me) then
    raise exception 'blocked';
  end if;
  select public.dm_find_conv(me, p_other) into v_id;
  if v_id is null then
    begin
      insert into public.dm_conversations (user_a, user_b)
        values (least(me, p_other), greatest(me, p_other))
        returning id into v_id;
    exception when unique_violation then
      v_id := public.dm_find_conv(me, p_other);
    end;
  end if;
  -- 状态行：发起者视为已接受；对方保持「消息请求」待处理（已有状态不动）
  insert into public.dm_states (conv_id, user_id, accepted)
    values (v_id, me, true), (v_id, p_other, false)
    on conflict (conv_id, user_id) do nothing;
  return jsonb_build_object('conv_id', v_id);
end $$;
-- (待续4)

-- 发消息（一个事务内：插消息 + 会话冗余 + 双方状态 + 对方通知）
-- 错误码：auth-required / bad-conv / empty-message / forbidden / blocked / blocked-by-me
create or replace function public.dm_send(p_conv bigint, p_body text default '', p_image text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me      uuid := auth.uid();
  v_other uuid;
  v_mid   bigint;
  v_body  text := coalesce(p_body, '');
  v_muted boolean := false;
  v_dms   boolean := true;
  v_prev  text;
begin
  if me is null then raise exception 'auth-required'; end if;
  if p_conv is null then raise exception 'bad-conv'; end if;
  v_body := left(btrim(v_body), 2000);
  if char_length(v_body) = 0 and coalesce(p_image, '') = '' then
    raise exception 'empty-message';
  end if;
  select case when user_a = me then user_b else user_a end into v_other
    from public.dm_conversations where id = p_conv;
  if v_other is null then raise exception 'forbidden'; end if;  -- 不是参与者
  if exists (select 1 from public.dm_blocks where blocker = me and blocked = v_other) then
    raise exception 'blocked-by-me';   -- 我拉黑了对方：先去解除拉黑
  end if;
  if exists (select 1 from public.dm_blocks where blocker = v_other and blocked = me) then
    raise exception 'blocked';         -- 对方拉黑了我
  end if;

  insert into public.dm_messages (conv_id, sender, body, image_path)
    values (p_conv, me, v_body, nullif(coalesce(p_image, ''), ''))
    returning id into v_mid;

  -- 预览：正文截 80 字；纯图片用 📷
  v_prev := case when char_length(v_body) > 0 then left(v_body, 80) else '📷' end;
  update public.dm_conversations
     set last_message_at = now(), last_preview = v_prev
   where id = p_conv;

  -- 我方状态：回复即接受消息请求；发送意味着读到了自己的消息（抬水位）
  insert into public.dm_states (conv_id, user_id, accepted, last_read_id)
    values (p_conv, me, true, v_mid)
    on conflict (conv_id, user_id) do update
      set accepted = true,
          last_read_id = greatest(public.dm_states.last_read_id, excluded.last_read_id);
  -- 确保对方状态行存在（防御：老会话状态行缺失时补齐）
  insert into public.dm_states (conv_id, user_id, accepted)
    values (p_conv, v_other, false)
    on conflict (conv_id, user_id) do nothing;
  -- 新消息让两边被隐藏的会话重新出现（WhatsApp 行为；拉黑时 dm_send 已拒绝，不会复活）
  update public.dm_states set hidden_until = null where conv_id = p_conv;

  -- 通知对方：看对方偏好（dms 开关）与免打扰
  select coalesce(s.muted, false) into v_muted
    from public.dm_states s where s.conv_id = p_conv and s.user_id = v_other;
  select coalesce(p.dms, true) into v_dms
    from public.notification_prefs p where p.user_id = v_other;
  if not coalesce(v_muted, false) and v_dms then
    insert into public.notifications (user_id, actor_id, kind, conv_id, meta)
      values (v_other, me, 'dm', p_conv, jsonb_build_object('preview', v_prev));
  end if;

  return jsonb_build_object('msg_id', v_mid, 'conv_id', p_conv, 'created_at', now());
end $$;
-- (待续5)

-- 会话列表：对方昵称 + 未读数 + 预览 + 我方状态，一次聚合（无 N+1）
-- 返回 [{conv_id, other_id, nickname, last_message_at, last_preview, created_at,
--        accepted, muted, hidden, blocked, unread}]，按最近动静新→旧
create or replace function public.dm_list_convs(p_limit integer default 100, p_offset integer default 0)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'auth-required'; end if;
  return coalesce((
    select jsonb_agg(q.x order by q.sort_at desc)
    from (
      select jsonb_build_object(
        'conv_id',        c.id,
        'other_id',       case when c.user_a = me then c.user_b else c.user_a end,
        'nickname',       p.nickname,
        'last_message_at', c.last_message_at,
        'last_preview',   c.last_preview,
        'created_at',     c.created_at,
        'accepted',       coalesce(s.accepted, true),
        'muted',          coalesce(s.muted, false),
        'hidden',         coalesce(s.hidden_until > now(), false),
        'blocked',        public.dm_is_blocked(me, case when c.user_a = me then c.user_b else c.user_a end),
        'unread', (select count(*) from public.dm_messages m
                    where m.conv_id = c.id and m.sender <> me
                      and m.deleted_at is null
                      and m.id > coalesce(s.last_read_id, 0))
      ) as x,
      coalesce(c.last_message_at, c.created_at) as sort_at
      from public.dm_conversations c
      join public.dm_states s on s.conv_id = c.id and s.user_id = me
      join public.profiles  p on p.id = (case when c.user_a = me then c.user_b else c.user_a end)
      where coalesce(s.hidden_until, '-infinity'::timestamptz) <= now()
        and not public.dm_is_blocked(me, case when c.user_a = me then c.user_b else c.user_a end)
      order by coalesce(c.last_message_at, c.created_at) desc
      limit least(coalesce(p_limit, 100), 200) offset greatest(coalesce(p_offset, 0), 0)
    ) q
  ), '[]'::jsonb);
end $$;

-- 消息分页：游标（p_before = 上一页最小 id）向上翻历史；返回新→旧，客户端反转
create or replace function public.dm_list_messages(p_conv bigint, p_before bigint default null, p_limit integer default 30)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'auth-required'; end if;
  if not exists (
    select 1 from public.dm_conversations c
     where c.id = p_conv and (c.user_a = me or c.user_b = me)
  ) then raise exception 'forbidden'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id',         m.id,
      'sender',     m.sender,
      'nickname',   p.nickname,
      'body',       case when m.deleted_at is null then m.body else '' end,
      'image_path', case when m.deleted_at is null then m.image_path else null end,
      'edited_at',  m.edited_at,
      'deleted_at', m.deleted_at,
      'created_at', m.created_at
    ) order by m.id desc)
    from (
      select * from public.dm_messages
       where conv_id = p_conv and (p_before is null or id < p_before)
       order by id desc
       limit least(coalesce(p_limit, 30), 100)
    ) m
    join public.profiles p on p.id = m.sender
  ), '[]'::jsonb);
end $$;

-- 单个会话的元信息（深链 /messages/:id 直接进入时用）
create or replace function public.dm_conv_meta(p_conv bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me      uuid := auth.uid();
  v_other uuid;
  s       public.dm_states;
begin
  if me is null then raise exception 'auth-required'; end if;
  select case when user_a = me then user_b else user_a end into v_other
    from public.dm_conversations where id = p_conv;
  if v_other is null then raise exception 'forbidden'; end if;
  select * into s from public.dm_states
   where conv_id = p_conv and user_id = me;
  return jsonb_build_object(
    'conv_id',  p_conv,
    'other_id', v_other,
    'nickname', (select nickname from public.profiles where id = v_other),
    'accepted', coalesce(s.accepted, true),
    'muted',    coalesce(s.muted, false),
    'hidden',   coalesce(s.hidden_until > now(), false),
    'blocked',  public.dm_is_blocked(me, v_other)
  );
end $$;
-- (待续6)

-- 已读水位：读到本会话最新一条（进入会话 / 收到新消息时调用）
create or replace function public.dm_mark_read(p_conv bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me    uuid := auth.uid();
  v_max bigint;
begin
  if me is null then raise exception 'auth-required'; end if;
  if not exists (
    select 1 from public.dm_conversations c
     where c.id = p_conv and (c.user_a = me or c.user_b = me)
  ) then raise exception 'forbidden'; end if;
  select coalesce(max(id), 0) into v_max from public.dm_messages where conv_id = p_conv;
  insert into public.dm_states (conv_id, user_id, last_read_id)
    values (p_conv, me, v_max)
    on conflict (conv_id, user_id) do update
      set last_read_id = greatest(public.dm_states.last_read_id, excluded.last_read_id);
  return jsonb_build_object('ok', true, 'last_read_id', v_max);
end $$;

-- 会话状态三件套：隐藏 / 取消隐藏 / 免打扰 / 接受请求（拒绝 = 隐藏，前端映射）
create or replace function public.dm_hide(p_conv bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'auth-required'; end if;
  update public.dm_states set hidden_until = 'infinity'::timestamptz
   where conv_id = p_conv and user_id = me;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.dm_unhide(p_conv bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'auth-required'; end if;
  update public.dm_states set hidden_until = null
   where conv_id = p_conv and user_id = me;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.dm_mute(p_conv bigint, p_on boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'auth-required'; end if;
  update public.dm_states set muted = coalesce(p_on, true)
   where conv_id = p_conv and user_id = me;
  return jsonb_build_object('ok', true, 'muted', coalesce(p_on, true));
end $$;

create or replace function public.dm_accept(p_conv bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'auth-required'; end if;
  update public.dm_states set accepted = true, hidden_until = null
   where conv_id = p_conv and user_id = me;
  return jsonb_build_object('ok', true);
end $$;

-- 撤回：作者本人、发出后 15 分钟内；清空内容并把（若仍是最新一条的）预览改成 ⟲
create or replace function public.dm_recall(p_msg bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me        uuid := auth.uid();
  v_conv    bigint;
  v_sender  uuid;
  v_created timestamptz;
  v_deleted timestamptz;
begin
  if me is null then raise exception 'auth-required'; end if;
  select conv_id, sender, created_at, deleted_at
    into v_conv, v_sender, v_created, v_deleted
    from public.dm_messages where id = p_msg;
  if not found then raise exception 'no-message'; end if;
  if v_sender <> me then raise exception 'forbidden'; end if;
  if v_deleted is not null then return jsonb_build_object('ok', true); end if;
  if v_created < now() - interval '15 minutes' then raise exception 'too-late'; end if;

  update public.dm_messages set deleted_at = now(), body = '', image_path = null
   where id = p_msg;
  -- 只有当它仍是最新一条活消息时才改预览，避免把别人刚回的内容盖掉
  update public.dm_conversations c
     set last_preview = '⟲'
   where c.id = v_conv
     and not exists (
       select 1 from public.dm_messages m2
        where m2.conv_id = v_conv and m2.id > p_msg and m2.deleted_at is null
     );
  return jsonb_build_object('ok', true, 'conv_id', v_conv);
end $$;
-- (待续7)

-- 拉黑 / 解除拉黑 / 名单（硬墙：双向禁发；我这边永久隐藏相关会话）
create or replace function public.dm_block(p_user uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'auth-required'; end if;
  if p_user is null or p_user = me then raise exception 'bad-target'; end if;
  insert into public.dm_blocks (blocker, blocked) values (me, p_user)
    on conflict (blocker, blocked) do nothing;
  -- 我这边把与该用户的会话永久隐藏（解除拉黑时恢复可见）
  update public.dm_states s set hidden_until = 'infinity'::timestamptz
    from public.dm_conversations c
   where c.id = s.conv_id and s.user_id = me
     and ((c.user_a = me and c.user_b = p_user) or (c.user_a = p_user and c.user_b = me));
  return jsonb_build_object('ok', true, 'blocked', p_user);
end $$;

create or replace function public.dm_unblock(p_user uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'auth-required'; end if;
  delete from public.dm_blocks where blocker = me and blocked = p_user;
  -- 解除隐藏（回到列表；对方仍看不到我，除非TA也解除）
  update public.dm_states s set hidden_until = null
    from public.dm_conversations c
   where c.id = s.conv_id and s.user_id = me
     and ((c.user_a = me and c.user_b = p_user) or (c.user_a = p_user and c.user_b = me));
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.dm_blocks()
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'auth-required'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'user_id', b.blocked, 'nickname', p.nickname, 'created_at', b.created_at
    ) order by b.created_at desc)
    from public.dm_blocks b
    join public.profiles p on p.id = b.blocked
    where b.blocker = me
  ), '[]'::jsonb);
end $$;

-- 未读总览（导航角标轮询用）：total + 待处理的「消息请求」数
create or replace function public.dm_unread_total()
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then return jsonb_build_object('total', 0, 'requests', 0); end if;
  return jsonb_build_object(
    'total', coalesce((
      select count(*) from public.dm_messages m
        join public.dm_states s on s.conv_id = m.conv_id and s.user_id = me
        join public.dm_conversations c on c.id = m.conv_id
       where m.sender <> me and m.deleted_at is null
         and m.id > coalesce(s.last_read_id, 0)
         and coalesce(s.hidden_until, '-infinity'::timestamptz) <= now()
         and not public.dm_is_blocked(me, case when c.user_a = me then c.user_b else c.user_a end)
    ), 0),
    'requests', coalesce((
      select count(*) from public.dm_states s
        join public.dm_conversations c on c.id = s.conv_id
       where s.user_id = me and coalesce(s.accepted, true) = false
         and coalesce(s.hidden_until, '-infinity'::timestamptz) <= now()
         and not public.dm_is_blocked(me, case when c.user_a = me then c.user_b else c.user_a end)
    ), 0)
  );
end $$;
-- (待续8)

-- ══════════════════ 通知中心 RPC ══════════════════

-- 分页：p_kinds = 逗号分隔的类型白名单（如 'comment,reply'；空 = 全部）；p_unread 只看未读
-- 返回 [{id, kind, actor_id, actor_name, post_id, comment_id, conv_id, meta,
--        read_at, created_at, post_body, comment_body, removed}]
create or replace function public.notif_page(p_offset integer default 0, p_limit integer default 30,
                                             p_kinds text default null, p_unread boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me      uuid := auth.uid();
  v_kinds text[];
begin
  if me is null then raise exception 'auth-required'; end if;
  if p_kinds is not null and btrim(p_kinds) <> '' then
    select array_agg(btrim(x)) into v_kinds
      from unnest(string_to_array(p_kinds, ',')) x where btrim(x) <> '';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id',           n.id,
      'kind',         n.kind,
      'actor_id',     n.actor_id,
      'actor_name',   ap.nickname,
      'post_id',      n.post_id,
      'comment_id',   n.comment_id,
      'conv_id',      n.conv_id,
      'meta',         n.meta,
      'read_at',      n.read_at,
      'created_at',   n.created_at,
      'post_body',    left(pp.body, 80),
      'comment_body', left(pc.body, 80),
      'removed',      coalesce(pp.removed, false)
    ) order by n.id desc)
    from (
      select * from public.notifications
       where user_id = me
         and (v_kinds is null or kind = any(v_kinds))
         and (coalesce(p_unread, false) = false or read_at is null)
       order by id desc
       limit least(coalesce(p_limit, 30), 100)
       offset greatest(coalesce(p_offset, 0), 0)
    ) n
    left join public.profiles      ap on ap.id = n.actor_id
    left join public.wall_posts    pp on pp.id = n.post_id
    left join public.wall_comments pc on pc.id = n.comment_id
  ), '[]'::jsonb);
end $$;

-- 各分类未读数（通知页角标 + 总角标；dm 红点以 dm_unread_total 为准）
create or replace function public.notif_unread()
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then
    return jsonb_build_object('total',0,'comments',0,'reactions',0,'pets',0,'dms',0,'system',0);
  end if;
  return jsonb_build_object(
    'total',     (select count(*) from public.notifications where user_id = me and read_at is null),
    'comments',  (select count(*) from public.notifications where user_id = me and read_at is null and kind in ('comment','reply')),
    'reactions', (select count(*) from public.notifications where user_id = me and read_at is null and kind in ('reaction','pet')),
    'pets',      (select count(*) from public.notifications where user_id = me and read_at is null and kind = 'pet'),
    'dms',       (select count(*) from public.notifications where user_id = me and read_at is null and kind = 'dm'),
    'system',    (select count(*) from public.notifications where user_id = me and read_at is null and kind = 'system')
  );
end $$;

-- 标记已读：p_all = 全部；否则按 id 列表（只动自己的行）
create or replace function public.notif_mark(p_ids bigint[] default null, p_all boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'auth-required'; end if;
  if coalesce(p_all, false) then
    update public.notifications set read_at = now()
     where user_id = me and read_at is null;
  elsif p_ids is not null and array_length(p_ids, 1) > 0 then
    update public.notifications set read_at = now()
     where user_id = me and read_at is null and id = any(p_ids);
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- 清空我的全部通知（通知页「清空」按钮；返回删除条数）
create or replace function public.notif_clear()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  v_n integer := 0;
begin
  if me is null then raise exception 'auth-required'; end if;
  with del as (
    delete from public.notifications where user_id = me returning 1
  )
  select count(*) into v_n from del;
  return jsonb_build_object('ok', true, 'removed', v_n);
end $$;

-- 通知偏好：读（缺行 = 全开）+ 写
create or replace function public.notif_prefs_get()
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'auth-required'; end if;
  return jsonb_build_object(
    'comments',  coalesce((select p.comments  from public.notification_prefs p where p.user_id = me), true),
    'reactions', coalesce((select p.reactions from public.notification_prefs p where p.user_id = me), true),
    'pets',      coalesce((select p.pets      from public.notification_prefs p where p.user_id = me), true),
    'dms',       coalesce((select p.dms       from public.notification_prefs p where p.user_id = me), true)
  );
end $$;

create or replace function public.notif_prefs_set(p_comments boolean default true, p_reactions boolean default true,
                                                  p_pets boolean default true, p_dms boolean default true)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'auth-required'; end if;
  insert into public.notification_prefs (user_id, comments, reactions, pets, dms, updated_at)
    values (me, coalesce(p_comments, true), coalesce(p_reactions, true),
            coalesce(p_pets, true), coalesce(p_dms, true), now())
    on conflict (user_id) do update
      set comments   = excluded.comments,
          reactions  = excluded.reactions,
          pets       = excluded.pets,
          dms        = excluded.dms,
          updated_at = now();
  return jsonb_build_object('ok', true);
end $$;

-- 管理员公告 → 全员 system 通知（复用 is_admin()；上限 5000 人防误伤）
create or replace function public.admin_broadcast(p_body text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me     uuid := auth.uid();
  v_n    integer := 0;
  v_body text;
begin
  if not exists (select 1 from public.admin_users where user_id = me) then
    return jsonb_build_object('admin', false);
  end if;
  v_body := left(btrim(coalesce(p_body, '')), 1000);
  if char_length(v_body) = 0 then raise exception 'empty-body'; end if;
  with ins as (
    insert into public.notifications (user_id, actor_id, kind, meta)
      select id, me, 'system', jsonb_build_object('body', v_body)
        from public.profiles
       order by created_at asc
       limit 5000
      returning 1
  )
  select count(*) into v_n from ins;
  return jsonb_build_object('admin', true, 'sent', v_n);
end $$;
-- (待续10)

-- ══════════════════ 通知触发器（挂现有表，AFTER INSERT） ══════════════════

-- 评论 / 回复：回复优先（@ 被回复者），帖主不重复收（同一人只发一条）
create or replace function public.notify_on_comment()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_owner       uuid;
  v_parent_user uuid;
  v_pref        boolean;
  v_actor       uuid := new.user_id;
  v_targets     uuid[] := array[]::uuid[];
  v_target      uuid;
begin
  select user_id into v_owner from public.wall_posts where id = new.post_id;
  if v_owner is null then return new; end if;
  if new.parent_id is not null then
    select user_id into v_parent_user from public.wall_comments where id = new.parent_id;
  end if;
  if v_parent_user is not null and v_parent_user <> v_actor then
    v_targets := v_targets || v_parent_user;
  end if;
  if v_owner <> v_actor and not (v_owner = any(v_targets)) then
    v_targets := v_targets || v_owner;
  end if;
  foreach v_target in array v_targets loop
    select coalesce(p.comments, true) into v_pref
      from public.notification_prefs p where p.user_id = v_target;
    if coalesce(v_pref, true) then
      insert into public.notifications (user_id, actor_id, kind, post_id, comment_id, meta)
        values (v_target, v_actor,
                case when v_target = v_parent_user then 'reply' else 'comment' end,
                new.post_id, new.id,
                jsonb_build_object('preview', left(new.body, 80)));
    end if;
  end loop;
  return new;
end $$;

drop trigger if exists notify_wall_comment_trg on public.wall_comments;
create trigger notify_wall_comment_trg
  after insert on public.wall_comments
  for each row execute function public.notify_on_comment();
-- (待续11)

-- 回应（抱抱/暖暖/同感）：只通知帖主、只在新回应时（toggle 的删除不触发）
create or replace function public.notify_on_reaction()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid;
  v_pref  boolean;
begin
  select user_id into v_owner from public.wall_posts where id = new.post_id;
  if v_owner is null or v_owner = new.user_id then return new; end if;
  select coalesce(p.reactions, true) into v_pref
    from public.notification_prefs p where p.user_id = v_owner;
  if coalesce(v_pref, true) then
    insert into public.notifications (user_id, actor_id, kind, post_id, meta)
      values (v_owner, new.user_id, 'reaction', new.post_id,
              jsonb_build_object('reaction', new.kind));
  end if;
  return new;
end $$;

drop trigger if exists notify_wall_reaction_trg on public.wall_reactions;
create trigger notify_wall_reaction_trg
  after insert on public.wall_reactions
  for each row execute function public.notify_on_reaction();

-- 宠物互动（摸摸头/投喂）：只通知主人、只统计登录访客（匿名 key 无归属）
create or replace function public.notify_on_pet()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_viewer uuid := auth.uid();
  v_pref   boolean;
begin
  if v_viewer is null or v_viewer = new.owner_id then return new; end if;
  select coalesce(p.pets, true) into v_pref
    from public.notification_prefs p where p.user_id = new.owner_id;
  if coalesce(v_pref, true) then
    insert into public.notifications (user_id, actor_id, kind, meta)
      values (new.owner_id, v_viewer, 'pet', jsonb_build_object('pet_kind', new.kind));
  end if;
  return new;
end $$;

drop trigger if exists notify_pet_interaction_trg on public.pet_interactions;
create trigger notify_pet_interaction_trg
  after insert on public.pet_interactions
  for each row execute function public.notify_on_pet();

-- 执行权限：与既有函数一致（anon 可达但一律被 auth-required 拦下）
grant execute on all functions in schema public to anon, authenticated;

-- ============================================================
-- 执行完毕。请在 Supabase SQL Editor 运行本文件，然后跑：
--   node tools/dm-test.mjs && node tools/notify-test.mjs
-- ============================================================

