-- ══════════════════════════════════════════════════════════════
-- 轮 458 · 今日页「故事 + 语录」按日期发布
-- --------------------------------------------------------------
-- 背景：今日页原来从 src/data/stories.js 按「一年第几天 % 条数」轮换，
--       管理员无法指定某一天发什么，也无法按语言分别填写。
--
-- 新模型：
--   daily_stories  —— 每个日期一行（story_date 主键）
--     content     jsonb，固定 5 种语言 × {title, body, quote}
--                 例：{"zh":{"title":"...","body":"...","quote":"..."}, "en":{...}}
--     published   false = 草稿，只有管理端能看；true = 今日页可读
--
-- RPC：
--   daily_story_get(p_date)        公开读：只返回 published=true 的那一行
--   daily_story_admin_get(p_date)  管理端读：含草稿
--   daily_story_list(limit,offset) 管理端最近列表
--   daily_story_save(date,content,published)  新建/更新（admin-only）
--   daily_story_delete(date)       删除（admin-only）
--
-- 安全：表开 RLS 且不建 policy，只有 security definer 函数能碰；
--       管理函数内部校验 admin_users，非管理员拿不到草稿。
-- ══════════════════════════════════════════════════════════════

create table if not exists public.daily_stories (
  story_date date primary key,
  content    jsonb not null default '{}'::jsonb,
  published  boolean not null default true,
  updated_by uuid,
  updated_at timestamptz not null default now()
);

alter table public.daily_stories enable row level security;

-- 公开读：指定日期 + 已发布；没有就返回 null（前端退回内置故事轮换）
create or replace function public.daily_story_get(p_date date)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'date', d.story_date,
    'content', d.content,
    'published', d.published,
    'updated_at', d.updated_at
  )
  from public.daily_stories d
  where d.story_date = p_date
    and d.published = true
$$;

-- 管理端读单条：包含草稿；非管理员返回 null（不报错，管理页自己显示无权限）
create or replace function public.daily_story_admin_get(p_date date)
returns jsonb
language sql stable security definer set search_path = public as $$
  select case
    when exists (select 1 from public.admin_users a where a.user_id = auth.uid())
      then (
        select jsonb_build_object(
          'date', d.story_date,
          'content', d.content,
          'published', d.published,
          'updated_at', d.updated_at
        )
        from public.daily_stories d
        where d.story_date = p_date
      )
    else null
  end
$$;

-- 管理端列表：新日期在前；非管理员空集
create or replace function public.daily_story_list(
  p_limit  integer default 30,
  p_offset integer default 0
)
returns setof jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'date', d.story_date,
    'content', d.content,
    'published', d.published,
    'updated_at', d.updated_at
  )
  from public.daily_stories d
  where exists (select 1 from public.admin_users a where a.user_id = auth.uid())
  order by d.story_date desc
  limit least(greatest(coalesce(p_limit, 30), 1), 100)
  offset greatest(coalesce(p_offset, 0), 0)
$$;

-- 新建 / 更新（日期冲突即覆盖）；p_published=false 保存为草稿
create or replace function public.daily_story_save(
  p_date      date,
  p_content   jsonb,
  p_published boolean default true
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_row public.daily_stories%rowtype;
begin
  if not exists (select 1 from public.admin_users a where a.user_id = auth.uid()) then
    raise exception 'admin-only';
  end if;
  if p_date is null then raise exception 'bad-date'; end if;
  if p_content is null or jsonb_typeof(p_content) <> 'object' then
    raise exception 'bad-content';
  end if;
  if octet_length(p_content::text) > 200000 then
    raise exception 'content-too-large';
  end if;

  insert into public.daily_stories (story_date, content, published, updated_by, updated_at)
  values (p_date, p_content, coalesce(p_published, true), auth.uid(), now())
  on conflict (story_date) do update
    set content = excluded.content,
        published = excluded.published,
        updated_by = excluded.updated_by,
        updated_at = now()
  returning * into v_row;

  return jsonb_build_object(
    'date', v_row.story_date,
    'content', v_row.content,
    'published', v_row.published,
    'updated_at', v_row.updated_at
  );
end $$;

-- 删除某天的自定义故事（admin-only）；删掉后该日期回到内置轮换
create or replace function public.daily_story_delete(p_date date)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_count integer := 0;
begin
  if not exists (select 1 from public.admin_users a where a.user_id = auth.uid()) then
    raise exception 'admin-only';
  end if;
  if p_date is null then raise exception 'bad-date'; end if;
  delete from public.daily_stories where story_date = p_date;
  get diagnostics v_count = row_count;
  return jsonb_build_object('ok', v_count > 0, 'date', p_date);
end $$;

-- 执行权限：公开读给 anon/authenticated；管理函数只给 authenticated（函数内再校验 admin）
revoke all on function public.daily_story_get(date) from public;
grant execute on function public.daily_story_get(date) to anon, authenticated;

revoke all on function public.daily_story_admin_get(date) from public, anon;
grant execute on function public.daily_story_admin_get(date) to authenticated;

revoke all on function public.daily_story_list(integer, integer) from public, anon;
grant execute on function public.daily_story_list(integer, integer) to authenticated;

revoke all on function public.daily_story_save(date, jsonb, boolean) from public, anon;
grant execute on function public.daily_story_save(date, jsonb, boolean) to authenticated;

revoke all on function public.daily_story_delete(date) from public, anon;
grant execute on function public.daily_story_delete(date) to authenticated;
