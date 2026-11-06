-- ============================================================
-- MIGRATION_notif_prefs_clear.sql（关掉通知偏好后，已堆着的红点必须当场消）
-- ------------------------------------------------------------
-- 用户报障：「设置里把评论 / 回应 / 宠物通知关掉，实际上也没有效果」。
--
-- 实测（2026-11-07，两个临时账号，线上库）：
--   ① 生成侧**是好的** —— 关掉三类偏好后再有人评论 / 回应 / 摸宠物，
--      notifications 一行都不落（3 行 → 3 行，新增类型 []）；
--   ② 但**已经堆着的未读一条都没动** —— notif_unread 仍返回关闭前的数字
--      （total=5、comments=2、reactions=3），notif_page 照样列出那 5 条未读，
--      导航铃铛红点纹丝不动。
--   用户看到的「没效果」是 ②：他在设置里点下开关的那一刻，界面没有任何变化。
--
-- 本迁移只补 ②：某类由「开」变「关」时，把该类**还没读**的通知标记已读
--   （read_at = now()）。历史记录仍留在通知列表里（变成已读态），不删数据。
--   重新打开开关不会把旧通知复活成未读 —— 关闭时你已经表示「这类不用提醒我了」。
--
-- 口径对齐：
--   comments  → kind in ('comment','reply')   （回帖也算评论类）
--   reactions → kind = 'reaction'
--   pets      → kind = 'pet'
--   dm 已退出通知中心（notifications_drop_dm），不处理。
-- 幂等，可重复执行。
-- ============================================================

create or replace function public.notif_prefs_set(
  p_comments  boolean default true,
  p_reactions boolean default true,
  p_pets      boolean default true,
  p_dms       boolean default true)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  v_old_comments  boolean;
  v_old_reactions boolean;
  v_old_pets      boolean;
begin
  if me is null then raise exception 'auth-required'; end if;

  /* 缺行 = 全开（与 notif_prefs_get、各通知触发器的口径一致） */
  select p.comments, p.reactions, p.pets
    into v_old_comments, v_old_reactions, v_old_pets
    from public.notification_prefs p where p.user_id = me;

  insert into public.notification_prefs (user_id, comments, reactions, pets, dms, updated_at)
    values (me, coalesce(p_comments, true), coalesce(p_reactions, true),
            coalesce(p_pets, true), coalesce(p_dms, true), now())
    on conflict (user_id) do update
      set comments   = excluded.comments,
          reactions  = excluded.reactions,
          pets       = excluded.pets,
          dms        = excluded.dms,
          updated_at = now();

  /* 由开 → 关：该类未读立刻作废（红点当场消），历史行保留为已读态。
   * 只在「真的从开变关」时执行 —— 反复保存同一个关状态不会把之后新来的未读也抹掉。 */
  if coalesce(v_old_comments, true) and not coalesce(p_comments, true) then
    update public.notifications set read_at = now()
     where user_id = me and read_at is null and kind in ('comment', 'reply');
  end if;
  if coalesce(v_old_reactions, true) and not coalesce(p_reactions, true) then
    update public.notifications set read_at = now()
     where user_id = me and read_at is null and kind = 'reaction';
  end if;
  if coalesce(v_old_pets, true) and not coalesce(p_pets, true) then
    update public.notifications set read_at = now()
     where user_id = me and read_at is null and kind = 'pet';
  end if;

  return jsonb_build_object('ok', true);
end $$;

-- 一次性校准：修复此前「已经关掉偏好、但对应未读还挂着」的历史遗留
-- （线上已有一条 reactions=false 的偏好行，按旧逻辑它的红点一直没消）
update public.notifications n
   set read_at = now()
 where n.read_at is null
   and exists (
     select 1 from public.notification_prefs p
      where p.user_id = n.user_id
        and (
          (n.kind in ('comment', 'reply') and p.comments = false)
          or (n.kind = 'reaction'            and p.reactions = false)
          or (n.kind = 'pet'                 and p.pets = false)
        )
   );
