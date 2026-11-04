-- ═══════════════════════════════════════════════════════════════
--  Warm Paws · 暖爪 — 增量迁移：帖子回应改成服务端原子写入
--  用法：Supabase Dashboard → SQL Editor → 粘贴全部 → Run
--  幂等：可重复执行（CREATE OR REPLACE）
--  已建过库的老用户跑这一份即可；新用户跑 SUPABASE_SETUP.sql（已含同样内容）
-- ═══════════════════════════════════════════════════════════════
--
-- 【要解决什么】
--   帖级回应（抱抱 hug / 暖暖 warm / 同感 relate）此前是**客户端先查再写**：
--     findReaction（查有没有点过） → insertReaction / deleteReaction
--   「查」和「写」之间有时间窗，并发下会出事：
--     ① 同用户多设备同时点 → 两边都查到「没点过」→ 都 insert → 一边撞唯一键 23505
--        （前端把 23505 当成功处理，结果对，但白跑一趟）；
--     ② **查询失败被当成「没点过」**（catch 里吞掉）→ 用户点「取消抱抱」，
--        但那次查询恰好失败 → 跳过 delete → 库里那行还在 → 界面显示已取消、
--        服务端仍算已回应。**静默不一致**，比计数漂移更难发现。
--
-- 【为什么计数不用管】
--   动态流计数走 wall_feed_page RPC，SQL 里实时 GROUP BY 聚合，不存冗余计数列
--   → 天然无漂移。本迁移只管「谁点过」这件事的写入原子性。
--
-- 【口径与既有 RPC 对齐】
--   与 wall_toggle_dislike / wall_toggle_comment_reaction 同思路：
--     幂等「设置」语义（不是 toggle）、on conflict do nothing、计数由服务端算。
--   区别：本 RPC **不写任何冗余列**（hug/warm/relate 本来就没有冗余列）。

-- ── 1) 原子设置回应 ───────────────────────────────────────────
--    p_on = true  → 确保存在（重复点当成功）
--    p_on = false → 确保不存在
--    返回 {ok, on, counts:{hug,warm,relate}, mine:{...}}：
--      counts = 该帖三种回应的服务端权威计数
--      mine   = 我在这三种回应上的状态
--    ⚠ 只认 hug/warm/relate —— dislike（厌恶）走 wall_toggle_dislike，
--      因为它还带「达到阈值自动下架」的副作用，语义不同、不能混在一个函数里。
create or replace function public.wall_set_reaction(p_post bigint, p_kind text, p_on boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_on     boolean;
  v_counts jsonb;
  v_mine   jsonb;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'reason', 'auth-required');
  end if;

  if p_kind is null or p_kind not in ('hug', 'warm', 'relate') then
    return jsonb_build_object('ok', false, 'reason', 'bad-kind');
  end if;

  -- 幂等设置：不存在则插入（并发下同一用户重复插入由主键挡掉，on conflict 不报错）
  if p_on then
    insert into public.wall_reactions (post_id, user_id, kind)
    values (p_post, v_uid, p_kind)
    on conflict (post_id, user_id, kind) do nothing;
    v_on := true;
  else
    delete from public.wall_reactions
      where post_id = p_post and user_id = v_uid and kind = p_kind;
    v_on := false;
  end if;

  -- 服务端权威计数（不信前端传来的数字）
  select jsonb_build_object(
           'hug',    count(*) filter (where kind = 'hug'),
           'warm',   count(*) filter (where kind = 'warm'),
           'relate', count(*) filter (where kind = 'relate')
         ),
         jsonb_build_object(
           'hug',    exists (select 1 from public.wall_reactions r
                              where r.post_id = p_post and r.user_id = v_uid and r.kind = 'hug'),
           'warm',   exists (select 1 from public.wall_reactions r
                              where r.post_id = p_post and r.user_id = v_uid and r.kind = 'warm'),
           'relate', exists (select 1 from public.wall_reactions r
                              where r.post_id = p_post and r.user_id = v_uid and r.kind = 'relate')
         )
    into v_counts, v_mine
    from public.wall_reactions
   where post_id = p_post and kind in ('hug', 'warm', 'relate');

  return jsonb_build_object('ok', true, 'on', v_on, 'counts', v_counts, 'mine', v_mine);
end $$;

-- ── 2) 授权 ───────────────────────────────────────────────────
--    只给登录用户调用（函数内部用 auth.uid() 当操作者身份，
--    不接受调用方传 user_id —— 免得有人替别人点回应）。
--    revoke 先收干净再 grant，避免旧库残留的宽松授权。
revoke all on function public.wall_set_reaction(bigint, text, boolean) from public;
revoke all on function public.wall_set_reaction(bigint, text, boolean) from anon;
grant execute on function public.wall_set_reaction(bigint, text, boolean) to authenticated;
