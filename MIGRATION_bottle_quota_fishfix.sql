-- ═══════════════════════════════════════════════════════════════
--  迁移：漂流瓶次数探针 + 捞信竞态修复（轮 18 · 用户反馈①④）
--  1) bottle_quota()：今天已写几封 / 已捞几封（UTC 日，服务端权威）。
--     修「网页显示还能捞 2 瓶、服务端却说次数用完」——旧口径次数记在
--     本机 localStorage，网页和 App 各记各的账，跨端必然打架。
--  2) bottle_fish() 重写：随机挑信 → 条件更新抢占，被别人同一瞬间捞走
--     同一封时换一封重试（最多 3 次）；海里真没信时明抛 bottle-empty-sea。
--     修复旧版竞态：抢占落空后函数返回 null（不报错），客户端误当
--     「捞到了」把次数扣掉（用户反馈：没捞到信也减次数）。
--  用法：Supabase Dashboard → SQL Editor → 粘贴全部 → Run（幂等，可重复执行）
--  前置：已执行 MIGRATION_bottle.sql
-- ═══════════════════════════════════════════════════════════════

-- 1) 今日次数（登录用户可用；匿名 revoke）
create or replace function public.bottle_quota()
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'sent',   (select count(*) from public.bottle_letters
                where user_id = auth.uid()
                  and created_day = (now() at time zone 'utc')::date),
    'fished', (select count(*) from public.bottle_fishes
                where user_id = auth.uid()
                  and day = (now() at time zone 'utc')::date)
  )
$$;
revoke all on function public.bottle_quota() from public, anon;
grant execute on function public.bottle_quota() to authenticated;

-- 2) 捞信：抢占式重试，杜绝「返回 null 被当成功」的竞态
create or replace function public.bottle_fish()
returns public.bottle_letters
language plpgsql security definer set search_path = public as $$
declare
  v_count int;
  v_row   public.bottle_letters;
  i       int;
begin
  if auth.uid() is null then raise exception 'bottle-auth'; end if;
  /* 捞起超 48h 未处理的信先放回海里（不让信卡死在谁手里） */
  update public.bottle_letters set status = 'sea', holder = null, held_at = null
    where status = 'held' and held_at < now() - interval '48 hours';
  select count(*) into v_count from public.bottle_fishes
    where user_id = auth.uid() and day = (now() at time zone 'utc')::date;
  if v_count >= 7 then raise exception 'bottle-limit-fish'; end if;
  /* 随机挑一封 → 条件更新抢占（只在仍是 sea 时成立）。别人同一瞬间捞走
     同一封 → 命中 0 行 → 换一封重试；重试 3 次仍落空或海里已空 →
     明确抛 bottle-empty-sea（绝不返回 null：客户端只在拿到信时才计数） */
  for i in 1..3 loop
    select * into v_row from public.bottle_letters
      where status = 'sea' and user_id <> auth.uid()
      order by random() limit 1;
    if not found then raise exception 'bottle-empty-sea'; end if;
    update public.bottle_letters set status = 'held', holder = auth.uid(), held_at = now()
      where id = v_row.id and status = 'sea'
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
  raise exception 'bottle-empty-sea';
end $$;
