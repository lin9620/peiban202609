-- 漂流瓶续聊：先执行 MIGRATION_dm_notifications.sql 与 MIGRATION_bottle.sql。
-- 回信通知 + 作者同意后关联私信；重复执行安全。不会为历史回信补发通知。
begin;
alter table public.bottle_letters add column if not exists conv_id bigint
  references public.dm_conversations(id) on delete set null;
alter table public.bottle_letters add column if not exists chat_decision text
  not null default 'pending' check (chat_decision in ('pending', 'accepted', 'declined'));

-- 回复事件与通知在同一事务中；不依赖页面是否在线。
create or replace function public.bottle_notify_reply()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'answered' and old.status <> 'answered' and new.reply_by is not null then
    if not public.dm_is_blocked(new.user_id, new.reply_by)
       and not public.dm_is_blocked(new.reply_by, new.user_id)
       and coalesce((select dms from public.notification_prefs where user_id = new.user_id), true) then
      insert into public.notifications(user_id, actor_id, kind, meta)
      values (new.user_id, new.reply_by, 'dm', jsonb_build_object(
        'event', 'bottle_reply', 'bottle_id', new.id, 'preview', left(new.reply, 80)));
    end if;
  end if;
  return new;
end $$;
drop trigger if exists bottle_reply_notification on public.bottle_letters;
create trigger bottle_reply_notification after update on public.bottle_letters
  for each row execute function public.bottle_notify_reply();

-- 只有原信作者能决定是否续聊。锁信件行，事务失败则消息/状态整体回滚。
create or replace function public.bottle_chat_decide(p_id uuid, p_accept boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  letter public.bottle_letters;
  cid bigint;
  opened jsonb;
begin
  if me is null then raise exception 'bottle-auth'; end if;
  if p_accept is null then raise exception 'bottle-bad-decision'; end if;
  select * into letter from public.bottle_letters where id = p_id for update;
  if not found or letter.user_id <> me then raise exception 'bottle-not-owner'; end if;
  if letter.status <> 'answered' or letter.reply_by is null or letter.reply_by = me then
    raise exception 'bottle-not-answered';
  end if;
  if letter.chat_decision = 'accepted' and letter.conv_id is not null then
    return jsonb_build_object('conv_id', letter.conv_id, 'decision', 'accepted');
  end if;
  if letter.chat_decision = 'declined' then
    return jsonb_build_object('conv_id', null, 'decision', 'declined');
  end if;
  if not p_accept then
    update public.bottle_letters set chat_decision = 'declined' where id = p_id;
    return jsonb_build_object('conv_id', null, 'decision', 'declined');
  end if;
  if public.dm_is_blocked(me, letter.reply_by) or public.dm_is_blocked(letter.reply_by, me) then
    raise exception 'bottle-chat-blocked';
  end if;
  opened := public.dm_open(letter.reply_by);
  cid := (opened->>'conv_id')::bigint;
  -- 同一对用户的多个瓶子按会话串行导入，不会交叉更新会话预览。
  perform 1 from public.dm_conversations where id = cid for update;
  insert into public.dm_messages(conv_id, sender, body, created_at)
    values (cid, me, letter.body, letter.created_at);
  insert into public.dm_messages(conv_id, sender, body, created_at)
    values (cid, letter.reply_by, letter.reply, letter.reply_at);
  update public.dm_conversations set last_message_at = now(), last_preview = left(letter.reply, 80)
    where id = cid;
  insert into public.dm_states(conv_id, user_id, accepted)
    values (cid, me, true), (cid, letter.reply_by, true)
    on conflict (conv_id, user_id) do update set accepted = true, hidden_until = null;
  update public.bottle_letters set conv_id = cid, chat_decision = 'accepted' where id = p_id;
  if coalesce((select dms from public.notification_prefs where user_id = letter.reply_by), true)
     and not coalesce((select muted from public.dm_states where conv_id = cid and user_id = letter.reply_by), false) then
    insert into public.notifications(user_id, actor_id, kind, conv_id, meta)
      values (letter.reply_by, me, 'dm', cid, jsonb_build_object(
        'event', 'bottle_chat', 'bottle_id', p_id, 'preview', left(letter.body, 80)));
  end if;
  return jsonb_build_object('conv_id', cid, 'decision', 'accepted');
end $$;

-- 独立记录分页，深链按 ID 取单条；只返回参与者自己的信件。
create or replace function public.bottle_records(p_id uuid default null, p_offset integer default 0)
returns setof public.bottle_letters language sql stable security definer set search_path = public as $$
  select * from public.bottle_letters
   where (user_id = auth.uid() or reply_by = auth.uid())
     and (p_id is null or id = p_id)
   order by coalesce(reply_at, created_at) desc, id
   limit 30 offset greatest(coalesce(p_offset, 0), 0)
$$;
revoke all on function public.bottle_notify_reply() from public, anon, authenticated;
revoke all on function public.bottle_chat_decide(uuid, boolean) from public, anon;
revoke all on function public.bottle_records(uuid, integer) from public, anon;
grant execute on function public.bottle_chat_decide(uuid, boolean) to authenticated;
grant execute on function public.bottle_records(uuid, integer) to authenticated;
commit;
