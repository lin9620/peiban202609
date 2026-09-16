/* 云端数据访问适配层契约测试（直连实现；阶段 1 起）
 * ------------------------------------------------------------
 * 用「会记录调用链的假 supabase 客户端」跑一遍 src/utils/api/db.js 选择器
 * （默认直连实现 db.supabase.js）的每个方法，断言三件事：
 *   1. 形状：表名 / 过滤列 / 排序方向 / RPC 名与参数 / Storage 桶与路径，与现有 Supabase 后端一致；
 *   2. 降级：removed 列、pats/feeds 列缺失时的退回查询形状正确；
 *   3. 红线：upsertPetProfile 的 payload 只含 user_id / data / updated_at，绝不覆盖 pats/feeds 计数列。
 * 以后换后端（Hyperdrive 接别的 Postgres / D1 / 自建 API）：先改 db.js，再跑本测试 —— 形状跑偏这里立刻报。
 * 运行：node tools/api-contract-test.mjs
 */
import { db, setDbClient } from "../src/utils/api/db.js";
import { getClient } from "../src/utils/supabase.js";

/* —— 假客户端：每个 builder 记录自己的调用链（from|select|eq|...），await 时从 script 队列弹一个结果 —— */
function makeFake(script = []) {
  const calls = [];
  let i = 0;
  const next = () => (i < script.length ? script[i++] : { data: null, error: null });
  const builder = (table) => {
    const ops = [`from:${table}`];
    const b = {
      select: (c) => { ops.push(`select:${c}`); return b; },
      eq: (k, v) => { ops.push(`eq:${k}:${JSON.stringify(v)}`); return b; },
      in: (k, a) => { ops.push(`in:${k}:${JSON.stringify(a)}`); return b; },
      order: (k, o = {}) => { ops.push(`order:${k}:${o && o.ascending === false ? "desc" : "asc"}`); return b; },
      limit: (n) => { ops.push(`limit:${n}`); return b; },
      insert: (row) => { ops.push(`insert:${JSON.stringify(row)}`); return b; },
      update: (row) => { ops.push(`update:${JSON.stringify(row)}`); return b; },
      upsert: (row) => { ops.push(`upsert:${JSON.stringify(row)}`); return b; },
      delete: () => { ops.push("delete"); return b; },
      single: () => { ops.push("single"); return b; },
      maybeSingle: () => { ops.push("maybeSingle"); return b; },
      then: (res, rej) => {
        calls.push(ops.join("|"));
        const r = next();
        return r && r.throw ? Promise.reject(r.throw).then(res, rej) : Promise.resolve(r).then(res, rej);
      },
    };
    return b;
  };
  const sb = {
    from: (t) => builder(t),
    rpc: (name, params) => {
      calls.push(`rpc:${name}:${JSON.stringify(params)}`);
      const r = next();
      return r && r.throw ? Promise.reject(r.throw) : Promise.resolve(r);
    },
    storage: {
      from: (bucket) => ({
        upload: async (path, bytes, opts = {}) => {
          calls.push(`upload:${bucket}:${path}:${bytes.length}:${JSON.stringify(opts)}`);
          const r = next();
          if (r && r.throw) throw r.throw;
          return r || { data: null, error: null };
        },
        getPublicUrl: (path) => {
          calls.push(`publicUrl:${bucket}:${path}`);
          const r = next();
          return r && r.data ? r : { data: { publicUrl: `https://cdn.test/${bucket}/${path}` } };
        },
      }),
    },
  };
  return { sb, calls };
}

let pass = 0;
const fails = [];
function ok(name, cond, extra = "") {
  if (cond) pass++;
  else fails.push(name + (extra ? ` —— ${extra}` : ""));
}
/** 每个用例独立假客户端：跑完立刻拔掉，绝不把假 client 泄漏给别的用例 */
async function run(script, fn) {
  const fake = makeFake(script);
  setDbClient(fake.sb);
  try {
    return { fake, out: await fn() };
  } finally {
    setDbClient(null);
  }
}

const rows = [{ id: 1 }, { id: 2 }];

/* ─────────── 帖子 ─────────── */
{
  const { fake, out } = await run([{ data: rows }], () => db.listPosts(200));
  ok("listPosts 形状", fake.calls[0] === "from:wall_posts|select:*|eq:removed:false|order:created_at:desc|limit:200", fake.calls[0]);
  ok("listPosts 返回行", JSON.stringify(out) === JSON.stringify(rows));
}
{
  const { fake, out } = await run([{ error: { code: "42703" } }, { data: rows }], () => db.listPosts(200));
  ok("listPosts 无 removed 列 → 退回查询不带该过滤", fake.calls[1] === "from:wall_posts|select:*|order:created_at:desc|limit:200", fake.calls[1]);
  ok("listPosts 降级仍返回行", out && out.length === 2);
}
{
  const { fake } = await run([{ data: rows }], () => db.listPostsByUser("u1", 50));
  ok("listPostsByUser 形状", fake.calls[0] === 'from:wall_posts|select:*|eq:user_id:"u1"|eq:removed:false|order:created_at:desc|limit:50', fake.calls[0]);
}
{
  const row = { id: 9, user_id: "u1" };
  const { fake, out } = await run([{ data: row }], () =>
    db.insertPost({ user_id: "u1", author_name: "A", body: "hi", image_path: null }));
  ok("insertPost 形状", fake.calls[0] === 'from:wall_posts|insert:{"user_id":"u1","author_name":"A","body":"hi","image_path":null}|select:*|single', fake.calls[0]);
  ok("insertPost 返回整行", out && out.id === 9);
}

/* ─────────── 档案 ─────────── */
{
  const { fake, out } = await run([{ data: { nickname: "N", created_at: null } }], () => db.getProfile("u1"));
  ok("getProfile 形状", fake.calls[0] === 'from:profiles|select:nickname,created_at|eq:id:"u1"|maybeSingle', fake.calls[0]);
  ok("getProfile 返回行", out && out.nickname === "N");
}
{
  const { out } = await run([{ data: null }], () => db.getProfile("u1"));
  ok("getProfile 行不存在 → null", out === null);
}

/* ─────────── 评论 ─────────── */
{
  const { fake } = await run([{ data: [] }], () => db.listComments(42, 200));
  ok("listComments 形状（旧→新）", fake.calls[0] === "from:wall_comments|select:*|eq:post_id:42|order:created_at:asc|limit:200", fake.calls[0]);
}
{
  const row = { post_id: 1, user_id: "u1", author_name: "A", body: "b", parent_id: 2, reply_to_name: "R" };
  const { fake } = await run([{ data: { id: 3 } }], () => db.insertComment(row));
  ok("insertComment 形状", fake.calls[0] === 'from:wall_comments|insert:{"post_id":1,"user_id":"u1","author_name":"A","body":"b","parent_id":2,"reply_to_name":"R"}|select:*|single', fake.calls[0]);
}
{
  const { fake } = await run([{ data: [] }], () => db.listCommentPostIds([1, 2], 2000));
  ok("listCommentPostIds 形状", fake.calls[0] === "from:wall_comments|select:post_id|in:post_id:[1,2]|limit:2000", fake.calls[0]);
}
{
  const { fake } = await run([{ data: null }], () => db.deleteComment(7));
  ok("deleteComment 形状", fake.calls[0] === "from:wall_comments|delete|eq:id:7", fake.calls[0]);
}

/* ─────────── 回应 ─────────── */
{
  const { fake } = await run([{ data: [] }], () => db.listReactionsByPosts([1, 2]));
  ok("listReactionsByPosts 形状", fake.calls[0] === "from:wall_reactions|select:post_id,user_id,kind|in:post_id:[1,2]", fake.calls[0]);
}
{
  const { fake } = await run([{ data: [] }], () => db.listReactionsByPost(5));
  ok("listReactionsByPost 形状", fake.calls[0] === "from:wall_reactions|select:post_id,user_id,kind|eq:post_id:5", fake.calls[0]);
}
{
  const { fake, out } = await run([{ data: { post_id: 5 } }], () => db.findReaction({ postId: 5, userId: "u1", kind: "hug" }));
  ok("findReaction 形状", fake.calls[0] === 'from:wall_reactions|select:post_id|eq:post_id:5|eq:user_id:"u1"|eq:kind:"hug"|maybeSingle', fake.calls[0]);
  ok("findReaction 返回命中行", out && out.post_id === 5);
}
{
  const { fake } = await run([{ data: null }], () => db.insertReaction({ post_id: 5, user_id: "u1", kind: "hug" }));
  ok("insertReaction 形状", fake.calls[0] === 'from:wall_reactions|insert:{"post_id":5,"user_id":"u1","kind":"hug"}', fake.calls[0]);
}
{
  const { fake } = await run([{ data: null }], () => db.deleteReaction({ postId: 5, userId: "u1", kind: "hug" }));
  ok("deleteReaction 形状", fake.calls[0] === 'from:wall_reactions|delete|eq:post_id:5|eq:user_id:"u1"|eq:kind:"hug"', fake.calls[0]);
}
{
  const { out } = await run([{ error: { message: "boom" } }], async () => {
    try { await db.insertReaction({ post_id: 1, user_id: "u", kind: "hug" }); return { failed: false }; }
    catch (e) { return { failed: e && e.message === "boom" }; }
  });
  ok("错误上抛（unwrap 契约：error → reject）", out && out.failed === true);
}

/* ─────────── RPC（服务端权威逻辑） ─────────── */
{
  const { fake, out } = await run([{ data: { ok: true, views: 3 } }], () => db.addView(1, "v"));
  ok("addView RPC 形状", fake.calls[0] === 'rpc:wall_add_view:{"p_post":1,"p_viewer":"v"}', fake.calls[0]);
  ok("addView 返回", out && out.views === 3);
}
{
  const { fake } = await run([{ data: { ok: true } }], () => db.toggleDislike(1));
  ok("toggleDislike RPC 形状", fake.calls[0] === 'rpc:wall_toggle_dislike:{"p_post":1}', fake.calls[0]);
}
{
  const { fake } = await run([{ data: { ok: true, counted: true, counts: { pats: 2, feeds: 1 } } }], () =>
    db.petInteract("owner", "pat", "anon"));
  ok("petInteract RPC 形状", fake.calls[0] === 'rpc:pet_interact:{"p_owner":"owner","p_kind":"pat","p_viewer":"anon"}', fake.calls[0]);
}

/* ─────────── 宠物主页 ─────────── */
{
  const { fake, out } = await run([{ data: { data: {}, pats: 2, feeds: 1 } }], () => db.getPetProfile("u1"));
  ok("getPetProfile 形状（带计数列）", fake.calls[0] === 'from:pet_profiles|select:data,pats,feeds|eq:user_id:"u1"|maybeSingle', fake.calls[0]);
  ok("getPetProfile 返回整行（含计数）", out && out.pats === 2 && out.feeds === 1);
}
{
  const { fake, out } = await run(
    [{ error: { message: "column pats does not exist" } }, { data: { data: {} } }],
    () => db.getPetProfile("u1"),
  );
  ok("getPetProfile 无计数列 → 退回只读 data", fake.calls[1] === 'from:pet_profiles|select:data|eq:user_id:"u1"|maybeSingle', fake.calls[1]);
  ok("getPetProfile 降级返回行", out && out.data != null);
}
{
  const data = { pet: { name: "Mochi" }, dishes: [], updated: 123 };
  const { fake } = await run([{ data: null }], () => db.upsertPetProfile("u1", data, "2026-01-01T00:00:00.000Z"));
  ok("upsertPetProfile 红线：payload 只含 user_id/data/updated_at（绝不覆盖 pats/feeds）",
    fake.calls[0] === 'from:pet_profiles|upsert:{"user_id":"u1","data":{"pet":{"name":"Mochi"},"dishes":[],"updated":123},"updated_at":"2026-01-01T00:00:00.000Z"}',
    fake.calls[0]);
}

/* ─────────── Storage（图片） ─────────── */
{
  const { fake } = await run([{ data: null }], () =>
    db.uploadImage("u1/pet-ab12.jpg", new Uint8Array([1, 2, 3]), { mime: "image/png", upsert: true }));
  ok("uploadImage 形状（桶 / 路径 / 选项）", fake.calls[0] === 'upload:wall-images:u1/pet-ab12.jpg:3:{"contentType":"image/png","upsert":true}', fake.calls[0]);
}
{
  const { fake, out } = await run([], () => db.imageUrl("u1/x.jpg"));
  ok("imageUrl 公开 URL", out === "https://cdn.test/wall-images/u1/x.jpg", String(out));
  ok("imageUrl 记录调用", fake.calls[0] === "publicUrl:wall-images:u1/x.jpg", fake.calls[0]);
}

/* ─────────── 管理员（RLS is_admin 兜底；页面只是壳） ─────────── */
{
  const { fake, out } = await run([{ data: true }], () => db.amAdmin());
  ok("amAdmin 形状", fake.calls[0] === "rpc:is_admin:undefined", fake.calls[0]);
  ok("amAdmin 返回 true", out === true);
}
{
  const { fake, out } = await run([{ data: { admin: true, users_total: 1 } }], () => db.adminOverview());
  ok("adminOverview 形状", fake.calls[0] === "rpc:admin_overview:undefined", fake.calls[0]);
  ok("adminOverview 返回 jsonb", out && out.admin === true);
}
{
  const { fake, out } = await run([{ data: rows }], () => db.adminListPosts(50));
  ok("adminListPosts 形状（含已下架全列）",
    fake.calls[0] === "from:wall_posts|select:id,user_id,author_name,body,image_path,views,dislikes,removed,created_at|order:created_at:desc|limit:50",
    fake.calls[0]);
  ok("adminListPosts 返回行", out && out.length === 2);
}
{
  const { fake } = await run([{ data: null }], () => db.adminSetPostRemoved("p1", true));
  ok("adminSetPostRemoved 形状",
    fake.calls[0] === 'from:wall_posts|update:{"removed":true}|eq:id:"p1"', fake.calls[0]);
}
{
  const { fake } = await run([{ data: null }], () => db.adminSetPostRemoved("p1", false));
  ok("adminSetPostRemoved 恢复（removed=false）",
    fake.calls[0] === 'from:wall_posts|update:{"removed":false}|eq:id:"p1"', fake.calls[0]);
}
{
  const { fake } = await run([{ data: null }], () => db.adminDeletePost("p1"));
  ok("adminDeletePost 形状", fake.calls[0] === "from:wall_posts|delete|eq:id:\"p1\"", fake.calls[0]);
}
{
  const { fake, out } = await run([{ data: rows }], () => db.adminListComments(100));
  ok("adminListComments 形状",
    fake.calls[0] === "from:wall_comments|select:id,post_id,parent_id,user_id,author_name,body,created_at|order:created_at:desc|limit:100",
    fake.calls[0]);
  ok("adminListComments 返回行", out && out.length === 2);
}
{
  const { fake } = await run([{ data: null }], () => db.adminDeleteComment("c1"));
  ok("adminDeleteComment 形状", fake.calls[0] === "from:wall_comments|delete|eq:id:\"c1\"", fake.calls[0]);
}
{
  const { out } = await run([{ data: false }], () => db.amAdmin());
  ok("非管理员 amAdmin=false（页面据此拦截）", out === false);
}

/* ─────────── 就绪探测 ─────────── */
{
  setDbClient(makeFake().sb);
  ok("注入 client 后 ready()=true", db.ready() === true);
  setDbClient(null);
}
if (!getClient()) {
  ok("未就绪时 ready()=false", db.ready() === false);
  let msg = "";
  try { await db.listPosts(10); } catch (e) { msg = e && e.message; }
  ok("未就绪时数据访问抛 cloud-not-ready", msg === "cloud-not-ready", msg);
} else {
  ok("（本机配置了云端：未就绪分支跳过）", true);
}


setDbClient(null); /* 兜底：绝不把假 client 泄漏出测试进程 */
console.log(`api-contract: ${pass} pass, ${fails.length} fail`);
for (const f of fails) console.log("FAIL  " + f);
if (fails.length) process.exit(1);