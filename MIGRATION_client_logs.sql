-- ============================================================
-- MIGRATION_client_logs.sql —— 轮 270 · 客户端错误信标落库 + 管理中心可查
-- 在 Supabase SQL Editor 里**整段**复制执行（可重复跑，全段幂等）。
--
-- 背景：轮 256 建了前端 utils/beacon.js（未捕获错误 / unhandledrejection → POST /api/client-log），
--       但 Worker 那头只有 console.log —— 日志进 Cloudflare 临时日志区，不落库、没有查询界面。
--       结果是「采得到、看不到、回溯不了」：真出问题时只能开着 wrangler tail 现场等它再崩一次。
--       本轮补上「落库 + 管理中心查看」。
--
-- 口径：
--   · 写入方是 Worker 代发的**匿名**信标。Worker 只持有 SUPABASE_URL + SUPABASE_ANON_KEY，
--     **没有 service role**（见 worker/api.js 的 outboundHeaders），所以写入必须走
--     security definer RPC 并授给 anon —— 与本项目「写入一律收口在 RPC、表不给直连策略」一致。
--   · 表启用 RLS 但**不建任何策略**：普通用户与匿名都碰不到原始表，读写只走 RPC。
--   · **不记录 user_id**：信标按轮 256 的口径不带任何凭据字段（app-shell-test T65 钉住），
--     Worker 侧也不反查身份——避免把「无声上报」变成「可关联到具体用户的上报」。
--     真要定位到人，走 route + stack + ua 组合，或另开一轮专门讨论。
--   · 防灌三闸（层层兜底，超了静默丢弃，绝不向客户端报错、绝不阻塞业务）：
--       ① Worker 侧每 IP 每 60s 20 条（轮 256 已有，内存窗，随隔离实例重启）
--       ② 本文件每 IP 每 UTC 日 200 条（持久窗，重启也认）
--       ③ 全局每 UTC 日 5000 条（防某个客户端疯转把表刷爆）
-- ============================================================

-- ─────────────────────────────────────────────
-- 1) 客户端错误日志表
--    ip 只存 cf-connecting-ip（限频用），与 profiles 无任何关联、无外键。
-- ─────────────────────────────────────────────
create table if not exists public.client_logs (
  id         bigserial primary key,
  kind       text not null default 'err' check (kind in ('err','rej')),
  msg        text not null default '',
  route      text not null default '',
  stack      text not null default '',
  ua         text not null default '',
  ip         text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists client_logs_id_desc_idx  on public.client_logs (id desc);
create index if not exists client_logs_kind_idx     on public.client_logs (kind, id desc);
create index if not exists client_logs_created_idx  on public.client_logs (created_at desc);

-- RLS 全开 + 零策略：原始表对所有人不可见，只经 RPC
alter table public.client_logs enable row level security;

-- ─────────────────────────────────────────────
-- 2) 写入（Worker 代发匿名信标 → 授 anon）
--    字段在这里**再夹一次**（Worker 已经夹过）：纵深防御，RPC 也可能被直接调用。
--    返回 {ok:true,kept:true} / {ok:true,kept:false,reason:'ip-daily'|'global-daily'}
--    —— 无论丢没丢都回 ok:true，客户端永远不需要重试。
-- ─────────────────────────────────────────────
create or replace function public.client_log_write(
  p_kind  text,
  p_msg   text,
  p_route text,
  p_stack text,
  p_ua    text,
  p_ip    text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kind  text := case when lower(coalesce(p_kind,'')) = 'rej' then 'rej' else 'err' end;
  v_ip    text := left(coalesce(p_ip,''), 60);
  /* UTC 当日起点：必须显式落到 timestamptz —— `date AT TIME ZONE 'utc'` 得到的是
     **无时区**的 timestamp，直接拿去和 timestamptz 比会被「会话时区」再解释一遍
     （Supabase 默认 UTC，但不该赌这个）。`timestamp AT TIME ZONE 'utc'` 才返回 timestamptz。 */
  v_from  timestamptz := ((now() at time zone 'utc')::date)::timestamp at time zone 'utc';
  v_ip_n  bigint;
  v_all_n bigint;
begin
  -- 防灌闸②：每 IP 每 UTC 日 200 条
  select count(*) into v_ip_n from public.client_logs
   where ip = v_ip and created_at >= v_from;
  if v_ip_n >= 200 then
    return jsonb_build_object('ok', true, 'kept', false, 'reason', 'ip-daily');
  end if;

  -- 防灌闸③：全局每 UTC 日 5000 条
  select count(*) into v_all_n from public.client_logs
   where created_at >= v_from;
  if v_all_n >= 5000 then
    return jsonb_build_object('ok', true, 'kept', false, 'reason', 'global-daily');
  end if;

  insert into public.client_logs (kind, msg, route, stack, ua, ip)
  values (
    v_kind,
    left(btrim(coalesce(p_msg,'')),   300),
    left(btrim(coalesce(p_route,'')), 120),
    left(btrim(coalesce(p_stack,'')), 1200),
    left(btrim(coalesce(p_ua,'')),    160),
    v_ip
  );

  return jsonb_build_object('ok', true, 'kept', true);
end $$;

revoke all on function public.client_log_write(text, text, text, text, text, text) from public, anon;
grant execute on function public.client_log_write(text, text, text, text, text, text) to anon, authenticated;

-- ─────────────────────────────────────────────
-- 3) 管理端读取（仅管理员；非管理员得到 {admin:false}，不泄露任何内容）
--    一次返回两样，省一轮往返：
--      · items —— 最新 N 条原始日志（按 id 倒序，分页）
--      · top   —— 按 (msg, route) 聚合的 Top 20：出现次数 + 最近一次时间。
--                 这才是「能用」的形态：一屏看清「哪个错误炸了 47 次」，
--                 而不是在几百条原始行里自己数。
-- ─────────────────────────────────────────────
create or replace function public.admin_clientlog_page(
  p_offset integer default 0,
  p_limit  integer default 50
)
returns jsonb
language plpgsql
stable security definer
set search_path = public
as $$
declare
  v_total bigint;
begin
  if not exists (select 1 from public.admin_users where user_id = auth.uid()) then
    return jsonb_build_object('admin', false, 'total', 0, 'items', '[]'::jsonb, 'top', '[]'::jsonb);
  end if;

  select count(*) into v_total from public.client_logs;

  return jsonb_build_object(
    'admin', true,
    'total', v_total,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id,
               'kind', c.kind,
               'msg', c.msg,
               'route', c.route,
               'stack', c.stack,
               'ua', c.ua,
               'ip', c.ip,
               'created_at', c.created_at
             ) order by c.id desc)
      from (select *
              from public.client_logs
             order by id desc
             limit least(greatest(coalesce(p_limit, 50), 1), 200)
            offset greatest(coalesce(p_offset, 0), 0)) c
    ), '[]'::jsonb),
    'top', coalesce((
      select jsonb_agg(jsonb_build_object(
               'msg', s.msg,
               'route', s.route,
               'n', s.n,
               'last_at', s.last_at
             ) order by s.n desc, s.last_at desc)
      from (select left(msg, 160) as msg,
                   route,
                   count(*) as n,
                   max(created_at) as last_at
              from public.client_logs
             group by left(msg, 160), route
             order by count(*) desc, max(created_at) desc
             limit 20) s
    ), '[]'::jsonb)
  );
end $$;

revoke all on function public.admin_clientlog_page(integer, integer) from public, anon;
grant execute on function public.admin_clientlog_page(integer, integer) to authenticated;

-- ============================================================
-- 执行完毕。验证：
--   · 本文件应全部无报错
--   · 前端 / 管理端未跑迁移时的表现（**必须是降级可用，不能报错**）：
--       POST /api/client-log 仍返回 {ok:true}（Worker 侧已夹好字段，只是没落库）；
--       管理中心「客户端错误」页签显示空列表。
--   · 线上探针：client_log_write 对匿名应报 42501（存在无权）还是能写？
--     —— 本函数**授给了 anon**，匿名可写（这正是设计：信标本来就匿名）。
--     admin_clientlog_page 对匿名应报 42501（存在无权），而不是 PGRST202（不存在）。
-- ============================================================
