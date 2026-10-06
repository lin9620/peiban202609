-- ═══ 轮 208 · 宠物数据上云 ═══
-- 宠物栏全量状态（pets 数组 + 当前宠物 + 金币）按用户一份，JSONB 整包存取。
-- RLS：只允许本人读写。未跑本迁移时 App 静默跳过云同步（行为退回纯本地），随时可补跑。

create table if not exists public.pets (
  user_id uuid primary key references auth.users(id) on delete cascade,
  state jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.pets enable row level security;

drop policy if exists "pets select own" on public.pets;
drop policy if exists "pets insert own" on public.pets;
drop policy if exists "pets update own" on public.pets;

create policy "pets select own" on public.pets
  for select using (auth.uid() = user_id);
create policy "pets insert own" on public.pets
  for insert with check (auth.uid() = user_id);
create policy "pets update own" on public.pets
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
