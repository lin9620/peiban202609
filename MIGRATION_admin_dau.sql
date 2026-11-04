-- 轮 365 · 管理中心「最近 24 小时日活」
-- ------------------------------------------------------------------
-- 口径：auth.users.last_sign_in_at >= now() - interval '24 hours'，
--       按账户去重；只统计有 profiles 的账户，和用户总数/用户名单同口径。
-- 为什么不用 profiles.created_at：那是注册数，不是登录数。
-- 为什么用滚动 24h 而不是自然日：用户要的是「最近 24 小时登录过的账户」。
--
-- 执行：以管理员身份在 Supabase SQL Editor 跑本文件（可重复执行）。
-- 未执行时前端不会白屏：admin_overview() 旧版仍返回旧字段，
-- 页面把 dau_24h / recent_logins 当 0 / 空列表处理。
-- ------------------------------------------------------------------

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

    /* 最近 24 小时登录过的账户（滚动窗口，去重） */
    'dau_24h', (
      select count(distinct u.id)
        from auth.users u
        join public.profiles p on p.id = u.id
       where u.last_sign_in_at >= now() - interval '24 hours'
    ),

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
    ),

    /* DAU 卡片的明细：最近 8 个登录账户（邮箱只给管理员） */
    'recent_logins', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', u.id,
               'nickname', coalesce(u.nickname, ''),
               'email', coalesce(u.email, ''),
               'last_sign_in_at', u.last_sign_in_at
             ) order by u.last_sign_in_at desc), '[]'::jsonb)
        from (
          select u.id, u.email, u.last_sign_in_at, p.nickname
            from auth.users u
            join public.profiles p on p.id = u.id
           where u.last_sign_in_at >= now() - interval '24 hours'
           order by u.last_sign_in_at desc
           limit 8
        ) u
    )
  );
end $$;

grant execute on function public.admin_overview() to anon, authenticated;

/* 用户名单也补一列「最近登录」：管理员能直接核对 DAU 口径。 */
create or replace function public.admin_users_page(p_offset integer default 0, p_limit integer default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_total bigint;
begin
  if not exists (select 1 from public.admin_users where user_id = auth.uid()) then
    return jsonb_build_object('admin', false, 'total', 0, 'users', '[]'::jsonb);
  end if;

  select count(*) into v_total from public.profiles;

  return jsonb_build_object(
    'admin', true,
    'total', v_total,
    'users', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id,
               'nickname', p.nickname,
               'email', coalesce(u.email, ''),
               'created_at', p.created_at,
               'last_sign_in_at', u.last_sign_in_at
             ) order by p.created_at desc, p.id desc)
        from (select *
                from public.profiles
               order by created_at desc, id desc
               limit least(greatest(coalesce(p_limit, 100), 1), 500)
              offset greatest(coalesce(p_offset, 0), 0)) p
        join auth.users u on u.id = p.id
    ), '[]'::jsonb)
  );
end $$;

grant execute on function public.admin_users_page(integer, integer) to anon, authenticated;
