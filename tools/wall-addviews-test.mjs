/* 浏览计数批量化离线测试：真实 Worker + 内存上游 + 假 supabase 客户端，无生产请求。
 * 轮 302：暖心墙首屏从「1× feed + 20× wall_add_view（逐条串行）」改成「1× feed + 1× wall_add_views」。
 *         本文件把批量的形状、降级（迁移没跑 → 逐帖循环）、能力标记只试一次、
 *         以及「脏值绝不补 0 / 不冒充」全部钉死。
 * 注意：能力标记是模块级变量（只试一次），所以每个场景都要 import 一个全新模块实例
 *       （Node ESM 里带 query 的 specifier 就是独立实例），否则前一个场景会污染后一个。
 * 运行：node tools/wall-addviews-test.mjs
 */
import assert from "node:assert/strict";
import { wallViewIds, normalizeWallAddViews, WALL_VIEW_BATCH_MAX } from "../src/utils/wallRules.js";

const ENV = { SUPABASE_URL: "https://sb.test", SUPABASE_ANON_KEY: "test" };

let pass = 0;
const T = {
  ok: (c, m) => { assert.ok(c, m); pass++; },
  equal: (a, b, m) => { assert.equal(a, b, m); pass++; },
  deepEqual: (a, b, m) => { assert.deepEqual(a, b, m); pass++; },
  throws: (fn, m) => { assert.throws(fn, m); pass++; },
};

/* ── 假 supabase 客户端（只够本文件用：rpc 记录调用链，await 时从 script 弹一个结果） ── */
function makeFake(script = []) {
  const calls = [];
  let i = 0;
  const next = () => (i < script.length ? script[i++] : { data: null, error: null });
  const sb = {
    rpc: (name, params) => {
      calls.push(`rpc:${name}:${JSON.stringify(params)}`);
      const r = next();
      return Promise.resolve(r);
    },
  };
  return { sb, calls };
}

let seq = 0;
/** 每个场景一个全新模块实例（模块级 wallAddViewsRpc 标记互不污染） */
const freshDirect = async () => await import(`../src/utils/api/db.supabase.js?fresh=${++seq}`);
const freshGateway = async () => await import(`../src/utils/api/db.gateway.js?fresh=${++seq}`);
const freshWorker = async () => (await import(`../worker/api.js?fresh=${++seq}`)).default;

const askWorker = (worker, body) =>
  worker.fetch(new Request("https://site.test/api/posts/views", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }), ENV, {});

const realFetch = globalThis.fetch;

try {
  /* ══════════ A. 纯函数：id 整形 ══════════ */
  {
    T.deepEqual(wallViewIds([3, 1, 3, "2", 0, -1, null, "abc", 1.5, "", 2]), [3, 1, 2],
      "去重 + 只留正整数 + 保序（0/负数/小数/脏串/null 全丢）");
    T.deepEqual(wallViewIds(Array.from({ length: 150 }, (_, i) => i + 1)).length, WALL_VIEW_BATCH_MAX,
      "超上限截断到 WALL_VIEW_BATCH_MAX");
    T.deepEqual(wallViewIds(null), [], "非数组 → 空");
    T.deepEqual(wallViewIds([Number.MAX_SAFE_INTEGER + 2]), [], "超出安全整数 → 丢（不给上游 bigint 塞脏值）");
    T.deepEqual(wallViewIds(["007"]), [7], "数字串照收并归一");
    T.ok(true, "A wallViewIds 整形 6 例");
  }

  /* ══════════ B. 纯函数：返回校验（红线：绝不补 0） ══════════ */
  {
    const good = normalizeWallAddViews({
      ok: true,
      results: [
        { post: 1, ok: true, counted: true, views: 5, dislikes: 0, removed: false },
        { post: 2, ok: true, counted: false, views: 9, dislikes: 1, removed: true },
        { post: 3, ok: false, reason: "not-found" },
      ],
    });
    T.equal(good.size, 2, "ok:false（帖不存在）不进 map，不冒充有数据");
    T.deepEqual(good.get(1), { views: 5, dislikes: 0, removed: false, counted: true });
    T.deepEqual(good.get(2), { views: 9, dislikes: 1, removed: true, counted: false });

    const bad = [
      ["不是对象", null],
      ["ok 不是 true", { ok: false, results: [] }],
      ["results 不是数组", { ok: true, results: {} }],
      ["行不是对象", { ok: true, results: [1] }],
      ["post 缺失", { ok: true, results: [{ ok: true, views: 1, dislikes: 0 }] }],
      ["views = null（不是数字）", { ok: true, results: [{ post: 1, ok: true, views: null, dislikes: 0 }] }],
      ["views 负数", { ok: true, results: [{ post: 1, ok: true, views: -1, dislikes: 0 }] }],
      ["views 脏串", { ok: true, results: [{ post: 1, ok: true, views: "abc", dislikes: 0 }] }],
      ["views 小数", { ok: true, results: [{ post: 1, ok: true, views: 1.5, dislikes: 0 }] }],
      ["dislikes 缺失", { ok: true, results: [{ post: 1, ok: true, views: 1 }] }],
      ["post 重复", { ok: true, results: [{ post: 1, ok: true, views: 1, dislikes: 0 }, { post: 1, ok: true, views: 2, dislikes: 0 }] }],
    ];
    for (const [label, payload] of bad) {
      T.throws(() => normalizeWallAddViews(payload), label + " 必须报错，不能补 0");
    }
    T.ok(true, "B normalizeWallAddViews 11 例脏值全报错");
  }

  /* ══════════ C. 直连：RPC 在 → 一条 wall_add_views，返回 Map ══════════ */
  {
    const { sb, calls } = makeFake([{
      data: {
        ok: true,
        results: [
          { post: 1, ok: true, counted: true, views: 5, dislikes: 0, removed: false },
          { post: 2, ok: true, counted: false, views: 9, dislikes: 1, removed: false },
        ],
      },
    }]);
    const m = await freshDirect();
    m.setDbClient(sb);
    const map = await m.db.addViews([1, 2, 2, "x", 0], "v");
    T.equal(calls.length, 1, "只发 1 次 RPC（旧链路是 20 次）");
    T.equal(calls[0], 'rpc:wall_add_views:{"p_posts":[1,2],"p_viewer":"v"}',
      "参数名 p_posts/p_viewer 与迁移对齐，且脏 id 已在适配层滤掉");
    T.equal(map.get(1).views, 5);
    T.equal(map.get(2).counted, false, "counted 原样透出（服务端去重的真相）");
    T.ok(map instanceof Map, "返回 Map（调用方按 id 认领，RPC 不承诺行序）");
    T.ok(true, "C 直连批量成功：1 次上游 + Map 形状");
  }

  /* ══════════ D. 直连：能力标记只试一次（确认可用后不再回头试逐帖） ══════════ */
  {
    const { sb, calls } = makeFake([
      { data: { ok: true, results: [] } },
      { data: { ok: true, results: [] } },
    ]);
    const m = await freshDirect();
    m.setDbClient(sb);
    await m.db.addViews([1], "v");
    await m.db.addViews([2], "v");
    T.deepEqual(calls, [
      'rpc:wall_add_views:{"p_posts":[1],"p_viewer":"v"}',
      'rpc:wall_add_views:{"p_posts":[2],"p_viewer":"v"}',
    ], "两次都走批量，第二次不会退回逐帖");
    T.ok(true, "D 已确认可用后不再回退");
  }

  /* ══════════ E. 直连：函数没建（迁移未跑）→ 逐帖回退，形状与旧链路一致 ══════════ */
  {
    const { sb, calls } = makeFake([
      { data: null, error: { code: "PGRST202", message: "Could not find the function public.wall_add_views(bigint[], text) in the schema cache" } },
      { data: { ok: true, counted: true, views: 1, dislikes: 0, removed: false } },
      { data: { ok: true, counted: false, views: 2, dislikes: 3, removed: true } },
      /* 第二次调用：批量已记住「没有」，直接逐帖 */
      { data: { ok: true, counted: true, views: 7, dislikes: 0, removed: false } },
    ]);
    const m = await freshDirect();
    m.setDbClient(sb);
    const map = await m.db.addViews([1, 2], "v");
    T.equal(map.size, 2, "回退后仍逐帖认领到结果");
    T.equal(map.get(1).views, 1);
    T.equal(map.get(2).removed, true, "removed 照旧透出（下架帖前台要剔除）");
    T.equal(calls.length, 3, "先白试 1 次批量 + 2 次逐帖");
    T.equal(calls[1], 'rpc:wall_add_view:{"p_post":1,"p_viewer":"v"}', "逐帖参数名与旧链路一致");
    T.equal(calls[2], 'rpc:wall_add_view:{"p_post":2,"p_viewer":"v"}');

    await m.db.addViews([3], "v");
    T.equal(calls.length, 4, "第二次不再白试批量（否则比旧链路还多一个来回）");
    T.equal(calls[3], 'rpc:wall_add_view:{"p_post":3,"p_viewer":"v"}');
    T.ok(true, "E 迁移未跑 → 逐帖回退 + 能力标记只试一次");
  }

  /* ══════════ F. 直连：别的错误不许静默降级，照旧上抛 ══════════ */
  {
    const { sb, calls } = makeFake([{ data: null, error: { code: "42P01", message: "nope" } }]);
    const m = await freshDirect();
    m.setDbClient(sb);
    /* 42P01 属于「没跑迁移」那一类（表/函数不存在）→ 应降级而不是抛 */
    const map = await m.db.addViews([1], "v");
    T.equal(map.size, 0, "42P01 也按「没建」降级（与 isMissingFnError 同口径）");
    T.equal(calls.length, 2, "降级后逐帖也试了一次");

    const { sb: sb2, calls: c2 } = makeFake([{ data: null, error: { code: "500", message: "boom" } }]);
    const m2 = await freshDirect();
    m2.setDbClient(sb2);
    let threw = false;
    try { await m2.db.addViews([1], "v"); } catch (e) { threw = true; }
    T.equal(threw, true, "非「函数没建」的错误必须上抛，绝不静默吞掉");
    T.equal(c2.length, 1, "上抛时不再做无谓的逐帖重试");
    T.ok(true, "F 只认「函数没建」才降级");
  }

  /* ══════════ G. 直连：空/脏 id 列表 → 零上游调用；脏返回 → 抛（不补 0） ══════════ */
  {
    const { sb, calls } = makeFake([]);
    const m = await freshDirect();
    m.setDbClient(sb);
    const map = await m.db.addViews([0, -3, "x", null], "v");
    T.equal(map.size, 0);
    T.equal(calls.length, 0, "一个有效 id 都没有 → 一个上游请求都不发");

    const { sb: sb2 } = makeFake([{ data: { ok: true, results: [{ post: 1, ok: true, views: null, dislikes: 0 }] } }]);
    const m2 = await freshDirect();
    m2.setDbClient(sb2);
    let threw = false;
    try { await m2.db.addViews([1], "v"); } catch (e) { threw = true; }
    T.equal(threw, true, "脏返回必须报错：补 0 会把「没取到」说成「0 次浏览」");
    T.ok(true, "G 空列表零调用 + 脏返回不补 0");
  }

  /* ══════════ H. Worker：RPC 在 → 一条上游 POST，形状 {ok,results} ══════════ */
  {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({
        ok: true,
        results: [
          { post: 1, ok: true, counted: true, views: 5, dislikes: 0, removed: false },
          { post: 2, ok: true, counted: false, views: 9, dislikes: 1, removed: true },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const worker = await freshWorker();
    const res = await askWorker(worker, { ids: [1, 2, 2], viewer: "v" });
    T.equal(res.status, 200);
    const body = await res.json();
    T.equal(body.ok, true);
    T.equal(body.results.length, 2);
    T.deepEqual(body.results[0], { post: 1, ok: true, counted: true, views: 5, dislikes: 0, removed: false });
    T.equal(calls.length, 1, "RPC 路径只发 1 次上游请求（旧链路 20 次）");
    const u = new URL(calls[0].url);
    T.equal(u.pathname, "/rest/v1/rpc/wall_add_views");
    T.equal(calls[0].init.method, "POST");
    T.deepEqual(JSON.parse(calls[0].init.body), { p_posts: [1, 2], p_viewer: "v" }, "参数名与迁移对齐 + 去重");
    T.equal(new Headers(calls[0].init.headers).get("apikey"), ENV.SUPABASE_ANON_KEY);
    T.ok(true, "H Worker 批量成功：1 次上游 + 形状对齐");
  }

  /* ══════════ I. Worker：函数没建 → 逐帖回退（同一响应形状），能力标记只试一次 ══════════ */
  {
    let batches = 0;
    const singles = [];
    globalThis.fetch = async (url) => {
      const s = String(url);
      if (s.endsWith("/rpc/wall_add_views")) {
        batches++;
        return new Response(JSON.stringify({ code: "PGRST202", message: "Could not find the function" }), {
          status: 404, headers: { "content-type": "application/json" },
        });
      }
      if (s.endsWith("/rpc/wall_add_view")) {
        singles.push(s);
        return new Response(JSON.stringify({ ok: true, counted: true, views: 1, dislikes: 0, removed: false }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      throw new Error("unexpected " + s);
    };
    const worker = await freshWorker();
    const body = await (await askWorker(worker, { ids: [1, 2, 3], viewer: "v" })).json();
    T.equal(body.ok, true);
    T.equal(body.results.length, 3, "回退后形状不变（调用方零改动）");
    T.equal(singles.length, 3, "逐帖发 3 次");
    T.equal(batches, 1, "只白试了 1 次批量");

    await askWorker(worker, { ids: [4], viewer: "v" });
    T.equal(batches, 1, "第二次不再白试批量");
    T.equal(singles.length, 4);
    T.ok(true, "I Worker 迁移未跑 → 逐帖回退 + 只试一次");
  }

  /* ══════════ J. Worker：空 ids → 200 空结果、零上游；脏返回 → 500（不补 0） ══════════ */
  {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response("{}", { status: 200 }); };
    const worker = await freshWorker();
    const res = await askWorker(worker, { ids: [0, "x", null], viewer: "v" });
    T.equal(res.status, 200);
    T.deepEqual(await res.json(), { ok: true, results: [] });
    T.equal(calls, 0, "没有有效 id 时不该白跑上游");

    globalThis.fetch = async () => new Response(JSON.stringify({
      ok: true, results: [{ post: 1, ok: true, views: null, dislikes: 0 }],
    }), { status: 200, headers: { "content-type": "application/json" } });
    const worker2 = await freshWorker();
    T.ok((await askWorker(worker2, { ids: [1], viewer: "v" })).status >= 500, "脏返回不能冒充浏览数");
    T.ok(true, "J 空 ids 零上游 + 脏返回 500");
  }

  /* ══════════ K. 网关：POST /api/posts/views{ids,viewer}；老 Worker 404 → 逐帖回退 ══════════ */
  {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      const s = String(url);
      calls.push({ url: s, method: (init && init.method) || "GET", body: init && init.body });
      if (s === "/api/posts/views") {
        return new Response(JSON.stringify({ ok: true, results: [{ post: 7, ok: true, counted: true, views: 3, dislikes: 0, removed: false }] }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true, counted: false, views: 4, dislikes: 0, removed: false }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    };
    const m = await freshGateway();
    m.setGatewayAuthProbe(() => true);
    const map = await m.db.addViews([7], "v");
    T.equal(calls[0].url, "/api/posts/views", "批量走一条端点");
    T.equal(calls[0].method, "POST");
    T.equal(calls[0].body, JSON.stringify({ ids: [7], viewer: "v" }));
    T.equal(map.get(7).views, 3);

    /* 老 Worker（没这条路由）→ 404 → 逐帖 */
    const calls2 = [];
    globalThis.fetch = async (url, init) => {
      const s = String(url);
      calls2.push(s);
      if (s === "/api/posts/views") return new Response(JSON.stringify({ error: "not-found" }), { status: 404, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ ok: true, counted: true, views: 8, dislikes: 0, removed: false }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const m2 = await freshGateway();
    m2.setGatewayAuthProbe(() => true);
    const map2 = await m2.db.addViews([9, 10], "v");
    T.equal(map2.size, 2, "回退后照旧认领到结果");
    T.deepEqual(calls2, ["/api/posts/views", "/api/posts/9/view", "/api/posts/10/view"], "404 → 逐帖 /view");
    await m2.db.addViews([11], "v");
    T.equal(calls2.filter((x) => x === "/api/posts/views").length, 1, "记住没这条路由，之后不再白试");
    T.ok(true, "K 网关批量 + 404 回退 + 只试一次");
  }

  /* ══════════ L. 迁移 SQL 与三处实现同源（签名 / 语义 / 降级开关 / 调用点） ══════════ */
  {
    const { readFileSync } = await import("node:fs");
    const strip = (s) => s.replace(/^\s*--.*$/gm, "");
    const sql = strip(readFileSync(new URL("../MIGRATION_wall_add_views.sql", import.meta.url), "utf8"));
    T.ok(/create or replace function public\.wall_add_views\(p_posts bigint\[\], p_viewer text default ''\)/.test(sql),
      "函数签名与两处实现的 rpc 参数名对齐");
    T.ok(/for v_post in/.test(sql) && /select distinct x from unnest/.test(sql),
      "循环 + distinct（同一 id 传两次只记一次）");
    T.ok(/on conflict do nothing/.test(sql) && /v_counted := found/.test(sql),
      "同人同帖同日只 +1 的口径与单帖版一致");
    T.ok(/insert into public\.wall_post_views \(post_id, viewer_key\)/.test(sql),
      "写的就是单帖版那张去重表");
    T.ok(/views = views \+ 1/.test(sql), "计到数才 +1");
    /* 轮 306（线上 e2e 抓到）：存在性检查必须排在 insert 之前 —— 先 insert 会先撞外键，
       not-found 降级永远走不到。断言读修复迁移（旧文件保留历史定义，只加了更正注释）；
       单帖版在前、批量版在后，必须按函数切片分别比，跨函数 indexOf 会误判。 */
    const fixSql = strip(readFileSync(new URL("../MIGRATION_wall_add_views_fix.sql", import.meta.url), "utf8"));
    const fsi = fixSql.indexOf("create or replace function public.wall_add_view(");
    const fbi = fixSql.indexOf("create or replace function public.wall_add_views(");
    const fSingle = fsi >= 0 && fbi > fsi ? fixSql.slice(fsi, fbi) : "";
    const fBatch = fbi > 0 ? fixSql.slice(fbi) : "";
    T.ok(fSingle.indexOf("where id = p_post") > 0 && fSingle.indexOf("where id = p_post") < fSingle.indexOf("insert into public.wall_post_views"),
      "单帖版：先查帖存在再 insert（坏 id 不撞外键；轮 306 顺序锁）");
    T.ok(fBatch.indexOf("where id = v_post") > 0 && fBatch.indexOf("where id = v_post") < fBatch.indexOf("insert into public.wall_post_views"),
      "批量版：先查帖存在再 insert（坏 id 不拖垮整批；轮 306 顺序锁）");
    T.ok(/create or replace function public\.wall_add_view\(p_post bigint/.test(fixSql)
      && /create or replace function public\.wall_add_views\(p_posts bigint\[\]/.test(fixSql),
      "修复迁移里单帖版 + 批量版都在（两版同修）");
    T.ok(/'reason', 'not-found'/.test(sql) && /'ok', true, 'results'/.test(sql), "帖不存在单条降级、整体仍成功");
    T.ok(/returns jsonb/.test(sql), "返回 jsonb（results 数组）");
    T.ok(/security definer/i.test(sql), "wall_post_views 不开 insert 策略，必须 definer（与单帖版一致）");
    T.ok(/grant execute on function public\.wall_add_views\(bigint\[\], text\) to anon, authenticated/.test(sql),
      "匿名与登录都要能记（游客也计数）");

    const setup = strip(readFileSync(new URL("../SUPABASE_SETUP.sql", import.meta.url), "utf8"));
    const si = setup.indexOf("create or replace function public.wall_add_views");
    const ge = setup.indexOf("grant execute on function public.wall_add_views");
    const fnText = si >= 0 && ge > si ? setup.slice(si, ge) : "";
    T.ok(fnText.length > 0, "SETUP 里能定位到该函数定义到 grant 的整段");
    T.ok(/for v_post in/.test(fnText) && /on conflict do nothing/.test(fnText),
      "SETUP 是同款实现（新装库不该退到 20 次逐帖）");
    T.ok(/grant execute on function public\.wall_add_views\(bigint\[\], text\) to anon, authenticated/.test(setup),
      "SETUP 里的授权与迁移文件一致");
    T.ok(/create or replace function public\.wall_add_view\(p_post bigint, p_viewer text default ''\)/.test(setup),
      "单帖版仍在（回退链路要用）");

    const workerSrc = readFileSync(new URL("../worker/api.js", import.meta.url), "utf8");
    const supaSrc = readFileSync(new URL("../src/utils/api/db.supabase.js", import.meta.url), "utf8");
    const gateSrc = readFileSync(new URL("../src/utils/api/db.gateway.js", import.meta.url), "utf8");
    T.ok(workerSrc.includes('restUrl(env, "rpc/wall_add_views")'), "Worker 调的就是这条 RPC");
    T.ok(supaSrc.includes('rpc("wall_add_views"'), "直连模式调的就是这条 RPC");
    T.ok(workerSrc.includes("wallAddViewsRpc !== false") && supaSrc.includes("wallAddViewsRpc !== false"),
      "两条链路都有「只试一次」的能力标记");
    T.ok(supaSrc.includes("isMissingFnError") && workerSrc.includes("MISSING_FN_CODES"),
      "降级判定复用既有口径，不另写一套");
    T.ok(gateSrc.includes('"/posts/views"'), "网关也有批量端点");
    T.ok(workerSrc.includes("seg.length === 2 && seg[1] === \"views\" && m === \"POST\""),
      "Worker 路由抢在「单帖 id」分支前拦下（否则 'views' 会被当 id 判 400）");

    /* 调用点：必须真的从 20 条循环换成 1 条批量 —— 否则上面全对也没用 */
    const cv = readFileSync(new URL("../src/views/CommunityView.vue", import.meta.url), "utf8");
    T.ok(!/await cloudAddView\(/.test(cv.replace(/^\s*\/\/.*$/gm, "")), "CommunityView 里不该再有逐条 await cloudAddView");
    T.ok(/cloudAddViews\(pending\.map\(\(p\) => p\.dbId\)/.test(cv), "countViews 改成了「一批一次」");
    T.ok(/collectViews\(viewStamps, list, viewerKey\.value\)/.test(cv), "本地去重（stamps）保留，只是发送合并了");
    T.ok(true, "L 迁移 SQL 与三处实现 + 调用点同源");
  }

  console.log("wall-addviews-test: PASS (id 整形/返回校验 11 例脏值/直连批量与逐帖回退/能力标记只试一次/非缺失错误上抛/空列表零上游/Worker 与网关批量+回退/迁移与三处实现+调用点同源)");
  console.log("wall-addviews-test: " + pass + " checks, 0 fail");
} finally {
  globalThis.fetch = realFetch;
}
