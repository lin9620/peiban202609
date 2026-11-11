-- ══════════════════════════════════════════════════════════════
-- Warm Paws · 生产 Supabase schema 基线
-- 生成时间：2026-11-11T06:20:29.297Z
-- 来源：当前测试 Supabase 项目（schema-only）
-- 内容：public schema + 必要扩展 + auth 触发器 + Storage bucket/策略 + Realtime 表
-- 不含：auth 用户、业务数据、Storage 文件、service_role / anon key
--
-- 重新生成：node tools/schema-baseline.mjs dump
-- 校验：    node tools/schema-baseline.mjs verify --url=<目标库>
-- 应用：    node tools/schema-baseline.mjs apply --url=<空库> --yes
--
-- ⚠️ 这是生成文件，不要手改；改 schema 时先写 MIGRATION_*.sql，
--    在测试库应用并验证后，再重新 dump 基线。
-- ══════════════════════════════════════════════════════════════

-- 生产库通常已自带这些扩展；IF NOT EXISTS 保证可重复执行。
create schema if not exists "public";
create schema if not exists "extensions";
create extension if not exists "pgcrypto" with schema "extensions";
create extension if not exists "uuid-ossp" with schema "extensions";
create extension if not exists "pg_trgm" with schema "public";

--
-- PostgreSQL database dump
--



-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
-- SET transaction_timeout = 0; -- PG17-only; keep compatible
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', 'public, extensions', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS "public";


--
-- Name: SCHEMA "public"; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA "public" IS 'standard public schema';


--
-- Name: admin_broadcast_start("text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."admin_broadcast_start"("p_body" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  me     uuid := auth.uid();
  v_body text;
  v_total integer;
  v_bid  uuid;
begin
  if not exists (select 1 from public.admin_users where user_id = me) then
    return jsonb_build_object('admin', false);
  end if;
  v_body := left(btrim(coalesce(p_body, '')), 1000);
  if char_length(v_body) = 0 then raise exception 'empty-body'; end if;
  select count(*)::integer into v_total from public.profiles;
  insert into public.admin_broadcasts (body, created_by, total)
    values (v_body, me, v_total)
    returning id into v_bid;
  return jsonb_build_object('admin', true, 'bid', v_bid::text, 'total', v_total, 'sent', 0, 'done', false);
end $$;


--
-- Name: admin_broadcast_step("text", integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."admin_broadcast_step"("p_bid" "text", "p_batch" integer DEFAULT 2000) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  me      uuid := auth.uid();
  b       public.admin_broadcasts%rowtype;
  v_batch integer := least(greatest(coalesce(p_batch, 2000), 100), 5000);
  v_ins   integer := 0;
begin
  if not exists (select 1 from public.admin_users where user_id = me) then
    return jsonb_build_object('admin', false);
  end if;
  select * into b from public.admin_broadcasts where id = p_bid::uuid;
  if not found then return jsonb_build_object('admin', true, 'missing', true); end if;
  with ins as (
    insert into public.notifications (user_id, actor_id, kind, meta)
      select p.id, b.created_by, 'system', jsonb_build_object('body', b.body, 'bid', b.id::text)
        from public.profiles p
       where not exists (
           select 1 from public.notifications n
            where n.kind = 'system'
              and n.meta ->> 'bid' = b.id::text
              and n.user_id = p.id)
       order by p.created_at asc
       limit v_batch
      returning 1
  )
  select count(*) into v_ins from ins;
  update public.admin_broadcasts set sent = sent + v_ins where id = b.id;
  return jsonb_build_object('admin', true, 'bid', b.id::text, 'total', b.total,
    'sent', b.sent + v_ins, 'done', v_ins = 0);
end $$;


--
-- Name: admin_broadcasts_list(integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."admin_broadcasts_list"("p_limit" integer DEFAULT 20, "p_offset" integer DEFAULT 0) RETURNS TABLE("id" "text", "body" "text", "created_at" timestamp with time zone, "sent" integer, "total" integer, "done" boolean)
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select b.id::text, b.body, b.created_at, b.sent, b.total,
         (b.sent >= b.total) as done
    from public.admin_broadcasts b
   where exists (select 1 from public.admin_users a where a.user_id = auth.uid())
   order by b.created_at desc
   limit least(greatest(coalesce(p_limit, 20), 1), 100)
   offset greatest(coalesce(p_offset, 0), 0)
$$;


--
-- Name: admin_clientlog_page(integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."admin_clientlog_page"("p_offset" integer DEFAULT 0, "p_limit" integer DEFAULT 50) RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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


--
-- Name: admin_overview(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."admin_overview"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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


--
-- Name: admin_report_handle(bigint, "text", "text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."admin_report_handle"("p_report" bigint, "p_action" "text", "p_note" "text" DEFAULT ''::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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


--
-- Name: admin_report_page("text", integer, integer, "text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."admin_report_page"("p_status" "text" DEFAULT 'pending'::"text", "p_offset" integer DEFAULT 0, "p_limit" integer DEFAULT 20, "p_target_type" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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


SET default_tablespace = '';

SET default_table_access_method = "heap";

--
-- Name: app_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."app_state" (
    "id" integer DEFAULT 1 NOT NULL,
    "maintenance_mode" "text" DEFAULT 'off'::"text" NOT NULL,
    "maintenance_note" "text",
    "maintenance_until" timestamp with time zone,
    "maintenance_started_at" timestamp with time zone,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_by" "uuid",
    CONSTRAINT "app_state_id_check" CHECK (("id" = 1)),
    CONSTRAINT "app_state_maintenance_mode_check" CHECK (("maintenance_mode" = ANY (ARRAY['off'::"text", 'read'::"text", 'full'::"text"])))
);


--
-- Name: TABLE "app_state"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."app_state" IS '站点运行时状态（单行）。maintenance_mode 三档维护开关；until 到点自动恢复，防止忘记关闭。';


--
-- Name: COLUMN "app_state"."maintenance_until"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."app_state"."maintenance_until" IS '预计结束时间。到点后 maintenance_active() 自动返回 off —— 忘了关也不会永久停机。';


--
-- Name: admin_set_maintenance("text", "text", timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."admin_set_maintenance"("p_mode" "text", "p_note" "text" DEFAULT NULL::"text", "p_until" timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS "public"."app_state"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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


--
-- Name: FUNCTION "admin_set_maintenance"("p_mode" "text", "p_note" "text", "p_until" timestamp with time zone); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION "public"."admin_set_maintenance"("p_mode" "text", "p_note" "text", "p_until" timestamp with time zone) IS '管理中心「维护升级」按钮的唯一入口。p_mode: off/read/full；p_until 到点自动恢复。';


--
-- Name: admin_users_page(integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."admin_users_page"("p_offset" integer DEFAULT 0, "p_limit" integer DEFAULT 100) RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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


--
-- Name: bottle_chat_decide("uuid", boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."bottle_chat_decide"("p_id" "uuid", "p_accept" boolean) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  me uuid := auth.uid();
  letter public.bottle_letters;
  cid bigint;
  opened jsonb;
begin
  if me is null then raise exception 'bottle-auth'; end if;
  if p_accept is null then raise exception 'bottle-bad-decision'; end if;
  select * into letter from public.bottle_letters where id = p_id for update;
  if not found or letter.user_id <> me then raise exception 'bottle-not-owner'; end if;
  if letter.status <> 'answered' or letter.reply_by is null or letter.reply_by = me then
    raise exception 'bottle-not-answered';
  end if;
  if letter.chat_decision = 'accepted' and letter.conv_id is not null then
    return jsonb_build_object('conv_id', letter.conv_id, 'decision', 'accepted');
  end if;
  if letter.chat_decision = 'declined' then
    return jsonb_build_object('conv_id', null, 'decision', 'declined');
  end if;
  if not p_accept then
    update public.bottle_letters set chat_decision = 'declined' where id = p_id;
    return jsonb_build_object('conv_id', null, 'decision', 'declined');
  end if;
  if public.dm_is_blocked(me, letter.reply_by) or public.dm_is_blocked(letter.reply_by, me) then
    raise exception 'bottle-chat-blocked';
  end if;
  opened := public.dm_open(letter.reply_by);
  cid := (opened->>'conv_id')::bigint;
  -- 同一对用户的多个瓶子按会话串行导入，不会交叉更新会话预览。
  perform 1 from public.dm_conversations where id = cid for update;
  insert into public.dm_messages(conv_id, sender, body, created_at)
    values (cid, me, letter.body, letter.created_at);
  insert into public.dm_messages(conv_id, sender, body, created_at)
    values (cid, letter.reply_by, letter.reply, letter.reply_at);
  update public.dm_conversations set last_message_at = now(), last_preview = left(letter.reply, 80)
    where id = cid;
  insert into public.dm_states(conv_id, user_id, accepted)
    values (cid, me, true), (cid, letter.reply_by, true)
    on conflict (conv_id, user_id) do update set accepted = true, hidden_until = null;
  update public.bottle_letters set conv_id = cid, chat_decision = 'accepted' where id = p_id;
  if coalesce((select dms from public.notification_prefs where user_id = letter.reply_by), true)
     and not coalesce((select muted from public.dm_states where conv_id = cid and user_id = letter.reply_by), false) then
    insert into public.notifications(user_id, actor_id, kind, conv_id, meta)
      values (letter.reply_by, me, 'dm', cid, jsonb_build_object(
        'event', 'bottle_chat', 'bottle_id', p_id, 'preview', left(letter.body, 80)));
  end if;
  return jsonb_build_object('conv_id', cid, 'decision', 'accepted');
end $$;


--
-- Name: bottle_letters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."bottle_letters" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "nickname" "text" DEFAULT ''::"text" NOT NULL,
    "body" "text" NOT NULL,
    "status" "text" DEFAULT 'sea'::"text" NOT NULL,
    "holder" "uuid",
    "held_at" timestamp with time zone,
    "reply" "text",
    "reply_by" "uuid",
    "reply_at" timestamp with time zone,
    "created_day" "date" DEFAULT (("now"() AT TIME ZONE 'utc'::"text"))::"date" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "conv_id" bigint,
    "chat_decision" "text" DEFAULT 'pending'::"text" NOT NULL,
    "pickup_count" integer DEFAULT 0 NOT NULL,
    "last_picked_at" timestamp with time zone,
    "random_bucket" smallint DEFAULT ("floor"(("random"() * (256)::double precision)))::smallint NOT NULL,
    "body_hash" "text",
    "hidden_at" timestamp with time zone,
    "lang" "text" DEFAULT 'und'::"text" NOT NULL,
    "deleted_at" timestamp with time zone,
    CONSTRAINT "bottle_letters_chat_decision_check" CHECK (("chat_decision" = ANY (ARRAY['pending'::"text", 'accepted'::"text", 'declined'::"text"]))),
    CONSTRAINT "bottle_letters_lang_chk" CHECK (("lang" = ANY (ARRAY['zh'::"text", 'en'::"text", 'es'::"text", 'pt'::"text", 'fr'::"text", 'ja'::"text", 'ko'::"text", 'und'::"text"])))
);


--
-- Name: TABLE "bottle_letters"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."bottle_letters" IS '温暖漂流瓶：写信投海；24h 最多写 5 封 / 捞 30 瓶 / 回 7 封；按 pickup_count 公平轮转';


--
-- Name: COLUMN "bottle_letters"."pickup_count"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."bottle_letters"."pickup_count" IS '被捞起次数；公平捞取优先选最小值的信（未被捞过的先出现）';


--
-- Name: COLUMN "bottle_letters"."last_picked_at"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."bottle_letters"."last_picked_at" IS '最近一次被捞起时间；同 pickup_count 时更久没被捞的优先';


--
-- Name: COLUMN "bottle_letters"."random_bucket"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."bottle_letters"."random_bucket" IS '0..255 随机桶；大规模时只扫一个桶，避免全海 order by random()';


--
-- Name: COLUMN "bottle_letters"."body_hash"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."bottle_letters"."body_hash" IS 'md5(lower(btrim(body)))，同一用户 24h 内重复内容拦截用';


--
-- Name: COLUMN "bottle_letters"."hidden_at"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."bottle_letters"."hidden_at" IS '轮446 作者从「我发布的」隐藏：只影响写信人自己的列表，对方无感知，
   回信与已有会话都不受影响。hidden_at 非空的行不进 bottle_records(p_mine => true)。';


--
-- Name: COLUMN "bottle_letters"."deleted_at"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."bottle_letters"."deleted_at" IS '轮446 作者撤回：仅 status=sea 可撤回。软删 —— bottle_fishes 是 on delete cascade，
   物理删会让「同一封 7 天内不再发给你」与捞瓶额度记账一起回退，等于开了刷额度口子。';


--
-- Name: bottle_fish("text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."bottle_fish"("p_lang" "text" DEFAULT NULL::"text") RETURNS "public"."bottle_letters"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_count int;
  v_row   public.bottle_letters;
  v_lang  text;
  v_pass  int;
  v_from  int;
  i       int;
begin
  if auth.uid() is null then raise exception 'bottle-auth'; end if;
  /* 捞起超 48h 未处理的信先放回海里（不让信卡死在谁手里） */
  update public.bottle_letters set status = 'sea', holder = null, held_at = null
    where status = 'held' and held_at < now() - interval '48 hours';
  select count(*) into v_count from public.bottle_fishes
    where user_id = auth.uid() and day = (now() at time zone 'utc')::date;
  if v_count >= 7 then raise exception 'bottle-limit-fish'; end if;

  /* 用户偏好为「全部」时没有 pass 1，直接全语言 */
  v_lang := case when p_lang in ('zh','en','es','pt','fr','ja','ko') then p_lang else null end;
  v_from := case when v_lang is null then 2 else 1 end;

  for v_pass in v_from..2 loop
    /* 随机挑一封 → 条件更新抢占（只在仍是 sea 时成立）。别人同一瞬间捞走同一封
       → 命中 0 行 → 换一封重试；重试 3 次仍落空 → 进下一 pass */
    for i in 1..3 loop
      select * into v_row from public.bottle_letters
        where status = 'sea' and user_id <> auth.uid()
          and deleted_at is null                      /* 轮446：作者撤回的信不再发出去 */
          and (v_pass = 2 or lang = v_lang)
        order by random() limit 1;
      if not found then exit; end if;   -- 本池空 → 下一 pass
      update public.bottle_letters set status = 'held', holder = auth.uid(), held_at = now()
        where id = v_row.id and status = 'sea' and deleted_at is null
        returning * into v_row;
      if found then
        /* 捞信日志：同一封当天放回再捞不重复计数、不报错（放回→再捞同一封会撞
           (user_id, day, letter_id) 唯一键——线上老版在这里炸 23505，用户看到报错） */
        insert into public.bottle_fishes (user_id, day, letter_id)
          values (auth.uid(), (now() at time zone 'utc')::date, v_row.id)
          on conflict (user_id, day, letter_id) do nothing;
        return v_row;
      end if;
    end loop;
  end loop;
  raise exception 'bottle-empty-sea';
end $$;


--
-- Name: bottle_held(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."bottle_held"() RETURNS SETOF "public"."bottle_letters"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select * from public.bottle_letters
    where holder = auth.uid() and status = 'held'
    order by held_at desc limit 10
$$;


--
-- Name: bottle_letter_delete("uuid"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."bottle_letter_delete"("p_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  n int;
begin
  if auth.uid() is null then raise exception 'bottle-auth'; end if;
  update public.bottle_letters
     set deleted_at = now()
   where id = p_id
     and user_id = auth.uid()
     and deleted_at is null
     and status = 'sea';           -- 已被捞走 → 命中 0 行
  get diagnostics n = row_count;
  if n > 0 then return true; end if;
  /* 区分几种 false：被捞走了要单独告诉用户（「刚被捞走，只能隐藏」），
     不是自己的/已经删了则静默返回 false。 */
  if exists (
    select 1 from public.bottle_letters
     where id = p_id and user_id = auth.uid() and deleted_at is null and status <> 'sea'
  ) then
    raise exception 'bottle-already-picked';
  end if;
  return false;
end;
$$;


--
-- Name: bottle_letter_hidden(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."bottle_letter_hidden"() RETURNS SETOF "public"."bottle_letters"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select * from public.bottle_letters
   where user_id = auth.uid()
     and hidden_at is not null
     and deleted_at is null
   order by hidden_at desc
   limit 50
$$;


--
-- Name: bottle_letter_hide("uuid"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."bottle_letter_hide"("p_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  n int;
begin
  if auth.uid() is null then raise exception 'bottle-auth'; end if;
  update public.bottle_letters
     set hidden_at = now()
   where id = p_id
     and user_id = auth.uid()
     and deleted_at is null
     and hidden_at is null
     and status <> 'sea'                                        -- 海里的用「撤回」，不给藏
     and chat_decision <> 'accepted'                            -- 已有会话 = 聊天入口
     and not (status = 'answered' and chat_decision = 'pending'); -- 待我决定，藏了就漏掉回信
  get diagnostics n = row_count;
  return n > 0;
end;
$$;


--
-- Name: bottle_letter_unhide("uuid"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."bottle_letter_unhide"("p_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  n int;
begin
  if auth.uid() is null then raise exception 'bottle-auth'; end if;
  update public.bottle_letters set hidden_at = null
   where id = p_id and user_id = auth.uid() and hidden_at is not null;
  get diagnostics n = row_count;
  return n > 0;
end;
$$;


--
-- Name: bottle_mine(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."bottle_mine"() RETURNS SETOF "public"."bottle_letters"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select * from public.bottle_letters
    where user_id = auth.uid() or reply_by = auth.uid()
    order by created_at desc limit 30
$$;


--
-- Name: bottle_notify_reply(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."bottle_notify_reply"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if new.status = 'answered' and old.status <> 'answered' and new.reply_by is not null then
    if not public.dm_is_blocked(new.user_id, new.reply_by)
       and not public.dm_is_blocked(new.reply_by, new.user_id)
       and coalesce((select dms from public.notification_prefs where user_id = new.user_id), true) then
      insert into public.notifications(user_id, actor_id, kind, meta)
      values (new.user_id, new.reply_by, 'dm', jsonb_build_object(
        'event', 'bottle_reply', 'bottle_id', new.id, 'preview', left(new.reply, 80)));
    end if;
  end if;
  return new;
end $$;


--
-- Name: bottle_quota(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."bottle_quota"() RETURNS "jsonb"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select jsonb_build_object(
    'sent',   (select count(*) from public.bottle_letters
                where user_id = auth.uid()
                  and created_at > now() - interval '24 hours'),
    'picked', (select count(*) from public.bottle_fishes
                where user_id = auth.uid()
                  and picked_at > now() - interval '24 hours'),
    'fished', (select count(*) from public.bottle_fishes
                where user_id = auth.uid()
                  and replied_at > now() - interval '24 hours')
  )
$$;


--
-- Name: bottle_records("uuid", integer, boolean, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."bottle_records"("p_id" "uuid" DEFAULT NULL::"uuid", "p_offset" integer DEFAULT 0, "p_mine" boolean DEFAULT NULL::boolean, "p_limit" integer DEFAULT 30) RETURNS SETOF "public"."bottle_letters"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select l.* from public.bottle_letters l
   where (p_id is null or l.id = p_id)
     and (
       /* 默认（p_mine is null）：维持旧口径 —— 我写的或我回过的 */
       (p_mine is null and (l.user_id = auth.uid() or l.reply_by = auth.uid()))
       /* 我发布的（轮446：隐藏的、撤回的不进列表） */
       or (p_mine is true and l.user_id = auth.uid()
           and l.hidden_at is null and l.deleted_at is null)
       /* 我捞到的（轮 45）：只显示已回信的。只有捞到信的人能回信（bottle_reply
          要求 status='held' 且 holder=我），回信人 = 我 即「我捞到且已回信」；
          已放回的（status 回 sea、没回过信）与在守的（status=held）天然排除。 */
       or (p_mine is false and l.reply_by = auth.uid() and l.reply_at is not null)
     )
   order by
     /* 我捞到的按捞到时间新→旧；其余口径按发布时间新→旧 */
     (case when p_mine is false then l.held_at else l.created_at end) desc,
     l.id
   limit greatest(coalesce(p_limit, 30), 1)
   offset greatest(coalesce(p_offset, 0), 0)
$$;


--
-- Name: bottle_release("uuid"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."bottle_release"("p_id" "uuid") RETURNS "public"."bottle_letters"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_row public.bottle_letters;
begin
  if auth.uid() is null then raise exception 'bottle-auth'; end if;
  update public.bottle_letters
    set status = 'sea', holder = null, held_at = null
    where id = p_id and status = 'held' and holder = auth.uid()
    returning * into v_row;
  if v_row is null then raise exception 'bottle-not-holder'; end if;
  return v_row;
end $$;


--
-- Name: bottle_reply("uuid", "text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."bottle_reply"("p_id" "uuid", "p_reply" "text") RETURNS "public"."bottle_letters"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_row public.bottle_letters;
begin
  if auth.uid() is null then raise exception 'bottle-auth'; end if;
  p_reply := btrim(coalesce(p_reply, ''));
  if p_reply = '' or char_length(p_reply) > 1000 then raise exception 'bottle-too-long'; end if;
  update public.bottle_letters
    set status = 'answered', reply = p_reply, reply_by = auth.uid(), reply_at = now(),
        hidden_at = null            /* 轮446：收到回信 → 自动取消隐藏，别让提醒埋在折叠区里 */
    where id = p_id and status = 'held' and holder = auth.uid()
    returning * into v_row;
  if v_row is null then raise exception 'bottle-not-holder'; end if;
  /* 记次（幂等）：只给这封信**最新一条**捞信日志盖「已回信」。
     为什么不能只按 letter_id 全量更新：同一封信「捞起→放回→跨天再捞」会有
     多行日志（主键含 day），全量更新会把 N 行都盖成今天 → 一次回信扣 N 次
     （用户反馈的「捞一次扣好多」类问题就是这么来的）。取 day 最大的一行即可。 */
  update public.bottle_fishes f
    set replied_at = now(), replied_day = (now() at time zone 'utc')::date
    from (
      select user_id, day, letter_id from public.bottle_fishes
        where user_id = auth.uid() and letter_id = p_id and replied_at is null
        order by day desc limit 1
    ) t
    where f.user_id = t.user_id and f.day = t.day and f.letter_id = t.letter_id;
  return v_row;
end $$;


--
-- Name: bottle_report("uuid", "text", "text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."bottle_report"("p_id" "uuid", "p_reason" "text" DEFAULT 'other'::"text", "p_detail" "text" DEFAULT ''::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_uid    uuid := auth.uid();
  v_reason text := lower(coalesce(p_reason, 'other'));
  v_detail text := left(btrim(coalesce(p_detail, '')), 200);
  v_count  int;
  v_row    public.bottle_letters;
begin
  if v_uid is null then raise exception 'auth-required'; end if;
  perform pg_advisory_xact_lock(411, hashtext(v_uid::text));
  if p_id is null then raise exception 'bad-target'; end if;
  if v_reason not in ('spam','abuse','porn','illegal','false','other') then
    v_reason := 'other';
  end if;

  select * into v_row from public.bottle_letters where id = p_id for update;
  if v_row.id is null then raise exception 'target-gone'; end if;
  if v_row.user_id = v_uid then raise exception 'bad-target'; end if;

  select count(*) into v_count
    from public.bottle_reports
   where reporter_id = v_uid
     and created_at > now() - interval '24 hours';
  if v_count >= 10 then raise exception 'bottle-report-limit'; end if;

  insert into public.bottle_reports (reporter_id, letter_id, reason, detail)
    values (v_uid, p_id, v_reason, v_detail)
    on conflict (reporter_id, letter_id) do nothing;

  select count(*) into v_count
    from public.bottle_reports
   where letter_id = p_id;
  if v_count >= 3 then
    update public.bottle_letters
       set hidden_at = coalesce(hidden_at, now())
     where id = p_id;
  end if;

  return jsonb_build_object('ok', true);
end $$;


--
-- Name: bottle_send("text", "text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."bottle_send"("p_body" "text", "p_lang" "text" DEFAULT NULL::"text") RETURNS "public"."bottle_letters"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_count int;
  v_hash  text;
  v_row   public.bottle_letters;
begin
  if auth.uid() is null then raise exception 'bottle-auth'; end if;
  /* 同一用户的额度检查串行化：并发双击/多端同时投捞也不会把 30 瓶刷成 31 瓶 */
  perform pg_advisory_xact_lock(411, hashtext(auth.uid()::text));

  p_body := btrim(coalesce(p_body, ''));
  if char_length(p_body) < 10 then raise exception 'bottle-too-short'; end if;
  if char_length(p_body) > 1000 then raise exception 'bottle-too-long'; end if;

  v_hash := md5(lower(p_body));

  /* 同一用户 24h 内不能重复发同一段内容（防止复制粘贴刷海）
     轮446：已撤回的信不算 —— 撤回后想重新写一遍同样的内容是合理需求 */
  if exists (
    select 1 from public.bottle_letters
     where user_id = auth.uid()
       and body_hash = v_hash
       and deleted_at is null
       and created_at > now() - interval '24 hours'
  ) then
    raise exception 'bottle-duplicate';
  end if;

  /* 滚动 24h，不再按 UTC 自然日。轮446：已撤回的**照算**（撤回不退还投递次数） */
  select count(*) into v_count
    from public.bottle_letters
   where user_id = auth.uid()
     and created_at > now() - interval '24 hours';
  if v_count >= 5 then raise exception 'bottle-limit-send'; end if;

  insert into public.bottle_letters (user_id, nickname, body, body_hash, lang)
    values (auth.uid(),
            coalesce((select nickname from public.profiles where id = auth.uid()), ''),
            p_body,
            v_hash,
            case when p_lang in ('zh','en','es','pt','fr','ja','ko','und') then p_lang else 'und' end)
    returning * into v_row;
  return v_row;
end $$;


--
-- Name: client_log_write("text", "text", "text", "text", "text", "text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."client_log_write"("p_kind" "text", "p_msg" "text", "p_route" "text", "p_stack" "text", "p_ua" "text", "p_ip" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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


--
-- Name: daily_story_admin_get("date"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."daily_story_admin_get"("p_date" "date") RETURNS "jsonb"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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


--
-- Name: daily_story_delete("date"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."daily_story_delete"("p_date" "date") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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


--
-- Name: daily_story_get("date"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."daily_story_get"("p_date" "date") RETURNS "jsonb"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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


--
-- Name: daily_story_list(integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."daily_story_list"("p_limit" integer DEFAULT 30, "p_offset" integer DEFAULT 0) RETURNS SETOF "jsonb"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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


--
-- Name: daily_story_save("date", "jsonb", boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."daily_story_save"("p_date" "date", "p_content" "jsonb", "p_published" boolean DEFAULT true) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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


--
-- Name: delete_my_account(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."delete_my_account"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  uid uuid;
  removed bigint;
begin
  uid := auth.uid();
  if uid is null then
    raise exception 'not-signed-in';
  end if;

  -- 1) Storage：wall-images/<uid>/ 前缀全删（失败不阻塞，返回 removed = -1）
  begin
    with del as (
      delete from storage.objects
      where bucket_id = 'wall-images'
        and name like uid::text || '/%'
      returning 1
    )
    select count(*) into removed from del;
  exception when others then
    removed := -1;
  end;

  -- 2) 业务数据：删 auth.users 一行 → 外键级联清掉 profiles / 帖子 / 评论 / 回应 /
  --    宠物 / 私信 / 漂流瓶（身份摘除）/ 通知 / 管理员名单 等（逐表核对见 SUPABASE_SETUP.sql）
  delete from auth.users where id = uid;

  return jsonb_build_object('ok'::text, true, 'storage_removed', removed);
end;
$$;


--
-- Name: FUNCTION "delete_my_account"(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION "public"."delete_my_account"() IS '自助删号：删除 wall-images/<uid>/ 存储对象 + 级联删除全部业务数据。仅限删除自己的账号（auth.uid() 校验）。';


--
-- Name: dm_accept(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."dm_accept"("p_conv" bigint) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'auth-required'; end if;
  update public.dm_states set accepted = true, hidden_until = null
   where conv_id = p_conv and user_id = me;
  return jsonb_build_object('ok', true);
end $$;


--
-- Name: dm_block("uuid"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."dm_block"("p_user" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'auth-required'; end if;
  if p_user is null or p_user = me then raise exception 'bad-target'; end if;
  insert into public.dm_blocks (blocker, blocked) values (me, p_user)
    on conflict (blocker, blocked) do nothing;
  -- 我这边把与该用户的会话永久隐藏（解除拉黑时恢复可见）
  update public.dm_states s set hidden_until = 'infinity'::timestamptz
    from public.dm_conversations c
   where c.id = s.conv_id and s.user_id = me
     and ((c.user_a = me and c.user_b = p_user) or (c.user_a = p_user and c.user_b = me));
  return jsonb_build_object('ok', true, 'blocked', p_user);
end $$;


--
-- Name: dm_blocks(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."dm_blocks"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'auth-required'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'user_id', b.blocked, 'nickname', p.nickname, 'created_at', b.created_at
    ) order by b.created_at desc)
    from public.dm_blocks b
    join public.profiles p on p.id = b.blocked
    where b.blocker = me
  ), '[]'::jsonb);
end $$;


--
-- Name: dm_conv_meta(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."dm_conv_meta"("p_conv" bigint) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  me      uuid := auth.uid();
  v_other uuid;
  s       public.dm_states;
begin
  if me is null then raise exception 'auth-required'; end if;
  select case when user_a = me then user_b else user_a end into v_other
    from public.dm_conversations where id = p_conv;
  if v_other is null then raise exception 'forbidden'; end if;
  select * into s from public.dm_states
   where conv_id = p_conv and user_id = me;
  return jsonb_build_object(
    'conv_id',  p_conv,
    'other_id', v_other,
    'nickname', (select nickname from public.profiles where id = v_other),
    'accepted', coalesce(s.accepted, true),
    'muted',    coalesce(s.muted, false),
    'hidden',   coalesce(s.hidden_until > now(), false),
    'blocked',  public.dm_is_blocked(me, v_other)
  );
end $$;


--
-- Name: dm_find_conv("uuid", "uuid"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."dm_find_conv"("a" "uuid", "b" "uuid") RETURNS bigint
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select id from public.dm_conversations
   where (user_a = a and user_b = b) or (user_a = b and user_b = a)
   limit 1
$$;


--
-- Name: dm_hide(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."dm_hide"("p_conv" bigint) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'auth-required'; end if;
  update public.dm_states set hidden_until = 'infinity'::timestamptz
   where conv_id = p_conv and user_id = me;
  return jsonb_build_object('ok', true);
end $$;


--
-- Name: dm_is_blocked("uuid", "uuid"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."dm_is_blocked"("a" "uuid", "b" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (select 1 from public.dm_blocks where blocker = a and blocked = b)
$$;


--
-- Name: dm_list_convs(integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."dm_list_convs"("p_limit" integer DEFAULT 100, "p_offset" integer DEFAULT 0) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'auth-required'; end if;
  return coalesce((
    select jsonb_agg(q.x order by q.sort_at desc)
    from (
      select jsonb_build_object(
        'conv_id',        c.id,
        'other_id',       case when c.user_a = me then c.user_b else c.user_a end,
        'nickname',       p.nickname,
        'last_message_at', c.last_message_at,
        'last_preview',   c.last_preview,
        'created_at',     c.created_at,
        'accepted',       coalesce(s.accepted, true),
        'muted',          coalesce(s.muted, false),
        'hidden',         coalesce(s.hidden_until > now(), false),
        'blocked',        public.dm_is_blocked(me, case when c.user_a = me then c.user_b else c.user_a end),
        'unread', (select count(*) from public.dm_messages m
                    where m.conv_id = c.id and m.sender <> me
                      and m.deleted_at is null
                      and m.id > coalesce(s.last_read_id, 0))
      ) as x,
      coalesce(c.last_message_at, c.created_at) as sort_at
      from public.dm_conversations c
      join public.dm_states s on s.conv_id = c.id and s.user_id = me
      join public.profiles  p on p.id = (case when c.user_a = me then c.user_b else c.user_a end)
      where coalesce(s.hidden_until, '-infinity'::timestamptz) <= now()
        and not public.dm_is_blocked(me, case when c.user_a = me then c.user_b else c.user_a end)
      order by coalesce(c.last_message_at, c.created_at) desc
      limit least(coalesce(p_limit, 100), 200) offset greatest(coalesce(p_offset, 0), 0)
    ) q
  ), '[]'::jsonb);
end $$;


--
-- Name: dm_list_messages(bigint, bigint, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."dm_list_messages"("p_conv" bigint, "p_before" bigint DEFAULT NULL::bigint, "p_limit" integer DEFAULT 30) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'auth-required'; end if;
  if not exists (
    select 1 from public.dm_conversations c
     where c.id = p_conv and (c.user_a = me or c.user_b = me)
  ) then raise exception 'forbidden'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id',         m.id,
      'sender',     m.sender,
      'nickname',   p.nickname,
      'body',       case when m.deleted_at is null then m.body else '' end,
      'image_path', case when m.deleted_at is null then m.image_path else null end,
      'edited_at',  m.edited_at,
      'deleted_at', m.deleted_at,
      'created_at', m.created_at
    ) order by m.id desc)
    from (
      select * from public.dm_messages
       where conv_id = p_conv and (p_before is null or id < p_before)
       order by id desc
       limit least(coalesce(p_limit, 30), 100)
    ) m
    join public.profiles p on p.id = m.sender
  ), '[]'::jsonb);
end $$;


--
-- Name: dm_mark_read(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."dm_mark_read"("p_conv" bigint) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  me    uuid := auth.uid();
  v_max bigint;
begin
  if me is null then raise exception 'auth-required'; end if;
  if not exists (
    select 1 from public.dm_conversations c
     where c.id = p_conv and (c.user_a = me or c.user_b = me)
  ) then raise exception 'forbidden'; end if;
  select coalesce(max(id), 0) into v_max from public.dm_messages where conv_id = p_conv;
  insert into public.dm_states (conv_id, user_id, last_read_id)
    values (p_conv, me, v_max)
    on conflict (conv_id, user_id) do update
      set last_read_id = greatest(public.dm_states.last_read_id, excluded.last_read_id);
  return jsonb_build_object('ok', true, 'last_read_id', v_max);
end $$;


--
-- Name: dm_mute(bigint, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."dm_mute"("p_conv" bigint, "p_on" boolean) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'auth-required'; end if;
  update public.dm_states set muted = coalesce(p_on, true)
   where conv_id = p_conv and user_id = me;
  return jsonb_build_object('ok', true, 'muted', coalesce(p_on, true));
end $$;


--
-- Name: dm_open("uuid"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."dm_open"("p_other" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  me   uuid := auth.uid();
  v_id bigint;
begin
  if me is null then raise exception 'auth-required'; end if;
  if p_other is null or p_other = me then raise exception 'bad-target'; end if;
  if not exists (select 1 from public.profiles where id = p_other) then
    raise exception 'no-user';
  end if;
  -- 对方拉黑了我 → 拒绝发起（不暴露更多信息）
  if exists (select 1 from public.dm_blocks where blocker = p_other and blocked = me) then
    raise exception 'blocked';
  end if;
  select public.dm_find_conv(me, p_other) into v_id;
  if v_id is null then
    begin
      insert into public.dm_conversations (user_a, user_b)
        values (least(me, p_other), greatest(me, p_other))
        returning id into v_id;
    exception when unique_violation then
      v_id := public.dm_find_conv(me, p_other);
    end;
  end if;
  -- 状态行：发起者视为已接受；对方保持「消息请求」待处理（已有状态不动）
  insert into public.dm_states (conv_id, user_id, accepted)
    values (v_id, me, true), (v_id, p_other, false)
    on conflict (conv_id, user_id) do nothing;
  return jsonb_build_object('conv_id', v_id);
end $$;


--
-- Name: dm_recall(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."dm_recall"("p_msg" bigint) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  me        uuid := auth.uid();
  v_conv    bigint;
  v_sender  uuid;
  v_created timestamptz;
  v_deleted timestamptz;
begin
  if me is null then raise exception 'auth-required'; end if;
  select conv_id, sender, created_at, deleted_at
    into v_conv, v_sender, v_created, v_deleted
    from public.dm_messages where id = p_msg;
  if not found then raise exception 'no-message'; end if;
  if v_sender <> me then raise exception 'forbidden'; end if;
  if v_deleted is not null then return jsonb_build_object('ok', true); end if;
  if v_created < now() - interval '15 minutes' then raise exception 'too-late'; end if;

  update public.dm_messages set deleted_at = now(), body = '', image_path = null
   where id = p_msg;
  -- 只有当它仍是最新一条活消息时才改预览，避免把别人刚回的内容盖掉
  update public.dm_conversations c
     set last_preview = '⟲'
   where c.id = v_conv
     and not exists (
       select 1 from public.dm_messages m2
        where m2.conv_id = v_conv and m2.id > p_msg and m2.deleted_at is null
     );
  return jsonb_build_object('ok', true, 'conv_id', v_conv);
end $$;


--
-- Name: dm_send(bigint, "text", "text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."dm_send"("p_conv" bigint, "p_body" "text" DEFAULT ''::"text", "p_image" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  me      uuid := auth.uid();
  v_other uuid;
  v_mid   bigint;
  v_body  text := coalesce(p_body, '');
  v_muted boolean := false;
  v_dms   boolean := true;
  v_prev  text;
begin
  if me is null then raise exception 'auth-required'; end if;
  if p_conv is null then raise exception 'bad-conv'; end if;
  v_body := left(btrim(v_body), 2000);
  if char_length(v_body) = 0 and coalesce(p_image, '') = '' then
    raise exception 'empty-message';
  end if;
  select case when user_a = me then user_b else user_a end into v_other
    from public.dm_conversations where id = p_conv;
  if v_other is null then raise exception 'forbidden'; end if;  -- 不是参与者
  if exists (select 1 from public.dm_blocks where blocker = me and blocked = v_other) then
    raise exception 'blocked-by-me';   -- 我拉黑了对方：先去解除拉黑
  end if;
  if exists (select 1 from public.dm_blocks where blocker = v_other and blocked = me) then
    raise exception 'blocked';         -- 对方拉黑了我
  end if;

  -- #22 首次会话限制：对方从没回过时，先发起的一方最多发 3 条（防骚扰；对方一回复即解锁）。
  -- 漂流瓶续聊导入的会话双方各有一条消息，天然解锁，不受影响；已撤回的不计数。
  if not exists (
    select 1 from public.dm_messages
     where conv_id = p_conv and sender = v_other and deleted_at is null
  ) then
    if (select count(*) from public.dm_messages
         where conv_id = p_conv and sender = me and deleted_at is null) >= 3 then
      raise exception 'first-limit';
    end if;
  end if;

  insert into public.dm_messages (conv_id, sender, body, image_path)
    values (p_conv, me, v_body, nullif(coalesce(p_image, ''), ''))
    returning id into v_mid;

  -- 预览：正文截 80 字；纯图片用 📷
  v_prev := case when char_length(v_body) > 0 then left(v_body, 80) else '📷' end;
  update public.dm_conversations
     set last_message_at = now(), last_preview = v_prev
   where id = p_conv;

  -- 我方状态：回复即接受消息请求；发送意味着读到了自己的消息（抬水位）
  insert into public.dm_states (conv_id, user_id, accepted, last_read_id)
    values (p_conv, me, true, v_mid)
    on conflict (conv_id, user_id) do update
      set accepted = true,
          last_read_id = greatest(public.dm_states.last_read_id, excluded.last_read_id);
  -- 确保对方状态行存在（防御：老会话状态行缺失时补齐）
  insert into public.dm_states (conv_id, user_id, accepted)
    values (p_conv, v_other, false)
    on conflict (conv_id, user_id) do nothing;
  -- 新消息让两边被隐藏的会话重新出现（WhatsApp 行为；拉黑时 dm_send 已拒绝，不会复活）
  update public.dm_states set hidden_until = null where conv_id = p_conv;

  -- 通知对方：看对方偏好（dms 开关）与免打扰
  -- 注意：PL/pgSQL 的 SELECT INTO 在「无行」时把 NULL 赋给目标 —— 必须在赋值后再兜底，
  -- 否则没建偏好行的新用户（select 无行 → v_dms=NULL → if NULL 走 else）永远收不到私信通知。
  select coalesce(s.muted, false) into v_muted
    from public.dm_states s where s.conv_id = p_conv and s.user_id = v_other;
  v_muted := coalesce(v_muted, false);
  select p.dms into v_dms
    from public.notification_prefs p where p.user_id = v_other;
  v_dms := coalesce(v_dms, true);
  if not v_muted and v_dms then
    insert into public.notifications (user_id, actor_id, kind, conv_id, meta)
      values (v_other, me, 'dm', p_conv, jsonb_build_object('preview', v_prev));
  end if;

  return jsonb_build_object('msg_id', v_mid, 'conv_id', p_conv, 'created_at', now());
end $$;


--
-- Name: dm_unblock("uuid"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."dm_unblock"("p_user" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'auth-required'; end if;
  delete from public.dm_blocks where blocker = me and blocked = p_user;
  -- 解除隐藏（回到列表；对方仍看不到我，除非TA也解除）
  update public.dm_states s set hidden_until = null
    from public.dm_conversations c
   where c.id = s.conv_id and s.user_id = me
     and ((c.user_a = me and c.user_b = p_user) or (c.user_a = p_user and c.user_b = me));
  return jsonb_build_object('ok', true);
end $$;


--
-- Name: dm_unhide(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."dm_unhide"("p_conv" bigint) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'auth-required'; end if;
  update public.dm_states set hidden_until = null
   where conv_id = p_conv and user_id = me;
  return jsonb_build_object('ok', true);
end $$;


--
-- Name: dm_unread_total(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."dm_unread_total"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  me      uuid := auth.uid();
  v_rows  jsonb := '[]'::jsonb;
  v_total bigint := 0;
begin
  if me is null then
    return jsonb_build_object('total', 0, 'requests', 0, 'convs', '[]'::jsonb);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('conv_id', t.conv_id, 'unread', t.n) order by t.n desc), '[]'::jsonb),
         coalesce(sum(t.n), 0)
    into v_rows, v_total
    from (
      select m.conv_id, count(*) as n
        from public.dm_messages m
        join public.dm_states s on s.conv_id = m.conv_id and s.user_id = me
        join public.dm_conversations c on c.id = m.conv_id
       where m.sender <> me and m.deleted_at is null
         and m.id > coalesce(s.last_read_id, 0)
         and coalesce(s.hidden_until, '-infinity'::timestamptz) <= now()
         and not coalesce(s.muted, false)   -- 免打扰：这条会话的未读不进角标
         and not public.dm_is_blocked(me, case when c.user_a = me then c.user_b else c.user_a end)
       group by m.conv_id
    ) t;
  return jsonb_build_object(
    'total', v_total,
    'requests', coalesce((
      select count(*) from public.dm_states s
        join public.dm_conversations c on c.id = s.conv_id
       where s.user_id = me and coalesce(s.accepted, true) = false
         and coalesce(s.hidden_until, '-infinity'::timestamptz) <= now()
         and not coalesce(s.muted, false)   -- 免打扰：待处理的请求也不再催
         and not public.dm_is_blocked(me, case when c.user_a = me then c.user_b else c.user_a end)
    ), 0),
    'convs', v_rows
  );
end $$;


--
-- Name: FUNCTION "dm_unread_total"(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION "public"."dm_unread_total"() IS '未读总览；免打扰（dm_states.muted）的会话不计入 total / convs / requests（MIGRATION_dm_mute_silence.sql）';


--
-- Name: handle_new_user(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  insert into public.profiles (id, nickname)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'nickname', ''))
  on conflict (id) do nothing;
  return new;
end;
$$;


--
-- Name: is_admin(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."is_admin"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (select 1 from public.admin_users where user_id = auth.uid());
$$;


--
-- Name: maintenance_active(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."maintenance_active"() RETURNS "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select case
           when s.maintenance_mode = 'off' then 'off'
           when s.maintenance_until is not null and s.maintenance_until <= now() then 'off'
           else s.maintenance_mode
         end
    from public.app_state s
   where s.id = 1
$$;


--
-- Name: FUNCTION "maintenance_active"(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION "public"."maintenance_active"() IS '当前生效的维护档位（off/read/full）。until 过点即自动 off；表为空时也返回 off。';


--
-- Name: maintenance_blocks_write(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."maintenance_blocks_write"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select coalesce(public.maintenance_active(), 'off') <> 'off'
     and not coalesce(public.is_admin(), false)
$$;


--
-- Name: FUNCTION "maintenance_blocks_write"(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION "public"."maintenance_blocks_write"() IS '维护期是否拦截创作类写入。管理员永远不拦（便于维护期间自测）。';


--
-- Name: notif_clear(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."notif_clear"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  me uuid := auth.uid();
  v_n integer := 0;
begin
  if me is null then raise exception 'auth-required'; end if;
  with del as (
    delete from public.notifications where user_id = me returning 1
  )
  select count(*) into v_n from del;
  return jsonb_build_object('ok', true, 'removed', v_n);
end $$;


--
-- Name: notif_mark(bigint[], boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."notif_mark"("p_ids" bigint[] DEFAULT NULL::bigint[], "p_all" boolean DEFAULT false) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'auth-required'; end if;
  if coalesce(p_all, false) then
    update public.notifications set read_at = now()
     where user_id = me and read_at is null;
  elsif p_ids is not null and array_length(p_ids, 1) > 0 then
    update public.notifications set read_at = now()
     where user_id = me and read_at is null and id = any(p_ids);
  end if;
  return jsonb_build_object('ok', true);
end $$;


--
-- Name: notif_page(integer, integer, "text", boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."notif_page"("p_offset" integer DEFAULT 0, "p_limit" integer DEFAULT 30, "p_kinds" "text" DEFAULT NULL::"text", "p_unread" boolean DEFAULT false) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  me      uuid := auth.uid();
  v_kinds text[];
begin
  if me is null then raise exception 'auth-required'; end if;
  if p_kinds is not null and btrim(p_kinds) <> '' then
    select array_agg(btrim(x)) into v_kinds
      from unnest(string_to_array(p_kinds, ',')) x where btrim(x) <> '';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id',           n.id,
      'kind',         n.kind,
      'actor_id',     n.actor_id,
      'actor_name',   ap.nickname,
      'post_id',      n.post_id,
      'comment_id',   n.comment_id,
      'conv_id',      n.conv_id,
      'meta',         n.meta,
      'read_at',      n.read_at,
      'created_at',   n.created_at,
      'post_body',    left(pp.body, 80),
      'comment_body', left(pc.body, 80),
      'removed',      coalesce(pp.removed, false)
    ) order by n.id desc)
    from (
      select * from public.notifications
       where user_id = me
         and (v_kinds is null or kind = any(v_kinds))
         and (coalesce(p_unread, false) = false or read_at is null)
       order by id desc
       limit least(coalesce(p_limit, 30), 100)
       offset greatest(coalesce(p_offset, 0), 0)
    ) n
    left join public.profiles      ap on ap.id = n.actor_id
    left join public.wall_posts    pp on pp.id = n.post_id
    left join public.wall_comments pc on pc.id = n.comment_id
  ), '[]'::jsonb);
end $$;


--
-- Name: notif_prefs_get(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."notif_prefs_get"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'auth-required'; end if;
  return jsonb_build_object(
    'comments',  coalesce((select p.comments  from public.notification_prefs p where p.user_id = me), true),
    'reactions', coalesce((select p.reactions from public.notification_prefs p where p.user_id = me), true),
    'pets',      coalesce((select p.pets      from public.notification_prefs p where p.user_id = me), true),
    'dms',       coalesce((select p.dms       from public.notification_prefs p where p.user_id = me), true)
  );
end $$;


--
-- Name: notif_prefs_set(boolean, boolean, boolean, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."notif_prefs_set"("p_comments" boolean DEFAULT true, "p_reactions" boolean DEFAULT true, "p_pets" boolean DEFAULT true, "p_dms" boolean DEFAULT true) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  me uuid := auth.uid();
  v_old_comments  boolean;
  v_old_reactions boolean;
  v_old_pets      boolean;
begin
  if me is null then raise exception 'auth-required'; end if;

  /* 缺行 = 全开（与 notif_prefs_get、各通知触发器的口径一致） */
  select p.comments, p.reactions, p.pets
    into v_old_comments, v_old_reactions, v_old_pets
    from public.notification_prefs p where p.user_id = me;

  insert into public.notification_prefs (user_id, comments, reactions, pets, dms, updated_at)
    values (me, coalesce(p_comments, true), coalesce(p_reactions, true),
            coalesce(p_pets, true), coalesce(p_dms, true), now())
    on conflict (user_id) do update
      set comments   = excluded.comments,
          reactions  = excluded.reactions,
          pets       = excluded.pets,
          dms        = excluded.dms,
          updated_at = now();

  /* 由开 → 关：该类未读立刻作废（红点当场消），历史行保留为已读态。
   * 只在「真的从开变关」时执行 —— 反复保存同一个关状态不会把之后新来的未读也抹掉。 */
  if coalesce(v_old_comments, true) and not coalesce(p_comments, true) then
    update public.notifications set read_at = now()
     where user_id = me and read_at is null and kind in ('comment', 'reply');
  end if;
  if coalesce(v_old_reactions, true) and not coalesce(p_reactions, true) then
    update public.notifications set read_at = now()
     where user_id = me and read_at is null and kind = 'reaction';
  end if;
  if coalesce(v_old_pets, true) and not coalesce(p_pets, true) then
    update public.notifications set read_at = now()
     where user_id = me and read_at is null and kind = 'pet';
  end if;

  return jsonb_build_object('ok', true);
end $$;


--
-- Name: notif_unread(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."notif_unread"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare me uuid := auth.uid();
begin
  if me is null then
    return jsonb_build_object('total',0,'comments',0,'reactions',0,'pets',0,'dms',0,'system',0);
  end if;
  return jsonb_build_object(
    'total',     (select count(*) from public.notifications where user_id = me and read_at is null),
    'comments',  (select count(*) from public.notifications where user_id = me and read_at is null and kind in ('comment','reply')),
    'reactions', (select count(*) from public.notifications where user_id = me and read_at is null and kind in ('reaction','pet')),
    'pets',      (select count(*) from public.notifications where user_id = me and read_at is null and kind = 'pet'),
    'dms',       (select count(*) from public.notifications where user_id = me and read_at is null and kind = 'dm'),
    'system',    (select count(*) from public.notifications where user_id = me and read_at is null and kind = 'system')
  );
end $$;


--
-- Name: notifications_drop_dm(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."notifications_drop_dm"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  if new.kind = 'dm' then
    return null;   -- 私信有自己的入口（💬 + /messages），不再进通知中心
  end if;
  return new;
end $$;


--
-- Name: notify_on_comment(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."notify_on_comment"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_owner       uuid;
  v_parent_user uuid;
  v_pref        boolean;
  v_actor       uuid := new.user_id;
  v_targets     uuid[] := array[]::uuid[];
  v_target      uuid;
begin
  select user_id into v_owner from public.wall_posts where id = new.post_id;
  if v_owner is null then return new; end if;
  if new.parent_id is not null then
    select user_id into v_parent_user from public.wall_comments where id = new.parent_id;
  end if;
  if v_parent_user is not null and v_parent_user <> v_actor then
    v_targets := v_targets || v_parent_user;
  end if;
  if v_owner <> v_actor and not (v_owner = any(v_targets)) then
    v_targets := v_targets || v_owner;
  end if;
  foreach v_target in array v_targets loop
    select coalesce(p.comments, true) into v_pref
      from public.notification_prefs p where p.user_id = v_target;
    if coalesce(v_pref, true) then
      insert into public.notifications (user_id, actor_id, kind, post_id, comment_id, meta)
        values (v_target, v_actor,
                case when v_target = v_parent_user then 'reply' else 'comment' end,
                new.post_id, new.id,
                jsonb_build_object('preview', left(new.body, 80)));
    end if;
  end loop;
  return new;
end $$;


--
-- Name: notify_on_pet(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."notify_on_pet"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_viewer uuid := auth.uid();
  v_pref   boolean;
begin
  if v_viewer is null or v_viewer = new.owner_id then return new; end if;
  select coalesce(p.pets, true) into v_pref
    from public.notification_prefs p where p.user_id = new.owner_id;
  if coalesce(v_pref, true) then
    delete from public.notifications
     where user_id = new.owner_id
       and actor_id = v_viewer
       and kind = 'pet'
       and coalesce(meta->>'pet_kind', '') = new.kind
       and read_at is null
       and created_at > now() - interval '24 hours';
    insert into public.notifications (user_id, actor_id, kind, meta)
      values (new.owner_id, v_viewer, 'pet', jsonb_build_object('pet_kind', new.kind));
  end if;
  return new;
end $$;


--
-- Name: notify_on_reaction(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."notify_on_reaction"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_owner uuid;
  v_pref  boolean;
begin
  select user_id into v_owner from public.wall_posts where id = new.post_id;
  if v_owner is null or v_owner = new.user_id then return new; end if;
  select coalesce(p.reactions, true) into v_pref
    from public.notification_prefs p where p.user_id = v_owner;
  if coalesce(v_pref, true) then
    /* 降噪：同一人对同一条帖的同一类回应，未读只保留最新一条 */
    delete from public.notifications
     where user_id = v_owner
       and actor_id = new.user_id
       and kind = 'reaction'
       and post_id = new.post_id
       and coalesce(meta->>'reaction', '') = new.kind
       and read_at is null;
    insert into public.notifications (user_id, actor_id, kind, post_id, meta)
      values (v_owner, new.user_id, 'reaction', new.post_id,
              jsonb_build_object('reaction', new.kind));
  end if;
  return new;
end $$;


--
-- Name: notify_on_reaction_undo(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."notify_on_reaction_undo"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  delete from public.notifications
   where user_id = (select user_id from public.wall_posts where id = old.post_id)
     and actor_id = old.user_id
     and kind = 'reaction'
     and post_id = old.post_id
     and coalesce(meta->>'reaction', '') = old.kind
     and read_at is null;
  return old;
end $$;


--
-- Name: pet_interact("uuid", "text", "text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."pet_interact"("p_owner" "uuid", "p_kind" "text", "p_viewer" "text" DEFAULT ''::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_viewer  text := coalesce(nullif(trim(coalesce(p_viewer, '')), ''),
                             coalesce(auth.uid()::text, 'anon'));
  v_counted boolean;
  v_pats    integer;
  v_feeds   integer;
begin
  if p_kind not in ('pat', 'feed') then
    return jsonb_build_object('ok', false, 'reason', 'bad-kind');
  end if;

  insert into public.pet_interactions (owner_id, viewer_key, kind)
  values (p_owner, v_viewer, p_kind)
  on conflict do nothing;
  v_counted := found;                      -- 真的插进去了才算一次（同人同日同类型只一次）

  if v_counted then
    /* 主人还没推过快照也先建好行，保证计数不丢（主人之后的 upsert 只改 data / updated_at） */
    insert into public.pet_profiles (user_id) values (p_owner)
      on conflict (user_id) do nothing;

    update public.pet_profiles
      set pats  = pats  + case when p_kind = 'pat'  then 1 else 0 end,
          feeds = feeds + case when p_kind = 'feed' then 1 else 0 end
      where user_id = p_owner;
  end if;

  select pats, feeds into v_pats, v_feeds
    from public.pet_profiles where user_id = p_owner;

  return jsonb_build_object('ok', true, 'counted', v_counted,
                            'counts', jsonb_build_object('pats',  coalesce(v_pats, 0),
                                                         'feeds', coalesce(v_feeds, 0)));
end $$;


--
-- Name: rename_me("text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."rename_me"("p_nick" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  me         uuid := auth.uid();
  v_nick     text;
  v_posts    integer := 0;
  v_comments integer := 0;
begin
  if me is null then raise exception 'auth-required'; end if;

  v_nick := btrim(coalesce(p_nick, ''));
  if v_nick = '' then raise exception 'empty-nickname'; end if;
  -- 24 = 前端 authRules.NICK_MAX（超长会撑破署名与侧栏）
  if char_length(v_nick) > 24 then raise exception 'nick-too-long'; end if;

  update public.profiles set nickname = v_nick where id = me;
  if not found then raise exception 'no-profile'; end if;

  update public.wall_posts    set author_name = v_nick where user_id = me;
  get diagnostics v_posts = row_count;

  update public.wall_comments set author_name = v_nick where user_id = me;
  get diagnostics v_comments = row_count;

  return jsonb_build_object('nickname', v_nick, 'posts', v_posts, 'comments', v_comments);
end $$;


--
-- Name: FUNCTION "rename_me"("p_nick" "text"); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION "public"."rename_me"("p_nick" "text") IS '改自己的昵称并同步旧帖/旧评论的署名（security definer；未跑本迁移时前端退回只改 profiles）';


--
-- Name: report_create("text", bigint, "text", "text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."report_create"("p_target_type" "text", "p_target_id" bigint, "p_reason" "text", "p_detail" "text" DEFAULT ''::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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


--
-- Name: status_counts(timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."status_counts"("p_since" timestamp with time zone) RETURNS TABLE("status" "text", "cnt" bigint)
    LANGUAGE "sql" STABLE
    AS $_$
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
$_$;


--
-- Name: story_add_comment(bigint, "text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."story_add_comment"("p_story_id" bigint, "p_body" "text") RETURNS bigint
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  me uuid := auth.uid();
  v_body text;
  v_id bigint;
begin
  if me is null then raise exception 'story-auth'; end if;
  v_body := btrim(coalesce(p_body, ''));
  if char_length(v_body) < 1 then raise exception 'story-comment-empty'; end if;
  if char_length(v_body) > 1000 then raise exception 'story-comment-long'; end if;

  insert into public.story_comments (story_id, user_id, body)
  values (p_story_id, me, v_body)
  returning id into v_id;

  -- 目标必须是已发布故事：否则删掉刚插的那条，保持计数与实际条数一致
  if not exists (select 1 from public.stories where id = p_story_id and status = 'published') then
    delete from public.story_comments where id = v_id;
    raise exception 'story-not-found';
  end if;

  update public.stories set comment_count = comment_count + 1 where id = p_story_id;
  return v_id;
end $$;


--
-- Name: story_add_view(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."story_add_view"("p_id" bigint) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare me uuid := auth.uid();
begin
  if me is null then return; end if;
  insert into public.story_views (story_id, user_id) values (p_id, me)
    on conflict do nothing;
  if found then
    update public.stories set view_count = view_count + 1 where id = p_id and status = 'published';
  end if;
end $$;


--
-- Name: story_bookmark_list(integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."story_bookmark_list"("p_limit" integer DEFAULT 30, "p_offset" integer DEFAULT 0) RETURNS TABLE("id" bigint, "user_id" "uuid", "nickname" "text", "title" "text", "tags" "text"[], "like_count" integer, "view_count" integer, "word_count" integer, "read_minutes" integer, "published_at" timestamp with time zone, "saved_at" timestamp with time zone)
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select s.id, s.user_id,
         (select pr.nickname from public.profiles pr where pr.id = s.user_id),
         s.title, s.tags, s.like_count, s.view_count, s.word_count, s.read_minutes,
         s.published_at, b.created_at
    from public.story_bookmarks b
    join public.stories s on s.id = b.story_id
   where b.user_id = auth.uid()
     and s.status = 'published'
   order by b.created_at desc, s.id desc
   limit greatest(p_limit, 1) offset greatest(coalesce(p_offset, 0), 0)
$$;


--
-- Name: story_comment_list(bigint, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."story_comment_list"("p_story_id" bigint, "p_limit" integer DEFAULT 50) RETURNS TABLE("id" bigint, "user_id" "uuid", "nickname" "text", "body" "text", "created_at" timestamp with time zone, "mine" boolean)
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select c.id, c.user_id,
         (select pr.nickname from public.profiles pr where pr.id = c.user_id),
         c.body, c.created_at, (c.user_id = auth.uid()) as mine
    from public.story_comments c
   where c.story_id = p_story_id
     and exists (select 1 from public.stories s
                  where s.id = c.story_id
                    and (s.status = 'published' or s.user_id = auth.uid()))
   order by c.created_at asc, c.id asc
   limit greatest(p_limit, 1)
$$;


--
-- Name: story_delete_comment(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."story_delete_comment"("p_id" bigint) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  me uuid := auth.uid();
  v_story bigint;
begin
  if me is null then raise exception 'story-auth'; end if;
  select c.story_id into v_story from public.story_comments c where c.id = p_id;
  if not found then raise exception 'story-not-found'; end if;
  if not exists (select 1 from public.story_comments c
                   where c.id = p_id
                     and (c.user_id = me
                          or exists (select 1 from public.stories s
                                      where s.id = c.story_id and s.user_id = me)))
  then raise exception 'story-auth'; end if;

  delete from public.story_comments where id = p_id;
  update public.stories set comment_count = greatest(comment_count - 1, 0) where id = v_story;
end $$;


--
-- Name: story_delete_draft(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."story_delete_draft"("p_id" bigint) RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception 'story-auth'; end if;
  delete from public.stories
   where id = p_id and user_id = me and status = 'draft';
  if not found then raise exception 'story-not-found'; end if;
  return true;
end $$;


--
-- Name: story_featured(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."story_featured"() RETURNS TABLE("id" bigint, "user_id" "uuid", "nickname" "text", "title" "text", "tags" "text"[], "like_count" integer, "view_count" integer, "word_count" integer, "read_minutes" integer, "published_at" timestamp with time zone)
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select s.id, s.user_id,
         (select pr.nickname from public.profiles pr where pr.id = s.user_id),
         s.title, s.tags, s.like_count, s.view_count, s.word_count, s.read_minutes,
         s.published_at
    from public.stories s
   where s.status = 'published' and s.featured
   order by s.published_at desc, s.id desc
   limit 1
$$;


--
-- Name: story_get(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."story_get"("p_id" bigint) RETURNS TABLE("id" bigint, "user_id" "uuid", "nickname" "text", "title" "text", "body" "text", "tags" "text"[], "status" "text", "like_count" integer, "comment_count" integer, "view_count" integer, "word_count" integer, "read_minutes" integer, "rev" integer, "published_at" timestamp with time zone, "updated_at" timestamp with time zone, "liked" boolean, "marked" boolean, "mine" boolean)
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select s.id, s.user_id,
         (select pr.nickname from public.profiles pr where pr.id = s.user_id),
         s.title, s.body, s.tags, s.status, s.like_count, s.comment_count, s.view_count,
         s.word_count, s.read_minutes, s.rev, s.published_at, s.updated_at,
         exists (select 1 from public.story_likes l
                  where l.story_id = s.id and l.user_id = auth.uid()) as liked,
         exists (select 1 from public.story_bookmarks b
                  where b.story_id = s.id and b.user_id = auth.uid()) as marked,
         (s.user_id = auth.uid()) as mine
    from public.stories s
   where s.id = p_id
     and (s.status = 'published' or s.user_id = auth.uid())
$$;


--
-- Name: story_mine("text", integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."story_mine"("p_status" "text" DEFAULT NULL::"text", "p_limit" integer DEFAULT 30, "p_offset" integer DEFAULT 0) RETURNS TABLE("id" bigint, "user_id" "uuid", "nickname" "text", "title" "text", "body" "text", "tags" "text"[], "status" "text", "like_count" integer, "comment_count" integer, "view_count" integer, "word_count" integer, "read_minutes" integer, "rev" integer, "published_at" timestamp with time zone, "updated_at" timestamp with time zone, "liked" boolean, "mine" boolean)
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select s.id, s.user_id, null::text,
         s.title, s.body, s.tags, s.status, s.like_count, s.comment_count, s.view_count,
         s.word_count, s.read_minutes, s.rev, s.published_at, s.updated_at,
         false, true
    from public.stories s
   where s.user_id = auth.uid()
     and s.status <> 'removed'
     and (p_status is null or s.status = p_status)
   order by s.updated_at desc, s.id desc
   limit greatest(p_limit, 1) offset greatest(coalesce(p_offset, 0), 0)
$$;


--
-- Name: story_my_flags(bigint[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."story_my_flags"("p_ids" bigint[]) RETURNS TABLE("story_id" bigint, "liked" boolean, "marked" boolean)
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select s.id,
         exists (select 1 from public.story_likes l
                  where l.story_id = s.id and l.user_id = auth.uid()),
         exists (select 1 from public.story_bookmarks b
                  where b.story_id = s.id and b.user_id = auth.uid())
    from unnest(coalesce(p_ids, '{}')) s(id)
$$;


--
-- Name: story_my_stats(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."story_my_stats"() RETURNS TABLE("published_count" bigint, "draft_count" bigint, "total_likes" bigint, "total_views" bigint, "total_comments" bigint, "bookmark_count" bigint, "best_id" bigint, "best_title" "text", "best_likes" integer)
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  with mine as (
    select s.id, s.title, s.status, s.like_count, s.view_count, s.comment_count, s.published_at
      from public.stories s
     where s.user_id = auth.uid() and s.status in ('draft', 'published')
  ),
  best as (
    select m.id, m.title, m.like_count
      from mine m
     where m.status = 'published'
     order by m.like_count desc, m.published_at desc nulls last, m.id desc
     limit 1
  )
  select (select count(*) from mine where status = 'published'),
         (select count(*) from mine where status = 'draft'),
         (select coalesce(sum(like_count), 0) from mine where status = 'published'),
         (select coalesce(sum(view_count), 0) from mine where status = 'published'),
         (select coalesce(sum(comment_count), 0) from mine where status = 'published'),
         (select count(*) from public.story_bookmarks b where b.user_id = auth.uid()),
         (select id from best), (select title from best), (select like_count from best)
$$;


--
-- Name: stories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."stories" (
    "id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "body" "text" NOT NULL,
    "tags" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "word_count" integer DEFAULT 0 NOT NULL,
    "read_minutes" integer DEFAULT 1 NOT NULL,
    "like_count" integer DEFAULT 0 NOT NULL,
    "comment_count" integer DEFAULT 0 NOT NULL,
    "view_count" integer DEFAULT 0 NOT NULL,
    "rev" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "published_at" timestamp with time zone,
    "featured" boolean DEFAULT false NOT NULL,
    "lang" "text" DEFAULT 'und'::"text" NOT NULL,
    CONSTRAINT "stories_body_check" CHECK ((("char_length"("body") >= 1) AND ("char_length"("body") <= 30000))),
    CONSTRAINT "stories_lang_chk" CHECK (("lang" = ANY (ARRAY['zh'::"text", 'en'::"text", 'es'::"text", 'pt'::"text", 'fr'::"text", 'ja'::"text", 'ko'::"text", 'und'::"text"]))),
    CONSTRAINT "stories_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'published'::"text", 'removed'::"text"]))),
    CONSTRAINT "stories_tags_len" CHECK ((("array_length"("tags", 1) IS NULL) OR (("array_length"("tags", 1) >= 1) AND ("array_length"("tags", 1) <= 3)))),
    CONSTRAINT "stories_title_check" CHECK ((("char_length"("title") >= 1) AND ("char_length"("title") <= 100)))
);


--
-- Name: story_publish(bigint, "text", "text", "text"[], "text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."story_publish"("p_id" bigint, "p_title" "text", "p_body" "text", "p_tags" "text"[] DEFAULT '{}'::"text"[], "p_lang" "text" DEFAULT NULL::"text") RETURNS SETOF "public"."stories"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  me uuid := auth.uid();
  v_tags text[];
  v_words integer;
  v_lang text;
  rec public.stories%rowtype;
begin
  if me is null then raise exception 'story-auth'; end if;
  if p_title is null or char_length(trim(p_title)) = 0 or char_length(p_title) > 100 then
    raise exception 'story-bad-title';
  end if;
  if p_body is null or char_length(p_body) = 0 or char_length(p_body) > 30000 then
    raise exception 'story-too-long';
  end if;
  -- 正文下限 100 字（只卡发布；草稿 story_save_draft 不受此限）。
  -- 注意：刻意不动表上的 check (char_length(body) between 1 and 30000) ——
  -- 库里可能有 <100 字的存量故事，改约束会让它们一被编辑就撞约束报错。
  if char_length(p_body) < 100 then
    raise exception 'story-too-short';
  end if;
  select coalesce(array_agg(distinct lower(trim(x))) filter (where length(trim(x)) between 1 and 20), '{}')
    into v_tags from unnest(coalesce(p_tags, '{}')) x;
  if array_length(v_tags, 1) is null or array_length(v_tags, 1) > 3 then
    raise exception 'story-bad-tags';
  end if;
  v_words := char_length(p_body);

  /* 语言：优先用客户端检测结果，没传则按汉字正则兜底 */
  v_lang := case
    when p_lang in ('zh','en','es','pt','fr','ja','ko','und') then p_lang
    when coalesce(p_title, '') || ' ' || coalesce(p_body, '') ~ '[一-龥]' then 'zh'
    else 'und'
  end;

  if p_id is null then
    insert into public.stories (user_id, title, body, tags, status, word_count, read_minutes, published_at, lang)
    values (me, trim(p_title), p_body, v_tags, 'published', v_words,
            greatest(1, ceil(v_words / 400.0)::int), now(), v_lang)
    returning * into rec;
  else
    update public.stories
       set title = trim(p_title), body = p_body, tags = v_tags, status = 'published',
           word_count = v_words, read_minutes = greatest(1, ceil(v_words / 400.0)::int),
           rev = rev + 1, updated_at = now(),
           published_at = coalesce(published_at, now()),
           lang = v_lang
     where id = p_id and user_id = me and status <> 'removed'
    returning * into rec;
    if not found then raise exception 'story-not-found'; end if;
  end if;
  return next rec;
end $$;


--
-- Name: story_rank("text", "text", "text", integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."story_rank"("p_mode" "text" DEFAULT 'random'::"text", "p_tag" "text" DEFAULT NULL::"text", "p_period" "text" DEFAULT NULL::"text", "p_limit" integer DEFAULT 20, "p_offset" integer DEFAULT 0) RETURNS TABLE("id" bigint, "user_id" "uuid", "nickname" "text", "title" "text", "tags" "text"[], "like_count" integer, "view_count" integer, "word_count" integer, "read_minutes" integer, "published_at" timestamp with time zone, "score" numeric, "lang" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_period text := coalesce(p_period, to_char(now(), 'YYYY-MM'));
  v_seed bigint := floor(extract(epoch from now()) / 300)::bigint; -- 5 分钟一换批
begin
  if p_mode not in ('random', 'latest', 'monthly', 'tag') then raise exception 'story-bad-mode'; end if;

  if p_mode = 'random' then
    perform setseed(((v_seed % 1000)::double precision / 1000.0) - 0.5); -- 确定性种子：同窗口内结果稳定
    return query
    with pool as (
      select s.*,
             (select pr.nickname from public.profiles pr where pr.id = s.user_id) as nickname,
             (s.like_count * 0.6 + s.view_count * 0.3
              + 10.0 * greatest(0, 1 - extract(epoch from (now() - s.published_at)) / 2592000)) as q,
             /* 轮 443：阶梯新鲜度 —— 0 = 30 天内，1 = 90 天内，2 = 一年内，3 = 更早。
                分档代替过滤：新内容永远优先，池子不够时逐级往后放宽，不会给出空榜。 */
             case
               when s.published_at > now() - interval '30 days'  then 0
               when s.published_at > now() - interval '90 days'  then 1
               when s.published_at > now() - interval '365 days' then 2
               else 3
             end as tier
        from public.stories s
       where s.status = 'published'
         and (p_tag is null or s.tags && array[p_tag])
    )
    select p.id, p.user_id, p.nickname, p.title, p.tags, p.like_count, p.view_count,
           p.word_count, p.read_minutes, p.published_at, p.q, p.lang
      from pool p
     /* tier 升序 = 新的在前；(q+1) 而非 q：老内容时间衰减被截断成 0，
        直接用 q 会让它们整档并列 0、分页顺序漂移（翻页重复/漏条）。 */
     order by p.tier, (p.q + 1) * (0.5 + random()) desc
     limit greatest(p_limit, 1) offset greatest(coalesce(p_offset, 0), 0);

  elsif p_mode = 'latest' then
    return query
    select s.id, s.user_id,
           (select pr.nickname from public.profiles pr where pr.id = s.user_id),
           s.title, s.tags, s.like_count, s.view_count,
           s.word_count, s.read_minutes, s.published_at, 0::numeric, s.lang
      from public.stories s
     where s.status = 'published' and (p_tag is null or s.tags && array[p_tag])
     order by s.published_at desc, s.id desc
     limit greatest(p_limit, 1) offset greatest(coalesce(p_offset, 0), 0);

  elsif p_mode = 'monthly' then
    return query
    select s.id, s.user_id,
           (select pr.nickname from public.profiles pr where pr.id = s.user_id),
           s.title, s.tags, s.like_count, s.view_count,
           s.word_count, s.read_minutes, s.published_at,
           count(l.user_id)::numeric as mlikes, s.lang
      from public.stories s
      join public.story_likes l on l.story_id = s.id
     where s.status = 'published'
       and to_char(l.created_at, 'YYYY-MM') = v_period
       and (p_tag is null or s.tags && array[p_tag])
     group by s.id
     order by mlikes desc, s.published_at desc
     limit greatest(p_limit, 1) offset greatest(coalesce(p_offset, 0), 0);

  else -- tag：热门标签云榜（按标签聚合的当期赞数+篇数，前端选标签后再拉该标签故事）
    return query
    select 0::bigint as id, '00000000-0000-0000-0000-000000000000'::uuid as user_id,
           null::text as nickname,
           t as title, array[t] as tags, sum(s.like_count)::integer as like_count,
           count(*)::integer as view_count, 0 as word_count, 0 as read_minutes,
           max(s.published_at) as published_at,
           count(l.user_id)::numeric,
           null::text as lang
      from public.stories s
      cross join lateral unnest(s.tags) t
      left join public.story_likes l on l.story_id = s.id
       and to_char(l.created_at, 'YYYY-MM') = v_period
     where s.status = 'published'
     group by t
     -- 排序列必须用限定名/别名：裸 score 会被 plpgsql 当 OUT 变量替换（NULL，排序静默失效）
     order by count(l.user_id) desc, count(*) desc, t
     limit greatest(p_limit, 1) offset greatest(coalesce(p_offset, 0), 0);
  end if;
end $$;


--
-- Name: story_save_draft(bigint, "text", "text", "text"[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."story_save_draft"("p_id" bigint, "p_title" "text", "p_body" "text", "p_tags" "text"[] DEFAULT '{}'::"text"[]) RETURNS SETOF "public"."stories"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  me uuid := auth.uid();
  rec public.stories%rowtype;
begin
  if me is null then raise exception 'story-auth'; end if;
  /* 存草稿宽容：标题可空（占位「无标题」），正文 ≤30000 同口径 */
  if char_length(coalesce(p_body, '')) > 30000 then raise exception 'story-too-long'; end if;
  if p_id is null then
    insert into public.stories (user_id, title, body, tags, status, word_count)
    values (me, coalesce(nullif(trim(coalesce(p_title, '')), ''), '无标题'), coalesce(p_body, ''),
            coalesce(p_tags, '{}'), 'draft', char_length(coalesce(p_body, '')))
    returning * into rec;
  else
    update public.stories
       set title = coalesce(nullif(trim(coalesce(p_title, '')), ''), title),
           body = coalesce(p_body, body), tags = coalesce(p_tags, tags),
           word_count = char_length(coalesce(p_body, body)), rev = rev + 1, updated_at = now()
     where id = p_id and user_id = me and status = 'draft'
    returning * into rec;
    if not found then raise exception 'story-not-found'; end if;
  end if;
  return next rec;
end $$;


--
-- Name: story_set_bookmark(bigint, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."story_set_bookmark"("p_id" bigint, "p_on" boolean) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  me uuid := auth.uid();
  n integer;
begin
  if me is null then raise exception 'story-auth'; end if;
  if not exists (select 1 from public.stories where id = p_id) then
    raise exception 'story-not-found';
  end if;
  if p_on and not exists (select 1 from public.story_bookmarks where story_id = p_id and user_id = me) then
    insert into public.story_bookmarks (story_id, user_id) values (p_id, me);
  elsif (not p_on) and exists (select 1 from public.story_bookmarks where story_id = p_id and user_id = me) then
    delete from public.story_bookmarks where story_id = p_id and user_id = me;
  end if;
  select count(*) into n from public.story_bookmarks where story_id = p_id;
  return n;
end $$;


--
-- Name: story_set_featured(bigint, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."story_set_featured"("p_id" bigint, "p_on" boolean) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if not public.is_admin() then raise exception 'story-auth'; end if;
  if p_on then
    if not exists (select 1 from public.stories where id = p_id and status = 'published')
    then raise exception 'story-not-found'; end if;
    update public.stories set featured = false where featured;   -- 单一精选：先全撤
    update public.stories set featured = true where id = p_id;
  else
    update public.stories set featured = false where id = p_id;
  end if;
end $$;


--
-- Name: story_set_like(bigint, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."story_set_like"("p_id" bigint, "p_on" boolean) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  me uuid := auth.uid();
  n integer;
begin
  if me is null then raise exception 'story-auth'; end if;
  if not exists (select 1 from public.stories where id = p_id) then
    raise exception 'story-not-found';
  end if;
  if p_on and not exists (select 1 from public.story_likes where story_id = p_id and user_id = me) then
    insert into public.story_likes (story_id, user_id) values (p_id, me);
    update public.stories set like_count = like_count + 1 where id = p_id and status = 'published';
  elsif (not p_on) and exists (select 1 from public.story_likes where story_id = p_id and user_id = me) then
    delete from public.story_likes where story_id = p_id and user_id = me;
    update public.stories set like_count = greatest(like_count - 1, 0) where id = p_id and status = 'published';
  end if;
  select like_count into n from public.stories where id = p_id;
  if n is null then raise exception 'story-not-found'; end if;
  return n;
end $$;


--
-- Name: story_toggle_bookmark(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."story_toggle_bookmark"("p_id" bigint) RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception 'story-auth'; end if;
  if not exists (select 1 from public.stories where id = p_id and status = 'published')
  then raise exception 'story-not-found'; end if;

  if exists (select 1 from public.story_bookmarks where story_id = p_id and user_id = me) then
    delete from public.story_bookmarks where story_id = p_id and user_id = me;
    return false;
  end if;
  insert into public.story_bookmarks (story_id, user_id) values (p_id, me);
  return true;
end $$;


--
-- Name: story_toggle_like(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."story_toggle_like"("p_id" bigint) RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  me uuid := auth.uid();
  had boolean;
begin
  if me is null then raise exception 'story-auth'; end if;
  select true into had from public.story_likes where story_id = p_id and user_id = me;
  if found then
    delete from public.story_likes where story_id = p_id and user_id = me;
    update public.stories set like_count = greatest(like_count - 1, 0) where id = p_id;
    return false;
  end if;
  insert into public.story_likes (story_id, user_id) values (p_id, me);
  update public.stories set like_count = like_count + 1
   where id = p_id and status = 'published';
  if not found then raise exception 'story-not-found'; end if;
  return true;
end $$;


--
-- Name: tg_maintenance_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."tg_maintenance_guard"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if public.maintenance_blocks_write() then
    raise exception 'maintenance-mode' using errcode = 'PT503';
  end if;
  return new;
end $$;


--
-- Name: FUNCTION "tg_maintenance_guard"(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION "public"."tg_maintenance_guard"() IS '维护期拦截创作类 INSERT。errcode PT503 便于前端识别成「正在升级」而不是通用错误。';


--
-- Name: wall_add_view(bigint, "text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."wall_add_view"("p_post" bigint, "p_viewer" "text" DEFAULT ''::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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


--
-- Name: wall_add_views(bigint[], "text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."wall_add_views"("p_posts" bigint[], "p_viewer" "text" DEFAULT ''::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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


--
-- Name: wall_comment_delete(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."wall_comment_delete"("p_id" bigint) RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  n int;
begin
  update public.wall_comments
     set deleted_at = now()
   where id = p_id
     and user_id = auth.uid()        -- 本人（未登录时 auth.uid() 为空 → 改不到任何行 → 返回 false）
     and deleted_at is null;         -- 幂等：已经删过的不再动
  get diagnostics n = row_count;
  return n > 0;
end;
$$;


--
-- Name: wall_daily_limit(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."wall_daily_limit"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if (
    select count(*) from public.wall_posts p
    where p.user_id = new.user_id and p.created_day = new.created_day
  ) >= 7 then
    -- 固定暗号不变：前端 wallRules.errorKind 靠它显示「今天发满了」
    raise exception 'wall_daily_limit' using errcode = 'P0001',
      hint = '每个用户每天最多发 7 条暖心墙内容';
  end if;
  return new;
end $$;


--
-- Name: wall_feed_page(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."wall_feed_page"("p_limit" integer DEFAULT 20) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_ids   bigint[];
  v_rnd   bigint[];
  v_latest jsonb;
  v_random jsonb;
  v_react  jsonb;
  v_comment jsonb;
begin
  -- ① 最新页（id 倒序 = 发布序），行 + id 数组一次取出
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', t.id, 'user_id', t.user_id, 'author_name', t.author_name,
           'body', t.body, 'image_path', t.image_path, 'created_at', t.created_at,
           'views', t.views, 'dislikes', t.dislikes, 'removed', false
         ) order by t.id desc), '[]'::jsonb),
         coalesce(array_agg(t.id), '{}'::bigint[])
    into v_latest, v_ids
    from (
      select id, user_id, author_name, body, image_path, created_at, views, dislikes
      from wall_posts
      where removed = false
      order by id desc
      limit greatest(p_limit, 1)
    ) t;

  -- ② 7 天池随机批（排除最新页已有的帖）
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', t.id, 'user_id', t.user_id, 'author_name', t.author_name,
           'body', t.body, 'image_path', t.image_path, 'created_at', t.created_at,
           'views', t.views, 'dislikes', t.dislikes, 'removed', false
           ) order by t.ord), '[]'::jsonb),
         coalesce(array_agg(t.id), '{}'::bigint[])
    into v_random, v_rnd
    from (
      select id, user_id, author_name, body, image_path, created_at, views, dislikes,
             row_number() over () as ord
      from wall_posts
      where removed = false
        and created_at > now() - interval '7 days'
        and not (id = any(v_ids))
      order by random()
      limit greatest(p_limit, 1)
    ) t;

  -- ③ 回应计数（按 kind 分组 JOIN）+ 我的回应；评论数——全部对并集一次聚合
  --
  -- ⚠ 轮 295 修复（生产实测 400 / code 22023「field name must not be null」）：
  --   a.post_id、b.post_id 是 LEFT JOIN 出来的**可空列**。一条帖只要没有任何回应或评论，
  --   它就是 NULL —— 而 jsonb_object_agg 拿 NULL 当字典键会直接抛错，于是**整个函数失败**。
  --   外面那层 coalesce(..., '{}') 救不了：它包的是聚合的「结果」，可聚合在出结果之前就炸了。
  --   墙上绝大多数帖都是 0 回应 0 评论 → 本函数基本必炸。
  --   后果：前端每次刷新都回退到「只拉最新页」，轮 169/170 的「随机换一批 + 合并包」一直静默失效，
  --         且每次白等一次往返才兜底（生产实测该 RPC 烧掉 2.3s）。
  --   修法：给两个 jsonb_object_agg 各加 filter —— NULL 键根本不进聚合，也就无从抛错；
  --         没有匹配行时 coalesce 照旧给 {}，语义与「有回应/有评论时照常出包」完全一致。
  select coalesce(jsonb_object_agg(
           a.post_id,
           jsonb_build_object('hug', a.hug, 'warm', a.warm, 'relate', a.relate, 'mine', a.mine)
         ) filter (where a.post_id is not null), '{}'::jsonb),
         coalesce(jsonb_object_agg(b.post_id, b.cmt)
                  filter (where b.post_id is not null), '{}'::jsonb)
    into v_react, v_comment
    from (
      select p.id
      from (select unnest(v_ids) as id union select unnest(coalesce(v_rnd, '{}'::bigint[])) as id) u
      join wall_posts p on p.id = u.id and p.removed = false
    ) pool
    left join (
      select r.post_id,
             count(*) filter (where r.kind = 'hug')    as hug,
             count(*) filter (where r.kind = 'warm')   as warm,
             count(*) filter (where r.kind = 'relate') as relate,
             coalesce(jsonb_object_agg(r.kind, true) filter (where r.user_id = auth.uid()), '{}'::jsonb) as mine
      from wall_reactions r
      where r.post_id in (select id from (select unnest(v_ids) as id union select unnest(coalesce(v_rnd, '{}'::bigint[])) as id) u)
      group by r.post_id
    ) a on a.post_id = pool.id
    left join (
      select c.post_id, count(*) as cmt
      from wall_comments c
      where c.post_id in (select id from (select unnest(v_ids) as id union select unnest(coalesce(v_rnd, '{}'::bigint[])) as id) u)
        and c.deleted_at is null
      group by c.post_id
    ) b on b.post_id = pool.id;

  return jsonb_build_object('latest', v_latest, 'random', v_random, 'react', v_react, 'comment', v_comment);
end;
$$;


--
-- Name: wall_following(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."wall_following"() RETURNS TABLE("user_id" "uuid", "nickname" "text", "followed_at" timestamp with time zone, "post_count" integer, "last_post_at" timestamp with time zone)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select f.followee_id,
         coalesce(nullif(p.nickname, ''), 'Guest') as nickname,
         f.created_at,
         coalesce(s.n, 0)::int,
         s.last_at
  from public.wall_follows f
  left join public.profiles p on p.id = f.followee_id
  left join lateral (
    select count(*) as n, max(w.created_at) as last_at
    from public.wall_posts w
    where w.user_id = f.followee_id
      and w.removed = false
      and w.deleted_at is null
  ) s on true
  where f.follower_id = auth.uid()
  order by s.last_at desc nulls last, f.created_at desc;
$$;


--
-- Name: wall_follows_limit(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."wall_follows_limit"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare n int;
begin
  -- 自关注先判：check 约束也能拦，但报错早于它才会给出准确原因
  -- （关注满 200 时去关注自己，不先判这里就会误报「已达上限」）
  if new.follower_id = new.followee_id then
    raise exception 'wall-follow-self' using errcode = 'P0001';
  end if;

  -- 已关注：直接放行，交给 on conflict do nothing 收尾
  if exists (
    select 1 from public.wall_follows
    where follower_id = new.follower_id and followee_id = new.followee_id
  ) then
    return new;
  end if;

  select count(*) into n from public.wall_follows where follower_id = new.follower_id;
  if n >= 200 then
    raise exception 'wall-follow-limit' using errcode = 'P0001';
  end if;
  return new;
end $$;


--
-- Name: wall_post_delete(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."wall_post_delete"("p_id" bigint) RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  n int;
begin
  update public.wall_posts
     set deleted_at = now(),
         removed    = true        -- 借 removed 的过滤面：既有 6 处查询 + 2 个 RPC + 网关全都不必改
   where id = p_id
     and user_id = auth.uid()     -- 只能删自己的（未登录 auth.uid() 为空 → 改不到任何行 → false）
     and deleted_at is null;      -- 幂等：已经删过的不再动
  get diagnostics n = row_count;
  return n > 0;
end;
$$;


--
-- Name: FUNCTION "wall_post_delete"("p_id" bigint); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION "public"."wall_post_delete"("p_id" bigint) IS '轮446 作者删自己的帖子（软删 + 置 removed）。返回 false = 不是你的 / 已经删过了。';


--
-- Name: wall_search_posts("text", "text"[], integer, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."wall_search_posts"("p_q" "text" DEFAULT ''::"text", "p_tags" "text"[] DEFAULT '{}'::"text"[], "p_limit" integer DEFAULT 20, "p_before" bigint DEFAULT 0) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_ids     bigint[];
  v_posts   jsonb;
  v_react   jsonb;
  v_comment jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', t.id, 'user_id', t.user_id, 'author_name', t.author_name,
           'body', t.body, 'image_path', t.image_path, 'created_at', t.created_at,
           'views', t.views, 'dislikes', t.dislikes, 'removed', false,
           'tags', coalesce(t.tags, '{}'), 'img_w', t.img_w, 'img_h', t.img_h
         ) order by t.id desc), '[]'::jsonb),
         coalesce(array_agg(t.id), '{}'::bigint[])
    into v_posts, v_ids
    from (
      select id, user_id, author_name, body, image_path, created_at, views, dislikes, tags, img_w, img_h
      from wall_posts
      where removed = false
        and (p_before <= 0 or id < p_before)
        and (p_q is null or p_q = '' or body ilike '%' || p_q || '%')
        and (coalesce(array_length(p_tags, 1), 0) = 0 or tags && p_tags)
      order by id desc
      limit greatest(p_limit, 1)
    ) t;
  -- 轮 295 修法见上；轮 301：评论聚合加 deleted_at is null（软删不计，与渲染口径一致）。
  select coalesce(jsonb_object_agg(
           a.post_id,
           jsonb_build_object('hug', a.hug, 'warm', a.warm, 'relate', a.relate, 'mine', a.mine)
         ) filter (where a.post_id is not null), '{}'::jsonb),
         coalesce(jsonb_object_agg(b.post_id, b.cmt)
                  filter (where b.post_id is not null), '{}'::jsonb)
    into v_react, v_comment
    from (
      select p.id
      from (select unnest(v_ids) as id) u
      join wall_posts p on p.id = u.id and p.removed = false
    ) pool
    left join (
      select r.post_id,
             count(*) filter (where r.kind = 'hug')    as hug,
             count(*) filter (where r.kind = 'warm')   as warm,
             count(*) filter (where r.kind = 'relate') as relate,
             coalesce(jsonb_object_agg(r.kind, true) filter (where r.user_id = auth.uid()), '{}'::jsonb) as mine
      from wall_reactions r
      where r.post_id in (select id from (select unnest(v_ids) as id) u)
      group by r.post_id
    ) a on a.post_id = pool.id
    left join (
      select c.post_id, count(*) as cmt
      from wall_comments c
      where c.post_id in (select id from (select unnest(v_ids) as id) u)
        and c.deleted_at is null
      group by c.post_id
    ) b on b.post_id = pool.id;
  return jsonb_build_object('posts', v_posts, 'react', v_react, 'comment', v_comment);
end;
$$;


--
-- Name: wall_set_reaction(bigint, "text", boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."wall_set_reaction"("p_post" bigint, "p_kind" "text", "p_on" boolean) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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


--
-- Name: wall_toggle_comment_reaction(bigint, "text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."wall_toggle_comment_reaction"("p_comment" bigint, "p_kind" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_uid    uuid := auth.uid();
  v_on     boolean;
  v_hearts integer;
  v_broken integer;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'reason', 'auth-required');
  end if;
  if p_kind not in ('heart', 'broken') then
    return jsonb_build_object('ok', false, 'reason', 'bad-kind');
  end if;

  -- 评论必须真存在（否则会产生挂在空处的回应行）
  if not exists (select 1 from public.wall_comments where id = p_comment) then
    return jsonb_build_object('ok', false, 'reason', 'not-found');
  end if;

  if exists (
    select 1 from public.wall_comment_reactions
    where comment_id = p_comment and user_id = v_uid and kind = p_kind
  ) then
    delete from public.wall_comment_reactions
      where comment_id = p_comment and user_id = v_uid and kind = p_kind;
    v_on := false;
  else
    insert into public.wall_comment_reactions (comment_id, user_id, kind)
    values (p_comment, v_uid, p_kind)
    on conflict do nothing;
    v_on := true;
  end if;

  select count(*) filter (where kind = 'heart'),
         count(*) filter (where kind = 'broken')
    into v_hearts, v_broken
    from public.wall_comment_reactions where comment_id = p_comment;

  update public.wall_comments set hearts = v_hearts, brokens = v_broken where id = p_comment;

  return jsonb_build_object('ok', true, 'on', v_on, 'hearts', v_hearts, 'brokens', v_broken);
end $$;


--
-- Name: wall_toggle_dislike(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."wall_toggle_dislike"("p_post" bigint) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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


--
-- Name: admin_broadcasts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."admin_broadcasts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "body" "text" NOT NULL,
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "total" integer DEFAULT 0 NOT NULL,
    "sent" integer DEFAULT 0 NOT NULL
);


--
-- Name: admin_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."admin_users" (
    "user_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: bottle_fishes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."bottle_fishes" (
    "user_id" "uuid" NOT NULL,
    "day" "date" DEFAULT (("now"() AT TIME ZONE 'utc'::"text"))::"date" NOT NULL,
    "letter_id" "uuid" NOT NULL,
    "replied_at" timestamp with time zone,
    "replied_day" "date",
    "picked_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: TABLE "bottle_fishes"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."bottle_fishes" IS '漂流瓶捞信日志：picked_at 记捞取额度，replied_at 记回信额度；均按滚动 24h 计';


--
-- Name: COLUMN "bottle_fishes"."replied_at"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."bottle_fishes"."replied_at" IS '回信时刻（null = 捞起后从未回信，不计入每日次数）';


--
-- Name: COLUMN "bottle_fishes"."replied_day"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."bottle_fishes"."replied_day" IS '回信日（UTC）：每日次数就是数这一列';


--
-- Name: COLUMN "bottle_fishes"."picked_at"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."bottle_fishes"."picked_at" IS '捞起时刻；24h 捞取额度、7 天内同信不再发、作者近 7 天降权都看这一列';


--
-- Name: bottle_reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."bottle_reports" (
    "id" bigint NOT NULL,
    "reporter_id" "uuid" NOT NULL,
    "letter_id" "uuid" NOT NULL,
    "reason" "text" DEFAULT 'other'::"text" NOT NULL,
    "detail" "text" DEFAULT ''::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: bottle_reports_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS "public"."bottle_reports_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bottle_reports_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."bottle_reports_id_seq" OWNED BY "public"."bottle_reports"."id";


--
-- Name: client_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."client_logs" (
    "id" bigint NOT NULL,
    "kind" "text" DEFAULT 'err'::"text" NOT NULL,
    "msg" "text" DEFAULT ''::"text" NOT NULL,
    "route" "text" DEFAULT ''::"text" NOT NULL,
    "stack" "text" DEFAULT ''::"text" NOT NULL,
    "ua" "text" DEFAULT ''::"text" NOT NULL,
    "ip" "text" DEFAULT ''::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "client_logs_kind_check" CHECK (("kind" = ANY (ARRAY['err'::"text", 'rej'::"text"])))
);


--
-- Name: client_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS "public"."client_logs_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: client_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."client_logs_id_seq" OWNED BY "public"."client_logs"."id";


--
-- Name: daily_stories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."daily_stories" (
    "story_date" "date" NOT NULL,
    "content" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "published" boolean DEFAULT true NOT NULL,
    "updated_by" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: dm_blocks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."dm_blocks" (
    "blocker" "uuid" NOT NULL,
    "blocked" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: dm_conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."dm_conversations" (
    "id" bigint NOT NULL,
    "user_a" "uuid" NOT NULL,
    "user_b" "uuid" NOT NULL,
    "last_message_at" timestamp with time zone,
    "last_preview" "text" DEFAULT ''::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "dm_conv_sorted" CHECK (("user_a" < "user_b"))
);


--
-- Name: dm_conversations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS "public"."dm_conversations_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: dm_conversations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."dm_conversations_id_seq" OWNED BY "public"."dm_conversations"."id";


--
-- Name: dm_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."dm_messages" (
    "id" bigint NOT NULL,
    "conv_id" bigint NOT NULL,
    "sender" "uuid" NOT NULL,
    "body" "text" DEFAULT ''::"text" NOT NULL,
    "image_path" "text",
    "edited_at" timestamp with time zone,
    "deleted_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "dm_msg_body_len" CHECK (("char_length"("body") <= 2000)),
    CONSTRAINT "dm_msg_not_empty" CHECK ((("deleted_at" IS NOT NULL) OR ("char_length"("body") > 0) OR ("image_path" IS NOT NULL)))
);


--
-- Name: dm_messages_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS "public"."dm_messages_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: dm_messages_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."dm_messages_id_seq" OWNED BY "public"."dm_messages"."id";


--
-- Name: dm_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."dm_states" (
    "conv_id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "last_read_id" bigint DEFAULT 0 NOT NULL,
    "accepted" boolean DEFAULT false NOT NULL,
    "hidden_until" timestamp with time zone,
    "muted" boolean DEFAULT false NOT NULL
);


--
-- Name: notification_prefs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."notification_prefs" (
    "user_id" "uuid" NOT NULL,
    "comments" boolean DEFAULT true NOT NULL,
    "reactions" boolean DEFAULT true NOT NULL,
    "pets" boolean DEFAULT true NOT NULL,
    "dms" boolean DEFAULT true NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."notifications" (
    "id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "actor_id" "uuid",
    "kind" "text" NOT NULL,
    "post_id" bigint,
    "comment_id" bigint,
    "conv_id" bigint,
    "meta" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "read_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "notif_kind" CHECK (("kind" = ANY (ARRAY['comment'::"text", 'reply'::"text", 'reaction'::"text", 'pet'::"text", 'dm'::"text", 'system'::"text"])))
);


--
-- Name: notifications_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS "public"."notifications_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: notifications_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."notifications_id_seq" OWNED BY "public"."notifications"."id";


--
-- Name: pet_interactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."pet_interactions" (
    "owner_id" "uuid" NOT NULL,
    "viewer_key" "text" NOT NULL,
    "day" "date" DEFAULT ("timezone"('utc'::"text", "now"()))::"date" NOT NULL,
    "kind" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "pet_interactions_kind_check" CHECK (("kind" = ANY (ARRAY['pat'::"text", 'feed'::"text"])))
);


--
-- Name: pet_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."pet_profiles" (
    "user_id" "uuid" NOT NULL,
    "data" "jsonb" DEFAULT '{"pet": null, "counts": {"pats": 0, "feeds": 0}, "dishes": []}'::"jsonb" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "pats" integer DEFAULT 0 NOT NULL,
    "feeds" integer DEFAULT 0 NOT NULL
);


--
-- Name: pets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."pets" (
    "user_id" "uuid" NOT NULL,
    "state" "jsonb" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "nickname" "text" DEFAULT ''::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "status" "text",
    "status_at" timestamp with time zone
);


--
-- Name: COLUMN "profiles"."status"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."profiles"."status" IS '陪你大厅状态 key（working/studying/sleepless/chilling）；null = 未设置（不显示）';


--
-- Name: COLUMN "profiles"."status_at"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."profiles"."status_at" IS '状态更新时间；大厅与主页只展示近 24h 内的状态（过期自动隐去）';


--
-- Name: reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."reports" (
    "id" bigint NOT NULL,
    "reporter_id" "uuid",
    "target_type" "text" NOT NULL,
    "target_id" bigint NOT NULL,
    "reason" "text" DEFAULT 'other'::"text" NOT NULL,
    "detail" "text" DEFAULT ''::"text" NOT NULL,
    "source" "text" DEFAULT 'report'::"text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "handled_by" "uuid",
    "handled_at" timestamp with time zone,
    "action" "text",
    "note" "text" DEFAULT ''::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "reports_source_check" CHECK (("source" = ANY (ARRAY['report'::"text", 'auto'::"text"]))),
    CONSTRAINT "reports_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'handled'::"text"]))),
    CONSTRAINT "reports_target_type_check" CHECK (("target_type" = ANY (ARRAY['post'::"text", 'comment'::"text"])))
);


--
-- Name: reports_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS "public"."reports_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: reports_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."reports_id_seq" OWNED BY "public"."reports"."id";


--
-- Name: stories_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = to_regclass('public.stories')
       AND attname = 'id'
       AND attidentity <> ''
  ) THEN
    ALTER TABLE "public"."stories" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."stories_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
    );
  END IF;
END $do$;


--
-- Name: story_bookmarks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."story_bookmarks" (
    "story_id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: story_comments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."story_comments" (
    "id" bigint NOT NULL,
    "story_id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "body" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "story_comments_body_check" CHECK ((("char_length"("body") >= 1) AND ("char_length"("body") <= 1000)))
);


--
-- Name: story_comments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = to_regclass('public.story_comments')
       AND attname = 'id'
       AND attidentity <> ''
  ) THEN
    ALTER TABLE "public"."story_comments" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."story_comments_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
    );
  END IF;
END $do$;


--
-- Name: story_likes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."story_likes" (
    "story_id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: story_views; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."story_views" (
    "story_id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "day" "date" DEFAULT CURRENT_DATE NOT NULL
);


--
-- Name: wall_comment_reactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."wall_comment_reactions" (
    "comment_id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "kind" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "wall_comment_reactions_kind_check" CHECK (("kind" = ANY (ARRAY['heart'::"text", 'broken'::"text"])))
);


--
-- Name: wall_comments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."wall_comments" (
    "id" bigint NOT NULL,
    "post_id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "author_name" "text" DEFAULT 'Guest'::"text" NOT NULL,
    "body" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "parent_id" bigint,
    "reply_to_name" "text",
    "hidden" boolean DEFAULT false NOT NULL,
    "hidden_at" timestamp with time zone,
    "hearts" integer DEFAULT 0 NOT NULL,
    "brokens" integer DEFAULT 0 NOT NULL,
    "deleted_at" timestamp with time zone,
    CONSTRAINT "wall_comments_body_check" CHECK ((("char_length"("body") >= 1) AND ("char_length"("body") <= 200)))
);


--
-- Name: COLUMN "wall_comments"."deleted_at"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."wall_comments"."deleted_at" IS '轮 285 软删标记：作者删自己的评论时写入。行保留（on delete cascade 因此不触发，二级回复活下来），正文留库供审计/恢复；界面渲染成「该评论已删除」占位。';


--
-- Name: wall_comments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS "public"."wall_comments_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: wall_comments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."wall_comments_id_seq" OWNED BY "public"."wall_comments"."id";


--
-- Name: wall_favorites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."wall_favorites" (
    "id" bigint NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "post_id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: TABLE "wall_favorites"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."wall_favorites" IS '帖子收藏夹：user_id 默认 auth.uid()（客户端只传 post_id）；收藏列表私有，仅本人可读';


--
-- Name: wall_favorites_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = to_regclass('public.wall_favorites')
       AND attname = 'id'
       AND attidentity <> ''
  ) THEN
    ALTER TABLE "public"."wall_favorites" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."wall_favorites_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
    );
  END IF;
END $do$;


--
-- Name: wall_follows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."wall_follows" (
    "follower_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "followee_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "wall_follows_no_self" CHECK (("follower_id" <> "followee_id"))
);


--
-- Name: TABLE "wall_follows"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."wall_follows" IS '轮447 暖心墙关注：follower_id 关注 followee_id。单向、静默 —— 被关注者读不到，
   也不会收到任何通知。只影响暖心墙（「我的关注」筛选），与漂流瓶/故事无关。';


--
-- Name: COLUMN "wall_follows"."follower_id"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."wall_follows"."follower_id" IS '关注者 = auth.uid()（default 盖章，客户端不传身份）';


--
-- Name: wall_post_views; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."wall_post_views" (
    "post_id" bigint NOT NULL,
    "viewer_key" "text" NOT NULL,
    "day" "date" DEFAULT ("timezone"('utc'::"text", "now"()))::"date" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: wall_posts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."wall_posts" (
    "id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "author_name" "text" DEFAULT 'Guest'::"text" NOT NULL,
    "body" "text" NOT NULL,
    "image_path" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "views" integer DEFAULT 0 NOT NULL,
    "dislikes" integer DEFAULT 0 NOT NULL,
    "removed" boolean DEFAULT false NOT NULL,
    "removed_at" timestamp with time zone,
    "created_day" "date" DEFAULT ("timezone"('utc'::"text", "now"()))::"date" NOT NULL,
    "tags" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "img_w" integer,
    "img_h" integer,
    "lang" "text" DEFAULT 'und'::"text" NOT NULL,
    "deleted_at" timestamp with time zone,
    CONSTRAINT "wall_posts_body_check" CHECK ((("char_length"("body") >= 1) AND ("char_length"("body") <= 1000))),
    CONSTRAINT "wall_posts_lang_chk" CHECK (("lang" = ANY (ARRAY['zh'::"text", 'en'::"text", 'es'::"text", 'pt'::"text", 'fr'::"text", 'ja'::"text", 'ko'::"text", 'und'::"text"])))
);


--
-- Name: COLUMN "wall_posts"."deleted_at"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."wall_posts"."deleted_at" IS '轮446 作者自删时间：非空 = 作者删了这条帖子。行保留（评论/回应/举报不连带消失，可审计可恢复）；
   删除时同时置 removed = true，复用既有 removed 过滤面，列表与 RPC 无需改动。
   口径区分：removed=true 且 deleted_at 为空 = 管理员下架；两者都非空 = 作者自删。';


--
-- Name: wall_posts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS "public"."wall_posts_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: wall_posts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."wall_posts_id_seq" OWNED BY "public"."wall_posts"."id";


--
-- Name: wall_reactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."wall_reactions" (
    "post_id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "kind" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "wall_reactions_kind_check" CHECK (("kind" = ANY (ARRAY['hug'::"text", 'warm'::"text", 'relate'::"text", 'dislike'::"text"])))
);


--
-- Name: bottle_reports id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."bottle_reports" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."bottle_reports_id_seq"'::"regclass");


--
-- Name: client_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."client_logs" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."client_logs_id_seq"'::"regclass");


--
-- Name: dm_conversations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."dm_conversations" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."dm_conversations_id_seq"'::"regclass");


--
-- Name: dm_messages id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."dm_messages" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."dm_messages_id_seq"'::"regclass");


--
-- Name: notifications id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."notifications" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."notifications_id_seq"'::"regclass");


--
-- Name: reports id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."reports" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."reports_id_seq"'::"regclass");


--
-- Name: wall_comments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."wall_comments" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."wall_comments_id_seq"'::"regclass");


--
-- Name: wall_posts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."wall_posts" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."wall_posts_id_seq"'::"regclass");


--
-- Name: admin_broadcasts admin_broadcasts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'admin_broadcasts_pkey'
       AND conrelid = to_regclass('public.admin_broadcasts')
  ) THEN
    ALTER TABLE ONLY "public"."admin_broadcasts"
    ADD CONSTRAINT "admin_broadcasts_pkey" PRIMARY KEY ("id");
  END IF;
END $do$;


--
-- Name: admin_users admin_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'admin_users_pkey'
       AND conrelid = to_regclass('public.admin_users')
  ) THEN
    ALTER TABLE ONLY "public"."admin_users"
    ADD CONSTRAINT "admin_users_pkey" PRIMARY KEY ("user_id");
  END IF;
END $do$;


--
-- Name: app_state app_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'app_state_pkey'
       AND conrelid = to_regclass('public.app_state')
  ) THEN
    ALTER TABLE ONLY "public"."app_state"
    ADD CONSTRAINT "app_state_pkey" PRIMARY KEY ("id");
  END IF;
END $do$;


--
-- Name: bottle_fishes bottle_fishes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'bottle_fishes_pkey'
       AND conrelid = to_regclass('public.bottle_fishes')
  ) THEN
    ALTER TABLE ONLY "public"."bottle_fishes"
    ADD CONSTRAINT "bottle_fishes_pkey" PRIMARY KEY ("user_id", "day", "letter_id");
  END IF;
END $do$;


--
-- Name: bottle_letters bottle_letters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'bottle_letters_pkey'
       AND conrelid = to_regclass('public.bottle_letters')
  ) THEN
    ALTER TABLE ONLY "public"."bottle_letters"
    ADD CONSTRAINT "bottle_letters_pkey" PRIMARY KEY ("id");
  END IF;
END $do$;


--
-- Name: bottle_reports bottle_reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'bottle_reports_pkey'
       AND conrelid = to_regclass('public.bottle_reports')
  ) THEN
    ALTER TABLE ONLY "public"."bottle_reports"
    ADD CONSTRAINT "bottle_reports_pkey" PRIMARY KEY ("id");
  END IF;
END $do$;


--
-- Name: bottle_reports bottle_reports_reporter_id_letter_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'bottle_reports_reporter_id_letter_id_key'
       AND conrelid = to_regclass('public.bottle_reports')
  ) THEN
    ALTER TABLE ONLY "public"."bottle_reports"
    ADD CONSTRAINT "bottle_reports_reporter_id_letter_id_key" UNIQUE ("reporter_id", "letter_id");
  END IF;
END $do$;


--
-- Name: client_logs client_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'client_logs_pkey'
       AND conrelid = to_regclass('public.client_logs')
  ) THEN
    ALTER TABLE ONLY "public"."client_logs"
    ADD CONSTRAINT "client_logs_pkey" PRIMARY KEY ("id");
  END IF;
END $do$;


--
-- Name: daily_stories daily_stories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'daily_stories_pkey'
       AND conrelid = to_regclass('public.daily_stories')
  ) THEN
    ALTER TABLE ONLY "public"."daily_stories"
    ADD CONSTRAINT "daily_stories_pkey" PRIMARY KEY ("story_date");
  END IF;
END $do$;


--
-- Name: dm_blocks dm_blocks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'dm_blocks_pkey'
       AND conrelid = to_regclass('public.dm_blocks')
  ) THEN
    ALTER TABLE ONLY "public"."dm_blocks"
    ADD CONSTRAINT "dm_blocks_pkey" PRIMARY KEY ("blocker", "blocked");
  END IF;
END $do$;


--
-- Name: dm_conversations dm_conv_pair_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'dm_conv_pair_key'
       AND conrelid = to_regclass('public.dm_conversations')
  ) THEN
    ALTER TABLE ONLY "public"."dm_conversations"
    ADD CONSTRAINT "dm_conv_pair_key" UNIQUE ("user_a", "user_b");
  END IF;
END $do$;


--
-- Name: dm_conversations dm_conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'dm_conversations_pkey'
       AND conrelid = to_regclass('public.dm_conversations')
  ) THEN
    ALTER TABLE ONLY "public"."dm_conversations"
    ADD CONSTRAINT "dm_conversations_pkey" PRIMARY KEY ("id");
  END IF;
END $do$;


--
-- Name: dm_messages dm_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'dm_messages_pkey'
       AND conrelid = to_regclass('public.dm_messages')
  ) THEN
    ALTER TABLE ONLY "public"."dm_messages"
    ADD CONSTRAINT "dm_messages_pkey" PRIMARY KEY ("id");
  END IF;
END $do$;


--
-- Name: dm_states dm_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'dm_states_pkey'
       AND conrelid = to_regclass('public.dm_states')
  ) THEN
    ALTER TABLE ONLY "public"."dm_states"
    ADD CONSTRAINT "dm_states_pkey" PRIMARY KEY ("conv_id", "user_id");
  END IF;
END $do$;


--
-- Name: notification_prefs notification_prefs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'notification_prefs_pkey'
       AND conrelid = to_regclass('public.notification_prefs')
  ) THEN
    ALTER TABLE ONLY "public"."notification_prefs"
    ADD CONSTRAINT "notification_prefs_pkey" PRIMARY KEY ("user_id");
  END IF;
END $do$;


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'notifications_pkey'
       AND conrelid = to_regclass('public.notifications')
  ) THEN
    ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_pkey" PRIMARY KEY ("id");
  END IF;
END $do$;


--
-- Name: pet_interactions pet_interactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pet_interactions_pkey'
       AND conrelid = to_regclass('public.pet_interactions')
  ) THEN
    ALTER TABLE ONLY "public"."pet_interactions"
    ADD CONSTRAINT "pet_interactions_pkey" PRIMARY KEY ("owner_id", "viewer_key", "day", "kind");
  END IF;
END $do$;


--
-- Name: pet_profiles pet_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pet_profiles_pkey'
       AND conrelid = to_regclass('public.pet_profiles')
  ) THEN
    ALTER TABLE ONLY "public"."pet_profiles"
    ADD CONSTRAINT "pet_profiles_pkey" PRIMARY KEY ("user_id");
  END IF;
END $do$;


--
-- Name: pets pets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pets_pkey'
       AND conrelid = to_regclass('public.pets')
  ) THEN
    ALTER TABLE ONLY "public"."pets"
    ADD CONSTRAINT "pets_pkey" PRIMARY KEY ("user_id");
  END IF;
END $do$;


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'profiles_pkey'
       AND conrelid = to_regclass('public.profiles')
  ) THEN
    ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");
  END IF;
END $do$;


--
-- Name: reports reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'reports_pkey'
       AND conrelid = to_regclass('public.reports')
  ) THEN
    ALTER TABLE ONLY "public"."reports"
    ADD CONSTRAINT "reports_pkey" PRIMARY KEY ("id");
  END IF;
END $do$;


--
-- Name: stories stories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'stories_pkey'
       AND conrelid = to_regclass('public.stories')
  ) THEN
    ALTER TABLE ONLY "public"."stories"
    ADD CONSTRAINT "stories_pkey" PRIMARY KEY ("id");
  END IF;
END $do$;


--
-- Name: story_bookmarks story_bookmarks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'story_bookmarks_pkey'
       AND conrelid = to_regclass('public.story_bookmarks')
  ) THEN
    ALTER TABLE ONLY "public"."story_bookmarks"
    ADD CONSTRAINT "story_bookmarks_pkey" PRIMARY KEY ("story_id", "user_id");
  END IF;
END $do$;


--
-- Name: story_comments story_comments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'story_comments_pkey'
       AND conrelid = to_regclass('public.story_comments')
  ) THEN
    ALTER TABLE ONLY "public"."story_comments"
    ADD CONSTRAINT "story_comments_pkey" PRIMARY KEY ("id");
  END IF;
END $do$;


--
-- Name: story_likes story_likes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'story_likes_pkey'
       AND conrelid = to_regclass('public.story_likes')
  ) THEN
    ALTER TABLE ONLY "public"."story_likes"
    ADD CONSTRAINT "story_likes_pkey" PRIMARY KEY ("story_id", "user_id");
  END IF;
END $do$;


--
-- Name: story_views story_views_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'story_views_pkey'
       AND conrelid = to_regclass('public.story_views')
  ) THEN
    ALTER TABLE ONLY "public"."story_views"
    ADD CONSTRAINT "story_views_pkey" PRIMARY KEY ("story_id", "user_id", "day");
  END IF;
END $do$;


--
-- Name: wall_comment_reactions wall_comment_reactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'wall_comment_reactions_pkey'
       AND conrelid = to_regclass('public.wall_comment_reactions')
  ) THEN
    ALTER TABLE ONLY "public"."wall_comment_reactions"
    ADD CONSTRAINT "wall_comment_reactions_pkey" PRIMARY KEY ("comment_id", "user_id", "kind");
  END IF;
END $do$;


--
-- Name: wall_comments wall_comments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'wall_comments_pkey'
       AND conrelid = to_regclass('public.wall_comments')
  ) THEN
    ALTER TABLE ONLY "public"."wall_comments"
    ADD CONSTRAINT "wall_comments_pkey" PRIMARY KEY ("id");
  END IF;
END $do$;


--
-- Name: wall_favorites wall_favorites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'wall_favorites_pkey'
       AND conrelid = to_regclass('public.wall_favorites')
  ) THEN
    ALTER TABLE ONLY "public"."wall_favorites"
    ADD CONSTRAINT "wall_favorites_pkey" PRIMARY KEY ("id");
  END IF;
END $do$;


--
-- Name: wall_favorites wall_favorites_user_id_post_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'wall_favorites_user_id_post_id_key'
       AND conrelid = to_regclass('public.wall_favorites')
  ) THEN
    ALTER TABLE ONLY "public"."wall_favorites"
    ADD CONSTRAINT "wall_favorites_user_id_post_id_key" UNIQUE ("user_id", "post_id");
  END IF;
END $do$;


--
-- Name: wall_follows wall_follows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'wall_follows_pkey'
       AND conrelid = to_regclass('public.wall_follows')
  ) THEN
    ALTER TABLE ONLY "public"."wall_follows"
    ADD CONSTRAINT "wall_follows_pkey" PRIMARY KEY ("follower_id", "followee_id");
  END IF;
END $do$;


--
-- Name: wall_post_views wall_post_views_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'wall_post_views_pkey'
       AND conrelid = to_regclass('public.wall_post_views')
  ) THEN
    ALTER TABLE ONLY "public"."wall_post_views"
    ADD CONSTRAINT "wall_post_views_pkey" PRIMARY KEY ("post_id", "viewer_key", "day");
  END IF;
END $do$;


--
-- Name: wall_posts wall_posts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'wall_posts_pkey'
       AND conrelid = to_regclass('public.wall_posts')
  ) THEN
    ALTER TABLE ONLY "public"."wall_posts"
    ADD CONSTRAINT "wall_posts_pkey" PRIMARY KEY ("id");
  END IF;
END $do$;


--
-- Name: wall_reactions wall_reactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'wall_reactions_pkey'
       AND conrelid = to_regclass('public.wall_reactions')
  ) THEN
    ALTER TABLE ONLY "public"."wall_reactions"
    ADD CONSTRAINT "wall_reactions_pkey" PRIMARY KEY ("post_id", "user_id", "kind");
  END IF;
END $do$;


--
-- Name: bottle_fishes_user_letter_pick_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "bottle_fishes_user_letter_pick_idx" ON "public"."bottle_fishes" USING "btree" ("user_id", "letter_id", "picked_at" DESC);


--
-- Name: bottle_fishes_user_pick_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "bottle_fishes_user_pick_idx" ON "public"."bottle_fishes" USING "btree" ("user_id", "picked_at" DESC);


--
-- Name: bottle_fishes_user_reply_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "bottle_fishes_user_reply_idx" ON "public"."bottle_fishes" USING "btree" ("user_id", "replied_at" DESC);


--
-- Name: bottle_letters_held_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "bottle_letters_held_idx" ON "public"."bottle_letters" USING "btree" ("held_at") WHERE ("status" = 'held'::"text");


--
-- Name: bottle_letters_holder_held_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "bottle_letters_holder_held_idx" ON "public"."bottle_letters" USING "btree" ("holder", "held_at" DESC) WHERE ("status" = 'held'::"text");


--
-- Name: bottle_letters_lang_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "bottle_letters_lang_idx" ON "public"."bottle_letters" USING "btree" ("lang", "created_at" DESC) WHERE ("status" = 'sea'::"text");


--
-- Name: bottle_letters_mine_live_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "bottle_letters_mine_live_idx" ON "public"."bottle_letters" USING "btree" ("user_id", "created_at" DESC) WHERE (("hidden_at" IS NULL) AND ("deleted_at" IS NULL));


--
-- Name: bottle_letters_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "bottle_letters_owner_idx" ON "public"."bottle_letters" USING "btree" ("user_id", "created_at" DESC);


--
-- Name: bottle_letters_sea_bucket_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "bottle_letters_sea_bucket_idx" ON "public"."bottle_letters" USING "btree" ("random_bucket", "pickup_count", "last_picked_at") WHERE ("status" = 'sea'::"text");


--
-- Name: bottle_letters_sea_fair_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "bottle_letters_sea_fair_idx" ON "public"."bottle_letters" USING "btree" ("pickup_count", "last_picked_at") WHERE ("status" = 'sea'::"text");


--
-- Name: bottle_letters_sea_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "bottle_letters_sea_idx" ON "public"."bottle_letters" USING "btree" ("created_at" DESC) WHERE ("status" = 'sea'::"text");


--
-- Name: bottle_letters_user_hash_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "bottle_letters_user_hash_idx" ON "public"."bottle_letters" USING "btree" ("user_id", "body_hash", "created_at" DESC);


--
-- Name: bottle_reports_letter_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "bottle_reports_letter_idx" ON "public"."bottle_reports" USING "btree" ("letter_id");


--
-- Name: bottle_reports_reporter_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "bottle_reports_reporter_idx" ON "public"."bottle_reports" USING "btree" ("reporter_id", "created_at" DESC);


--
-- Name: client_logs_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "client_logs_created_idx" ON "public"."client_logs" USING "btree" ("created_at" DESC);


--
-- Name: client_logs_id_desc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "client_logs_id_desc_idx" ON "public"."client_logs" USING "btree" ("id" DESC);


--
-- Name: client_logs_kind_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "client_logs_kind_idx" ON "public"."client_logs" USING "btree" ("kind", "id" DESC);


--
-- Name: dm_conv_b_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "dm_conv_b_idx" ON "public"."dm_conversations" USING "btree" ("user_b");


--
-- Name: dm_conv_sort_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "dm_conv_sort_idx" ON "public"."dm_conversations" USING "btree" ("user_a", "created_at" DESC);


--
-- Name: dm_msg_conv_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "dm_msg_conv_idx" ON "public"."dm_messages" USING "btree" ("conv_id", "id" DESC);


--
-- Name: dm_states_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "dm_states_user_idx" ON "public"."dm_states" USING "btree" ("user_id", "accepted");


--
-- Name: notif_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "notif_user_idx" ON "public"."notifications" USING "btree" ("user_id", "id" DESC);


--
-- Name: notif_user_unread_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "notif_user_unread_idx" ON "public"."notifications" USING "btree" ("user_id") WHERE ("read_at" IS NULL);


--
-- Name: notifications_system_bid_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "notifications_system_bid_idx" ON "public"."notifications" USING "btree" ((("meta" ->> 'bid'::"text"))) WHERE ("kind" = 'system'::"text");


--
-- Name: profiles_status_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "profiles_status_at_idx" ON "public"."profiles" USING "btree" ("status_at" DESC);


--
-- Name: reports_auto_pending_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS "reports_auto_pending_uniq" ON "public"."reports" USING "btree" ("target_type", "target_id") WHERE (("source" = 'auto'::"text") AND ("status" = 'pending'::"text"));


--
-- Name: reports_reporter_target_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS "reports_reporter_target_uniq" ON "public"."reports" USING "btree" ("reporter_id", "target_type", "target_id") WHERE ("reporter_id" IS NOT NULL);


--
-- Name: reports_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "reports_status_idx" ON "public"."reports" USING "btree" ("status", "id" DESC);


--
-- Name: reports_target_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "reports_target_idx" ON "public"."reports" USING "btree" ("target_type", "target_id");


--
-- Name: stories_featured_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "stories_featured_idx" ON "public"."stories" USING "btree" ("featured", "published_at" DESC) WHERE "featured";


--
-- Name: stories_feed_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "stories_feed_idx" ON "public"."stories" USING "btree" ("status", "published_at" DESC);


--
-- Name: stories_lang_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "stories_lang_idx" ON "public"."stories" USING "btree" ("lang", "published_at" DESC) WHERE ("status" = 'published'::"text");


--
-- Name: stories_tags_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "stories_tags_idx" ON "public"."stories" USING "gin" ("tags");


--
-- Name: stories_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "stories_user_idx" ON "public"."stories" USING "btree" ("user_id", "status", "updated_at" DESC);


--
-- Name: story_bookmarks_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "story_bookmarks_user_idx" ON "public"."story_bookmarks" USING "btree" ("user_id", "created_at" DESC);


--
-- Name: story_comments_story_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "story_comments_story_idx" ON "public"."story_comments" USING "btree" ("story_id", "created_at");


--
-- Name: story_likes_month_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "story_likes_month_idx" ON "public"."story_likes" USING "btree" ("created_at");


--
-- Name: wall_comment_reactions_cmt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "wall_comment_reactions_cmt_idx" ON "public"."wall_comment_reactions" USING "btree" ("comment_id");


--
-- Name: wall_comment_reactions_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "wall_comment_reactions_user_idx" ON "public"."wall_comment_reactions" USING "btree" ("user_id");


--
-- Name: wall_comments_parent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "wall_comments_parent_idx" ON "public"."wall_comments" USING "btree" ("parent_id");


--
-- Name: wall_comments_post_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "wall_comments_post_idx" ON "public"."wall_comments" USING "btree" ("post_id");


--
-- Name: wall_favorites_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "wall_favorites_user_idx" ON "public"."wall_favorites" USING "btree" ("user_id", "created_at" DESC);


--
-- Name: wall_follows_followee_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "wall_follows_followee_idx" ON "public"."wall_follows" USING "btree" ("followee_id");


--
-- Name: wall_follows_follower_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "wall_follows_follower_idx" ON "public"."wall_follows" USING "btree" ("follower_id", "created_at" DESC);


--
-- Name: wall_post_views_post_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "wall_post_views_post_idx" ON "public"."wall_post_views" USING "btree" ("post_id");


--
-- Name: wall_posts_body_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "wall_posts_body_trgm" ON "public"."wall_posts" USING "gin" ("body" "gin_trgm_ops");


--
-- Name: wall_posts_lang_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "wall_posts_lang_idx" ON "public"."wall_posts" USING "btree" ("lang", "created_at" DESC);


--
-- Name: wall_posts_live_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "wall_posts_live_idx" ON "public"."wall_posts" USING "btree" ("created_at" DESC) WHERE (("deleted_at" IS NULL) AND ("removed" = false));


--
-- Name: wall_posts_tags_gin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "wall_posts_tags_gin" ON "public"."wall_posts" USING "gin" ("tags");


--
-- Name: wall_posts_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "wall_posts_user_idx" ON "public"."wall_posts" USING "btree" ("user_id", "created_at" DESC);


--
-- Name: wall_posts_visible_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "wall_posts_visible_idx" ON "public"."wall_posts" USING "btree" ("created_at" DESC) WHERE ("removed" = false);


--
-- Name: wall_reactions_post_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "wall_reactions_post_idx" ON "public"."wall_reactions" USING "btree" ("post_id");


--
-- Name: wall_reactions_user_post_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "wall_reactions_user_post_idx" ON "public"."wall_reactions" USING "btree" ("user_id", "post_id");


--
-- Name: bottle_letters bottle_reply_notification; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER "bottle_reply_notification" AFTER UPDATE ON "public"."bottle_letters" FOR EACH ROW EXECUTE FUNCTION "public"."bottle_notify_reply"();


--
-- Name: bottle_fishes maint_guard_bottle_fishes; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER "maint_guard_bottle_fishes" BEFORE INSERT ON "public"."bottle_fishes" FOR EACH ROW EXECUTE FUNCTION "public"."tg_maintenance_guard"();


--
-- Name: bottle_letters maint_guard_bottle_letters; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER "maint_guard_bottle_letters" BEFORE INSERT ON "public"."bottle_letters" FOR EACH ROW EXECUTE FUNCTION "public"."tg_maintenance_guard"();


--
-- Name: bottle_reports maint_guard_bottle_reports; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER "maint_guard_bottle_reports" BEFORE INSERT ON "public"."bottle_reports" FOR EACH ROW EXECUTE FUNCTION "public"."tg_maintenance_guard"();


--
-- Name: reports maint_guard_reports; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER "maint_guard_reports" BEFORE INSERT ON "public"."reports" FOR EACH ROW EXECUTE FUNCTION "public"."tg_maintenance_guard"();


--
-- Name: stories maint_guard_stories; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER "maint_guard_stories" BEFORE INSERT ON "public"."stories" FOR EACH ROW EXECUTE FUNCTION "public"."tg_maintenance_guard"();


--
-- Name: story_bookmarks maint_guard_story_bookmarks; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER "maint_guard_story_bookmarks" BEFORE INSERT ON "public"."story_bookmarks" FOR EACH ROW EXECUTE FUNCTION "public"."tg_maintenance_guard"();


--
-- Name: story_comments maint_guard_story_comments; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER "maint_guard_story_comments" BEFORE INSERT ON "public"."story_comments" FOR EACH ROW EXECUTE FUNCTION "public"."tg_maintenance_guard"();


--
-- Name: story_likes maint_guard_story_likes; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER "maint_guard_story_likes" BEFORE INSERT ON "public"."story_likes" FOR EACH ROW EXECUTE FUNCTION "public"."tg_maintenance_guard"();


--
-- Name: story_views maint_guard_story_views; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER "maint_guard_story_views" BEFORE INSERT ON "public"."story_views" FOR EACH ROW EXECUTE FUNCTION "public"."tg_maintenance_guard"();


--
-- Name: wall_comments maint_guard_wall_comments; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER "maint_guard_wall_comments" BEFORE INSERT ON "public"."wall_comments" FOR EACH ROW EXECUTE FUNCTION "public"."tg_maintenance_guard"();


--
-- Name: wall_favorites maint_guard_wall_favorites; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER "maint_guard_wall_favorites" BEFORE INSERT ON "public"."wall_favorites" FOR EACH ROW EXECUTE FUNCTION "public"."tg_maintenance_guard"();


--
-- Name: wall_posts maint_guard_wall_posts; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER "maint_guard_wall_posts" BEFORE INSERT ON "public"."wall_posts" FOR EACH ROW EXECUTE FUNCTION "public"."tg_maintenance_guard"();


--
-- Name: wall_reactions maint_guard_wall_reactions; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER "maint_guard_wall_reactions" BEFORE INSERT ON "public"."wall_reactions" FOR EACH ROW EXECUTE FUNCTION "public"."tg_maintenance_guard"();


--
-- Name: notifications notifications_drop_dm; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER "notifications_drop_dm" BEFORE INSERT ON "public"."notifications" FOR EACH ROW EXECUTE FUNCTION "public"."notifications_drop_dm"();


--
-- Name: TRIGGER "notifications_drop_dm" ON "notifications"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TRIGGER "notifications_drop_dm" ON "public"."notifications" IS '#23 私信退出通知中心：kind=dm 的通知行一律不落表（历史行已清理）';


--
-- Name: pet_interactions notify_pet_interaction_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER "notify_pet_interaction_trg" AFTER INSERT ON "public"."pet_interactions" FOR EACH ROW EXECUTE FUNCTION "public"."notify_on_pet"();


--
-- Name: wall_comments notify_wall_comment_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER "notify_wall_comment_trg" AFTER INSERT ON "public"."wall_comments" FOR EACH ROW EXECUTE FUNCTION "public"."notify_on_comment"();


--
-- Name: wall_reactions notify_wall_reaction_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER "notify_wall_reaction_trg" AFTER INSERT ON "public"."wall_reactions" FOR EACH ROW EXECUTE FUNCTION "public"."notify_on_reaction"();


--
-- Name: wall_reactions notify_wall_reaction_undo_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER "notify_wall_reaction_undo_trg" AFTER DELETE ON "public"."wall_reactions" FOR EACH ROW EXECUTE FUNCTION "public"."notify_on_reaction_undo"();


--
-- Name: wall_follows wall_follows_limit_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER "wall_follows_limit_trg" BEFORE INSERT ON "public"."wall_follows" FOR EACH ROW EXECUTE FUNCTION "public"."wall_follows_limit"();


--
-- Name: wall_posts wall_posts_daily_limit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER "wall_posts_daily_limit" BEFORE INSERT ON "public"."wall_posts" FOR EACH ROW EXECUTE FUNCTION "public"."wall_daily_limit"();


--
-- Name: admin_users admin_users_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'admin_users_user_id_fkey'
       AND conrelid = to_regclass('public.admin_users')
  ) THEN
    ALTER TABLE ONLY "public"."admin_users"
    ADD CONSTRAINT "admin_users_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
  END IF;
END $do$;


--
-- Name: bottle_fishes bottle_fishes_letter_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'bottle_fishes_letter_id_fkey'
       AND conrelid = to_regclass('public.bottle_fishes')
  ) THEN
    ALTER TABLE ONLY "public"."bottle_fishes"
    ADD CONSTRAINT "bottle_fishes_letter_id_fkey" FOREIGN KEY ("letter_id") REFERENCES "public"."bottle_letters"("id") ON DELETE CASCADE;
  END IF;
END $do$;


--
-- Name: bottle_fishes bottle_fishes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'bottle_fishes_user_id_fkey'
       AND conrelid = to_regclass('public.bottle_fishes')
  ) THEN
    ALTER TABLE ONLY "public"."bottle_fishes"
    ADD CONSTRAINT "bottle_fishes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
  END IF;
END $do$;


--
-- Name: bottle_letters bottle_letters_conv_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'bottle_letters_conv_id_fkey'
       AND conrelid = to_regclass('public.bottle_letters')
  ) THEN
    ALTER TABLE ONLY "public"."bottle_letters"
    ADD CONSTRAINT "bottle_letters_conv_id_fkey" FOREIGN KEY ("conv_id") REFERENCES "public"."dm_conversations"("id") ON DELETE SET NULL;
  END IF;
END $do$;


--
-- Name: bottle_letters bottle_letters_holder_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'bottle_letters_holder_fkey'
       AND conrelid = to_regclass('public.bottle_letters')
  ) THEN
    ALTER TABLE ONLY "public"."bottle_letters"
    ADD CONSTRAINT "bottle_letters_holder_fkey" FOREIGN KEY ("holder") REFERENCES "auth"."users"("id") ON DELETE SET NULL;
  END IF;
END $do$;


--
-- Name: bottle_letters bottle_letters_reply_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'bottle_letters_reply_by_fkey'
       AND conrelid = to_regclass('public.bottle_letters')
  ) THEN
    ALTER TABLE ONLY "public"."bottle_letters"
    ADD CONSTRAINT "bottle_letters_reply_by_fkey" FOREIGN KEY ("reply_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;
  END IF;
END $do$;


--
-- Name: bottle_letters bottle_letters_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'bottle_letters_user_id_fkey'
       AND conrelid = to_regclass('public.bottle_letters')
  ) THEN
    ALTER TABLE ONLY "public"."bottle_letters"
    ADD CONSTRAINT "bottle_letters_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
  END IF;
END $do$;


--
-- Name: bottle_reports bottle_reports_letter_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'bottle_reports_letter_id_fkey'
       AND conrelid = to_regclass('public.bottle_reports')
  ) THEN
    ALTER TABLE ONLY "public"."bottle_reports"
    ADD CONSTRAINT "bottle_reports_letter_id_fkey" FOREIGN KEY ("letter_id") REFERENCES "public"."bottle_letters"("id") ON DELETE CASCADE;
  END IF;
END $do$;


--
-- Name: bottle_reports bottle_reports_reporter_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'bottle_reports_reporter_id_fkey'
       AND conrelid = to_regclass('public.bottle_reports')
  ) THEN
    ALTER TABLE ONLY "public"."bottle_reports"
    ADD CONSTRAINT "bottle_reports_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
  END IF;
END $do$;


--
-- Name: dm_blocks dm_blocks_blocked_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'dm_blocks_blocked_fkey'
       AND conrelid = to_regclass('public.dm_blocks')
  ) THEN
    ALTER TABLE ONLY "public"."dm_blocks"
    ADD CONSTRAINT "dm_blocks_blocked_fkey" FOREIGN KEY ("blocked") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;
  END IF;
END $do$;


--
-- Name: dm_blocks dm_blocks_blocker_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'dm_blocks_blocker_fkey'
       AND conrelid = to_regclass('public.dm_blocks')
  ) THEN
    ALTER TABLE ONLY "public"."dm_blocks"
    ADD CONSTRAINT "dm_blocks_blocker_fkey" FOREIGN KEY ("blocker") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;
  END IF;
END $do$;


--
-- Name: dm_conversations dm_conversations_user_a_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'dm_conversations_user_a_fkey'
       AND conrelid = to_regclass('public.dm_conversations')
  ) THEN
    ALTER TABLE ONLY "public"."dm_conversations"
    ADD CONSTRAINT "dm_conversations_user_a_fkey" FOREIGN KEY ("user_a") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;
  END IF;
END $do$;


--
-- Name: dm_conversations dm_conversations_user_b_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'dm_conversations_user_b_fkey'
       AND conrelid = to_regclass('public.dm_conversations')
  ) THEN
    ALTER TABLE ONLY "public"."dm_conversations"
    ADD CONSTRAINT "dm_conversations_user_b_fkey" FOREIGN KEY ("user_b") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;
  END IF;
END $do$;


--
-- Name: dm_messages dm_messages_conv_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'dm_messages_conv_id_fkey'
       AND conrelid = to_regclass('public.dm_messages')
  ) THEN
    ALTER TABLE ONLY "public"."dm_messages"
    ADD CONSTRAINT "dm_messages_conv_id_fkey" FOREIGN KEY ("conv_id") REFERENCES "public"."dm_conversations"("id") ON DELETE CASCADE;
  END IF;
END $do$;


--
-- Name: dm_messages dm_messages_sender_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'dm_messages_sender_fkey'
       AND conrelid = to_regclass('public.dm_messages')
  ) THEN
    ALTER TABLE ONLY "public"."dm_messages"
    ADD CONSTRAINT "dm_messages_sender_fkey" FOREIGN KEY ("sender") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;
  END IF;
END $do$;


--
-- Name: dm_states dm_states_conv_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'dm_states_conv_id_fkey'
       AND conrelid = to_regclass('public.dm_states')
  ) THEN
    ALTER TABLE ONLY "public"."dm_states"
    ADD CONSTRAINT "dm_states_conv_id_fkey" FOREIGN KEY ("conv_id") REFERENCES "public"."dm_conversations"("id") ON DELETE CASCADE;
  END IF;
END $do$;


--
-- Name: dm_states dm_states_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'dm_states_user_id_fkey'
       AND conrelid = to_regclass('public.dm_states')
  ) THEN
    ALTER TABLE ONLY "public"."dm_states"
    ADD CONSTRAINT "dm_states_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;
  END IF;
END $do$;


--
-- Name: notification_prefs notification_prefs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'notification_prefs_user_id_fkey'
       AND conrelid = to_regclass('public.notification_prefs')
  ) THEN
    ALTER TABLE ONLY "public"."notification_prefs"
    ADD CONSTRAINT "notification_prefs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;
  END IF;
END $do$;


--
-- Name: notifications notifications_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'notifications_actor_id_fkey'
       AND conrelid = to_regclass('public.notifications')
  ) THEN
    ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;
  END IF;
END $do$;


--
-- Name: notifications notifications_comment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'notifications_comment_id_fkey'
       AND conrelid = to_regclass('public.notifications')
  ) THEN
    ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "public"."wall_comments"("id") ON DELETE CASCADE;
  END IF;
END $do$;


--
-- Name: notifications notifications_conv_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'notifications_conv_id_fkey'
       AND conrelid = to_regclass('public.notifications')
  ) THEN
    ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_conv_id_fkey" FOREIGN KEY ("conv_id") REFERENCES "public"."dm_conversations"("id") ON DELETE CASCADE;
  END IF;
END $do$;


--
-- Name: notifications notifications_post_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'notifications_post_id_fkey'
       AND conrelid = to_regclass('public.notifications')
  ) THEN
    ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "public"."wall_posts"("id") ON DELETE CASCADE;
  END IF;
END $do$;


--
-- Name: notifications notifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'notifications_user_id_fkey'
       AND conrelid = to_regclass('public.notifications')
  ) THEN
    ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;
  END IF;
END $do$;


--
-- Name: pet_interactions pet_interactions_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pet_interactions_owner_id_fkey'
       AND conrelid = to_regclass('public.pet_interactions')
  ) THEN
    ALTER TABLE ONLY "public"."pet_interactions"
    ADD CONSTRAINT "pet_interactions_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;
  END IF;
END $do$;


--
-- Name: pet_profiles pet_profiles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pet_profiles_user_id_fkey'
       AND conrelid = to_regclass('public.pet_profiles')
  ) THEN
    ALTER TABLE ONLY "public"."pet_profiles"
    ADD CONSTRAINT "pet_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;
  END IF;
END $do$;


--
-- Name: pets pets_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pets_user_id_fkey'
       AND conrelid = to_regclass('public.pets')
  ) THEN
    ALTER TABLE ONLY "public"."pets"
    ADD CONSTRAINT "pets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
  END IF;
END $do$;


--
-- Name: profiles profiles_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'profiles_id_fkey'
       AND conrelid = to_regclass('public.profiles')
  ) THEN
    ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
  END IF;
END $do$;


--
-- Name: reports reports_handled_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'reports_handled_by_fkey'
       AND conrelid = to_regclass('public.reports')
  ) THEN
    ALTER TABLE ONLY "public"."reports"
    ADD CONSTRAINT "reports_handled_by_fkey" FOREIGN KEY ("handled_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;
  END IF;
END $do$;


--
-- Name: reports reports_reporter_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'reports_reporter_id_fkey'
       AND conrelid = to_regclass('public.reports')
  ) THEN
    ALTER TABLE ONLY "public"."reports"
    ADD CONSTRAINT "reports_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;
  END IF;
END $do$;


--
-- Name: stories stories_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'stories_user_id_fkey'
       AND conrelid = to_regclass('public.stories')
  ) THEN
    ALTER TABLE ONLY "public"."stories"
    ADD CONSTRAINT "stories_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
  END IF;
END $do$;


--
-- Name: story_bookmarks story_bookmarks_story_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'story_bookmarks_story_id_fkey'
       AND conrelid = to_regclass('public.story_bookmarks')
  ) THEN
    ALTER TABLE ONLY "public"."story_bookmarks"
    ADD CONSTRAINT "story_bookmarks_story_id_fkey" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE CASCADE;
  END IF;
END $do$;


--
-- Name: story_comments story_comments_story_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'story_comments_story_id_fkey'
       AND conrelid = to_regclass('public.story_comments')
  ) THEN
    ALTER TABLE ONLY "public"."story_comments"
    ADD CONSTRAINT "story_comments_story_id_fkey" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE CASCADE;
  END IF;
END $do$;


--
-- Name: story_likes story_likes_story_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'story_likes_story_id_fkey'
       AND conrelid = to_regclass('public.story_likes')
  ) THEN
    ALTER TABLE ONLY "public"."story_likes"
    ADD CONSTRAINT "story_likes_story_id_fkey" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE CASCADE;
  END IF;
END $do$;


--
-- Name: story_views story_views_story_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'story_views_story_id_fkey'
       AND conrelid = to_regclass('public.story_views')
  ) THEN
    ALTER TABLE ONLY "public"."story_views"
    ADD CONSTRAINT "story_views_story_id_fkey" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE CASCADE;
  END IF;
END $do$;


--
-- Name: wall_comment_reactions wall_comment_reactions_comment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'wall_comment_reactions_comment_id_fkey'
       AND conrelid = to_regclass('public.wall_comment_reactions')
  ) THEN
    ALTER TABLE ONLY "public"."wall_comment_reactions"
    ADD CONSTRAINT "wall_comment_reactions_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "public"."wall_comments"("id") ON DELETE CASCADE;
  END IF;
END $do$;


--
-- Name: wall_comment_reactions wall_comment_reactions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'wall_comment_reactions_user_id_fkey'
       AND conrelid = to_regclass('public.wall_comment_reactions')
  ) THEN
    ALTER TABLE ONLY "public"."wall_comment_reactions"
    ADD CONSTRAINT "wall_comment_reactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
  END IF;
END $do$;


--
-- Name: wall_comments wall_comments_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'wall_comments_parent_id_fkey'
       AND conrelid = to_regclass('public.wall_comments')
  ) THEN
    ALTER TABLE ONLY "public"."wall_comments"
    ADD CONSTRAINT "wall_comments_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "public"."wall_comments"("id") ON DELETE CASCADE;
  END IF;
END $do$;


--
-- Name: wall_comments wall_comments_post_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'wall_comments_post_id_fkey'
       AND conrelid = to_regclass('public.wall_comments')
  ) THEN
    ALTER TABLE ONLY "public"."wall_comments"
    ADD CONSTRAINT "wall_comments_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "public"."wall_posts"("id") ON DELETE CASCADE;
  END IF;
END $do$;


--
-- Name: wall_comments wall_comments_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'wall_comments_user_id_fkey'
       AND conrelid = to_regclass('public.wall_comments')
  ) THEN
    ALTER TABLE ONLY "public"."wall_comments"
    ADD CONSTRAINT "wall_comments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
  END IF;
END $do$;


--
-- Name: wall_favorites wall_favorites_post_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'wall_favorites_post_id_fkey'
       AND conrelid = to_regclass('public.wall_favorites')
  ) THEN
    ALTER TABLE ONLY "public"."wall_favorites"
    ADD CONSTRAINT "wall_favorites_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "public"."wall_posts"("id") ON DELETE CASCADE;
  END IF;
END $do$;


--
-- Name: wall_favorites wall_favorites_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'wall_favorites_user_id_fkey'
       AND conrelid = to_regclass('public.wall_favorites')
  ) THEN
    ALTER TABLE ONLY "public"."wall_favorites"
    ADD CONSTRAINT "wall_favorites_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
  END IF;
END $do$;


--
-- Name: wall_follows wall_follows_followee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'wall_follows_followee_id_fkey'
       AND conrelid = to_regclass('public.wall_follows')
  ) THEN
    ALTER TABLE ONLY "public"."wall_follows"
    ADD CONSTRAINT "wall_follows_followee_id_fkey" FOREIGN KEY ("followee_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
  END IF;
END $do$;


--
-- Name: wall_follows wall_follows_follower_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'wall_follows_follower_id_fkey'
       AND conrelid = to_regclass('public.wall_follows')
  ) THEN
    ALTER TABLE ONLY "public"."wall_follows"
    ADD CONSTRAINT "wall_follows_follower_id_fkey" FOREIGN KEY ("follower_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
  END IF;
END $do$;


--
-- Name: wall_post_views wall_post_views_post_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'wall_post_views_post_id_fkey'
       AND conrelid = to_regclass('public.wall_post_views')
  ) THEN
    ALTER TABLE ONLY "public"."wall_post_views"
    ADD CONSTRAINT "wall_post_views_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "public"."wall_posts"("id") ON DELETE CASCADE;
  END IF;
END $do$;


--
-- Name: wall_posts wall_posts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'wall_posts_user_id_fkey'
       AND conrelid = to_regclass('public.wall_posts')
  ) THEN
    ALTER TABLE ONLY "public"."wall_posts"
    ADD CONSTRAINT "wall_posts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
  END IF;
END $do$;


--
-- Name: wall_reactions wall_reactions_post_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'wall_reactions_post_id_fkey'
       AND conrelid = to_regclass('public.wall_reactions')
  ) THEN
    ALTER TABLE ONLY "public"."wall_reactions"
    ADD CONSTRAINT "wall_reactions_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "public"."wall_posts"("id") ON DELETE CASCADE;
  END IF;
END $do$;


--
-- Name: wall_reactions wall_reactions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'wall_reactions_user_id_fkey'
       AND conrelid = to_regclass('public.wall_reactions')
  ) THEN
    ALTER TABLE ONLY "public"."wall_reactions"
    ADD CONSTRAINT "wall_reactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
  END IF;
END $do$;


--
-- Name: admin_broadcasts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."admin_broadcasts" ENABLE ROW LEVEL SECURITY;

--
-- Name: admin_users; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."admin_users" ENABLE ROW LEVEL SECURITY;

--
-- Name: admin_users admins manage admins; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "admins manage admins" ON "public"."admin_users";
CREATE POLICY "admins manage admins" ON "public"."admin_users" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());


--
-- Name: app_state; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."app_state" ENABLE ROW LEVEL SECURITY;

--
-- Name: app_state app_state_admin_write; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "app_state_admin_write" ON "public"."app_state";
CREATE POLICY "app_state_admin_write" ON "public"."app_state" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());


--
-- Name: app_state app_state_read; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "app_state_read" ON "public"."app_state";
CREATE POLICY "app_state_read" ON "public"."app_state" FOR SELECT USING (true);


--
-- Name: dm_blocks blocks insert own; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "blocks insert own" ON "public"."dm_blocks";
CREATE POLICY "blocks insert own" ON "public"."dm_blocks" FOR INSERT WITH CHECK ((("auth"."uid"() = "blocker") AND ("blocked" <> "blocker")));


--
-- Name: dm_blocks blocks read own; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "blocks read own" ON "public"."dm_blocks";
CREATE POLICY "blocks read own" ON "public"."dm_blocks" FOR SELECT USING (("auth"."uid"() = "blocker"));


--
-- Name: dm_blocks blocks remove own; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "blocks remove own" ON "public"."dm_blocks";
CREATE POLICY "blocks remove own" ON "public"."dm_blocks" FOR DELETE USING (("auth"."uid"() = "blocker"));


--
-- Name: bottle_letters bottle readable by owner or replier; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "bottle readable by owner or replier" ON "public"."bottle_letters";
CREATE POLICY "bottle readable by owner or replier" ON "public"."bottle_letters" FOR SELECT USING ((("user_id" = "auth"."uid"()) OR ("reply_by" = "auth"."uid"())));


--
-- Name: bottle_fishes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."bottle_fishes" ENABLE ROW LEVEL SECURITY;

--
-- Name: bottle_letters; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."bottle_letters" ENABLE ROW LEVEL SECURITY;

--
-- Name: bottle_reports; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."bottle_reports" ENABLE ROW LEVEL SECURITY;

--
-- Name: client_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."client_logs" ENABLE ROW LEVEL SECURITY;

--
-- Name: wall_comment_reactions comment reactions readable by all; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "comment reactions readable by all" ON "public"."wall_comment_reactions";
CREATE POLICY "comment reactions readable by all" ON "public"."wall_comment_reactions" FOR SELECT USING (true);


--
-- Name: wall_comment_reactions comment reactions remove own; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "comment reactions remove own" ON "public"."wall_comment_reactions";
CREATE POLICY "comment reactions remove own" ON "public"."wall_comment_reactions" FOR DELETE TO "authenticated" USING (("auth"."uid"() = "user_id"));


--
-- Name: wall_comment_reactions comment reactions write by auth; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "comment reactions write by auth" ON "public"."wall_comment_reactions";
CREATE POLICY "comment reactions write by auth" ON "public"."wall_comment_reactions" FOR INSERT TO "authenticated" WITH CHECK (("auth"."uid"() = "user_id"));


--
-- Name: wall_comments comments admin delete; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "comments admin delete" ON "public"."wall_comments";
CREATE POLICY "comments admin delete" ON "public"."wall_comments" FOR DELETE USING ("public"."is_admin"());


--
-- Name: wall_comments comments delete own; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "comments delete own" ON "public"."wall_comments";
CREATE POLICY "comments delete own" ON "public"."wall_comments" FOR DELETE USING (("auth"."uid"() = "user_id"));


--
-- Name: wall_comments comments insert by auth; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "comments insert by auth" ON "public"."wall_comments";
CREATE POLICY "comments insert by auth" ON "public"."wall_comments" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));


--
-- Name: wall_comments comments readable unless hidden; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "comments readable unless hidden" ON "public"."wall_comments";
CREATE POLICY "comments readable unless hidden" ON "public"."wall_comments" FOR SELECT USING ((("hidden" = false) OR ("user_id" = "auth"."uid"()) OR "public"."is_admin"()));


--
-- Name: dm_conversations convs read participant; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "convs read participant" ON "public"."dm_conversations";
CREATE POLICY "convs read participant" ON "public"."dm_conversations" FOR SELECT USING ((("auth"."uid"() = "user_a") OR ("auth"."uid"() = "user_b")));


--
-- Name: daily_stories; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."daily_stories" ENABLE ROW LEVEL SECURITY;

--
-- Name: dm_blocks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."dm_blocks" ENABLE ROW LEVEL SECURITY;

--
-- Name: dm_conversations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."dm_conversations" ENABLE ROW LEVEL SECURITY;

--
-- Name: dm_messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."dm_messages" ENABLE ROW LEVEL SECURITY;

--
-- Name: dm_states; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."dm_states" ENABLE ROW LEVEL SECURITY;

--
-- Name: wall_favorites favorites delete own; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "favorites delete own" ON "public"."wall_favorites";
CREATE POLICY "favorites delete own" ON "public"."wall_favorites" FOR DELETE USING (("auth"."uid"() = "user_id"));


--
-- Name: wall_favorites favorites insert own; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "favorites insert own" ON "public"."wall_favorites";
CREATE POLICY "favorites insert own" ON "public"."wall_favorites" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));


--
-- Name: wall_favorites favorites select own; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "favorites select own" ON "public"."wall_favorites";
CREATE POLICY "favorites select own" ON "public"."wall_favorites" FOR SELECT USING (("auth"."uid"() = "user_id"));


--
-- Name: wall_follows follows delete own; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "follows delete own" ON "public"."wall_follows";
CREATE POLICY "follows delete own" ON "public"."wall_follows" FOR DELETE USING (("auth"."uid"() = "follower_id"));


--
-- Name: wall_follows follows insert own; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "follows insert own" ON "public"."wall_follows";
CREATE POLICY "follows insert own" ON "public"."wall_follows" FOR INSERT WITH CHECK (("auth"."uid"() = "follower_id"));


--
-- Name: wall_follows follows select own; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "follows select own" ON "public"."wall_follows";
CREATE POLICY "follows select own" ON "public"."wall_follows" FOR SELECT USING (("auth"."uid"() = "follower_id"));


--
-- Name: dm_messages messages read participant; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "messages read participant" ON "public"."dm_messages";
CREATE POLICY "messages read participant" ON "public"."dm_messages" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."dm_conversations" "c"
  WHERE (("c"."id" = "dm_messages"."conv_id") AND (("auth"."uid"() = "c"."user_a") OR ("auth"."uid"() = "c"."user_b"))))));


--
-- Name: notification_prefs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."notification_prefs" ENABLE ROW LEVEL SECURITY;

--
-- Name: notifications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."notifications" ENABLE ROW LEVEL SECURITY;

--
-- Name: notifications notifs read recipient; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "notifs read recipient" ON "public"."notifications";
CREATE POLICY "notifs read recipient" ON "public"."notifications" FOR SELECT USING (("auth"."uid"() = "user_id"));


--
-- Name: notifications notifs remove recipient; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "notifs remove recipient" ON "public"."notifications";
CREATE POLICY "notifs remove recipient" ON "public"."notifications" FOR DELETE USING (("auth"."uid"() = "user_id"));


--
-- Name: pet_interactions pet interactions readable by all; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "pet interactions readable by all" ON "public"."pet_interactions";
CREATE POLICY "pet interactions readable by all" ON "public"."pet_interactions" FOR SELECT USING (true);


--
-- Name: pet_profiles pet profiles owner writes; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "pet profiles owner writes" ON "public"."pet_profiles";
CREATE POLICY "pet profiles owner writes" ON "public"."pet_profiles" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));


--
-- Name: pet_profiles pet profiles readable by all; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "pet profiles readable by all" ON "public"."pet_profiles";
CREATE POLICY "pet profiles readable by all" ON "public"."pet_profiles" FOR SELECT USING (true);


--
-- Name: pet_interactions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."pet_interactions" ENABLE ROW LEVEL SECURITY;

--
-- Name: pet_profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."pet_profiles" ENABLE ROW LEVEL SECURITY;

--
-- Name: pets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."pets" ENABLE ROW LEVEL SECURITY;

--
-- Name: pets pets insert own; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "pets insert own" ON "public"."pets";
CREATE POLICY "pets insert own" ON "public"."pets" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));


--
-- Name: pets pets select own; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "pets select own" ON "public"."pets";
CREATE POLICY "pets select own" ON "public"."pets" FOR SELECT USING (("auth"."uid"() = "user_id"));


--
-- Name: pets pets update own; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "pets update own" ON "public"."pets";
CREATE POLICY "pets update own" ON "public"."pets" FOR UPDATE USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));


--
-- Name: wall_post_views post views readable by all; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "post views readable by all" ON "public"."wall_post_views";
CREATE POLICY "post views readable by all" ON "public"."wall_post_views" FOR SELECT USING (true);


--
-- Name: wall_posts posts admin delete; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "posts admin delete" ON "public"."wall_posts";
CREATE POLICY "posts admin delete" ON "public"."wall_posts" FOR DELETE USING ("public"."is_admin"());


--
-- Name: wall_posts posts admin update; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "posts admin update" ON "public"."wall_posts";
CREATE POLICY "posts admin update" ON "public"."wall_posts" FOR UPDATE USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());


--
-- Name: wall_posts posts delete own; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "posts delete own" ON "public"."wall_posts";
CREATE POLICY "posts delete own" ON "public"."wall_posts" FOR DELETE USING (("auth"."uid"() = "user_id"));


--
-- Name: wall_posts posts insert by auth; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "posts insert by auth" ON "public"."wall_posts";
CREATE POLICY "posts insert by auth" ON "public"."wall_posts" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));


--
-- Name: wall_posts posts visible or own or admin; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "posts visible or own or admin" ON "public"."wall_posts";
CREATE POLICY "posts visible or own or admin" ON "public"."wall_posts" FOR SELECT USING (((("removed" = false) AND ("deleted_at" IS NULL)) OR ("auth"."uid"() = "user_id") OR "public"."is_admin"()));


--
-- Name: notification_prefs prefs read own; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "prefs read own" ON "public"."notification_prefs";
CREATE POLICY "prefs read own" ON "public"."notification_prefs" FOR SELECT USING (("auth"."uid"() = "user_id"));


--
-- Name: profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles profiles readable by all; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "profiles readable by all" ON "public"."profiles";
CREATE POLICY "profiles readable by all" ON "public"."profiles" FOR SELECT USING (true);


--
-- Name: profiles profiles self insert; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "profiles self insert" ON "public"."profiles";
CREATE POLICY "profiles self insert" ON "public"."profiles" FOR INSERT WITH CHECK (("auth"."uid"() = "id"));


--
-- Name: profiles profiles self update; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "profiles self update" ON "public"."profiles";
CREATE POLICY "profiles self update" ON "public"."profiles" FOR UPDATE USING (("auth"."uid"() = "id")) WITH CHECK (("auth"."uid"() = "id"));


--
-- Name: wall_reactions reactions readable by all; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "reactions readable by all" ON "public"."wall_reactions";
CREATE POLICY "reactions readable by all" ON "public"."wall_reactions" FOR SELECT USING (true);


--
-- Name: wall_reactions reactions remove own; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "reactions remove own" ON "public"."wall_reactions";
CREATE POLICY "reactions remove own" ON "public"."wall_reactions" FOR DELETE USING (("auth"."uid"() = "user_id"));


--
-- Name: wall_reactions reactions write by auth; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "reactions write by auth" ON "public"."wall_reactions";
CREATE POLICY "reactions write by auth" ON "public"."wall_reactions" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));


--
-- Name: reports; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."reports" ENABLE ROW LEVEL SECURITY;

--
-- Name: reports reports own or admin select; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "reports own or admin select" ON "public"."reports";
CREATE POLICY "reports own or admin select" ON "public"."reports" FOR SELECT USING ((("reporter_id" = "auth"."uid"()) OR "public"."is_admin"()));


--
-- Name: dm_states states read own; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "states read own" ON "public"."dm_states";
CREATE POLICY "states read own" ON "public"."dm_states" FOR SELECT USING (("auth"."uid"() = "user_id"));


--
-- Name: stories; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."stories" ENABLE ROW LEVEL SECURITY;

--
-- Name: stories stories_read; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "stories_read" ON "public"."stories";
CREATE POLICY "stories_read" ON "public"."stories" FOR SELECT USING ((("status" = 'published'::"text") OR ("user_id" = "auth"."uid"())));


--
-- Name: stories stories_write; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "stories_write" ON "public"."stories";
CREATE POLICY "stories_write" ON "public"."stories" TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));


--
-- Name: story_bookmarks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."story_bookmarks" ENABLE ROW LEVEL SECURITY;

--
-- Name: story_bookmarks story_bookmarks_read; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "story_bookmarks_read" ON "public"."story_bookmarks";
CREATE POLICY "story_bookmarks_read" ON "public"."story_bookmarks" FOR SELECT USING (true);


--
-- Name: story_bookmarks story_bookmarks_write; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "story_bookmarks_write" ON "public"."story_bookmarks";
CREATE POLICY "story_bookmarks_write" ON "public"."story_bookmarks" TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));


--
-- Name: story_comments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."story_comments" ENABLE ROW LEVEL SECURITY;

--
-- Name: story_comments story_comments_read; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "story_comments_read" ON "public"."story_comments";
CREATE POLICY "story_comments_read" ON "public"."story_comments" FOR SELECT USING (true);


--
-- Name: story_comments story_comments_write; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "story_comments_write" ON "public"."story_comments";
CREATE POLICY "story_comments_write" ON "public"."story_comments" TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));


--
-- Name: story_likes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."story_likes" ENABLE ROW LEVEL SECURITY;

--
-- Name: story_likes story_likes_read; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "story_likes_read" ON "public"."story_likes";
CREATE POLICY "story_likes_read" ON "public"."story_likes" FOR SELECT USING (true);


--
-- Name: story_likes story_likes_write; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "story_likes_write" ON "public"."story_likes";
CREATE POLICY "story_likes_write" ON "public"."story_likes" TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));


--
-- Name: story_views; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."story_views" ENABLE ROW LEVEL SECURITY;

--
-- Name: story_views story_views_write; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "story_views_write" ON "public"."story_views";
CREATE POLICY "story_views_write" ON "public"."story_views" TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));


--
-- Name: wall_comment_reactions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."wall_comment_reactions" ENABLE ROW LEVEL SECURITY;

--
-- Name: wall_comments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."wall_comments" ENABLE ROW LEVEL SECURITY;

--
-- Name: wall_favorites; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."wall_favorites" ENABLE ROW LEVEL SECURITY;

--
-- Name: wall_follows; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."wall_follows" ENABLE ROW LEVEL SECURITY;

--
-- Name: wall_post_views; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."wall_post_views" ENABLE ROW LEVEL SECURITY;

--
-- Name: wall_posts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."wall_posts" ENABLE ROW LEVEL SECURITY;

--
-- Name: wall_reactions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."wall_reactions" ENABLE ROW LEVEL SECURITY;

--
-- Name: SCHEMA "public"; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";


--
-- Name: FUNCTION "admin_broadcast_start"("p_body" "text"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."admin_broadcast_start"("p_body" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."admin_broadcast_start"("p_body" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."admin_broadcast_start"("p_body" "text") TO "service_role";


--
-- Name: FUNCTION "admin_broadcast_step"("p_bid" "text", "p_batch" integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."admin_broadcast_step"("p_bid" "text", "p_batch" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."admin_broadcast_step"("p_bid" "text", "p_batch" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."admin_broadcast_step"("p_bid" "text", "p_batch" integer) TO "service_role";


--
-- Name: FUNCTION "admin_broadcasts_list"("p_limit" integer, "p_offset" integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."admin_broadcasts_list"("p_limit" integer, "p_offset" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."admin_broadcasts_list"("p_limit" integer, "p_offset" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."admin_broadcasts_list"("p_limit" integer, "p_offset" integer) TO "service_role";


--
-- Name: FUNCTION "admin_clientlog_page"("p_offset" integer, "p_limit" integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."admin_clientlog_page"("p_offset" integer, "p_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_clientlog_page"("p_offset" integer, "p_limit" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."admin_clientlog_page"("p_offset" integer, "p_limit" integer) TO "service_role";


--
-- Name: FUNCTION "admin_overview"(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."admin_overview"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_overview"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."admin_overview"() TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_overview"() TO "anon";


--
-- Name: FUNCTION "admin_report_handle"("p_report" bigint, "p_action" "text", "p_note" "text"); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."admin_report_handle"("p_report" bigint, "p_action" "text", "p_note" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_report_handle"("p_report" bigint, "p_action" "text", "p_note" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."admin_report_handle"("p_report" bigint, "p_action" "text", "p_note" "text") TO "service_role";


--
-- Name: FUNCTION "admin_report_page"("p_status" "text", "p_offset" integer, "p_limit" integer, "p_target_type" "text"); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."admin_report_page"("p_status" "text", "p_offset" integer, "p_limit" integer, "p_target_type" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_report_page"("p_status" "text", "p_offset" integer, "p_limit" integer, "p_target_type" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."admin_report_page"("p_status" "text", "p_offset" integer, "p_limit" integer, "p_target_type" "text") TO "service_role";


--
-- Name: TABLE "app_state"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."app_state" TO "anon";
GRANT ALL ON TABLE "public"."app_state" TO "authenticated";
GRANT ALL ON TABLE "public"."app_state" TO "service_role";


--
-- Name: FUNCTION "admin_set_maintenance"("p_mode" "text", "p_note" "text", "p_until" timestamp with time zone); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."admin_set_maintenance"("p_mode" "text", "p_note" "text", "p_until" timestamp with time zone) TO "anon";
GRANT ALL ON FUNCTION "public"."admin_set_maintenance"("p_mode" "text", "p_note" "text", "p_until" timestamp with time zone) TO "authenticated";
GRANT ALL ON FUNCTION "public"."admin_set_maintenance"("p_mode" "text", "p_note" "text", "p_until" timestamp with time zone) TO "service_role";


--
-- Name: FUNCTION "admin_users_page"("p_offset" integer, "p_limit" integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."admin_users_page"("p_offset" integer, "p_limit" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."admin_users_page"("p_offset" integer, "p_limit" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."admin_users_page"("p_offset" integer, "p_limit" integer) TO "service_role";


--
-- Name: FUNCTION "bottle_chat_decide"("p_id" "uuid", "p_accept" boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."bottle_chat_decide"("p_id" "uuid", "p_accept" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."bottle_chat_decide"("p_id" "uuid", "p_accept" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."bottle_chat_decide"("p_id" "uuid", "p_accept" boolean) TO "service_role";
GRANT ALL ON FUNCTION "public"."bottle_chat_decide"("p_id" "uuid", "p_accept" boolean) TO "anon";


--
-- Name: TABLE "bottle_letters"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."bottle_letters" TO "anon";
GRANT ALL ON TABLE "public"."bottle_letters" TO "authenticated";
GRANT ALL ON TABLE "public"."bottle_letters" TO "service_role";


--
-- Name: FUNCTION "bottle_fish"("p_lang" "text"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."bottle_fish"("p_lang" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."bottle_fish"("p_lang" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."bottle_fish"("p_lang" "text") TO "service_role";


--
-- Name: FUNCTION "bottle_held"(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."bottle_held"() TO "anon";
GRANT ALL ON FUNCTION "public"."bottle_held"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."bottle_held"() TO "service_role";


--
-- Name: FUNCTION "bottle_letter_delete"("p_id" "uuid"); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."bottle_letter_delete"("p_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."bottle_letter_delete"("p_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."bottle_letter_delete"("p_id" "uuid") TO "service_role";


--
-- Name: FUNCTION "bottle_letter_hidden"(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."bottle_letter_hidden"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."bottle_letter_hidden"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."bottle_letter_hidden"() TO "service_role";


--
-- Name: FUNCTION "bottle_letter_hide"("p_id" "uuid"); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."bottle_letter_hide"("p_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."bottle_letter_hide"("p_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."bottle_letter_hide"("p_id" "uuid") TO "service_role";


--
-- Name: FUNCTION "bottle_letter_unhide"("p_id" "uuid"); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."bottle_letter_unhide"("p_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."bottle_letter_unhide"("p_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."bottle_letter_unhide"("p_id" "uuid") TO "service_role";


--
-- Name: FUNCTION "bottle_mine"(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."bottle_mine"() TO "anon";
GRANT ALL ON FUNCTION "public"."bottle_mine"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."bottle_mine"() TO "service_role";


--
-- Name: FUNCTION "bottle_notify_reply"(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."bottle_notify_reply"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."bottle_notify_reply"() TO "service_role";
GRANT ALL ON FUNCTION "public"."bottle_notify_reply"() TO "anon";
GRANT ALL ON FUNCTION "public"."bottle_notify_reply"() TO "authenticated";


--
-- Name: FUNCTION "bottle_quota"(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."bottle_quota"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."bottle_quota"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."bottle_quota"() TO "service_role";


--
-- Name: FUNCTION "bottle_records"("p_id" "uuid", "p_offset" integer, "p_mine" boolean, "p_limit" integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."bottle_records"("p_id" "uuid", "p_offset" integer, "p_mine" boolean, "p_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."bottle_records"("p_id" "uuid", "p_offset" integer, "p_mine" boolean, "p_limit" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."bottle_records"("p_id" "uuid", "p_offset" integer, "p_mine" boolean, "p_limit" integer) TO "service_role";


--
-- Name: FUNCTION "bottle_release"("p_id" "uuid"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."bottle_release"("p_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."bottle_release"("p_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."bottle_release"("p_id" "uuid") TO "service_role";


--
-- Name: FUNCTION "bottle_reply"("p_id" "uuid", "p_reply" "text"); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."bottle_reply"("p_id" "uuid", "p_reply" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."bottle_reply"("p_id" "uuid", "p_reply" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."bottle_reply"("p_id" "uuid", "p_reply" "text") TO "service_role";


--
-- Name: FUNCTION "bottle_report"("p_id" "uuid", "p_reason" "text", "p_detail" "text"); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."bottle_report"("p_id" "uuid", "p_reason" "text", "p_detail" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."bottle_report"("p_id" "uuid", "p_reason" "text", "p_detail" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."bottle_report"("p_id" "uuid", "p_reason" "text", "p_detail" "text") TO "service_role";


--
-- Name: FUNCTION "bottle_send"("p_body" "text", "p_lang" "text"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."bottle_send"("p_body" "text", "p_lang" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."bottle_send"("p_body" "text", "p_lang" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."bottle_send"("p_body" "text", "p_lang" "text") TO "service_role";


--
-- Name: FUNCTION "client_log_write"("p_kind" "text", "p_msg" "text", "p_route" "text", "p_stack" "text", "p_ua" "text", "p_ip" "text"); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."client_log_write"("p_kind" "text", "p_msg" "text", "p_route" "text", "p_stack" "text", "p_ua" "text", "p_ip" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."client_log_write"("p_kind" "text", "p_msg" "text", "p_route" "text", "p_stack" "text", "p_ua" "text", "p_ip" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."client_log_write"("p_kind" "text", "p_msg" "text", "p_route" "text", "p_stack" "text", "p_ua" "text", "p_ip" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."client_log_write"("p_kind" "text", "p_msg" "text", "p_route" "text", "p_stack" "text", "p_ua" "text", "p_ip" "text") TO "anon";


--
-- Name: FUNCTION "daily_story_admin_get"("p_date" "date"); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."daily_story_admin_get"("p_date" "date") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."daily_story_admin_get"("p_date" "date") TO "authenticated";
GRANT ALL ON FUNCTION "public"."daily_story_admin_get"("p_date" "date") TO "service_role";


--
-- Name: FUNCTION "daily_story_delete"("p_date" "date"); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."daily_story_delete"("p_date" "date") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."daily_story_delete"("p_date" "date") TO "authenticated";
GRANT ALL ON FUNCTION "public"."daily_story_delete"("p_date" "date") TO "service_role";


--
-- Name: FUNCTION "daily_story_get"("p_date" "date"); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."daily_story_get"("p_date" "date") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."daily_story_get"("p_date" "date") TO "anon";
GRANT ALL ON FUNCTION "public"."daily_story_get"("p_date" "date") TO "authenticated";
GRANT ALL ON FUNCTION "public"."daily_story_get"("p_date" "date") TO "service_role";


--
-- Name: FUNCTION "daily_story_list"("p_limit" integer, "p_offset" integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."daily_story_list"("p_limit" integer, "p_offset" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."daily_story_list"("p_limit" integer, "p_offset" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."daily_story_list"("p_limit" integer, "p_offset" integer) TO "service_role";


--
-- Name: FUNCTION "daily_story_save"("p_date" "date", "p_content" "jsonb", "p_published" boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."daily_story_save"("p_date" "date", "p_content" "jsonb", "p_published" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."daily_story_save"("p_date" "date", "p_content" "jsonb", "p_published" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."daily_story_save"("p_date" "date", "p_content" "jsonb", "p_published" boolean) TO "service_role";


--
-- Name: FUNCTION "delete_my_account"(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."delete_my_account"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_my_account"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."delete_my_account"() TO "service_role";
GRANT ALL ON FUNCTION "public"."delete_my_account"() TO "anon";


--
-- Name: FUNCTION "dm_accept"("p_conv" bigint); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."dm_accept"("p_conv" bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."dm_accept"("p_conv" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."dm_accept"("p_conv" bigint) TO "service_role";


--
-- Name: FUNCTION "dm_block"("p_user" "uuid"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."dm_block"("p_user" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."dm_block"("p_user" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."dm_block"("p_user" "uuid") TO "service_role";


--
-- Name: FUNCTION "dm_blocks"(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."dm_blocks"() TO "anon";
GRANT ALL ON FUNCTION "public"."dm_blocks"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."dm_blocks"() TO "service_role";


--
-- Name: FUNCTION "dm_conv_meta"("p_conv" bigint); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."dm_conv_meta"("p_conv" bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."dm_conv_meta"("p_conv" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."dm_conv_meta"("p_conv" bigint) TO "service_role";


--
-- Name: FUNCTION "dm_find_conv"("a" "uuid", "b" "uuid"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."dm_find_conv"("a" "uuid", "b" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."dm_find_conv"("a" "uuid", "b" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."dm_find_conv"("a" "uuid", "b" "uuid") TO "service_role";


--
-- Name: FUNCTION "dm_hide"("p_conv" bigint); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."dm_hide"("p_conv" bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."dm_hide"("p_conv" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."dm_hide"("p_conv" bigint) TO "service_role";


--
-- Name: FUNCTION "dm_is_blocked"("a" "uuid", "b" "uuid"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."dm_is_blocked"("a" "uuid", "b" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."dm_is_blocked"("a" "uuid", "b" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."dm_is_blocked"("a" "uuid", "b" "uuid") TO "service_role";


--
-- Name: FUNCTION "dm_list_convs"("p_limit" integer, "p_offset" integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."dm_list_convs"("p_limit" integer, "p_offset" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."dm_list_convs"("p_limit" integer, "p_offset" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."dm_list_convs"("p_limit" integer, "p_offset" integer) TO "service_role";


--
-- Name: FUNCTION "dm_list_messages"("p_conv" bigint, "p_before" bigint, "p_limit" integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."dm_list_messages"("p_conv" bigint, "p_before" bigint, "p_limit" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."dm_list_messages"("p_conv" bigint, "p_before" bigint, "p_limit" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."dm_list_messages"("p_conv" bigint, "p_before" bigint, "p_limit" integer) TO "service_role";


--
-- Name: FUNCTION "dm_mark_read"("p_conv" bigint); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."dm_mark_read"("p_conv" bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."dm_mark_read"("p_conv" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."dm_mark_read"("p_conv" bigint) TO "service_role";


--
-- Name: FUNCTION "dm_mute"("p_conv" bigint, "p_on" boolean); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."dm_mute"("p_conv" bigint, "p_on" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."dm_mute"("p_conv" bigint, "p_on" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."dm_mute"("p_conv" bigint, "p_on" boolean) TO "service_role";


--
-- Name: FUNCTION "dm_open"("p_other" "uuid"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."dm_open"("p_other" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."dm_open"("p_other" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."dm_open"("p_other" "uuid") TO "service_role";


--
-- Name: FUNCTION "dm_recall"("p_msg" bigint); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."dm_recall"("p_msg" bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."dm_recall"("p_msg" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."dm_recall"("p_msg" bigint) TO "service_role";


--
-- Name: FUNCTION "dm_send"("p_conv" bigint, "p_body" "text", "p_image" "text"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."dm_send"("p_conv" bigint, "p_body" "text", "p_image" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."dm_send"("p_conv" bigint, "p_body" "text", "p_image" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."dm_send"("p_conv" bigint, "p_body" "text", "p_image" "text") TO "service_role";


--
-- Name: FUNCTION "dm_unblock"("p_user" "uuid"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."dm_unblock"("p_user" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."dm_unblock"("p_user" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."dm_unblock"("p_user" "uuid") TO "service_role";


--
-- Name: FUNCTION "dm_unhide"("p_conv" bigint); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."dm_unhide"("p_conv" bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."dm_unhide"("p_conv" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."dm_unhide"("p_conv" bigint) TO "service_role";


--
-- Name: FUNCTION "dm_unread_total"(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."dm_unread_total"() TO "anon";
GRANT ALL ON FUNCTION "public"."dm_unread_total"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."dm_unread_total"() TO "service_role";


--
-- Name: FUNCTION "handle_new_user"(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";


--
-- Name: FUNCTION "is_admin"(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."is_admin"() TO "anon";
GRANT ALL ON FUNCTION "public"."is_admin"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_admin"() TO "service_role";


--
-- Name: FUNCTION "maintenance_active"(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."maintenance_active"() TO "anon";
GRANT ALL ON FUNCTION "public"."maintenance_active"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."maintenance_active"() TO "service_role";


--
-- Name: FUNCTION "maintenance_blocks_write"(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."maintenance_blocks_write"() TO "anon";
GRANT ALL ON FUNCTION "public"."maintenance_blocks_write"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."maintenance_blocks_write"() TO "service_role";


--
-- Name: FUNCTION "notif_clear"(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."notif_clear"() TO "anon";
GRANT ALL ON FUNCTION "public"."notif_clear"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."notif_clear"() TO "service_role";


--
-- Name: FUNCTION "notif_mark"("p_ids" bigint[], "p_all" boolean); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."notif_mark"("p_ids" bigint[], "p_all" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."notif_mark"("p_ids" bigint[], "p_all" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."notif_mark"("p_ids" bigint[], "p_all" boolean) TO "service_role";


--
-- Name: FUNCTION "notif_page"("p_offset" integer, "p_limit" integer, "p_kinds" "text", "p_unread" boolean); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."notif_page"("p_offset" integer, "p_limit" integer, "p_kinds" "text", "p_unread" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."notif_page"("p_offset" integer, "p_limit" integer, "p_kinds" "text", "p_unread" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."notif_page"("p_offset" integer, "p_limit" integer, "p_kinds" "text", "p_unread" boolean) TO "service_role";


--
-- Name: FUNCTION "notif_prefs_get"(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."notif_prefs_get"() TO "anon";
GRANT ALL ON FUNCTION "public"."notif_prefs_get"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."notif_prefs_get"() TO "service_role";


--
-- Name: FUNCTION "notif_prefs_set"("p_comments" boolean, "p_reactions" boolean, "p_pets" boolean, "p_dms" boolean); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."notif_prefs_set"("p_comments" boolean, "p_reactions" boolean, "p_pets" boolean, "p_dms" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."notif_prefs_set"("p_comments" boolean, "p_reactions" boolean, "p_pets" boolean, "p_dms" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."notif_prefs_set"("p_comments" boolean, "p_reactions" boolean, "p_pets" boolean, "p_dms" boolean) TO "service_role";


--
-- Name: FUNCTION "notif_unread"(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."notif_unread"() TO "anon";
GRANT ALL ON FUNCTION "public"."notif_unread"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."notif_unread"() TO "service_role";


--
-- Name: FUNCTION "notifications_drop_dm"(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."notifications_drop_dm"() TO "anon";
GRANT ALL ON FUNCTION "public"."notifications_drop_dm"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."notifications_drop_dm"() TO "service_role";


--
-- Name: FUNCTION "notify_on_comment"(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."notify_on_comment"() TO "anon";
GRANT ALL ON FUNCTION "public"."notify_on_comment"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."notify_on_comment"() TO "service_role";


--
-- Name: FUNCTION "notify_on_pet"(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."notify_on_pet"() TO "anon";
GRANT ALL ON FUNCTION "public"."notify_on_pet"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."notify_on_pet"() TO "service_role";


--
-- Name: FUNCTION "notify_on_reaction"(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."notify_on_reaction"() TO "anon";
GRANT ALL ON FUNCTION "public"."notify_on_reaction"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."notify_on_reaction"() TO "service_role";


--
-- Name: FUNCTION "notify_on_reaction_undo"(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."notify_on_reaction_undo"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."notify_on_reaction_undo"() TO "service_role";
GRANT ALL ON FUNCTION "public"."notify_on_reaction_undo"() TO "anon";
GRANT ALL ON FUNCTION "public"."notify_on_reaction_undo"() TO "authenticated";


--
-- Name: FUNCTION "pet_interact"("p_owner" "uuid", "p_kind" "text", "p_viewer" "text"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."pet_interact"("p_owner" "uuid", "p_kind" "text", "p_viewer" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."pet_interact"("p_owner" "uuid", "p_kind" "text", "p_viewer" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."pet_interact"("p_owner" "uuid", "p_kind" "text", "p_viewer" "text") TO "service_role";


--
-- Name: FUNCTION "rename_me"("p_nick" "text"); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."rename_me"("p_nick" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."rename_me"("p_nick" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."rename_me"("p_nick" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."rename_me"("p_nick" "text") TO "anon";


--
-- Name: FUNCTION "report_create"("p_target_type" "text", "p_target_id" bigint, "p_reason" "text", "p_detail" "text"); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."report_create"("p_target_type" "text", "p_target_id" bigint, "p_reason" "text", "p_detail" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."report_create"("p_target_type" "text", "p_target_id" bigint, "p_reason" "text", "p_detail" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."report_create"("p_target_type" "text", "p_target_id" bigint, "p_reason" "text", "p_detail" "text") TO "service_role";


--
-- Name: FUNCTION "status_counts"("p_since" timestamp with time zone); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."status_counts"("p_since" timestamp with time zone) TO "anon";
GRANT ALL ON FUNCTION "public"."status_counts"("p_since" timestamp with time zone) TO "authenticated";
GRANT ALL ON FUNCTION "public"."status_counts"("p_since" timestamp with time zone) TO "service_role";


--
-- Name: FUNCTION "story_add_comment"("p_story_id" bigint, "p_body" "text"); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."story_add_comment"("p_story_id" bigint, "p_body" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."story_add_comment"("p_story_id" bigint, "p_body" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."story_add_comment"("p_story_id" bigint, "p_body" "text") TO "service_role";


--
-- Name: FUNCTION "story_add_view"("p_id" bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."story_add_view"("p_id" bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."story_add_view"("p_id" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."story_add_view"("p_id" bigint) TO "service_role";


--
-- Name: FUNCTION "story_bookmark_list"("p_limit" integer, "p_offset" integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."story_bookmark_list"("p_limit" integer, "p_offset" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."story_bookmark_list"("p_limit" integer, "p_offset" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."story_bookmark_list"("p_limit" integer, "p_offset" integer) TO "service_role";


--
-- Name: FUNCTION "story_comment_list"("p_story_id" bigint, "p_limit" integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."story_comment_list"("p_story_id" bigint, "p_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."story_comment_list"("p_story_id" bigint, "p_limit" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."story_comment_list"("p_story_id" bigint, "p_limit" integer) TO "service_role";
GRANT ALL ON FUNCTION "public"."story_comment_list"("p_story_id" bigint, "p_limit" integer) TO "anon";


--
-- Name: FUNCTION "story_delete_comment"("p_id" bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."story_delete_comment"("p_id" bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."story_delete_comment"("p_id" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."story_delete_comment"("p_id" bigint) TO "service_role";


--
-- Name: FUNCTION "story_delete_draft"("p_id" bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."story_delete_draft"("p_id" bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."story_delete_draft"("p_id" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."story_delete_draft"("p_id" bigint) TO "service_role";


--
-- Name: FUNCTION "story_featured"(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."story_featured"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."story_featured"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."story_featured"() TO "service_role";
GRANT ALL ON FUNCTION "public"."story_featured"() TO "anon";


--
-- Name: FUNCTION "story_get"("p_id" bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."story_get"("p_id" bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."story_get"("p_id" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."story_get"("p_id" bigint) TO "service_role";
GRANT ALL ON FUNCTION "public"."story_get"("p_id" bigint) TO "anon";


--
-- Name: FUNCTION "story_mine"("p_status" "text", "p_limit" integer, "p_offset" integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."story_mine"("p_status" "text", "p_limit" integer, "p_offset" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."story_mine"("p_status" "text", "p_limit" integer, "p_offset" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."story_mine"("p_status" "text", "p_limit" integer, "p_offset" integer) TO "service_role";


--
-- Name: FUNCTION "story_my_flags"("p_ids" bigint[]); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."story_my_flags"("p_ids" bigint[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."story_my_flags"("p_ids" bigint[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."story_my_flags"("p_ids" bigint[]) TO "service_role";


--
-- Name: FUNCTION "story_my_stats"(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."story_my_stats"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."story_my_stats"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."story_my_stats"() TO "service_role";


--
-- Name: TABLE "stories"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."stories" TO "anon";
GRANT ALL ON TABLE "public"."stories" TO "authenticated";
GRANT ALL ON TABLE "public"."stories" TO "service_role";


--
-- Name: FUNCTION "story_publish"("p_id" bigint, "p_title" "text", "p_body" "text", "p_tags" "text"[], "p_lang" "text"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."story_publish"("p_id" bigint, "p_title" "text", "p_body" "text", "p_tags" "text"[], "p_lang" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."story_publish"("p_id" bigint, "p_title" "text", "p_body" "text", "p_tags" "text"[], "p_lang" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."story_publish"("p_id" bigint, "p_title" "text", "p_body" "text", "p_tags" "text"[], "p_lang" "text") TO "service_role";


--
-- Name: FUNCTION "story_rank"("p_mode" "text", "p_tag" "text", "p_period" "text", "p_limit" integer, "p_offset" integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."story_rank"("p_mode" "text", "p_tag" "text", "p_period" "text", "p_limit" integer, "p_offset" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."story_rank"("p_mode" "text", "p_tag" "text", "p_period" "text", "p_limit" integer, "p_offset" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."story_rank"("p_mode" "text", "p_tag" "text", "p_period" "text", "p_limit" integer, "p_offset" integer) TO "service_role";
GRANT ALL ON FUNCTION "public"."story_rank"("p_mode" "text", "p_tag" "text", "p_period" "text", "p_limit" integer, "p_offset" integer) TO "anon";


--
-- Name: FUNCTION "story_save_draft"("p_id" bigint, "p_title" "text", "p_body" "text", "p_tags" "text"[]); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."story_save_draft"("p_id" bigint, "p_title" "text", "p_body" "text", "p_tags" "text"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."story_save_draft"("p_id" bigint, "p_title" "text", "p_body" "text", "p_tags" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."story_save_draft"("p_id" bigint, "p_title" "text", "p_body" "text", "p_tags" "text"[]) TO "service_role";


--
-- Name: FUNCTION "story_set_bookmark"("p_id" bigint, "p_on" boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."story_set_bookmark"("p_id" bigint, "p_on" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."story_set_bookmark"("p_id" bigint, "p_on" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."story_set_bookmark"("p_id" bigint, "p_on" boolean) TO "service_role";


--
-- Name: FUNCTION "story_set_featured"("p_id" bigint, "p_on" boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."story_set_featured"("p_id" bigint, "p_on" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."story_set_featured"("p_id" bigint, "p_on" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."story_set_featured"("p_id" bigint, "p_on" boolean) TO "service_role";


--
-- Name: FUNCTION "story_set_like"("p_id" bigint, "p_on" boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."story_set_like"("p_id" bigint, "p_on" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."story_set_like"("p_id" bigint, "p_on" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."story_set_like"("p_id" bigint, "p_on" boolean) TO "service_role";


--
-- Name: FUNCTION "story_toggle_bookmark"("p_id" bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."story_toggle_bookmark"("p_id" bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."story_toggle_bookmark"("p_id" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."story_toggle_bookmark"("p_id" bigint) TO "service_role";


--
-- Name: FUNCTION "story_toggle_like"("p_id" bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."story_toggle_like"("p_id" bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."story_toggle_like"("p_id" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."story_toggle_like"("p_id" bigint) TO "service_role";


--
-- Name: FUNCTION "tg_maintenance_guard"(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."tg_maintenance_guard"() TO "anon";
GRANT ALL ON FUNCTION "public"."tg_maintenance_guard"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."tg_maintenance_guard"() TO "service_role";


--
-- Name: FUNCTION "wall_add_view"("p_post" bigint, "p_viewer" "text"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."wall_add_view"("p_post" bigint, "p_viewer" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."wall_add_view"("p_post" bigint, "p_viewer" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."wall_add_view"("p_post" bigint, "p_viewer" "text") TO "service_role";


--
-- Name: FUNCTION "wall_add_views"("p_posts" bigint[], "p_viewer" "text"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."wall_add_views"("p_posts" bigint[], "p_viewer" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."wall_add_views"("p_posts" bigint[], "p_viewer" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."wall_add_views"("p_posts" bigint[], "p_viewer" "text") TO "service_role";


--
-- Name: FUNCTION "wall_comment_delete"("p_id" bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."wall_comment_delete"("p_id" bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."wall_comment_delete"("p_id" bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."wall_comment_delete"("p_id" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."wall_comment_delete"("p_id" bigint) TO "service_role";


--
-- Name: FUNCTION "wall_daily_limit"(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."wall_daily_limit"() TO "anon";
GRANT ALL ON FUNCTION "public"."wall_daily_limit"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."wall_daily_limit"() TO "service_role";


--
-- Name: FUNCTION "wall_feed_page"("p_limit" integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."wall_feed_page"("p_limit" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."wall_feed_page"("p_limit" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."wall_feed_page"("p_limit" integer) TO "service_role";


--
-- Name: FUNCTION "wall_following"(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."wall_following"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."wall_following"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."wall_following"() TO "service_role";


--
-- Name: FUNCTION "wall_follows_limit"(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."wall_follows_limit"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."wall_follows_limit"() TO "service_role";


--
-- Name: FUNCTION "wall_post_delete"("p_id" bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."wall_post_delete"("p_id" bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."wall_post_delete"("p_id" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."wall_post_delete"("p_id" bigint) TO "service_role";


--
-- Name: FUNCTION "wall_search_posts"("p_q" "text", "p_tags" "text"[], "p_limit" integer, "p_before" bigint); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."wall_search_posts"("p_q" "text", "p_tags" "text"[], "p_limit" integer, "p_before" bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."wall_search_posts"("p_q" "text", "p_tags" "text"[], "p_limit" integer, "p_before" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."wall_search_posts"("p_q" "text", "p_tags" "text"[], "p_limit" integer, "p_before" bigint) TO "service_role";


--
-- Name: FUNCTION "wall_set_reaction"("p_post" bigint, "p_kind" "text", "p_on" boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."wall_set_reaction"("p_post" bigint, "p_kind" "text", "p_on" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."wall_set_reaction"("p_post" bigint, "p_kind" "text", "p_on" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."wall_set_reaction"("p_post" bigint, "p_kind" "text", "p_on" boolean) TO "service_role";


--
-- Name: FUNCTION "wall_toggle_comment_reaction"("p_comment" bigint, "p_kind" "text"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."wall_toggle_comment_reaction"("p_comment" bigint, "p_kind" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."wall_toggle_comment_reaction"("p_comment" bigint, "p_kind" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."wall_toggle_comment_reaction"("p_comment" bigint, "p_kind" "text") TO "service_role";


--
-- Name: FUNCTION "wall_toggle_dislike"("p_post" bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."wall_toggle_dislike"("p_post" bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."wall_toggle_dislike"("p_post" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."wall_toggle_dislike"("p_post" bigint) TO "service_role";


--
-- Name: TABLE "admin_broadcasts"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."admin_broadcasts" TO "anon";
GRANT ALL ON TABLE "public"."admin_broadcasts" TO "authenticated";
GRANT ALL ON TABLE "public"."admin_broadcasts" TO "service_role";


--
-- Name: TABLE "admin_users"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."admin_users" TO "anon";
GRANT ALL ON TABLE "public"."admin_users" TO "authenticated";
GRANT ALL ON TABLE "public"."admin_users" TO "service_role";


--
-- Name: TABLE "bottle_fishes"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."bottle_fishes" TO "anon";
GRANT ALL ON TABLE "public"."bottle_fishes" TO "authenticated";
GRANT ALL ON TABLE "public"."bottle_fishes" TO "service_role";


--
-- Name: TABLE "bottle_reports"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."bottle_reports" TO "anon";
GRANT ALL ON TABLE "public"."bottle_reports" TO "authenticated";
GRANT ALL ON TABLE "public"."bottle_reports" TO "service_role";


--
-- Name: SEQUENCE "bottle_reports_id_seq"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE "public"."bottle_reports_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."bottle_reports_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."bottle_reports_id_seq" TO "service_role";


--
-- Name: TABLE "client_logs"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."client_logs" TO "anon";
GRANT ALL ON TABLE "public"."client_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."client_logs" TO "service_role";


--
-- Name: SEQUENCE "client_logs_id_seq"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE "public"."client_logs_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."client_logs_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."client_logs_id_seq" TO "service_role";


--
-- Name: TABLE "daily_stories"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."daily_stories" TO "anon";
GRANT ALL ON TABLE "public"."daily_stories" TO "authenticated";
GRANT ALL ON TABLE "public"."daily_stories" TO "service_role";


--
-- Name: TABLE "dm_blocks"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."dm_blocks" TO "anon";
GRANT ALL ON TABLE "public"."dm_blocks" TO "authenticated";
GRANT ALL ON TABLE "public"."dm_blocks" TO "service_role";


--
-- Name: TABLE "dm_conversations"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."dm_conversations" TO "anon";
GRANT ALL ON TABLE "public"."dm_conversations" TO "authenticated";
GRANT ALL ON TABLE "public"."dm_conversations" TO "service_role";


--
-- Name: SEQUENCE "dm_conversations_id_seq"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE "public"."dm_conversations_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."dm_conversations_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."dm_conversations_id_seq" TO "service_role";


--
-- Name: TABLE "dm_messages"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."dm_messages" TO "anon";
GRANT ALL ON TABLE "public"."dm_messages" TO "authenticated";
GRANT ALL ON TABLE "public"."dm_messages" TO "service_role";


--
-- Name: SEQUENCE "dm_messages_id_seq"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE "public"."dm_messages_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."dm_messages_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."dm_messages_id_seq" TO "service_role";


--
-- Name: TABLE "dm_states"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."dm_states" TO "anon";
GRANT ALL ON TABLE "public"."dm_states" TO "authenticated";
GRANT ALL ON TABLE "public"."dm_states" TO "service_role";


--
-- Name: TABLE "notification_prefs"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."notification_prefs" TO "anon";
GRANT ALL ON TABLE "public"."notification_prefs" TO "authenticated";
GRANT ALL ON TABLE "public"."notification_prefs" TO "service_role";


--
-- Name: TABLE "notifications"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."notifications" TO "anon";
GRANT ALL ON TABLE "public"."notifications" TO "authenticated";
GRANT ALL ON TABLE "public"."notifications" TO "service_role";


--
-- Name: SEQUENCE "notifications_id_seq"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE "public"."notifications_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."notifications_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."notifications_id_seq" TO "service_role";


--
-- Name: TABLE "pet_interactions"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."pet_interactions" TO "anon";
GRANT ALL ON TABLE "public"."pet_interactions" TO "authenticated";
GRANT ALL ON TABLE "public"."pet_interactions" TO "service_role";


--
-- Name: TABLE "pet_profiles"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."pet_profiles" TO "anon";
GRANT ALL ON TABLE "public"."pet_profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."pet_profiles" TO "service_role";


--
-- Name: TABLE "pets"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."pets" TO "anon";
GRANT ALL ON TABLE "public"."pets" TO "authenticated";
GRANT ALL ON TABLE "public"."pets" TO "service_role";


--
-- Name: TABLE "profiles"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";


--
-- Name: TABLE "reports"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."reports" TO "anon";
GRANT ALL ON TABLE "public"."reports" TO "authenticated";
GRANT ALL ON TABLE "public"."reports" TO "service_role";


--
-- Name: SEQUENCE "reports_id_seq"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE "public"."reports_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."reports_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."reports_id_seq" TO "service_role";


--
-- Name: SEQUENCE "stories_id_seq"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE "public"."stories_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."stories_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."stories_id_seq" TO "service_role";


--
-- Name: TABLE "story_bookmarks"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."story_bookmarks" TO "anon";
GRANT ALL ON TABLE "public"."story_bookmarks" TO "authenticated";
GRANT ALL ON TABLE "public"."story_bookmarks" TO "service_role";


--
-- Name: TABLE "story_comments"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."story_comments" TO "anon";
GRANT ALL ON TABLE "public"."story_comments" TO "authenticated";
GRANT ALL ON TABLE "public"."story_comments" TO "service_role";


--
-- Name: SEQUENCE "story_comments_id_seq"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE "public"."story_comments_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."story_comments_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."story_comments_id_seq" TO "service_role";


--
-- Name: TABLE "story_likes"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."story_likes" TO "anon";
GRANT ALL ON TABLE "public"."story_likes" TO "authenticated";
GRANT ALL ON TABLE "public"."story_likes" TO "service_role";


--
-- Name: TABLE "story_views"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."story_views" TO "anon";
GRANT ALL ON TABLE "public"."story_views" TO "authenticated";
GRANT ALL ON TABLE "public"."story_views" TO "service_role";


--
-- Name: TABLE "wall_comment_reactions"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."wall_comment_reactions" TO "anon";
GRANT ALL ON TABLE "public"."wall_comment_reactions" TO "authenticated";
GRANT ALL ON TABLE "public"."wall_comment_reactions" TO "service_role";


--
-- Name: TABLE "wall_comments"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."wall_comments" TO "anon";
GRANT ALL ON TABLE "public"."wall_comments" TO "authenticated";
GRANT ALL ON TABLE "public"."wall_comments" TO "service_role";


--
-- Name: SEQUENCE "wall_comments_id_seq"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE "public"."wall_comments_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."wall_comments_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."wall_comments_id_seq" TO "service_role";


--
-- Name: TABLE "wall_favorites"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."wall_favorites" TO "authenticated";
GRANT ALL ON TABLE "public"."wall_favorites" TO "service_role";


--
-- Name: SEQUENCE "wall_favorites_id_seq"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE "public"."wall_favorites_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."wall_favorites_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."wall_favorites_id_seq" TO "service_role";


--
-- Name: TABLE "wall_follows"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."wall_follows" TO "authenticated";
GRANT ALL ON TABLE "public"."wall_follows" TO "service_role";


--
-- Name: TABLE "wall_post_views"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."wall_post_views" TO "anon";
GRANT ALL ON TABLE "public"."wall_post_views" TO "authenticated";
GRANT ALL ON TABLE "public"."wall_post_views" TO "service_role";


--
-- Name: TABLE "wall_posts"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."wall_posts" TO "anon";
GRANT ALL ON TABLE "public"."wall_posts" TO "authenticated";
GRANT ALL ON TABLE "public"."wall_posts" TO "service_role";


--
-- Name: SEQUENCE "wall_posts_id_seq"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE "public"."wall_posts_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."wall_posts_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."wall_posts_id_seq" TO "service_role";


--
-- Name: TABLE "wall_reactions"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."wall_reactions" TO "anon";
GRANT ALL ON TABLE "public"."wall_reactions" TO "authenticated";
GRANT ALL ON TABLE "public"."wall_reactions" TO "service_role";


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

-- ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
-- ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
-- ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
-- ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--

-- ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
-- ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
-- ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
-- ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

-- ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
-- ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
-- ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
-- ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";


--
-- PostgreSQL database dump complete
--



