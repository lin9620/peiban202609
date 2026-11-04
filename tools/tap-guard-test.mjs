/* 连点闸门回归（用户拍板 A）
 *   node tools/tap-guard-test.mjs
 *
 * 口径：同一颗按钮 350ms 内的第二下 = 误触，直接丢弃；
 *       不改 UI、不进写队列、不发第二次请求；不同按钮互不影响。
 *
 * 覆盖：纯逻辑行为 + 四个实际接入点（暖心墙 / 帖子详情 / 故事详情 / 私信）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createTapGuard } from "../src/utils/tapGuard.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

let pass = 0, fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log("PASS ", name); }
  else { fail++; console.log("FAIL ", name); }
};

console.log("── A. 纯逻辑：首击放行，350ms 内第二下丢弃 ──");
{
  const g = createTapGuard(350);
  ok("A1 第一次点击放行", g.accept("post:7:warm", 1000) === true);
  ok("A2 同一按钮 120ms 后的第二下被丢弃", g.accept("post:7:warm", 1120) === false);
  ok("A3 同一按钮 349ms 时仍被丢弃", g.accept("post:7:warm", 1349) === false);
  ok("A4 到 350ms 边界恢复可点", g.accept("post:7:warm", 1350) === true);
}
{
  const g = createTapGuard(350);
  ok("A5 不同回应 kind 互不阻塞（抱抱先点，暖暖仍可点）",
    g.accept("post:7:hug", 1000) === true && g.accept("post:7:warm", 1001) === true);
}
{
  const g = createTapGuard(350);
  ok("A6 不同对象互不阻塞（两条帖子各点各的）",
    g.accept("post:7:hug", 1000) === true && g.accept("post:8:hug", 1002) === true);
}
{
  const g = createTapGuard(350);
  let requests = 0;
  const click = (key, now) => {
    if (!g.accept(key, now)) return;
    requests++;   /* 真实视图里这里才是乐观翻转 + claim + push */
  };
  click("post:7:warm", 0);
  click("post:7:warm", 120);
  ok("A7 双击只产生一次写入意图", requests === 1);
  click("post:7:warm", 400);
  ok("A8 超过窗口后的下一次点击照常生效", requests === 2);
}
{
  const g = createTapGuard(350);
  g.accept("post:7:warm", 1000);
  g.reset("post:7:warm");
  ok("A9 reset 后可以立刻重试（失败重试用）", g.accept("post:7:warm", 1001) === true);
}

console.log("");
console.log("── B. 实际接入点：五处视图都必须用同一把闸门 ──");
const views = [
  ["src/views/CommunityView.vue", "暖心墙（帖级 + 评论 + 厌恶 + 收藏）"],
  ["src/views/PostDetailView.vue", "帖子详情（帖级 + 评论 + 厌恶 + 收藏）"],
  ["src/views/StoryDetailView.vue", "故事详情（点赞 + 收藏）"],
  ["src/views/MessagesView.vue", "私信（免打扰 + 拉黑）"],
  ["src/views/SettingsView.vue", "设置（通知总开关 + 分项）"],
];
for (const [file, label] of views) {
  const s = read(file);
  ok(`B ${label}：import createTapGuard`, s.includes('from "../utils/tapGuard.js"'));
  ok(`B ${label}：创建 350ms 闸门`, /createTapGuard\(350\)/.test(s));
  ok(`B ${label}：至少一处 accept 拦截`, /tapGuard\.accept\(/.test(s));
}

console.log("");
console.log("── C. 具体 key 不退回整帖/整评论锁 ──");
{
  const community = read("src/views/CommunityView.vue");
  const detail = read("src/views/PostDetailView.vue");
  const story = read("src/views/StoryDetailView.vue");
  const messages = read("src/views/MessagesView.vue");
  const settings = read("src/views/SettingsView.vue");
  ok("C1 暖心墙帖级 key 带 post + kind",
    /const gateKey = `post:\$\{post\.dbId != null \? post\.dbId : post\.id\}:\$\{kind\}`/.test(community)
    && /tapGuard\.accept\(gateKey\)/.test(community));
  ok("C2 暖心墙评论 key 带 cmt + dbId + kind",
    /tapGuard\.accept\(`cmt:\$\{cm\.dbId\}:\$\{kind\}`\)/.test(community));
  ok("C3 详情页帖级/评论 key 同样带 kind",
    /tapGuard\.accept\(`post:\$\{p\.dbId\}:\$\{k\}`\)/.test(detail)
    && /tapGuard\.accept\(`cmt:\$\{cm\.dbId\}:\$\{kind\}`\)/.test(detail));
  ok("C4 故事点赞/收藏按 story:id:key 分键",
    /tapGuard\.accept\(qKey\)/.test(story) && /const qKey = `story:\$\{id\}:\$\{key\}`/.test(story));
  ok("C5 私信免打扰/拉黑按会话/用户分键",
    /tapGuard\.accept\(`mute:\$\{c\.conv_id\}`\)/.test(messages)
    && /tapGuard\.accept\(`block:\$\{c\.conv_id\}`\)/.test(messages));
  ok("C6 设置通知总开关/分项各自分键",
    /tapGuard\.accept\("settings:notify:master"\)/.test(settings)
    && /tapGuard\.accept\(`settings:notify:\$\{key\}`\)/.test(settings));
}

console.log("");
console.log(`TOTAL ${pass + fail}  PASS ${pass}  FAIL ${fail}`);
process.exit(fail ? 1 : 0);
