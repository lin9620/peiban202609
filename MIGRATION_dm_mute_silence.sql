-- ============================================================
-- MIGRATION_dm_mute_silence.sql（免打扰真正生效：静音会话不进角标）
-- ------------------------------------------------------------
-- 实测现状（2026-11-07，线上库 probed）：
--   B 收到 2 条未读 → dm_unread_total 返回 total=2、convs=[{conv,2}]
--   B 调 dm_mute(true) → 再查 dm_unread_total 仍是 total=2，会话行 unread 仍是 2
--   notifications 里 kind=dm 的行数恒为 0
-- 原因有两层：
--   ① dm_unread_total / dm_list_convs 的未读计数**从不看** dm_states.muted；
--   ② 唯一读 muted 的地方是 dm_send / bottle_chat_decide 里的「要不要插 dm 通知」，
--      而 notifications_drop_dm 触发器会把 kind='dm' 的插入整条丢弃（#23 私信退出
--      通知中心）——那段 if 永远走不到落表，等于死代码。
--   于是「免打扰」变成一个纯装饰开关：点完只多一个静音小图标，红点、数字、导航
--   角标一个不少。用户报障「设置成免打扰了，为什么还有提示」即此。
--
-- 本次口径（产品决定）：
--   免打扰 = 别打扰我 → 该会话的未读**不进导航角标**、**不计入消息请求数**；
--   消息本身不丢：会话行仍显示一个无数字的灰点，点进去照常能看到全部未读。
--   （不把消息藏起来：静音不等于丢掉，用户随时能进去读。）
--
-- 只改 dm_unread_total 一个函数；dm_list_convs 的 unread 保持**事实值**不动 ——
-- 会话行的灰点就是靠它显示的（前端在 muted 时不再把数字渲染成红角标）。
-- 幂等，可重复执行。
-- ============================================================

create or replace function public.dm_unread_total()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me      uuid := auth.uid();
  v_rows  jsonb := '[]'::jsonb;
  v_total bigint := 0;
begin
  if me is null then
    return jsonb_build_object('total', 0, 'requests', 0, 'convs', '[]'::jsonb);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('conv_id', t.conv_id, 'unread', t.n) order by t.n desc), '[]'::jsonb),
         coalesce(sum(t.n), 0)
    into v_rows, v_total
    from (
      select m.conv_id, count(*) as n
        from public.dm_messages m
        join public.dm_states s on s.conv_id = m.conv_id and s.user_id = me
        join public.dm_conversations c on c.id = m.conv_id
       where m.sender <> me and m.deleted_at is null
         and m.id > coalesce(s.last_read_id, 0)
         and coalesce(s.hidden_until, '-infinity'::timestamptz) <= now()
         and not coalesce(s.muted, false)   -- 免打扰：这条会话的未读不进角标
         and not public.dm_is_blocked(me, case when c.user_a = me then c.user_b else c.user_a end)
       group by m.conv_id
    ) t;
  return jsonb_build_object(
    'total', v_total,
    'requests', coalesce((
      select count(*) from public.dm_states s
        join public.dm_conversations c on c.id = s.conv_id
       where s.user_id = me and coalesce(s.accepted, true) = false
         and coalesce(s.hidden_until, '-infinity'::timestamptz) <= now()
         and not coalesce(s.muted, false)   -- 免打扰：待处理的请求也不再催
         and not public.dm_is_blocked(me, case when c.user_a = me then c.user_b else c.user_a end)
    ), 0),
    'convs', v_rows
  );
end $$;

-- 权限与建函数时一致（create or replace 会保留，这里显式再钉一次）
comment on function public.dm_unread_total() is
  '未读总览；免打扰（dm_states.muted）的会话不计入 total / convs / requests（MIGRATION_dm_mute_silence.sql）';
