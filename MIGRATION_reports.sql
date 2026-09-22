-- ============================================================
-- MIGRATION_reports.sql —— 轮 33 · 举报 / 审核 / 拉黑（内容域）
-- 在 Supabase SQL Editor 里**整段**复制执行（可重复跑，全段幂等）。
-- 内容：
--   1) reports 举报与待复核队列（pending / handled；source 区分用户举报与系统自动条目）
--   2) wall_comments 加 hidden（≥3 人举报自动隐藏，作者本人与管理员仍可见）
--   3) RPC：report_create / admin_report_page / admin_report_handle
--   4) wall_toggle_dislike 扩展：厌恶自动下架时插一条「待复核」（帖子不因举报数下架）
--   5) admin_overview 扩展：reports_pending（管理中心红点用）
-- 口径（用户已拍板）：
--   · 帖子不因举报数自动下架（保留厌恶双档下架），下架后进队列由管理员复核；
--   · 评论 ≥3 人举报自动隐藏，管理员可恢复（恢复后不再自动隐藏，交人工）；
--   · 处理结果给举报人发一条 system 通知（前端按 event=report_handled 本地化渲染）；
--   · 拉黑 = 全站生效：复用 dm_blocks（私信拦截已有），内容过滤在前端做，本迁移不涉及。
-- ============================================================

-- ─────────────────────────────────────────────
-- 1) 举报 / 待复核队列表
--    target_id 故意不挂外键：内容被删（作者自删或管理员删）后举报记录要留下来审计，
--    队列里显示「内容已删除」即可；帖子/评论二选一由 target_type 区分。
-- ─────────────────────────────────────────────
create table if not exists public.reports (
  id          bigserial primary key,
  reporter_id uuid references public.profiles (id) on delete set null,  -- null = 系统自动条目（下架复核）
  target_type text not null check (target_type in ('post','comment')),
  target_id   bigint not null,
  reason      text not null default 'other',   -- spam|abuse|porn|illegal|false|other|auto
  detail      text not null default '',        -- 举报人补充说明（≤200 字）
  source      text not null default 'report' check (source in ('report','auto')),
  status      text not null default 'pending' check (status in ('pending','handled')),
  handled_by  uuid references public.profiles (id) on delete set null,
  handled_at  timestamptz,
  action      text,                            -- dismiss|remove_post|restore_post|delete_comment|unhide_comment
  note        text not null default '',        -- 管理员处理备注（≤200 字）
  created_at  timestamptz not null default now()
);

create index if not exists reports_status_idx on public.reports (status, id desc);
create index if not exists reports_target_idx on public.reports (target_type, target_id);

-- 同一人对同一目标只能举报一次（系统条目 reporter 为 null，不受此约束）
create unique index if not exists reports_reporter_target_uniq
  on public.reports (reporter_id, target_type, target_id)
  where reporter_id is not null;
-- 同一目标的「待复核」条目只排一次（处理完后再下架可以再排）
create unique index if not exists reports_auto_pending_uniq
  on public.reports (target_type, target_id)
  where source = 'auto' and status = 'pending';

alter table public.reports enable row level security;

drop policy if exists "reports own or admin select" on public.reports;
create policy "reports own or admin select" on public.reports
  for select using (reporter_id = auth.uid() or is_admin());
-- 写入/修改不做任何直连策略：全部收口在 security definer RPC（report_create / admin_report_handle）。

-- ─────────────────────────────────────────────
-- 2) 评论隐藏（≥3 人举报自动隐藏）
--    读策略升级：hidden 的评论只有作者本人与管理员能读到
--    （is_admin() 在本文件上方 admin 段已定义；本段整体可重复执行）
-- ─────────────────────────────────────────────
alter table public.wall_comments add column if not exists hidden   boolean     not null default false;
alter table public.wall_comments add column if not exists hidden_at timestamptz;

drop policy if exists "comments readable by all" on public.wall_comments;
drop policy if exists "comments readable unless hidden" on public.wall_comments;
create policy "comments readable unless hidden" on public.wall_comments
  for select using (hidden = false or user_id = auth.uid() or is_admin());

-- ─────────────────────────────────────────────
-- 3) 举报创建（用户侧；防刷 + 评论阈值自动隐藏）
--    错误码：auth-required / bad-target / target-gone / report-limit
-- ─────────────────────────────────────────────
create or replace function public.report_create(p_target_type text, p_target_id bigint, p_reason text, p_detail text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid    uuid := auth.uid();
  v_reason text := lower(coalesce(p_reason, 'other'));
  v_detail text := left(btrim(coalesce(p_detail, '')), 200);
  v_alive  boolean;
begin
  if v_uid is null then raise exception 'auth-required'; end if;
  if p_target_type not in ('post','comment') then raise exception 'bad-target'; end if;
  if v_reason not in ('spam','abuse','porn','illegal','false','other') then v_reason := 'other'; end if;

  -- 目标必须活着：已下架的帖子 / 已隐藏的评论不再收举报（前端也看不到它们）
  if p_target_type = 'post' then
    select true into v_alive from public.wall_posts where id = p_target_id and removed = false;
  else
    select true into v_alive from public.wall_comments where id = p_target_id and hidden = false;
  end if;
  if v_alive is null or not v_alive then raise exception 'target-gone'; end if;

  -- 防刷：每人每个 UTC 日最多 10 条举报
  if (select count(*) from public.reports
       where reporter_id = v_uid
         and created_at >= date_trunc('day', now() at time zone 'utc')) >= 10 then
    raise exception 'report-limit';
  end if;

  -- 同人同目标去重：重复举报视为成功（幂等，前端不给报错）
  insert into public.reports (reporter_id, target_type, target_id, reason, detail, source)
  values (v_uid, p_target_type, p_target_id, v_reason, v_detail, 'report')
  on conflict do nothing;

  -- 评论：≥3 人举报过（同人同目标唯一，行数 = 人数）→ 自动隐藏待复核。
  -- hidden_at is null = 只自动隐藏一次；管理员恢复后即使再被举报也不再自动隐藏（交人工）。
  if p_target_type = 'comment' then
    update public.wall_comments wc
       set hidden = true, hidden_at = now()
     where wc.id = p_target_id
       and wc.hidden = false
       and wc.hidden_at is null
       and (select count(*) from public.reports rr
             where rr.target_type = 'comment' and rr.target_id = wc.id) >= 3;
  end if;
  -- 帖子：不因举报数下架（用户拍板）——下架只走厌恶阈值，且下架时插「待复核」（见第 4 段）。

  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.report_create(text, bigint, text, text) from public, anon;
grant execute on function public.report_create(text, bigint, text, text) to authenticated;

-- ─────────────────────────────────────────────
-- 4) 管理端：举报/复核分页（pending / handled 两档）
--    非管理员 → {admin:false}；items 带被举报内容正文/作者与「几人举报过」聚合
-- ─────────────────────────────────────────────
create or replace function public.admin_report_page(p_status text default 'pending', p_offset integer default 0, p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_status text := lower(coalesce(p_status, 'pending'));
  v_total  bigint;
begin
  if not exists (select 1 from public.admin_users where user_id = auth.uid()) then
    return jsonb_build_object('admin', false, 'total', 0, 'items', '[]'::jsonb);
  end if;
  if v_status not in ('pending','handled') then v_status := 'pending'; end if;

  select count(*) into v_total from public.reports where status = v_status;

  return jsonb_build_object(
    'admin', true,
    'total', v_total,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', r.id,
               'source', r.source,
               'target_type', r.target_type,
               'target_id', r.target_id,
               'reason', r.reason,
               'detail', r.detail,
               'status', r.status,
               'created_at', r.created_at,
               'handled_at', r.handled_at,
               'action', r.action,
               'note', r.note,
               'reporter_name', rp.nickname,              -- null = 系统复核条目（前端显示「系统」）
               'reporters', (select count(*) from public.reports rr
                              where rr.target_type = r.target_type and rr.target_id = r.target_id),
               'content_gone', case when r.target_type = 'post'
                                  then not exists (select 1 from public.wall_posts wp where wp.id = r.target_id)
                                  else not exists (select 1 from public.wall_comments wc where wc.id = r.target_id) end,
               'post_id', case when r.target_type = 'post' then r.target_id
                               else (select wc.post_id from public.wall_comments wc where wc.id = r.target_id) end,
               'body', case when r.target_type = 'post'
                            then (select wp.body from public.wall_posts wp where wp.id = r.target_id)
                            else (select wc.body from public.wall_comments wc where wc.id = r.target_id) end,
               'author_name', case when r.target_type = 'post'
                                   then (select wp.author_name from public.wall_posts wp where wp.id = r.target_id)
                                   else (select wc.author_name from public.wall_comments wc where wc.id = r.target_id) end,
               'author_id', case when r.target_type = 'post'
                                  then (select wp.user_id from public.wall_posts wp where wp.id = r.target_id)
                                  else (select wc.user_id from public.wall_comments wc where wc.id = r.target_id) end,
               'removed', (select wp.removed from public.wall_posts wp
                            where wp.id = r.target_id and r.target_type = 'post'),
               'hidden', (select wc.hidden from public.wall_comments wc
                           where wc.id = r.target_id and r.target_type = 'comment'),
               'content_created_at', case when r.target_type = 'post'
                                   then (select wp.created_at from public.wall_posts wp where wp.id = r.target_id)
                                   else (select wc.created_at from public.wall_comments wc where wc.id = r.target_id) end
             ) order by r.created_at desc, r.id desc)
        from (select *
                from public.reports
               where status = v_status
               order by created_at desc, id desc
               limit least(greatest(coalesce(p_limit, 20), 1), 100)
              offset greatest(coalesce(p_offset, 0), 0)) r
        left join public.profiles rp on rp.id = r.reporter_id
    ), '[]'::jsonb)
  );
end $$;

revoke all on function public.admin_report_page(text, integer, integer) from public, anon;
grant execute on function public.admin_report_page(text, integer, integer) to authenticated;

-- ─────────────────────────────────────────────
-- 5) 管理端：处理一条举报/复核
--    动作：dismiss 驳回 | remove_post 下架帖子 | restore_post 恢复帖子
--          | delete_comment 删评论 | unhide_comment 恢复评论
--    处理完给举报人发 system 通知（前端按 event=report_handled 本地化渲染）。
--    重复处理幂等成功（already:true），防止连点/并发双写。
-- ─────────────────────────────────────────────
create or replace function public.admin_report_handle(p_report bigint, p_action text, p_note text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me       uuid := auth.uid();
  v_action text := lower(coalesce(p_action, 'dismiss'));
  v_note   text := left(btrim(coalesce(p_note, '')), 200);
  v_rep    public.reports%rowtype;
begin
  if not exists (select 1 from public.admin_users where user_id = me) then
    return jsonb_build_object('admin', false);
  end if;
  if v_action not in ('dismiss','remove_post','restore_post','delete_comment','unhide_comment') then
    v_action := 'dismiss';
  end if;

  select * into v_rep from public.reports where id = p_report;
  if v_rep.id is null then
    return jsonb_build_object('admin', true, 'ok', false, 'reason', 'not-found');
  end if;
  if v_rep.status = 'handled' then
    return jsonb_build_object('admin', true, 'ok', true, 'already', true);
  end if;

  -- 内容动作（目标可能已被作者自删：动作落空不算失败，记录照常闭环）
  if v_action = 'remove_post' and v_rep.target_type = 'post' then
    update public.wall_posts set removed = true, removed_at = now() where id = v_rep.target_id;
  elsif v_action = 'restore_post' and v_rep.target_type = 'post' then
    update public.wall_posts set removed = false, removed_at = null where id = v_rep.target_id;
  elsif v_action = 'delete_comment' and v_rep.target_type = 'comment' then
    delete from public.wall_comments where id = v_rep.target_id;   -- 二级回复级联删除
  elsif v_action = 'unhide_comment' and v_rep.target_type = 'comment' then
    update public.wall_comments set hidden = false where id = v_rep.target_id;
  end if;

  update public.reports
     set status = 'handled', handled_by = me, handled_at = now(), action = v_action, note = v_note
   where id = p_report;

  if v_rep.reporter_id is not null then
    insert into public.notifications (user_id, actor_id, kind, meta)
    values (v_rep.reporter_id, me, 'system',
            jsonb_build_object('event', 'report_handled', 'target_type', v_rep.target_type));
  end if;

  return jsonb_build_object('admin', true, 'ok', true);
end $$;

revoke all on function public.admin_report_handle(bigint, text, text) from public, anon;
grant execute on function public.admin_report_handle(bigint, text, text) to authenticated;

-- ─────────────────────────────────────────────
-- 6) wall_toggle_dislike 扩展：厌恶达到双档阈值把帖子下架时，
--    自动插一条「待复核」进队列（source='auto'，无举报人；同一帖子待复核只排一次）
--    除新增的 insert 外，与既有版本逐行一致。
-- ─────────────────────────────────────────────
create or replace function public.wall_toggle_dislike(p_post bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid   uuid := auth.uid();
  v_on    boolean;
  v_views integer;
  v_dis   integer;
  v_rm    boolean;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'reason', 'auth-required');
  end if;

  if exists (
    select 1 from public.wall_reactions
    where post_id = p_post and user_id = v_uid and kind = 'dislike'
  ) then
    delete from public.wall_reactions
      where post_id = p_post and user_id = v_uid and kind = 'dislike';
    v_on := false;
  else
    insert into public.wall_reactions (post_id, user_id, kind)
    values (p_post, v_uid, 'dislike')
    on conflict do nothing;
    v_on := true;
  end if;

  select count(*) into v_dis from public.wall_reactions
    where post_id = p_post and kind = 'dislike';
  update public.wall_posts set dislikes = v_dis where id = p_post
    returning views, removed into v_views, v_rm;

  if v_views is null then
    return jsonb_build_object('ok', false, 'reason', 'not-found');
  end if;

  if not v_rm and (
       (v_views < 100 and v_dis > 3)                    -- #26 低浏览档：超过 3 个（≥4）就下架
       or (v_views >= 100 and (v_dis::numeric / v_views) > 0.005)  -- 高浏览档：> 0.5% 就下架
     ) then
    update public.wall_posts set removed = true, removed_at = now() where id = p_post;
    v_rm := true;
    -- 轮 33：下架即进「待复核」队列，让管理员看到（处理完后再次下架可再排队）
    insert into public.reports (reporter_id, target_type, target_id, reason, source)
    values (null, 'post', p_post, 'auto', 'auto')
    on conflict do nothing;
  end if;

  return jsonb_build_object('ok', true, 'on', v_on, 'views', v_views,
                            'dislikes', v_dis, 'removed', v_rm);
end $$;

revoke all on function public.wall_toggle_dislike(bigint) from public, anon;
grant execute on function public.wall_toggle_dislike(bigint) to authenticated;

-- ─────────────────────────────────────────────
-- 7) admin_overview 扩展：reports_pending（管理中心「举报」页签红点）。
--    除新增一行统计外，与既有版本逐行一致。
-- ─────────────────────────────────────────────
create or replace function public.admin_overview()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (timezone('Asia/Shanghai', now()))::date;
begin
  if not exists (select 1 from public.admin_users where user_id = auth.uid()) then
    return jsonb_build_object('admin', false);
  end if;

  return jsonb_build_object(
    'admin', true,

    'users_total',    (select count(*) from public.profiles),
    'users_today',    (select count(*) from public.profiles
                        where (timezone('Asia/Shanghai', created_at))::date = v_today),
    'posts_total',    (select count(*) from public.wall_posts),
    'posts_today',    (select count(*) from public.wall_posts
                        where (timezone('Asia/Shanghai', created_at))::date = v_today),
    'posts_removed',  (select count(*) from public.wall_posts where removed = true),
    'comments_total', (select count(*) from public.wall_comments),
    'comments_today', (select count(*) from public.wall_comments
                        where (timezone('Asia/Shanghai', created_at))::date = v_today),
    'views_total',    (select coalesce(sum(views), 0) from public.wall_posts),
    'reports_pending', (select count(*) from public.reports where status = 'pending'),

    'reactions', (select coalesce(jsonb_object_agg(kind, c), '{}'::jsonb)
                    from (select kind, count(*) as c
                            from public.wall_reactions group by kind) s),

    'pets_total',  (select count(*) from public.pet_profiles),
    'pats_total',  (select coalesce(sum(pats), 0) from public.pet_profiles),
    'feeds_total', (select coalesce(sum(feeds), 0) from public.pet_profiles),

    'storage_objects', (select count(*) from storage.objects where bucket_id = 'wall-images'),
    'storage_bytes',   (select coalesce(sum((metadata ->> 'size')::bigint), 0)
                          from storage.objects where bucket_id = 'wall-images'),

    'daily', (
      select jsonb_agg(jsonb_build_object(
               'day', d::date,
               'posts',    (select count(*) from public.wall_posts
                             where (timezone('Asia/Shanghai', created_at))::date = d::date),
               'users',    (select count(*) from public.profiles
                             where (timezone('Asia/Shanghai', created_at))::date = d::date),
               'comments', (select count(*) from public.wall_comments
                             where (timezone('Asia/Shanghai', created_at))::date = d::date)
             ) order by d)
        from generate_series(v_today - 13, v_today, interval '1 day') g(d)
    ),

    'top_posts', (
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'author_name', p.author_name, 'body', left(p.body, 60),
               'views', p.views, 'removed', p.removed, 'created_at', p.created_at,
               'reactions', (select count(*) from public.wall_reactions r
                              where r.post_id = p.id and r.kind <> 'dislike')
             ) order by p.views desc, p.id desc)
        from (select * from public.wall_posts order by views desc, id desc limit 5) p
    ),

    'recent_users', (
      select jsonb_agg(jsonb_build_object(
               'id', u.id, 'nickname', u.nickname, 'created_at', u.created_at,
               'posts', (select count(*) from public.wall_posts p where p.user_id = u.id)
             ) order by u.created_at desc)
        from (select * from public.profiles order by created_at desc limit 8) u
    )
  );
end $$;

revoke all on function public.admin_overview() from public, anon;
grant execute on function public.admin_overview() to anon, authenticated;

-- ============================================================
-- 执行完毕。验证（任一）：
--   · 本文件应全部无报错；再跑 node tools/report-test.mjs（轮 33 契约）与
--     node tools/dm-test.mjs && node tools/notify-test.mjs 回归
--   · 线上探针：report_create 对匿名应报 42501（存在无权），而不是 PGRST202（不存在）
-- ============================================================
