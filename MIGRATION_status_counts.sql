-- ═══════════ 轮 300 · 大厅四类人数合并成一次查询 ═══════════
-- status_counts(p_since)：一条 SQL 数完四类人数，返回 4 行（0 人的状态也返回，cnt = 0）。
--
-- 之前：直连模式由 db.supabase.js 发 4 次 HEAD + prefer:count=exact（4 个来回、扫 4 次 profiles）；
--       网关模式由 worker/api.js 同样发 4 次上游 HEAD，仍然只是把 4 次合并成 1 次对外请求。
--       TodayPane 轮 291 注释里记着实测：这 4 条 head-count 约 1.25s，叠在 PATCH 落库之后，
--       点一下状态到数字变要 2118ms。
-- 现在：一条查询出全部四类 —— VALUES 造出四行状态骨架，LEFT JOIN profiles 聚合，
--       4 个来回变 1 个，4 次扫表变 1 次。
--
-- 口径与旧链路逐条对齐：
--   * 只数 status_at >= p_since 的行（新鲜窗口由调用方算好传进来，与旧的 gte 过滤同源）；
--   * 四类固定返回、顺序固定 working → studying → sleepless → chilling（前端按行渲染，顺序要稳）；
--   * LEFT JOIN 保证某一类 0 人时照样出这一行，不会少行；
--   * **不写 security definer**（Postgres 默认 = security invoker）：RLS 照常生效，
--     调用方能看到哪些 profiles 行，数出来就是哪些 —— 与旧的 4 次 HEAD 完全同口径。
--     若改成 definer，匿名与登录用户的可见范围会变，人数就和以前对不上了。
--
-- 安全：只读、无副作用、stable；参数只有一个 timestamptz；返回的只有 status 与数字，
--       不含任何用户身份字段（与旧链路「大厅只返回精确人数」的约定一致）。
--
-- 降级：**本迁移没跑之前，页面照常工作** —— 前端与 Worker 都会自动退回旧的 4 次精确计数
--       （判定复用 authRules.isMissingFnError：只认「函数还没建」PGRST202/42883，
--        别的错误照旧上抛，绝不把「取不到」冒充成 0 人）。跑完后前端自动切到单查询，
--       不用改任何前端代码、不用发版前先部署。
--
-- 执行：SQL Editor 里粘贴全部内容 → Run。幂等，可重复跑（create or replace 只换函数体）。

create or replace function public.status_counts(p_since timestamptz)
returns table (status text, cnt bigint)
language sql
stable
as $$
  /* 函数体用 $1 引用参数（= 签名里的 p_since）：位置引用在 SQL 函数里无歧义，
     不必赌「参数名在函数体内是否被当作列名解析」。PostgREST 按 pg_proc 的
     proargnames 收 {p_since}，与前端 rpc("status_counts",{p_since}) 对齐。 */
  select k.status, count(p.id) as cnt
  from (values ('working'), ('studying'), ('sleepless'), ('chilling')) as k(status)
  left join public.profiles p
    on p.status = k.status
   and p.status_at >= $1
  group by k.status
  order by array_position(array['working', 'studying', 'sleepless', 'chilling'], k.status);
$$;

grant execute on function public.status_counts(timestamptz) to anon, authenticated;
