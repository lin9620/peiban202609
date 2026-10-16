-- ═══════════ 轮 305 · 漂流瓶每日可写信 3 → 5 封 ═══════════
-- 用户原话：「把漂流瓶每日可写信由 3 封改成 5 封。」
-- 本迁移：bottle_send 的写信限额 v_count >= 3 → >= 5（其余不动：空信/超长校验、
-- 匿名拒绝、昵称回填原样保留）。create or replace 只换函数体，不动表、不动数据，幂等。
-- 执行权在用户（SQL Editor 跑一份）。未跑 = 旧 3 封口径（前端显示已是 5，按服务端裁定仍拦第 4 封，
-- 会和显示对不上）；跑了 = 前后端一致 5 封。
-- 同源：SUPABASE_SETUP.sql 内 bottle_send 已同步改。

create or replace function public.bottle_send(p_body text)
returns public.bottle_letters
language plpgsql security definer set search_path = public as $$
declare
  v_count int;
  v_row   public.bottle_letters;
begin
  if auth.uid() is null then raise exception 'bottle-auth'; end if;
  p_body := btrim(coalesce(p_body, ''));
  if p_body = '' or char_length(p_body) > 1000 then raise exception 'bottle-too-long'; end if;
  select count(*) into v_count from public.bottle_letters
    where user_id = auth.uid() and created_day = (now() at time zone 'utc')::date;
  if v_count >= 5 then raise exception 'bottle-limit-send'; end if;   -- 轮 305：3 → 5
  insert into public.bottle_letters (user_id, nickname, body)
    values (auth.uid(),
            coalesce((select nickname from public.profiles where id = auth.uid()), ''),
            p_body)
    returning * into v_row;
  return v_row;
end $$;
