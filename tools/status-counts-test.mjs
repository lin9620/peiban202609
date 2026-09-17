/* 大厅人数接口离线测试：真实 Worker + 内存上游，无生产请求。 */
import assert from "node:assert/strict";
import worker from "../worker/api.js";
const env = { SUPABASE_URL: "https://sb.test", SUPABASE_ANON_KEY: "test" };
const since = "2026-09-17T00:00:00.000Z";
const expected = { working: 1201, studying: 7, sleepless: 0, chilling: 2 };
const realFetch = globalThis.fetch;
let calls = 0;
try {
  globalThis.fetch = async (url, init) => {
    calls++;
    const q = new URL(url).searchParams;
    assert.equal(init.method, "HEAD");
    assert.equal(new Headers(init.headers).get("prefer"), "count=exact");
    assert.equal(q.get("select"), "id");
    assert.equal(q.get("status_at"), "gte." + since);
    const status = q.get("status").slice(3);
    assert.ok(status in expected);
    return new Response(null, { headers: { "content-range": "*/" + expected[status] } });
  };
  const request = (query) => worker.fetch(new Request("https://site.test/api/statuses/counts?since=" + encodeURIComponent(query)), env, {});
  const response = await request(since);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), Object.entries(expected).map(([status, count]) => ({ status, count })));
  assert.equal(calls, 4, "四个精确计数，不下载个人列表、不受一千行上限影响");
  assert.equal((await request("not-a-date")).status, 400);
  assert.equal(calls, 4);
  globalThis.fetch = async () => new Response(null, { headers: { "content-range": "*/*" } });
  assert.ok((await request(since)).status >= 500, "计数不可用不能冒充零人");
  console.log("status-counts-test: PASS (四类人数、零人、超过分页上限、无身份字段、非法日期、计数失败)");
} finally {
  globalThis.fetch = realFetch;
}
