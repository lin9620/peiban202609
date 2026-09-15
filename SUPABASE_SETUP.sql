-- ═══════════════════════════════════════════════════════════════
--  Warm Paws · 暖爪 — Supabase 一键建库脚本（第二批：云端暖心墙 + 登录）
--  用法：Supabase Dashboard → SQL Editor → 粘贴全部 → Run
--  幂等：可重复执行（全部用 IF NOT EXISTS / OR REPLACE）
-- ═══════════════════════════════════════════════════════════════

-- 1) 用户资料表（注册后由触发器自动创建一行）
create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  nickname   text not null default '',
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profiles readable by all"    on public.profiles;
drop policy if exists "profiles self insert"        on public.profiles;
drop policy if exists "profiles self update"        on public.profiles;

create policy "profiles readable by all" on public.profiles
  for select using (true);
create policy "profiles self insert" on public.profiles
  for insert with check (auth.uid() = id);
create policy "profiles self update" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- 注册后自动建档（昵称先取注册时填的 metadata.nickname）
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, nickname)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'nickname', ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 2) 暖心墙帖子
create table if not exists public.wall_posts (
  id          bigserial primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  author_name text not null default 'Guest',
  body        text not null check (char_length(body) between 1 and 1000),
  image_path  text,                       -- Storage 内路径，可空（纯文字帖）
  created_at  timestamptz not null default now()
);

alter table public.wall_posts enable row level security;

drop policy if exists "posts readable by all" on public.wall_posts;
drop policy if exists "posts insert by auth"  on public.wall_posts;
drop policy if exists "posts delete own"      on public.wall_posts;

create policy "posts readable by all" on public.wall_posts
  for select using (true);
create policy "posts insert by auth" on public.wall_posts
  for insert with check (auth.uid() = user_id);
create policy "posts delete own" on public.wall_posts
  for delete using (auth.uid() = user_id);

-- 3) 暖心墙评论
create table if not exists public.wall_comments (
  id          bigserial primary key,
  post_id     bigint not null references public.wall_posts (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  author_name text not null default 'Guest',
  body        text not null check (char_length(body) between 1 and 200),
  created_at  timestamptz not null default now()
);

alter table public.wall_comments enable row level security;

drop policy if exists "comments readable by all" on public.wall_comments;
drop policy if exists "comments insert by auth"  on public.wall_comments;
drop policy if exists "comments delete own"      on public.wall_comments;

create policy "comments readable by all" on public.wall_comments
  for select using (true);
create policy "comments insert by auth" on public.wall_comments
  for insert with check (auth.uid() = user_id);
create policy "comments delete own" on public.wall_comments
  for delete using (auth.uid() = user_id);

-- 4) 回应（抱抱/暖暖/同感）：每人每帖每种一次
create table if not exists public.wall_reactions (
  post_id   bigint not null references public.wall_posts (id) on delete cascade,
  user_id   uuid   not null references auth.users (id) on delete cascade,
  kind      text   not null check (kind in ('hug', 'warm', 'relate')),
  created_at timestamptz not null default now(),
  primary key (post_id, user_id, kind)
);

alter table public.wall_reactions enable row level security;

drop policy if exists "reactions readable by all" on public.wall_reactions;
drop policy if exists "reactions write by auth"   on public.wall_reactions;
drop policy if exists "reactions remove own"      on public.wall_reactions;

create policy "reactions readable by all" on public.wall_reactions
  for select using (true);
create policy "reactions write by auth" on public.wall_reactions
  for insert with check (auth.uid() = user_id);
create policy "reactions remove own" on public.wall_reactions
  for delete using (auth.uid() = user_id);

-- 5) 图片存储桶（公开读，登录上传，只能改/删自己路径下的对象）
insert into storage.buckets (id, name, public)
values ('wall-images', 'wall-images', true)
on conflict (id) do nothing;

drop policy if exists "wall images public read"   on storage.objects;
drop policy if exists "wall images auth upload"   on storage.objects;
drop policy if exists "wall images own update"    on storage.objects;
drop policy if exists "wall images own delete"    on storage.objects;

create policy "wall images public read" on storage.objects
  for select using (bucket_id = 'wall-images');
create policy "wall images auth upload" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'wall-images' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "wall images own update" on storage.objects
  for update to authenticated
  using (bucket_id = 'wall-images' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "wall images own delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'wall-images' and (storage.foldername(name))[1] = auth.uid()::text);

-- 完成 ✅ 接下来在项目根目录配置 URL 和 anon key（见 README「Supabase 配置」）
