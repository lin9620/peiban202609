-- MIGRATION_admin_report_filter.sql —— 轮 368 管理中心举报队列「帖子/评论分开 + 分类计数」
-- 前置：已执行 MIGRATION_reports.sql（reports 表 / admin_report_handle 已存在）。
-- 幂等：先 drop 旧三参函数，再建带 p_target_type 的四参函数；重复执行安全。
-- 未执行时前端会退回「只筛当前页」并提示，不会把混排列表冒充分类结果。

begin;

drop function if exists public.admin_report_page(text, integer, integer);

create or replace function public.admin_report_page(
  p_status text default 'pending',
  p_offset integer default 0,
  p_limit integer default 20,
  p_target_type text default null
)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_status text := lower(coalesce(p_status, 'pending'));
  v_target text := lower(nullif(btrim(coalesce(p_target_type, '')), ''));
  v_total  bigint;
begin
  if not exists (select 1 from public.admin_users where user_id = auth.uid()) then
    return jsonb_build_object('admin', false, 'total', 0, 'items', '[]'::jsonb);
  end if;
  if v_status not in ('pending','handled') then v_status := 'pending'; end if;
  if v_target not in ('post','comment') then v_target := null; end if;

  select count(*) into v_total
    from public.reports
   where status = v_status
     and (v_target is null or target_type = v_target);

  return jsonb_build_object(
    'admin', true,
    'total', v_total,
    'counts', jsonb_build_object(
      'post_pending', (select count(*) from public.reports where status = 'pending' and target_type = 'post'),
      'post_handled', (select count(*) from public.reports where status = 'handled' and target_type = 'post'),
      'comment_pending', (select count(*) from public.reports where status = 'pending' and target_type = 'comment'),
      'comment_handled', (select count(*) from public.reports where status = 'handled' and target_type = 'comment')
    ),
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
               'reporter_name', rp.nickname,
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
                 and (v_target is null or target_type = v_target)
               order by created_at desc, id desc
               limit least(greatest(coalesce(p_limit, 20), 1), 100)
              offset greatest(coalesce(p_offset, 0), 0)) r
        left join public.profiles rp on rp.id = r.reporter_id
    ), '[]'::jsonb)
  );
end $$;

revoke all on function public.admin_report_page(text, integer, integer, text) from public, anon;
grant execute on function public.admin_report_page(text, integer, integer, text) to authenticated;

commit;
