-- ══════════════════════════════════════════════════════════════════════════
-- 轮 84 · 评论回应（👍心 / 💔碎心）
-- ---------------------------------------------------------------------------
-- 需求：每条评论在「回复」右边可以点「心」和「碎心」，各自带数量。
-- 口径照帖子回应（wall_reactions + wall_posts.dislikes）那一套：
--   · 计数**去归一化**存在 wall_comments.hearts / brokens —— 列表页一次 select=* 就拿到，
--     不必对每条评论再发一次聚合查询（评论比帖子多，聚合放大更贵）。
--   · 「我点过哪些」不放进列表（那是按用户变化的），由客户端单独拉 mine 列表。
--   · 切换走 RPC（security definer），计数以服务端为准 —— 前端不算权威数字。
-- 幂等：可重复执行（if not exists / drop policy if exists / create or replace）。
-- ⚠ 执行权在用户（我没有 SQL Editor 权限）：本文件写好即交付，执行后跑探针确认。
-- ══════════════════════════════════════════════════════════════════════════

-- 1) 计数列（先加列，RPC 才能写）
alter table public.wall_comments add column if not exists hearts  integer not null default 0;
alter table public.wall_comments add column if not exists brokens integer not null default 0;

-- 2) 回应明细表：一条评论 × 一个用户 × 一种回应 = 一行（主键天然去重）
create table if not exists public.wall_comment_reactions (
  comment_id bigint      not null references public.wall_comments (id) on delete cascade,
  user_id    uuid        not null references auth.users (id)          on delete cascade,
  kind       text        not null check (kind in ('heart', 'broken')),
  created_at timestamptz not null default now(),
  primary key (comment_id, user_id, kind)
);

create index if not exists wall_comment_reactions_cmt_idx  on public.wall_comment_reactions (comment_id);
create index if not exists wall_comment_reactions_user_idx on public.wall_comment_reactions (user_id);

-- 3) RLS：所有人可读（计数要公开）；只能以自己身份写、删自己的
alter table public.wall_comment_reactions enable row level security;

drop policy if exists "comment reactions readable by all" on public.wall_comment_reactions;
drop policy if exists "comment reactions write by auth"   on public.wall_comment_reactions;
drop policy if exists "comment reactions remove own"      on public.wall_comment_reactions;

create policy "comment reactions readable by all" on public.wall_comment_reactions
  for select using (true);

create policy "comment reactions write by auth" on public.wall_comment_reactions
  for insert to authenticated with check (auth.uid() = user_id);

create policy "comment reactions remove own" on public.wall_comment_reactions
  for delete to authenticated using (auth.uid() = user_id);

-- 4) RPC：切换回应。返回权威计数（{ok,on,hearts,brokens}），前端拿返回值覆盖本地乐观值。
--    用 RPC 而不是「前端 insert/delete + 自己数」的原因：计数得由服务端算，
--    否则并发下两个客户端各自 +1 会把数字算飞（与 wall_toggle_dislike 同思路）。
create or replace function public.wall_toggle_comment_reaction(p_comment bigint, p_kind text)
returns jsonb language plpgsql security definer set search_path = public as $$
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

grant execute on function public.wall_toggle_comment_reaction(bigint, text) to authenticated;

-- 5) 让 PostgREST 立刻看到新表/新列（否则请求会 404 / 400 直到缓存过期）
notify pgrst, 'reload schema';
