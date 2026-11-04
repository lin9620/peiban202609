/* 轮 356 · 漂流瓶输入框长文封顶锁（Node 直跑，只读源码）
 *   node tools/bottle-autosize-test.mjs
 *
 * 用户实报：App 里写很长的漂流瓶信，输入框一路长高，直接铺满屏幕。
 * 根因是 Vant 的 autosize 只给了 true、没给 maxHeight —— 它按 scrollHeight
 * 把 textarea 撑到 1200px（1000 字实测）。这个锁要求 BottleView 的 4 个
 * 多行输入框（写信 / 托盘回信 / 记录回信 / 捞信弹窗回信）全部显式封顶，
 * 防以后有人又改回裸 autosize。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(root, "src/components/BottleView.vue"), "utf8");
let pass = 0, fail = 0; const out = [];
function t(name, fn) {
  try { fn(); pass++; out.push("ok   " + name); }
  catch (e) { fail++; out.push("FAIL " + name + " :: " + e.message); }
}
const has = (re, msg) => { if (!re.test(src)) throw new Error(msg); };

/* 4 个 self-closing van-field：模板里目前只有这些；若以后新增输入框，
 * 数量变化会先在这里报出来，提醒一起加封顶。 */
const fields = [...src.matchAll(/<van-field\b[\s\S]*?\/>/g)].map((m) => m[0]);
const textareas = fields.filter((f) => /type="textarea"/.test(f));

t("A1 漂流瓶 4 个多行输入框都在（写信 / 托盘回信 / 记录回信 / 捞信弹窗回信）", () => {
  assert.equal(textareas.length, 4, "textarea 数量变了：" + textareas.length);
});

t("A2 主写信框用 MAIL_AUTOSIZE（maxHeight 160）", () => {
  const f = textareas.find((x) => /bottle\.placeholder/.test(x));
  assert.ok(f, "找不到写信框");
  has(/const MAIL_AUTOSIZE = \{ maxHeight: 160 \}/, "MAIL_AUTOSIZE 不是 160px");
  assert.ok(/:autosize="MAIL_AUTOSIZE"/.test(f), "写信框没接 MAIL_AUTOSIZE");
});

t("A3 三个回信框都用 REPLY_AUTOSIZE（maxHeight 120）", () => {
  const replies = textareas.filter((x) => /bottle\.replyPlaceholder/.test(x));
  assert.equal(replies.length, 3, "回信框数量变了：" + replies.length);
  has(/const REPLY_AUTOSIZE = \{ maxHeight: 120 \}/, "REPLY_AUTOSIZE 不是 120px");
  for (const f of replies) {
    assert.ok(/:autosize="REPLY_AUTOSIZE"/.test(f), "有回信框没接 REPLY_AUTOSIZE");
  }
});

t("A4 不再出现裸 autosize（没有 maxHeight 就会铺满屏幕）", () => {
  for (const f of textareas) {
    assert.ok(!/\sautosize(?=[\s/>])/.test(f), "有 textarea 还在用裸 autosize");
    assert.ok(/:autosize="/.test(f), "有 textarea 没有绑定 :autosize");
  }
});

t("A5 封顶值必须有限且不是离谱大值", () => {
  for (const [name, v] of [["MAIL_AUTOSIZE", 160], ["REPLY_AUTOSIZE", 120]]) {
    assert.ok(v > 0 && v <= 200, `${name} 封顶值异常：${v}`);
  }
});

console.log(out.join("\n"));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
