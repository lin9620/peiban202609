/* 管理员看板纯函数单测（阶段 2.5）
 * ------------------------------------------------------------
 * src/utils/admin.js 的展示逻辑：格式化 / 趋势补零 / 柱高归一 / 回应聚合 / 日期提取。
 * 输入是 admin_overview() 的 jsonb（或它的片段），全部脏数据兜底 —— 不信任何上游形状。
 * 运行：node tools/admin-test.mjs
 */
import {
  fmtNum, fmtBytes, clip, dailySeries, barHeights, sumReactions, dayOf,
} from "../src/utils/admin.js";

let pass = 0;
const fails = [];
function eq(name, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) pass++;
  else fails.push(`${name} —— got ${g}, want ${w}`);
}

/* fmtNum：千分位 + 脏值归零 */
eq("fmtNum 千分位", fmtNum(1234567), "1,234,567");
eq("fmtNum 0", fmtNum(0), "0");
eq("fmtNum undefined → 0", fmtNum(undefined), "0");
eq("fmtNum null → 0", fmtNum(null), "0");
eq("fmtNum 负数 → 0", fmtNum(-5), "0");
eq("fmtNum 字符串数字", fmtNum("42"), "42");
eq("fmtNum NaN → 0", fmtNum("abc"), "0");

/* fmtBytes：人话单位 + 脏值 */
eq("fmtBytes 0", fmtBytes(0), "0");
eq("fmtBytes undefined", fmtBytes(undefined), "0");
eq("fmtBytes 负数", fmtBytes(-1), "0");
eq("fmtBytes <1KB", fmtBytes(512), "512 B");
eq("fmtBytes KB", fmtBytes(2048), "2.0 KB");
eq("fmtBytes MB", fmtBytes(5 * 1024 * 1024), "5.0 MB");
eq("fmtBytes GB", fmtBytes(3 * 1024 ** 3), "3.0 GB");

/* clip：截断 + 省略号 + 非字符串 */
eq("clip 短文本原样", clip("hello", 10), "hello");
eq("clip 长文本截断", clip("abcdef", 5), "abcd…");
eq("clip 非字符串 → 空串", clip(null, 5), "");
eq("clip n=0 → 只剩省略号", clip("abc", 0), "…");

/* dailySeries：固定 14 天、缺行补零、脏行兜底 */
const ds = dailySeries([
  { day: "2026-01-01T00:00:00Z", posts: 3, users: 1, comments: 2 },
  { day: "2026-01-02T00:00:00Z", posts: "x" },
  null,
  { day: 42, posts: -9 },
]);
eq("dailySeries 固定 14 项", ds.length, 14);
eq("dailySeries 首行解析", ds[0], { day: "2026-01-01", posts: 3, users: 1, comments: 2 });
eq("dailySeries 脏数字补零", ds[1], { day: "2026-01-02", posts: 0, users: 0, comments: 0 });
eq("dailySeries null 行补零", ds[2], { day: "", posts: 0, users: 0, comments: 0 });
eq("dailySeries 非字符串 day", ds[3], { day: "", posts: 0, users: 0, comments: 0 });
eq("dailySeries 尾部补零", ds[13], { day: "", posts: 0, users: 0, comments: 0 });
eq("dailySeries undefined 输入", dailySeries(undefined).length, 14);

/* barHeights：最大值归一到 100、全零给可见矮柱 */
eq("barHeights 归一", barHeights([{ posts: 5 }, { posts: 10 }, { posts: 0 }], "posts"),
  [{ v: 5, h: 50 }, { v: 10, h: 100 }, { v: 0, h: 3 }]);
eq("barHeights 全零 → 矮柱", barHeights([{ posts: 0 }, { posts: 0 }], "posts"),
  [{ v: 0, h: 3 }, { v: 0, h: 3 }]);
eq("barHeights 空输入", barHeights([], "posts"), []);

/* sumReactions：固定四种 + total，未知 kind 忽略 */
eq("sumReactions 聚合", sumReactions({ hug: "2", warm: 3, relate: 0, dislike: 1, weird: 99 }),
  { hug: 2, warm: 3, relate: 0, dislike: 1, total: 6 });
eq("sumReactions 空 → 全零", sumReactions(null), { hug: 0, warm: 0, relate: 0, dislike: 0, total: 0 });
eq("sumReactions 负数忽略", sumReactions({ hug: -3 }), { hug: 0, warm: 0, relate: 0, dislike: 0, total: 0 });

/* dayOf：YYYY-MM-DD 提取 + 脏值空串 */
eq("dayOf 标准时间戳", dayOf("2026-01-02T03:04:05.123Z"), "2026-01-02");
eq("dayOf 纯日期", dayOf("2026-01-02"), "2026-01-02");
eq("dayOf 非日期", dayOf("nope"), "");
eq("dayOf 数字", dayOf(42), "");
eq("dayOf undefined", dayOf(undefined), "");

console.log(`admin-test: ${pass} pass, ${fails.length} fail`);
for (const f of fails) console.log("FAIL  " + f);
if (fails.length) process.exit(1);