/* 大厅人数接口离线测试：真实 Worker + 内存上游，无生产请求。
 * 轮 300：入口从「4 次 HEAD 精确计数」改为「先试单条 RPC status_counts，函数没建才回退」。
 *        本文件把两条链路、回退条件、以及「不能把取不到冒充成 0 人」全部钉死。
 * 注意：能力标记是模块级变量（只试一次），所以每个场景都要 import 一个全新模块实例
 *       （Node ESM 里带 query 的 specifier 就是独立实例），否则前一个场景会污染后一个。
 */
import assert from "node:assert/strict";

const ENV = { SUPABASE_URL: "https://sb.test", SUPABASE_ANON_KEY: "test" };
const SINCE = "2026-09-17T00:00:00.000Z";
const ORDER = ["working", "studying", "sleepless", "chilling"];
const COUNTS = { working: 1201, studying: 7, sleepless: 0, chilling: 2 };
const EXPECTED = ORDER.map((status) => ({ status, count: COUNTS[status] }));

let seq = 0;
/** 每个场景一个全新模块实例（模块级 statusCountsRpc 标记互不污染） */
const freshWorker = async () => (await import(`../worker/api.js?fresh=${++seq}`)).default;
const ask = (worker, since = SINCE) =>
  worker.fetch(new Request("https://site.test/api/statuses/counts?since=" + encodeURIComponent(since)), ENV, {});

const realFetch = globalThis.fetch;
let pass = 0;
/* 断言计数器：本文件的断言散在 9 个场景里，逐条计数才和其它测试的报数同口径 */
const T = {
  ok: (c, m) => { assert.ok(c, m); pass++; },
  equal: (a, b, m) => { assert.equal(a, b, m); pass++; },
  deepEqual: (a, b, m) => { assert.deepEqual(a, b, m); pass++; },
};

try {
  /* ──────── 场景 1：RPC 在（迁移已跑）→ 一条上游 POST，不下载任何个人字段 ──────── */
  {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(ORDER.map((s) => ({ status: s, cnt: COUNTS[s] }))), {
        status: 200, headers: { "content-type": "application/json" },
      });
    };
    const worker = await freshWorker();
    const res = await ask(worker);
    T.equal(res.status, 200);
    T.deepEqual(await res.json(), EXPECTED, "四行按 STATUS_ORDER 顺序，形状与旧契约一致");
    T.equal(calls.length, 1, "RPC 路径只发 1 次上游请求（旧链路是 4 次）");
    const u = new URL(calls[0].url);
    T.equal(u.pathname, "/rest/v1/rpc/status_counts");
    T.equal(calls[0].init.method, "POST");
    T.deepEqual(JSON.parse(calls[0].init.body), { p_since: SINCE }, "参数名与迁移里的 p_since 对齐");
    T.equal(new Headers(calls[0].init.headers).get("apikey"), ENV.SUPABASE_ANON_KEY);
    T.equal(new Headers(calls[0].init.headers).get("content-type"), "application/json");
    T.ok(true, "T1 RPC 成功：1 次上游 + 四行按序 + 不带个人字段");
  }

  /* ──────── 场景 2：能力标记只试一次 —— 成功之后第二次仍走 RPC，不会回头试 HEAD ──────── */
  {
    let posts = 0;
    globalThis.fetch = async (url, init) => {
      if (init && init.method === "POST") posts++;
      return new Response(JSON.stringify(ORDER.map((s) => ({ status: s, cnt: COUNTS[s] }))), {
        status: 200, headers: { "content-type": "application/json" },
      });
    };
    const worker = await freshWorker();
    await ask(worker);
    await ask(worker);
    T.equal(posts, 2, "两次都走 RPC，第二次不会退回 4 次 HEAD");
    T.ok(true, "T2 已确认可用后不再回退");
  }

  /* ──────── 场景 3：函数没建（迁移未跑）→ 回退旧链路，形状逐条与迁移前一致 ──────── */
  {
    const heads = [];
    let rpcTried = 0;
    globalThis.fetch = async (url, init) => {
      const q = new URL(String(url)).searchParams;
      if (String(url).includes("/rpc/")) {
        rpcTried++;
        return new Response(JSON.stringify({ code: "PGRST202", message: "Could not find the function" }), {
          status: 404, headers: { "content-type": "application/json" },
        });
      }
      T.equal(init.method, "HEAD");
      T.equal(new Headers(init.headers).get("prefer"), "count=exact");
      T.equal(q.get("select"), "id");
      T.equal(q.get("status_at"), "gte." + SINCE);
      const status = q.get("status").slice(3);
      T.ok(status in COUNTS, "只按四类状态查");
      heads.push(status);
      return new Response(null, { headers: { "content-range": "*/" + COUNTS[status] } });
    };
    const worker = await freshWorker();
    const res = await ask(worker);
    T.equal(res.status, 200);
    T.deepEqual(await res.json(), EXPECTED, "回退后契约不变：四行、按序、精确计数");
    T.equal(heads.length, 4, "四个精确计数，不下载个人列表、不受一千行上限影响");
    T.deepEqual([...heads].sort(), [...ORDER].sort(), "四类各查一次，不重不漏");
    T.equal(rpcTried, 1);

    /* 第二次请求：已记住「函数没有」，直接走旧链路，不再白试一趟 RPC */
    heads.length = 0;
    await ask(worker);
    T.equal(heads.length, 4);
    T.equal(rpcTried, 1, "回退后不再每趟白试一次 RPC（否则比旧链路还多一个来回）");
    T.ok(true, "T3 迁移未跑 → 4 次 HEAD 回退 + 能力标记只试一次");
  }

  /* ──────── 场景 4：别的 404（不是「函数不存在」）不许回退，照旧报错 ──────── */
  {
    globalThis.fetch = async () => new Response(JSON.stringify({ message: "not found" }), {
      status: 404, headers: { "content-type": "application/json" },
    });
    const worker = await freshWorker();
    T.ok((await ask(worker)).status >= 500, "非函数缺失的 404 不能静默回退");
    T.ok(true, "T4 只认「函数不存在」才降级");
  }

  /* ──────── 场景 5：上游整体不可用 → 报错，绝不冒充 0 人 ──────── */
  {
    globalThis.fetch = async () => { throw new Error("network down"); };
    const worker = await freshWorker();
    T.ok((await ask(worker)).status >= 500, "计数不可用不能冒充零人");
    T.ok(true, "T5 上游不可用 → 500");
  }

  /* ──────── 场景 6：回退链路上游不可用同样不冒充 0 人 ──────── */
  {
    globalThis.fetch = async (url) => {
      if (String(url).includes("/rpc/")) {
        return new Response(JSON.stringify({ code: "42883", message: "does not exist" }), {
          status: 400, headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { headers: { "content-range": "*/*" } });   /* 缺 total */
    };
    const worker = await freshWorker();
    T.ok((await ask(worker)).status >= 500, "回退链路的脏 content-range 同样报错");
    T.ok(true, "T6 回退链路脏响应 → 500");
  }

  /* ──────── 场景 7：RPC 返回脏值 —— 缺行 / 重复 / 负数 / 非数字，一律报错不补 0 ──────── */
  const badRows = [
    ["缺一行", ORDER.slice(0, 3).map((s) => ({ status: s, cnt: COUNTS[s] }))],
    ["多一行", ORDER.map((s) => ({ status: s, cnt: COUNTS[s] })).concat({ status: "working", cnt: 9 })],
    /* 下面两个刻意凑满 4 行：否则先被行数检查拦住，走不到「未知状态」和「重复状态」两个分支 */
    ["未知状态", [{ status: "working", cnt: 1 }, { status: "studying", cnt: 1 }, { status: "sleepless", cnt: 1 }, { status: "sleeping", cnt: 1 }]],
    ["重复状态", [{ status: "working", cnt: 1 }, { status: "working", cnt: 2 }, { status: "studying", cnt: 1 }, { status: "chilling", cnt: 1 }]],
    ["负数", ORDER.map((s) => ({ status: s, cnt: s === "working" ? -1 : COUNTS[s] }))],
    ["字符串数字之外的脏值", ORDER.map((s) => ({ status: s, cnt: s === "working" ? "abc" : COUNTS[s] }))],
    ["null 计数", ORDER.map((s) => ({ status: s, cnt: s === "working" ? null : COUNTS[s] }))],
    ["不是数组", { rows: 4 }],
  ];
  for (const [label, rows] of badRows) {
    globalThis.fetch = async () => new Response(JSON.stringify(rows), {
      status: 200, headers: { "content-type": "application/json" },
    });
    const worker = await freshWorker();
    const res = await ask(worker);
    T.ok(res.status >= 500, "脏值(" + label + ")必须报错，补 0 会把「没取到」说成「没人在」");
  }
  T.ok(true, "T7 RPC 脏值 8 例 → 全部报错不补 0");

  /* ──────── 场景 8：非法 since → 400，且一个上游请求都不发 ──────── */
  {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response(null, { status: 200 }); };
    const worker = await freshWorker();
    T.equal((await ask(worker, "not-a-date")).status, 400);
    T.equal(calls, 0, "参数不合法时不该白跑上游");
    T.ok(true, "T8 非法 since → 400 且零上游调用");
  }

  /* ──────── 场景 9：迁移文件与两处实现同源（顺序、参数名、表名对得上） ──────── */
  {
    const { readFileSync } = await import("node:fs");
    const sqlRaw = readFileSync(new URL("../MIGRATION_status_counts.sql", import.meta.url), "utf8");
    /* 结构性断言只看代码：注释里提一句「不写 security definer」就会把朴素正则骗过去 */
    const sql = sqlRaw.replace(/^\s*--.*$/gm, "");
    T.ok(/create or replace function public\.status_counts\(p_since timestamptz\)/.test(sql), "函数签名与 rpc 参数名对齐");
    T.ok(/returns table \(status text, cnt bigint\)/.test(sql), "返回列名 status / cnt 与两处实现的字段名对齐");
    T.ok(!/security\s+definer/i.test(sql), "必须是 security invoker：RLS 口径要与旧的 4 次 HEAD 完全一致");
    T.ok(/left join public\.profiles p/.test(sql), "LEFT JOIN 才能保证 0 人的状态也出一行");
    T.ok(/grant execute on function public\.status_counts\(timestamptz\) to anon, authenticated/.test(sql), "匿名与登录都要能读");
    ORDER.forEach((s) => T.ok(sql.includes(`'${s}'`), "四类状态齐：" + s));

    const workerSrc = readFileSync(new URL("../worker/api.js", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "");
    const supaSrc = readFileSync(new URL("../src/utils/api/db.supabase.js", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "");
    T.ok(workerSrc.includes('restUrl(env, "rpc/status_counts")'), "Worker 调的就是这条 RPC");
    T.ok(/status_counts", \{ p_since: since \}|\{ p_since: since \}/.test(supaSrc), "直连模式参数名对齐");
    T.ok(workerSrc.includes("statusCountsRpc !== false") && supaSrc.includes("statusCountsRpc !== false"), "两条链路都有能力标记");
    T.ok(workerSrc.includes("STATUS_ORDER") && supaSrc.includes("STATUS_ORDER"), "两条链路都用显式顺序，不靠 Set 展开");
    T.ok(supaSrc.includes("isMissingFnError"), "直连模式复用既有降级判定，不另写一套");

    /* 新装库同源：SETUP 没有这个函数的话，新库会永远退到 4 次 HEAD（能用但慢一倍请求数） */
    const setup = readFileSync(new URL("../SUPABASE_SETUP.sql", import.meta.url), "utf8").replace(/^\s*--.*$/gm, "");
    T.ok(/create or replace function public\.status_counts\(p_since timestamptz\)/.test(setup),
      "SUPABASE_SETUP.sql 也含 status_counts（新装库不该静默退到 4 次 HEAD）");
    T.ok(/grant execute on function public\.status_counts\(timestamptz\) to anon, authenticated/.test(setup),
      "SETUP 里的授权与迁移文件一致");
    /* 只窗口 [函数定义 … grant] 这段：开太宽会扫到后面 handle_new_user() 的 security definer */
    const si = setup.indexOf("create or replace function public.status_counts");
    const ge = setup.indexOf("grant execute on function public.status_counts");
    const fnText = si >= 0 && ge > si ? setup.slice(si, ge) : "";
    T.ok(fnText.length > 0, "SETUP 里能定位到该函数定义到 grant 的整段");
    T.ok(!/security\s+definer/i.test(fnText), "SETUP 里的这个函数同样是 invoker（口径不能和迁移文件分叉）");
    T.ok(true, "T9 迁移 SQL 与双实现同源");
  }

  console.log("status-counts-test: PASS (RPC 成功/能力标记只试一次/迁移未跑回退 4 次 HEAD/非函数缺失不降级/上游不可用与脏值一律报错不补 0/非法参数零上游/迁移与双实现同源)");
  console.log("status-counts-test: " + pass + " checks, 0 fail");
} finally {
  globalThis.fetch = realFetch;
}
