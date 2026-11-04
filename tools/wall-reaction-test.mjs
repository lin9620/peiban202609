/* 暖心墙 · 帖级回应写入链路单测（轮 333）
 * ------------------------------------------------------------
 * 覆盖 cloudSetReaction 的三条路径与幂等/并发语义：
 *   ① 快路径：RPC wall_set_reaction 可用 → 一条语句完成「确保存在/确保不存在」
 *   ② 回退：迁移没跑（RPC 缺失）→ 退回无前置查询的幂等写法
 *   ③ 失败：真错误上抛（不静默成「没写成」）
 * 并断言「先查再写」的 findReaction **不再出现在写路径上** ——
 * 那正是老代码竞态窗口与「查询失败被当成没点过」的病根。
 *
 * 运行：node tools/wall-reaction-test.mjs
 */
import assert from "node:assert/strict";
import { cloud } from "../src/utils/supabase.js";
import { setDbClient, __resetRpcProbes } from "../src/utils/api/db.js";
import { cloudSetReaction } from "../src/utils/wall.js";

const out = [];
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; out.push("PASS  " + name); }
  catch (e) { fail++; out.push("FAIL  " + name + "  → " + e.message); }
}

/* ── 假 client：记录调用链，按 script 依次回结果 ── */
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
      insert: (row) => { ops.push(`insert:${JSON.stringify(row)}`); return b; },
      upsert: (row, opts) => {
        ops.push(`upsert:${JSON.stringify(row)}${opts ? `|opts:${JSON.stringify(opts)}` : ""}`);
        return b;
      },
      delete: () => { ops.push("delete"); return b; },
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
  };
  return { calls, sb };
}

/* cloud 是 reactive 对象 —— 直接改字段即可模拟登录态 */
cloud.ready = true;
cloud.user = { id: "u1" };

const withFake = async (script, fn) => {
  const fake = makeFake(script);
  setDbClient(fake.sb);
  __resetRpcProbes();
  try { return { fake, out: await fn() }; }
  finally { setDbClient(null); __resetRpcProbes(); }
};

const RPC_OK = (counts = { hug: 1, warm: 0, relate: 0 }, mine = { hug: true, warm: false, relate: false }) => ({
  data: { ok: true, on: mine.hug === true, counts, mine },
});

/* ══════════ ① 快路径：RPC 可用 ══════════ */
{
  const { fake, out: r } = await withFake([RPC_OK()], () => cloudSetReaction(5, "hug", true));
  t("#333 快路径：走 RPC 且只发 1 次请求", () => {
    assert.equal(fake.calls.length, 1);
    assert.ok(fake.calls[0].startsWith("rpc:wall_set_reaction:"), fake.calls[0]);
  });
  t("#333 快路径：写路径上**没有** findReaction（无前置查询 = 无竞态窗口）", () => {
    assert.ok(!fake.calls.some((c) => c.includes("maybeSingle")), JSON.stringify(fake.calls));
  });
  t("#333 快路径：返回服务端权威计数与 mine", () => {
    assert.deepEqual(r, { hug: 1, warm: 0, relate: 0, mine: { hug: true, warm: false, relate: false } });
  });
}
{
  /* p_on=false → 取消：同样一条语句，同样幂等 */
  const { fake, out: r } = await withFake(
    [RPC_OK({ hug: 0, warm: 0, relate: 0 }, { hug: false, warm: false, relate: false })],
    () => cloudSetReaction(5, "hug", false),
  );
  t("#333 快路径：取消也走同一条 RPC（on=false）", () => {
    assert.equal(fake.calls.length, 1);
    assert.ok(fake.calls[0].includes('"p_on":false'), fake.calls[0]);
    assert.equal(r.hug, 0);
    assert.equal(r.mine.hug, false);
  });
}

/* ══════════ ② 幂等语义：重复设同一个状态 ══════════ */
{
  /* 重复 on=true：每次都是「确保存在」，两次都成功，计数一致 */
  const a = await withFake([RPC_OK()], () => cloudSetReaction(5, "hug", true));
  const b = await withFake([RPC_OK()], () => cloudSetReaction(5, "hug", true));
  t("#333 幂等：重复设为 on 两次都成功且状态一致", () => {
    assert.deepEqual(a.out, b.out);
    assert.equal(a.out.mine.hug, true);
  });
}
{
  /* 重复 on=false：同样幂等 */
  const a = await withFake(
    [RPC_OK({ hug: 0, warm: 0, relate: 0 }, { hug: false, warm: false, relate: false })],
    () => cloudSetReaction(5, "hug", false),
  );
  const b = await withFake(
    [RPC_OK({ hug: 0, warm: 0, relate: 0 }, { hug: false, warm: false, relate: false })],
    () => cloudSetReaction(5, "hug", false),
  );
  t("#333 幂等：重复设为 off 两次都成功且状态一致", () => {
    assert.deepEqual(a.out, b.out);
    assert.equal(a.out.mine.hug, false);
  });
}
{
  /* 不同 kind 互相独立：hug 的写入不影响 warm 的计数 */
  const { out: r } = await withFake(
    [RPC_OK({ hug: 2, warm: 5, relate: 1 }, { hug: true, warm: false, relate: false })],
    () => cloudSetReaction(5, "hug", true),
  );
  t("#333 不同 kind 相互独立（计数按 kind 分开）", () => {
    assert.equal(r.hug, 2);
    assert.equal(r.warm, 5);
    assert.equal(r.relate, 1);
  });
}

/* ══════════ ③ 并发：同一用户多设备同时点 ══════════ */
{
  /* 两个「设备」同时点同一个 kind → 两次都发 RPC（服务端各自保证幂等），
     且**没有**任何一方因为「查到对方还没写」而误判。 */
  const fake = makeFake([RPC_OK(), RPC_OK()]);
  setDbClient(fake.sb);
  __resetRpcProbes();
  try {
    const [r1, r2] = await Promise.all([
      cloudSetReaction(5, "hug", true),
      cloudSetReaction(5, "hug", true),
    ]);
    t("#333 并发：同一用户两个设备同时点 → 两次都成功", () => {
      assert.ok(r1 && r2);
      assert.equal(r1.mine.hug, true);
      assert.equal(r2.mine.hug, true);
    });
    t("#333 并发：两次各发 1 条 RPC（无共享状态、无查询窗口）", () => {
      assert.equal(fake.calls.length, 2);
      assert.ok(fake.calls.every((c) => c.startsWith("rpc:wall_set_reaction:")), JSON.stringify(fake.calls));
    });
  } finally {
    setDbClient(null);
    __resetRpcProbes();
  }
}
{
  /* 并发 on/off（连点两下）：最终状态 = 各自 RPC 的权威返回，不做本地翻转 */
  const fake = makeFake([
    RPC_OK({ hug: 1, warm: 0, relate: 0 }, { hug: true, warm: false, relate: false }),
    RPC_OK({ hug: 0, warm: 0, relate: 0 }, { hug: false, warm: false, relate: false }),
  ]);
  setDbClient(fake.sb);
  __resetRpcProbes();
  try {
    const [on, off] = await Promise.all([
      cloudSetReaction(5, "hug", true),
      cloudSetReaction(5, "hug", false),
    ]);
    t("#333 并发 on/off：各自返回服务端权威状态（不做本地翻转）", () => {
      assert.equal(on.mine.hug, true);
      assert.equal(off.mine.hug, false);
    });
  } finally {
    setDbClient(null);
    __resetRpcProbes();
  }
}

/* ══════════ ④ 回退：迁移没跑 ══════════ */
{
  const missing = { error: { code: "PGRST202", message: "Could not find the function public.wall_set_reaction" } };
  const { fake, out: r } = await withFake(
    [missing, { data: null }],
    () => cloudSetReaction(5, "hug", true),
  );
  t("#333 回退：RPC 缺失 → 退回幂等写入（upsert ignoreDuplicates）", () => {
    const up = fake.calls.find((c) => c.includes("|upsert:"));
    assert.ok(up, JSON.stringify(fake.calls));
    assert.ok(up.includes('"ignoreDuplicates":true'), up);
  });
  t("#333 回退：回退路径也**没有** findReaction（老 bug 已被消掉）", () => {
    assert.ok(!fake.calls.some((c) => c.includes("maybeSingle")), JSON.stringify(fake.calls));
  });
  t("#333 回退：仍返回计数（重拉该帖回应后聚合）", () => {
    assert.ok(r && typeof r.hug === "number", JSON.stringify(r));
  });
}
{
  /* 回退 + 取消：直接 DELETE（删不存在的行也不报错 → 幂等） */
  const missing = { error: { code: "PGRST202", message: "Could not find the function" } };
  const { fake } = await withFake(
    [missing, { data: [] }],
    () => cloudSetReaction(5, "hug", false),
  );
  t("#333 回退：取消 = 直接 DELETE（不查；删不存在的也不报错）", () => {
    assert.ok(fake.calls.some((c) => c.includes("delete")), JSON.stringify(fake.calls));
    assert.ok(!fake.calls.some((c) => c.includes("maybeSingle")), JSON.stringify(fake.calls));
  });
}

/* ══════════ ⑤ 真错误不静默 ══════════ */
{
  /* RPC 存在但真失败（权限/网络）→ 返回 null（调用方据此回滚 + 提示），
     绝不能当成「写成功」 */
  const { out: r } = await withFake(
    [{ error: { message: "permission denied" } }],
    () => cloudSetReaction(5, "hug", true),
  );
  t("#333 真错误：返回 null（调用方会回滚 + 提示失败）", () => {
    assert.equal(r, null);
  });
}
{
  /* 未登录 → 直接 null，不发任何请求 */
  const saved = cloud.user;
  cloud.user = null;
  try {
    const { fake, out: r } = await withFake([], () => cloudSetReaction(5, "hug", true));
    t("#333 未登录：返回 null 且不发请求", () => {
      assert.equal(r, null);
      assert.equal(fake.calls.length, 0);
    });
  } finally {
    cloud.user = saved;
  }
}


/* ══════════ ⑥ 乐观更新回调（cloudSetReaction 的 opts）══════════ */
/* 验证 applyOptimistic / applyAuthoritative / applyRollback 触发时机与参数 */
{
  let optCalls = [], authCalls = [], rollbackCalls = [];
  const { fake, out: r } = await withFake([RPC_OK()], () =>
    cloudSetReaction(5, "hug", true, {
      applyOptimistic: (x) => { optCalls.push(x); },
      applyAuthoritative: (x) => { authCalls.push(x); },
      applyRollback: (x) => { rollbackCalls.push(x); },
    })
  );
  t("#333 乐观：applyOptimistic 在 RPC 前被调用，传了 {postId, kind, on}", () => {
    assert.deepEqual(optCalls, [{ postId: 5, kind: "hug", on: true }], JSON.stringify(optCalls));
    assert.equal(authCalls.length, 1, "applyAuthoritative 应在成功后调用 1 次");
    assert.equal(authCalls[0].postId, 5);
    assert.equal(authCalls[0].kind, "hug");
    assert.equal(authCalls[0].on, true);
    assert.deepEqual(authCalls[0].fresh, { hug: 1, warm: 0, relate: 0, mine: { hug: true, warm: false, relate: false } });
    assert.equal(rollbackCalls.length, 0, "成功时不应触发 applyRollback");
  });
}
{
  let rollbackCalls = [];
  const { out: r } = await withFake(
    [{ error: { message: "permission denied" } }],
    () => cloudSetReaction(5, "warm", false, {
      applyOptimistic: () => { /* 本地已翻转 */ },
      applyAuthoritative: () => { /* 不应触发 */ },
      applyRollback: (x) => { rollbackCalls.push(x); },
    })
  );
  t("#333 乐观：真错误时 applyRollback 被调用，applyAuthoritative 不触发", () => {
    assert.equal(r, null);
    assert.equal(rollbackCalls.length, 1);
    assert.deepEqual(rollbackCalls[0], { postId: 5, kind: "warm", on: false }, JSON.stringify(rollbackCalls));
  });
}
{
  /* 回退路径（RPC 缺失）走 upsert/delete，成功后也应触发 applyAuthoritative */
  let authCalls = [];
  const missing = { error: { code: "PGRST202", message: "Could not find the function" } };
  const { fake, out: r } = await withFake(
    [missing, { data: null }],
    () => cloudSetReaction(5, "relate", true, {
      applyOptimistic: () => {},
      applyAuthoritative: (x) => { authCalls.push(x); },
      applyRollback: () => {},
    })
  );
  t("#333 乐观：回退路径成功后 applyAuthoritative 也触发，返回重拉聚合计数", () => {
    assert.equal(authCalls.length, 1);
    assert.equal(authCalls[0].kind, "relate");
    assert.equal(authCalls[0].on, true);
    assert.ok(r && typeof r.relate === "number", JSON.stringify(r));
  });
}

console.log(out.join("\n"));

console.log(out.join("\n"));
console.log(`\nTOTAL ${pass + fail}  PASS ${pass}  FAIL ${fail}`);
process.exit(fail ? 1 : 0);
