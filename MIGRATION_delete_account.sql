-- ═══════════════════════════════════════════════════════════════════
-- MIGRATION_delete_account.sql —— 应用内自助删号（#T3）
-- App 上架 Google Play 的 2024 政策硬门槛；网页版同步获得此能力。
-- 幂等：create or replace；重跑安全。
-- 执行：由用户粘贴到 Supabase SQL Editor 运行（AI 无 SQL 执行权）。
-- ═══════════════════════════════════════════════════════════════════
-- 设计要点：
--   1) Storage：本站图片路径恒为两段 <uid>/<file>（Worker safeImagePath 白名单保证），
--      该用户的所有对象都在 wall-images/<uid>/ 前缀下 → 按前缀删除，不依赖业务行，
--      因此先删对象、后删行，顺序安全。
--   2) 业务数据：各表外键全部指向 auth.users / profiles 且 on delete cascade
--      （漂流瓶 holder/reply_by 为 set null：信件保留、摘除作者身份），
--      → 只需删除 auth.users 一行，级联清理全部业务数据（单语句，原子）。
--   3) 存储清理失败不阻塞删号（removed=-1 记录在返回值，残留对象可按前缀人工清理）。
-- 错误码：not-signed-in（未登录 / 账号已不存在）。
-- ═══════════════════════════════════════════════════════════════════

create or replace function public.delete_my_account()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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

-- 执行权限（项目惯例：必须显式 revoke anon —— 旧库可能带着
-- `grant execute on all functions to anon` 的显式授权，revoke from public 撤不掉它；
-- 函数内部 auth.uid() 再兜一层）
revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

comment on function public.delete_my_account() is
'自助删号：删除 wall-images/<uid>/ 存储对象 + 级联删除全部业务数据。仅限删除自己的账号（auth.uid() 校验）。';
