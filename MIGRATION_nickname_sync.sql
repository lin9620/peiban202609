-- ═══════════════════════════════════════════════════════════════
--  迁移：改昵称同步旧内容署名（轮 9 · 昵称修改）
-- ------------------------------------------------------------
--  背景：wall_posts.author_name / wall_comments.author_name 是**插入时写死**的
--        冗余列（列表一次查询出全量，不做 join），所以只改 profiles.nickname 的话，
--        用户会看到「我改名了，墙上的帖子还是旧名」。
--  做法：security definer RPC rename_me(new_nick) 在一个事务里：
--        ① 改 profiles.nickname（只改自己这一行）
--        ② 改自己所有帖子 / 评论的 author_name
--        ③ 返回改了行数，前端可如实告知
--  没跑也能改名：前端会退回「只改 profiles」，旧帖署名留旧名（不报错、不白屏）。
--  已知局限：别人评论里「@旧名」的 reply_to_name 是纯文本、没记 uuid，无法可靠回填，
--            保留当时的称呼（历史记录语义）。
--  用法：Supabase Dashboard → SQL Editor → 粘贴全部 → Run（幂等，可重复执行）
-- ═══════════════════════════════════════════════════════════════

create or replace function public.rename_me(p_nick text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me         uuid := auth.uid();
  v_nick     text;
  v_posts    integer := 0;
  v_comments integer := 0;
begin
  if me is null then raise exception 'auth-required'; end if;

  v_nick := btrim(coalesce(p_nick, ''));
  if v_nick = '' then raise exception 'empty-nickname'; end if;
  -- 24 = 前端 authRules.NICK_MAX（超长会撑破署名与侧栏）
  if char_length(v_nick) > 24 then raise exception 'nick-too-long'; end if;

  update public.profiles set nickname = v_nick where id = me;
  if not found then raise exception 'no-profile'; end if;

  update public.wall_posts    set author_name = v_nick where user_id = me;
  get diagnostics v_posts = row_count;

  update public.wall_comments set author_name = v_nick where user_id = me;
  get diagnostics v_comments = row_count;

  return jsonb_build_object('nickname', v_nick, 'posts', v_posts, 'comments', v_comments);
end $$;

-- 执行权限：anon 可能带着旧库 `grant execute on all functions to anon` 的**显式授权**
-- （revoke from public 撤不掉显式 grant），必须显式 revoke anon；函数内部还有 auth.uid() 兜底
revoke all on function public.rename_me(text) from public, anon;
grant execute on function public.rename_me(text) to authenticated;

comment on function public.rename_me(text) is
  '改自己的昵称并同步旧帖/旧评论的署名（security definer；未跑本迁移时前端退回只改 profiles）';