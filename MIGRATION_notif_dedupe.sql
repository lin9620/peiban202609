-- 通知降噪（用户反馈：「点了抱抱又取消、又点又取消，怎么那么多通知」「一进去十几条通知」）
-- ------------------------------------------------------------
-- 前置：已执行 MIGRATION_dm_notifications.sql（本文件只替换两个触发器函数 + 新增一个撤销触发器）。
-- 可重复执行；末尾会把历史重复行收拾干净。
--
-- 三条规则（与前端 NotificationsView 的聚合展示互补）：
--   1) 回应（抱抱/暖暖/同感）：同一人对同一条帖的同一种回应，**未读只留最新一条**
--      —— 反复点/取消不会把收件人的未读角标刷上去；
--   2) 取消回应（delete 行）：顺手删掉那条还没读的通知 —— 取消就等于「没发生过」，
--      不留一条「谁抱了你」的假消息（这是用户最直接的抱怨）；
--   3) 宠物互动（摸摸头/投喂）：同一访客对同一主人在 24 小时内同一种动作只留一条未读
--      —— 连点十下摸头，主人只看到一条。
-- 已读的历史行保留（那是用户看过的记录，不该被抹掉）。
begin;

-- 1) 回应：先删旧未读（同 actor + 同帖 + 同种类），再插新的
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
    /* 降噪：同一人对同一条帖的同一类回应，未读只保留最新一条 */
    delete from public.notifications
     where user_id = v_owner
       and actor_id = new.user_id
       and kind = 'reaction'
       and post_id = new.post_id
       and coalesce(meta->>'reaction', '') = new.kind
       and read_at is null;
    insert into public.notifications (user_id, actor_id, kind, post_id, meta)
      values (v_owner, new.user_id, 'reaction', new.post_id,
              jsonb_build_object('reaction', new.kind));
  end if;
  return new;
end $$;

-- 2) 取消回应：把对应的未读通知一起撤掉（取消 = 没发生过）
create or replace function public.notify_on_reaction_undo()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  delete from public.notifications
   where user_id = (select user_id from public.wall_posts where id = old.post_id)
     and actor_id = old.user_id
     and kind = 'reaction'
     and post_id = old.post_id
     and coalesce(meta->>'reaction', '') = old.kind
     and read_at is null;
  return old;
end $$;

drop trigger if exists notify_wall_reaction_undo_trg on public.wall_reactions;
create trigger notify_wall_reaction_undo_trg
  after delete on public.wall_reactions
  for each row execute function public.notify_on_reaction_undo();

-- 3) 宠物互动：同一访客 + 同一动作，24 小时内未读只留一条
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
    delete from public.notifications
     where user_id = new.owner_id
       and actor_id = v_viewer
       and kind = 'pet'
       and coalesce(meta->>'pet_kind', '') = new.kind
       and read_at is null
       and created_at > now() - interval '24 hours';
    insert into public.notifications (user_id, actor_id, kind, meta)
      values (new.owner_id, v_viewer, 'pet', jsonb_build_object('pet_kind', new.kind));
  end if;
  return new;
end $$;

-- 4) 历史数据清理：把已经堆起来的重复「未读」通知按同样口径合掉
do $$
declare
  v_reaction int;
  v_pet      int;
begin
  delete from public.notifications n
   using public.notifications m
   where n.kind = 'reaction' and m.kind = 'reaction'
     and n.user_id = m.user_id and n.actor_id = m.actor_id
     and n.post_id = m.post_id
     and coalesce(n.meta->>'reaction', '') = coalesce(m.meta->>'reaction', '')
     and n.read_at is null and m.read_at is null
     and n.id < m.id;
  get diagnostics v_reaction = row_count;

  delete from public.notifications n
   using public.notifications m
   where n.kind = 'pet' and m.kind = 'pet'
     and n.user_id = m.user_id and n.actor_id = m.actor_id
     and coalesce(n.meta->>'pet_kind', '') = coalesce(m.meta->>'pet_kind', '')
     and n.read_at is null and m.read_at is null
     and n.created_at > m.created_at - interval '24 hours'
     and n.id < m.id;
  get diagnostics v_pet = row_count;

  raise notice 'notif dedupe: reaction=% pet=%', v_reaction, v_pet;
end $$;

revoke all on function public.notify_on_reaction_undo() from public, anon, authenticated;
grant execute on all functions in schema public to anon, authenticated;
commit;

-- ============================================================
-- 执行完毕。请在 Supabase SQL Editor 运行本文件，然后跑：
--   node tools/notify-test.mjs && node tools/dm-test.mjs
