-- ═══════════════════════════════════════════════════════════════
--  迁移：首次会话限制（#22）
--  从暖心墙主页发起的第一次会话：对方回复之前，先发起方最多发 3 条；
--  对方一回复即解锁正常聊天。漂流瓶续聊导入的会话双方各有一条消息，天然解锁。
--  已撤回的消息不计数；错误码 first-limit 由前端映射成提示文案。
--  用法：Supabase Dashboard → SQL Editor → 粘贴全部 → Run（幂等，可重复执行）
--  前置：已执行 MIGRATION_dm_notifications.sql（本文件只替换 dm_send 一个函数）
-- ═══════════════════════════════════════════════════════════════

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

  -- #22 首次会话限制：对方从没回过时，先发起的一方最多发 3 条（防骚扰；对方一回复即解锁）。
  -- 漂流瓶续聊导入的会话双方各有一条消息，天然解锁，不受影响；已撤回的不计数。
  if not exists (
    select 1 from public.dm_messages
     where conv_id = p_conv and sender = v_other and deleted_at is null
  ) then
    if (select count(*) from public.dm_messages
         where conv_id = p_conv and sender = me and deleted_at is null) >= 3 then
      raise exception 'first-limit';
    end if;
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
  -- 注意：PL/pgSQL 的 SELECT INTO 在「无行」时把 NULL 赋给目标 —— 必须在赋值后再兜底，
  -- 否则没建偏好行的新用户（select 无行 → v_dms=NULL → if NULL 走 else）永远收不到私信通知。
  select coalesce(s.muted, false) into v_muted
    from public.dm_states s where s.conv_id = p_conv and s.user_id = v_other;
  v_muted := coalesce(v_muted, false);
  select p.dms into v_dms
    from public.notification_prefs p where p.user_id = v_other;
  v_dms := coalesce(v_dms, true);
  if not v_muted and v_dms then
    insert into public.notifications (user_id, actor_id, kind, conv_id, meta)
      values (v_other, me, 'dm', p_conv, jsonb_build_object('preview', v_prev));
  end if;

  return jsonb_build_object('msg_id', v_mid, 'conv_id', p_conv, 'created_at', now());
end $$;
