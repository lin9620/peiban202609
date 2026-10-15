-- 轮 302：浏览计数批量化 —— 20 次 wall_add_view 合成 1 次 wall_add_views
-- ============================================================================
-- 起因（免费额度实测，2026-10 官方文档 + 线上抓包）：
--   暖心墙首屏 = 1× wall_feed_page + **20× wall_add_view**（CommunityView 的 countViews
--   对「今天还没看过的每条帖」逐条 await），而这 20 条小请求**串行**发、是全站请求数
--   的最大头。Cloudflare Workers 免费档硬上限 = 10 万请求/天，这一项直接决定了免费额度
--   能撑多少日活（实测模型：约 1,000~3,500 DAU）。合成 1 条后首屏 21 → 2 个请求。
--
-- 语义与单帖版 wall_add_view() **逐格等价**（不是重写口径，只是把循环搬进函数里）：
--   · 同访客同日同帖只 +1（wall_post_views 主键含 day，on conflict do nothing）
--   · 计到数才 views+1；没计到只回读，不改
--   · 帖不存在 → 该条 ok=false/reason=not-found（整体仍 200，不让一条坏 id 拖垮整批）
--   · viewer 缺省口径同单帖版：本机匿名 id 优先 → 空则 auth.uid() → 再空则 'anon'
--   · 同一条 id 传两次只记一次（单帖版第二次必然 on conflict，等价）
-- security definer：wall_post_views 不开 insert 策略，写入只能走函数（与单帖版一致）。
--
-- 没跑它时：前端（db.supabase / db.gateway）与 Worker 网关都会自动退回旧的
-- 「逐帖 wall_add_view 循环」，行为与现在完全一致 —— 不跑也能用。
--
-- 跑完可 `node tools/wall-addviews-e2e.mjs` 实测（批量 ↔ 逐帖逐格对账）。

create or replace function public.wall_add_views(p_posts bigint[], p_viewer text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_viewer  text := coalesce(nullif(trim(coalesce(p_viewer, '')), ''),
                             coalesce(auth.uid()::text, 'anon'));
  v_post    bigint;
  v_counted boolean;
  v_views   integer;
  v_dis     integer;
  v_rm      boolean;
  v_out     jsonb := '[]'::jsonb;
begin
  /* distinct：同一 id 重复传只处理一次（与单帖版「第二次 on conflict」等价）。
     不承诺顺序 —— 调用方按 post 认领，不按位置。 */
  for v_post in
    select distinct x from unnest(coalesce(p_posts, '{}'::bigint[])) as t(x)
  loop
    insert into public.wall_post_views (post_id, viewer_key)
    values (v_post, v_viewer)
    on conflict do nothing;
    v_counted := found;

    if v_counted then
      update public.wall_posts set views = views + 1 where id = v_post
        returning views, dislikes, removed into v_views, v_dis, v_rm;
    else
      select views, dislikes, removed into v_views, v_dis, v_rm
        from public.wall_posts where id = v_post;
    end if;

    if v_views is null then
      v_out := v_out || jsonb_build_object('post', v_post, 'ok', false, 'reason', 'not-found');
    else
      v_out := v_out || jsonb_build_object('post', v_post, 'ok', true,
                                           'counted', v_counted,
                                           'views', v_views,
                                           'dislikes', v_dis,
                                           'removed', v_rm);
    end if;
  end loop;

  return jsonb_build_object('ok', true, 'results', v_out);
end $$;

grant execute on function public.wall_add_views(bigint[], text) to anon, authenticated;
