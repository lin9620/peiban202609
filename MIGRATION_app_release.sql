-- ═══════════════════════════════════════════════════════════════
-- 轮 238 · App 安装包发布桶（管理中心上传 APK → 下载/二维码即指向新包）
-- ---------------------------------------------------------------
-- · 公开桶：任何人可经 /sb/storage/v1/object/public/app-releases/... 下载
--   （下载按钮与二维码固定指向 warm-paws.apk，upsert 覆盖 = 链接永不变、内容常新）
-- · 写入仅限管理员（admin_users 白名单）；对象名固定 warm-paws.apk，upsert 覆盖。
-- · 需在 Supabase SQL 编辑器执行本文件（桶无法从客户端创建）。
-- ═══════════════════════════════════════════════════════════════

insert into storage.buckets (id, name, public)
values ('app-releases', 'app-releases', true)
on conflict (id) do update set public = true;

drop policy if exists "app releases public read"  on storage.objects;
drop policy if exists "app releases admin insert" on storage.objects;
drop policy if exists "app releases admin update" on storage.objects;

create policy "app releases public read" on storage.objects
  for select using (bucket_id = 'app-releases');

create policy "app releases admin insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'app-releases'
    and exists (select 1 from public.admin_users where user_id = auth.uid()));

create policy "app releases admin update" on storage.objects
  for update to authenticated
  using (bucket_id = 'app-releases'
    and exists (select 1 from public.admin_users where user_id = auth.uid()))
  with check (bucket_id = 'app-releases'
    and exists (select 1 from public.admin_users where user_id = auth.uid()));
