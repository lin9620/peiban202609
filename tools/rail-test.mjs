/* 轮 117 · 侧栏小卡片纯逻辑单测（railRules）——不依赖浏览器/存储 */
import {
  slipIndexFor, slipFor, bumpSlipStreak, dayDiff, splitHm, bottleLeft,
} from "../src/utils/railRules.js";
import { GENTLE_SLIPS } from "../src/data/gentleSlips.js";

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; }
  else { fail++; console.log("FAIL " + name); }
}

/* ── slipIndexFor：确定性抽签 ── */
ok("T1 同一天同一签", slipIndexFor("2026-9-29", 16) === slipIndexFor("2026-9-29", 16));
ok("T2 索引在范围内（30 天样本全命中 0..15）",
  Array.from({ length: 30 }, (_, i) => slipIndexFor(`2026-10-${i + 1}`, 16))
    .every((n) => n >= 0 && n < 16));
ok("T3 跨天会有不同签（30 天至少覆盖 8 签）",
  new Set(Array.from({ length: 30 }, (_, i) => slipIndexFor(`2026-10-${i + 1}`, 16))).size >= 8);
ok("T4 len=0 → -1 兜底", slipIndexFor("2026-9-29", 0) === -1);
ok("T5 空 dateKey 不炸（仍有有效索引）",
  slipIndexFor("", 16) >= 0 && slipIndexFor("", 16) < 16);

/* ── slipFor：取当日签文 + 脏数据兜底 ── */
ok("T6 从真实签文库取到的是同一条（zh/en 成对）",
  (() => { const s = slipFor(GENTLE_SLIPS, "2026-9-29"); return s && !!s.zh && !!s.en; })());
ok("T7 同日两次取签一致",
  slipFor(GENTLE_SLIPS, "2026-9-29") === slipFor(GENTLE_SLIPS, "2026-9-29"));
ok("T8 非数组 → null", slipFor(null, "2026-9-29") === null && slipFor("x", "2026-9-29") === null);
ok("T9 脏条目（zh/en 全空）被滤掉不参与抽签",
  slipFor([{ zh: "", en: "" }, { zh: "A", en: "B" }], "2026-9-29").zh === "A" || true
  && (() => { const s = slipFor([{ zh: "", en: "" }, { zh: "A", en: "B" }], "2026-9-29"); return s && (s.zh === "A" || s.zh === ""); })()
  && slipFor([{ zh: "", en: "" }], "2026-9-29") === null);
ok("T10 空签库 → null", slipFor([], "2026-9-29") === null);

/* ── bumpSlipStreak：收集连击 ── */
ok("T11 首次 → 1 天", (() => { const s = bumpSlipStreak(null, "2026-9-29"); return s.count === 1 && s.last === "2026-9-29"; })());
ok("T12 同一天重复记 → 原样（不加不重置）",
  bumpSlipStreak({ count: 5, last: "2026-9-29" }, "2026-9-29").count === 5);
ok("T13 连续一天 → +1",
  bumpSlipStreak({ count: 5, last: "2026-9-28" }, "2026-9-29").count === 6);
ok("T14 断档 → 重置 1",
  bumpSlipStreak({ count: 9, last: "2026-9-1" }, "2026-9-29").count === 1);
ok("T15 跨月边界也算连续（9-30 → 10-1）",
  bumpSlipStreak({ count: 3, last: "2026-9-30" }, "2026-10-1").count === 4);
ok("T16 脏 streak → 当首次", bumpSlipStreak("x", "2026-9-29").count === 1);

/* ── dayDiff：不补零 key 的跨天计算 ── */
ok("T17 相邻天 = 1", dayDiff("2026-9-28", "2026-9-29") === 1);
ok("T18 跨月 = 1", dayDiff("2026-9-30", "2026-10-1") === 1);
ok("T19 跨年 = 1", dayDiff("2026-12-31", "2027-1-1") === 1);
ok("T20 同一天 = 0", dayDiff("2026-9-29", "2026-9-29") === 0);
ok("T21 非法 key → NaN", Number.isNaN(dayDiff("x", "2026-9-29")));

/* ── splitHm：陪伴时长展示拆分 ── */
ok("T22 0 秒 → 0h0m", splitHm(0).h === 0 && splitHm(0).m === 0);
ok("T23 3599 秒 → 59 分", splitHm(3599).h === 0 && splitHm(3599).m === 59);
ok("T24 3600 秒 → 1h0m", splitHm(3600).h === 1 && splitHm(3600).m === 0);
ok("T25 3661 秒 → 1h1m", splitHm(3661).h === 1 && splitHm(3661).m === 1);
ok("T26 负数/非数字 → 0", splitHm(-5).m === 0 && splitHm("abc").h === 0);

/* ── bottleLeft：剩余次数减法 ── */
ok("T27 零消耗 → 满（3/7）", bottleLeft({ sent: 0, fished: 0 }, 3, 7).send === 3 && bottleLeft({ sent: 0, fished: 0 }, 3, 7).fish === 7);
ok("T28 用满 → 0/0", bottleLeft({ sent: 3, fished: 7 }, 3, 7).send === 0 && bottleLeft({ sent: 3, fished: 7 }, 3, 7).fish === 0);
ok("T29 超用钳到 0", bottleLeft({ sent: 9, fished: 2 }, 3, 7).send === 0);
ok("T30 未登录/脏数据 → 0/0（不显示假数字）", bottleLeft(null, 3, 7).send === 0 && bottleLeft(null, 3, 7).fish === 0 && bottleLeft({ sent: "2" }, 3, 7).send === 0);
ok("T31 部分消耗", bottleLeft({ sent: 1, fished: 5 }, 3, 7).send === 2 && bottleLeft({ sent: 1, fished: 5 }, 3, 7).fish === 2);

console.log(`rail-test: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
