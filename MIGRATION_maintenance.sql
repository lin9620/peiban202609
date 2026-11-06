-- ─────────────────────────────────────────────────────────────
-- 轮 444 · 维护/升级模式（管理中心可控，对用户干扰最小）
--
-- 设计要点（为什么不是「一键全站停机」）：
--   ① 三档而不是开关
--        off  正常
--        read 只读维护：浏览、看历史、翻榜单**全部照常**，只有「创作类写入」暂停
--        full 完全停机：连浏览也不放行（前端整页柔占位），只在真要动表结构/大迁移时用
--      绝大多数维护用 read 就够 —— 用户几乎无感，只是暂时发不了新内容。
--   ② 私信不在拦截范围（dm_messages 不挂触发器）
--      用户正聊到一半被掐断是最恼人的；私信也不参与内容审核/展示链路。
--   ③ 到期自动恢复（maintenance_until）
--      管理员忘记关闭也不会让站点永久维护 —— 这是最危险的运维事故。
--   ④ 管理员豁免
--      维护期间站主照样能发帖、能后台操作，便于验证修复效果。
--   ⑤ 服务端兜底
--      老版本客户端 / 直接打 API 的请求也会被 BEFORE INSERT 触发器拦下，
--      抛 'maintenance-mode'（errcode PT503）供前端识别成友好文案。
--
-- 幂等：全部 if not exists / create or replace / drop trigger if exists，可重复执行。
-- 回滚：drop table public.app_state cascade; drop function ...; drop trigger ...
-- ─────────────────────────────────────────────────────────────

-- ── ① 状态表（单行；id=1 的 check 保证永远只有一行，免得分页取错） ──
create table if not exists public.app_state (
  id integer primary key default 1 check (id = 1),
  maintenance_mode text not null default 'off' check (maintenance_mode in ('off', 'read', 'full')),
  maintenance_note text,               -- 自定义说明（空 = 用前端默认文案）
  maintenance_until timestamptz,       -- 预计结束时间；到点自动视为 off
  maintenance_started_at timestamptz,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
insert into public.app_state (id) values (1) on conflict (id) do nothing;

comment on table public.app_state is
  '站点运行时状态（单行）。maintenance_mode 三档维护开关；until 到点自动恢复，防止忘记关闭。';
comment on column public.app_state.maintenance_until is
  '预计结束时间。到点后 maintenance_active() 自动返回 off —— 忘了关也不会永久停机。';

-- ── ② 权限：所有人可读（要显示横幅），只有管理员可写 ──
alter table public.app_state enable row level security;

drop policy if exists app_state_read on public.app_state;
create policy app_state_read on public.app_state
  for select using (true);

drop policy if exists app_state_admin_write on public.app_state;
create policy app_state_admin_write on public.app_state
  for all using (public.is_admin()) with check (public.is_admin());

-- ── ③ 有效模式：把「到期」这件事收敛到一个函数里，客户端/触发器/RLS 共用 ──
create or replace function public.maintenance_active()
returns text
language sql stable security definer set search_path = public as $$
  select case
           when s.maintenance_mode = 'off' then 'off'
           when s.maintenance_until is not null and s.maintenance_until <= now() then 'off'
           else s.maintenance_mode
         end
    from public.app_state s
   where s.id = 1
$$;
comment on function public.maintenance_active() is
  '当前生效的维护档位（off/read/full）。until 过点即自动 off；表为空时也返回 off。';
grant execute on function public.maintenance_active() to anon, authenticated;

-- 写守卫：read / full 都禁止创作类写入；管理员豁免（维护期间要能自己验证）
create or replace function public.maintenance_blocks_write()
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.maintenance_active(), 'off') <> 'off'
     and not coalesce(public.is_admin(), false)
$$;
comment on function public.maintenance_blocks_write() is
  '维护期是否拦截创作类写入。管理员永远不拦（便于维护期间自测）。';
grant execute on function public.maintenance_blocks_write() to anon, authenticated;

-- ── ④ 写入兜底：BEFORE INSERT 触发器挂到「创作类」表上 ──
-- 为什么用触发器而不是改各个 RPC：bottle_send / story_publish 是 security definer，
-- 绕过 RLS，改 RPC 要重写整段配额/并发逻辑（风险高）；触发器在表上，RPC 也躲不过。
-- 只拦 INSERT：维护期间 view_count +1、点赞数修正这类 UPDATE 不该失败（会刷屏报错）。
create or replace function public.tg_maintenance_guard()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.maintenance_blocks_write() then
    raise exception 'maintenance-mode' using errcode = 'PT503';
  end if;
  return new;
end $$;
comment on function public.tg_maintenance_guard() is
  '维护期拦截创作类 INSERT。errcode PT503 便于前端识别成「正在升级」而不是通用错误。';

do $$
declare t text;
begin
  /* 内容创作类表（**刻意不含 dm_messages**：私信是私密对话，掐断最恼人，也不参与审核链路） */
  foreach t in array array[
    'wall_posts', 'wall_comments', 'wall_reactions', 'wall_favorites',
    'bottle_letters', 'bottle_fishes', 'bottle_reports',
    'stories', 'story_comments', 'story_likes', 'story_bookmarks', 'story_views',
    'reports'
  ] loop
    if exists (select 1 from pg_tables where schemaname = 'public' and tablename = t) then
      execute format('drop trigger if exists %I on public.%I', 'maint_guard_' || t, t);
      execute format(
        'create trigger %I before insert on public.%I for each row execute function public.tg_maintenance_guard()',
        'maint_guard_' || t, t);
    end if;
  end loop;
end $$;

-- ── ⑤ 管理员开/关维护（一个入口，参数校验在这里做） ──
create or replace function public.admin_set_maintenance(
  p_mode text,
  p_note text default null,
  p_until timestamptz default null
) returns public.app_state
language plpgsql security definer set search_path = public as $$
declare
  rec public.app_state;
  v_old text;
begin
  if not coalesce(public.is_admin(), false) then
    raise exception 'admin-only' using errcode = 'PT403';
  end if;
  if p_mode not in ('off', 'read', 'full') then
    raise exception 'maintenance-bad-mode';
  end if;

  select maintenance_mode into v_old from public.app_state where id = 1;

  update public.app_state
     set maintenance_mode = p_mode,
         maintenance_note = nullif(btrim(coalesce(p_note, '')), ''),
         /* 关的时候把 until 一起清掉，否则下次开维护会带着旧时间，一开就「已到期」 */
         maintenance_until = case when p_mode = 'off' then null else p_until end,
         /* 首次进入维护才记开始时间；read ↔ full 之间切换保留原起点（倒计时不跳） */
         maintenance_started_at = case
           when p_mode = 'off' then null
           when coalesce(v_old, 'off') = 'off' then now()
           else maintenance_started_at
         end,
         updated_at = now(),
         updated_by = auth.uid()
   where id = 1
  returning * into rec;

  return rec;
end $$;
comment on function public.admin_set_maintenance(text, text, timestamptz) is
  '管理中心「维护升级」按钮的唯一入口。p_mode: off/read/full；p_until 到点自动恢复。';
grant execute on function public.admin_set_maintenance(text, text, timestamptz) to authenticated;

-- ── ⑥ 让 Realtime 能把状态变化推给所有在线用户（横幅即时出现/消失，不用刷新） ──
do $$
begin
  begin
    alter publication supabase_realtime add table public.app_state;
  exception
    when duplicate_object then null;   -- 已在发布里
    when undefined_object then null;   -- 本地库没有 supabase_realtime 发布
  end;
end $$;

-- ── ⑦ 自检 ──
-- 期望：mode=off、blocks_write=false、单行、13 个触发器（12 张内容表 + 不含 dm）。
select maintenance_mode as 当前档位 from public.app_state where id = 1;
select public.maintenance_blocks_write() as 现在会拦截写入;
select count(*) as 触发器数 from pg_trigger
 where not tgisinternal and tgname like 'maint\_guard\_%';
