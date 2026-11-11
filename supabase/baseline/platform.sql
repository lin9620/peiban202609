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

-- ── Platform glue: auth trigger / storage buckets & policies / realtime ──
set search_path = public, extensions, storage;

drop trigger if exists "on_auth_user_created" on "auth"."users";
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- Storage buckets（只建 bucket，不建文件）
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('app-releases', 'app-releases', true, null, null::text[]),
  ('wall-images', 'wall-images', true, null, null::text[])
on conflict (id) do update set
  name = excluded.name,
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "app releases admin insert" on "storage"."objects";
create policy "app releases admin insert" on "storage"."objects" as permissive for insert to "authenticated" with check (((bucket_id = 'app-releases'::text) AND (EXISTS ( SELECT 1
   FROM admin_users
  WHERE (admin_users.user_id = auth.uid())))));

drop policy if exists "app releases admin update" on "storage"."objects";
create policy "app releases admin update" on "storage"."objects" as permissive for update to "authenticated" using (((bucket_id = 'app-releases'::text) AND (EXISTS ( SELECT 1
   FROM admin_users
  WHERE (admin_users.user_id = auth.uid()))))) with check (((bucket_id = 'app-releases'::text) AND (EXISTS ( SELECT 1
   FROM admin_users
  WHERE (admin_users.user_id = auth.uid())))));

drop policy if exists "app releases public read" on "storage"."objects";
create policy "app releases public read" on "storage"."objects" as permissive for select to public using ((bucket_id = 'app-releases'::text));

drop policy if exists "wall images auth upload" on "storage"."objects";
create policy "wall images auth upload" on "storage"."objects" as permissive for insert to "authenticated" with check (((bucket_id = 'wall-images'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));

drop policy if exists "wall images own delete" on "storage"."objects";
create policy "wall images own delete" on "storage"."objects" as permissive for delete to "authenticated" using (((bucket_id = 'wall-images'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));

drop policy if exists "wall images own update" on "storage"."objects";
create policy "wall images own update" on "storage"."objects" as permissive for update to "authenticated" using (((bucket_id = 'wall-images'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));

drop policy if exists "wall images public read" on "storage"."objects";
create policy "wall images public read" on "storage"."objects" as permissive for select to public using ((bucket_id = 'wall-images'::text));

-- Realtime publication（只加表，不复制数据）
do $$ begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;
do $$ begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'app_state'
  ) then
    alter publication supabase_realtime add table "public"."app_state";
  end if;
end $$;
do $$ begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'dm_messages'
  ) then
    alter publication supabase_realtime add table "public"."dm_messages";
  end if;
end $$;
