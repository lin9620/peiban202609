-- ═══════════════════════════════════════════════════════════════
--  迁移：私信退出通知中心（#23）
-- ------------------------------------------------------------
--  背景：私信有自己的聊天页（/messages + 导航 💬 角标），通知中心再列一遍
--        只会造成「外面没红点、点进通知里却有红点」的困惑。用户明确：
--        私信不要出现在通知里。
--  做法（一处拦住所有生成点，不重写任何复杂函数）：
--    ① 清掉历史 kind='dm' 的通知行；
--    ② BEFORE INSERT 触发器把 kind='dm' 的插入**静默丢弃**（RETURN NULL）——
--       dm_send / 漂流瓶触发器里的通知语句不用改，写进去的行直接不落表；
--    ③ notif_unread 的 total 从此自然不含 dm（表里已经不会有 dm 行）。
--  副作用说明：notification_prefs.dms 开关自此无效果（前端设置页已同步移除该开关）。
--  用法：Supabase Dashboard → SQL Editor → 粘贴全部 → Run（幂等，可重复执行）
-- ═══════════════════════════════════════════════════════════════

-- ① 历史 dm 通知一次性清理
delete from public.notifications where kind = 'dm';

-- ② 拦截未来写入：kind='dm' 的行静默丢弃（BEFORE INSERT RETURN NULL 不报错，
--    因此 dm_send / bottle 触发器整条事务不受影响，只是通知行不再生成）
create or replace function public.notifications_drop_dm()
returns trigger language plpgsql as $$
begin
  if new.kind = 'dm' then
    return null;   -- 私信有自己的入口（💬 + /messages），不再进通知中心
  end if;
  return new;
end $$;

drop trigger if exists notifications_drop_dm on public.notifications;
create trigger notifications_drop_dm
  before insert on public.notifications
  for each row execute function public.notifications_drop_dm();

comment on trigger notifications_drop_dm on public.notifications is
  '#23 私信退出通知中心：kind=dm 的通知行一律不落表（历史行已清理）';