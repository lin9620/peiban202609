-- ============================================================
-- MIGRATION_dm_realtime.sql（轮 269 · 幂等；与前批迁移同批待跑）
-- 私信实时通道：dm_messages 加入 supabase_realtime publication —— A 发消息后
-- B 的 WebSocket 立刻收到 INSERT 事件（前台秒达 <1s，原轮询在看的会话 ~5s、
-- 别处 ~30s；用户问「A 发了 B 多久才收到通知」）。
-- 前提：Supabase 项目开启了 Realtime（默认开启）。前端没连上 = 静默降级轮询。
-- ALTER PUBLICATION 无 if not exists 语义：用 DO 块查目录表实现真幂等。
do $$
begin
  if not exists (
    select 1
      from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'dm_messages'
  ) then
    alter publication supabase_realtime add table public.dm_messages;
  end if;
end $$;
