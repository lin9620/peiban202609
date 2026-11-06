-- ═══════════════════════════════════════════════════════════════
--  Warm Paws · 暖爪 — 增量迁移：作者删除自己的内容
--  （轮446 · 暖心墙帖子删除 / 漂流瓶信件撤回与隐藏）
-- ═══════════════════════════════════════════════════════════════
--  需求（用户原话）：
--    「暖心墙帖子，自己发布的怎么没有删除功能，还有漂流瓶我发布的信，也没有删除
--      功能，未被捞到的可以删除，已被捞到的不可删除，但可隐藏。」
--
--  设计（docs/PLAN-owner-delete.md）：
--    · 暖心墙：作者随时可删 → 软删。写 deleted_at 的**同时**置 removed = true，
--      白拿既有 removed 过滤面（6 处查询 + wall_feed_page + wall_search_posts +
--      Worker 网关全都不用改）。只加 deleted_at 要改 14 处 T.posts 查询，漏一处就出 bug。
--    · 漂流瓶：status='sea' 可撤回（软删）；held/answered 只能隐藏（hidden_at）。
--      撤回必须软删 —— bottle_fishes.letter_id 是 on delete cascade，物理删会让
--      「同一封 7 天内不再发给你」和捞瓶额度记账一起回退，等于开了刷额度口子。
--
--  用法：Supabase Dashboard → SQL Editor → **粘贴本文件全部内容** → Run
--        （幂等，可重复执行；只粘片段会静默保留旧定义 —— 踩坑 #21）
--  前置：已执行 MIGRATION_bottle* 系列、MIGRATION_content_lang.sql、
--        MIGRATION_comment_delete.sql、MIGRATION_admin.sql
--
--  不跑也能用（降级）：
--    · 暖心墙：RPC 不存在 → 前端退回 .delete() 走既有 RLS "posts delete own" → 硬删，
--      帖子彻底消失（评论级联没了）。与本仓库「不跑迁移也能用」口径一致。
--    · 漂流瓶：**不能降级**（硬删会破额度台账），前端提示「功能未开通」。
-- ═══════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════
--  一、暖心墙：帖子软删
-- ═══════════════════════════════════════════════════════════════

-- ① 加列：作者自删时间戳（空 = 没删）
alter table public.wall_posts add column if not exists deleted_at timestamptz;

comment on column public.wall_posts.deleted_at is
  '轮446 作者自删时间：非空 = 作者删了这条帖子。行保留（评论/回应/举报不连带消失，可审计可恢复）；
   删除时同时置 removed = true，复用既有 removed 过滤面，列表与 RPC 无需改动。
   口径区分：removed=true 且 deleted_at 为空 = 管理员下架；两者都非空 = 作者自删。';

-- ② 活帖索引：列表/详情永远只查未删未下架的，软删后不能让索引选择变差
create index if not exists wall_posts_live_idx
  on public.wall_posts (created_at desc)
  where deleted_at is null and removed = false;

-- ③ 读策略：已删的只有作者本人与管理员能读到
--    不加这一条，别人直连 REST 仍能拿到已删帖的正文（removed=true 只挡住列表查询，
--    服务端返回与否由 RLS 决定）。
drop policy if exists "posts visible or own or admin" on public.wall_posts;
create policy "posts visible or own or admin" on public.wall_posts
  for select using (
    (removed = false and deleted_at is null)
    or auth.uid() = user_id
    or public.is_admin()
  );

-- ④ 删帖 RPC —— security definer：
--    wall_posts 上没有作者可用的 update 策略（只有 "posts admin update"），
--    照轮 285 删评论的做法把写路径收口到函数里，函数内仍按 auth.uid() 卡「只能删自己的」。
create or replace function public.wall_post_delete(p_id bigint)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
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

-- 注意必须同时 revoke anon：Supabase 的 default privileges 会自动把 EXECUTE 授给 anon，
-- 只 revoke public 撤不掉它（验收时在 role_routine_grants 里抓到过这一条）。
revoke all on function public.wall_post_delete(bigint) from public, anon;
grant execute on function public.wall_post_delete(bigint) to authenticated;

comment on function public.wall_post_delete(bigint) is
  '轮446 作者删自己的帖子（软删 + 置 removed）。返回 false = 不是你的 / 已经删过了。';

-- ⑤ 管理端统计口径：**刻意不改** admin_stats 的 posts_removed。
--    那个函数在 MIGRATION_admin.sql / _admin_dau.sql / _reports.sql 里各自重定义过，
--    整段重写的风险（覆盖掉后来加的 dau / 举报统计）远大于收益 —— 仪表盘一个数字而已。
--    改为：管理端帖子列表带上 deleted_at，前端给作者自删的帖子标注「作者已删」，
--    管理员一眼能分辨该条目不该被"恢复"。

-- ═══════════════════════════════════════════════════════════════
--  二、漂流瓶：撤回（仅 sea）与隐藏（held / answered）
-- ═══════════════════════════════════════════════════════════════

-- ⑥ 加列
alter table public.bottle_letters add column if not exists deleted_at timestamptz;
alter table public.bottle_letters add column if not exists hidden_at  timestamptz;

comment on column public.bottle_letters.deleted_at is
  '轮446 作者撤回：仅 status=sea 可撤回。软删 —— bottle_fishes 是 on delete cascade，
   物理删会让「同一封 7 天内不再发给你」与捞瓶额度记账一起回退，等于开了刷额度口子。';

comment on column public.bottle_letters.hidden_at is
  '轮446 作者从「我发布的」隐藏：只影响写信人自己的列表，对方无感知，
   回信与已有会话都不受影响。hidden_at 非空的行不进 bottle_records(p_mine => true)。';

-- ⑦ 「我发布的」列表索引（只查未隐藏未删的）
create index if not exists bottle_letters_mine_live_idx
  on public.bottle_letters (user_id, created_at desc)
  where hidden_at is null and deleted_at is null;

-- ⑧ 撤回：只在还在海里时允许
create or replace function public.bottle_letter_delete(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
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

-- ⑨ 隐藏：只允许「没有待办、也不是聊天入口」的信
--    这条判断必须与前端按钮显示口径**逐字一致**，否则会出现「按钮点了没反应」。
create or replace function public.bottle_letter_hide(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
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

-- ⑩ 恢复显示
create or replace function public.bottle_letter_unhide(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
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

-- ⑪ 已隐藏列表（「已隐藏 N 封 · 查看」用）。单开函数而不给 bottle_records 加参数：
--    加默认参数 = 新签名，旧函数会残留成重载，rpc 调用命中哪个不確定（轮439 踩过）。
create or replace function public.bottle_letter_hidden()
returns setof public.bottle_letters
language sql
stable
security definer
set search_path = public
as $$
  select * from public.bottle_letters
   where user_id = auth.uid()
     and hidden_at is not null
     and deleted_at is null
   order by hidden_at desc
   limit 50
$$;

revoke all on function public.bottle_letter_delete(uuid) from public, anon;
revoke all on function public.bottle_letter_hide(uuid)   from public, anon;
revoke all on function public.bottle_letter_unhide(uuid) from public, anon;
revoke all on function public.bottle_letter_hidden()     from public, anon;
grant execute on function public.bottle_letter_delete(uuid) to authenticated;
grant execute on function public.bottle_letter_hide(uuid)   to authenticated;
grant execute on function public.bottle_letter_unhide(uuid) to authenticated;
grant execute on function public.bottle_letter_hidden()     to authenticated;

-- ═══════════════════════════════════════════════════════════════
--  三、连带修改的三个既有函数（不修改就会漏）
-- ═══════════════════════════════════════════════════════════════

-- ⑫ bottle_fish：挑信时排除已撤回的
--    基线 = MIGRATION_content_lang.sql 那一版（带 p_lang 的两轮 pass）。
--    **并发防护（条件更新抢锁 + 重试 3 次 + 换 pass）一字不改**，只加一个条件。
--    用错基线会把「本语言优先」覆盖掉 —— 轮 439 差点犯的错。
create or replace function public.bottle_fish(p_lang text default null)
returns public.bottle_letters
language plpgsql security definer set search_path = public as $$
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

-- ⑬ bottle_records：只在「我发布的」分支过滤隐藏与撤回
--    p_mine = false（我捞到的）与 null（旧口径）**不加** —— 那是别人写的信，
--    写信人隐藏自己的列表不该影响捞信人。
create or replace function public.bottle_records(
  p_id     uuid default null,
  p_offset integer default 0,
  p_mine   boolean default null,
  p_limit  integer default 30
)
returns setof public.bottle_letters language sql stable security definer set search_path = public as $$
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

-- ⑭ bottle_reply：回信时自动取消隐藏
--    基线 = MIGRATION_bottle_reply_quota.sql（记次只盖最新一条捞信日志）。
--    为什么必须加：隐藏着的信后来收到回信，若不取消隐藏 → 红点亮了、列表里却找不到
--    那封信，用户收不到最重要的提醒。
create or replace function public.bottle_reply(p_id uuid, p_reply text)
returns public.bottle_letters
language plpgsql security definer set search_path = public as $$
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

-- ⑮ bottle_send：撤回的信不参与「24h 内不能重复发同一段内容」去重
--    基线 = MIGRATION_content_lang.sql（advisory lock + 滚动 24h/5 封）。
--    额度计数**不排除**已删 —— 撤回不退还投递次数（否则可以无限试写）。
create or replace function public.bottle_send(p_body text, p_lang text default null)
returns public.bottle_letters
language plpgsql security definer set search_path = public as $$
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

commit;
