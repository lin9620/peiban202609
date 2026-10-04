# 轮 162：暖心墙刷新 10s 之痛——sample 免计数单查 + cron 保活 + 刷新批瘦身 + 刷新提示重做
import io

def edit(p, pairs):
    s = io.open(p, encoding="utf-8").read()
    for old, new in pairs:
        assert s.count(old) == 1, f"{p}: anchor x{s.count(old)}: {old[:70]!r}"
        s = s.replace(old, new)
    io.open(p, "w", encoding="utf-8", newline="\n").write(s)
    print("ok", p)

# ═══ ① worker/api.js：samplePosts 随机锚点单查（免 count=exact）+ cron 保活 ═══
edit("worker/api.js", [
("""async function samplePosts(env, request, limit, since) {
  const base = ["select=id", "removed=eq.false"];
  if (since) base.push(`created_at=gte.${encodeURIComponent(since)}`);
  const c = await upstream(env, request, restUrl(env, TABLE.posts, [...base, "order=created_at.desc"].join("&")), { headers: { prefer: "count=exact", range: "0-0" } });
  if (!c || !c.ok) return fail(502, "upstream-unreachable");
  const total = parseInt(((c.headers.get("content-range") || "").split("/")[1] || "0"), 10) || 0;
  const maxOff = Math.max(0, total - limit);
  const off = Math.floor(Math.random() * (maxOff + 1));
  const qs = [...base, "order=created_at.desc", `limit=${limit}`, off > 0 ? `offset=${off}` : ""].filter(Boolean).join("&");
  const res = await upstream(env, request, restUrl(env, TABLE.posts, qs));
  if (!res || !res.ok) return fail(502, "upstream-unreachable");
  return new Response(await res.text(), { status: res.status, headers: { "content-type": "application/json" } });
}""",
 """async function samplePosts(env, request, limit, since) {
  /* 轮 162：随机时间锚点替代「count=exact → 随机 offset」。线上实测旧实现 12~16s/次
     还频繁 502：count=exact 在墙表上要 6s+（两次串行上游查询，慢查询窗口里一动就散）。
     改为：在 7 天窗口内随机取一个时刻，单条走 created_at 索引的查询取「该时刻之前的
     N 条」——免计数、单查、随机性照样每次不同（锚点毫秒级随机）；select=* 顺带修掉
     旧实现页面查询只取 id 的暗病。锚点早于窗口内最老帖子（空结果）→ 兜底拉最新一批。 */
  const now = Date.now();
  const parsed = since ? Date.parse(since) : NaN;
  const start = Number.isFinite(parsed) ? parsed : now - 7 * 86400000;
  const anchor = new Date(start + Math.random() * Math.max(1000, now - start)).toISOString();
  const base = ["select=*", "removed=eq.false", "order=created_at.desc", `limit=${limit}`];
  const anchored = [...base, `created_at=lte.${encodeURIComponent(anchor)}`].join("&");
  let res = await upstream(env, request, restUrl(env, TABLE.posts, anchored));
  if (res && res.ok) {
    let rows = null;
    try { rows = JSON.parse(await res.text()); } catch (e) { rows = null; }
    if (Array.isArray(rows) && rows.length === 0) {
      /* 锚点落空（窗口头部没货）→ 退最新一批，保证换一批永远有内容 */
      res = await upstream(env, request, restUrl(env, TABLE.posts, base.join("&")));
    }
  }
  if (!res || !res.ok) return fail(502, "upstream-unreachable");
  return new Response(await res.text(), { status: res.status, headers: { "content-type": "application/json" } });
}"""),
("""export default {
  async fetch(request, env, ctx) {""",
 """export default {
  /* 轮 162：每分钟 cron 自 ping——免费版 isolate 回收造成冷启动尖峰（实测单查 2.3~9.6s
     跳变），靠它压住：保活 isolate 的同时顺手热身。免费额度 10 万次/天，每分钟 1 次
     = 1440 次，余量充足。wrangler.jsonc 里同步挂 triggers.crons。 */
  async scheduled(controller, env, ctx) {
    try {
      const p = fetch("https://warmpaws.de5.net/api/posts?limit=1").catch(() => {});
      if (ctx && ctx.waitUntil) ctx.waitUntil(p);
    } catch (e) { /* 保活失败无所谓 */ }
  },
  async fetch(request, env, ctx) {"""),
])

# ═══ ② wrangler.jsonc：挂每分钟 cron ═══
edit("wrangler.jsonc", [
("""  "routes": [
    { "pattern": "warmpaws.de5.net", "custom_domain": true }
  ],""",
 """  "routes": [
    { "pattern": "warmpaws.de5.net", "custom_domain": true }
  ],
  // 轮 162：每分钟 cron 触发 worker/api.js 的 scheduled 自 ping（压冷启动尖峰），
  // 免费额度 10 万次/天，1440 次/天 余量充足；部署后 Cloudflare 面板可见 cron 绑定。
  "triggers": { "crons": ["* * * * *"] },"""),
])
print("PART A DONE")
