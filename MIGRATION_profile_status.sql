-- ═══════════════════════════════════════════════════════════════
--  迁移：陪你大厅状态上云（#4）
--  profiles 加 status / status_at 两列；写路径沿用现有
--  "profiles self update" RLS 策略（auth.uid() = id），无需新 RPC。
--  用法：Supabase Dashboard → SQL Editor → 粘贴全部 → Run（幂等，可重复执行）
-- ═══════════════════════════════════════════════════════════════

alter table public.profiles add column if not exists status    text;
alter table public.profiles add column if not exists status_at timestamptz;

/* 大厅按状态时间倒序取近期状态 */
create index if not exists profiles_status_at_idx on public.profiles (status_at desc);

comment on column public.profiles.status is
  '陪你大厅状态 key（working/studying/sleepless/chilling）；null = 未设置（不显示）';
comment on column public.profiles.status_at is
  '状态更新时间；大厅与主页只展示近 24h 内的状态（过期自动隐去）';
