-- ============================================================
-- MIGRATION_dm_unread_convs.sql（轮 268 · 幂等；与 MIGRATION_wall_search.sql 同批待跑）
-- dm_unread_total 增加行级未读明细 convs:[{conv_id,unread}] —— badge 请求（30s 轮询
-- + 角标本地缓存秒出）同时携带行级未读，会话列表行红点与顶/底部角标同时出现，
-- 不再等 dm_list_convs（用户报障「下面跟上面都有红点，中间的要等好几秒才出现」）。
-- total 改为由分组聚合求和（省一次同条件重复扫描）。
-- 不跑此迁移：前端降级为旧行为（行红点仍随会话列表出现），无报错。
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
         and not public.dm_is_blocked(me, case when c.user_a = me then c.user_b else c.user_a end)
    ), 0),
    'convs', v_rows
  );
end $$;
