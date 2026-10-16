-- ═══════════ 轮 306 · wall_add_view(s) 坏 id 撞外键修复（先查存在，再记浏览） ═══════════
-- 线上取证（wall-addviews-e2e 实测，2026-10-15）：批量版传进一个不存在的帖 id 时，
--   insert into wall_post_views 先跑 → 撞 wall_post_views_post_id_fkey → 整个函数抛
--   外键错，承诺的「该条 not-found、整体仍 ok:true」降级根本走不到。
--   单帖版 wall_add_view 是同款写法（先 insert 后查），坏 id 一样炸 —— 本迁移一并修。
-- 修法：两版都改成「先 select 探帖存在 → 不存在直接 not-found（不 insert、不炸外键）；
--   存在才 insert 去重表 + 计到数才 views+1」。语义逐格不变（同人同帖同日只 +1 /
--   帖不存在该条降级 / viewer 缺省口径同款），只是把「查存在」挪到 insert 前面堵住 FK。
-- 幂等：create or replace 只换函数体；执行权在用户（SQL Editor 跑一份）。
-- 同源：SUPABASE_SETUP.sql 两个函数已同步改。

-- ── ① 单帖版 ──
create or replace function public.wall_add_view(p_post bigint, p_viewer text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_viewer  text := coalesce(nullif(trim(coalesce(p_viewer, '')), ''),
                             coalesce(auth.uid()::text, 'anon'));
  v_counted boolean;
  v_views   integer;
  v_dis     integer;
  v_rm      boolean;
begin
  select views, dislikes, removed into v_views, v_dis, v_rm
    from public.wall_posts where id = p_post;
  if v_views is null then                     -- 帖不存在：先探后插，不再撞外键（轮 306）
    return jsonb_build_object('ok', false, 'reason', 'not-found');
  end if;

  insert into public.wall_post_views (post_id, viewer_key)
  values (p_post, v_viewer)
  on conflict do nothing;
  v_counted := found;                       -- 真的插进去了才算一次浏览

  if v_counted then
    update public.wall_posts set views = views + 1 where id = p_post
      returning views into v_views;
  end if;
  return jsonb_build_object('ok', true, 'counted', v_counted,
                            'views', v_views, 'dislikes', v_dis, 'removed', v_rm);
end $$;

grant execute on function public.wall_add_view(bigint, text) to anon, authenticated;

-- ── ② 批量版 ──
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
  for v_post in
    select distinct x from unnest(coalesce(p_posts, '{}'::bigint[])) as t(x)
  loop
    select views, dislikes, removed into v_views, v_dis, v_rm
      from public.wall_posts where id = v_post;
    if v_views is null then                 -- 帖不存在：单条降级，不炸外键、不拖垮整批（轮 306）
      v_out := v_out || jsonb_build_object('post', v_post, 'ok', false, 'reason', 'not-found');
      continue;
    end if;

    insert into public.wall_post_views (post_id, viewer_key)
    values (v_post, v_viewer)
    on conflict do nothing;
    v_counted := found;

    if v_counted then
      update public.wall_posts set views = views + 1 where id = v_post
        returning views into v_views;
    end if;

    v_out := v_out || jsonb_build_object('post', v_post, 'ok', true,
                                         'counted', v_counted,
                                         'views', v_views,
                                         'dislikes', v_dis,
                                         'removed', v_rm);
  end loop;

  return jsonb_build_object('ok', true, 'results', v_out);
end $$;

grant execute on function public.wall_add_views(bigint[], text) to anon, authenticated;
