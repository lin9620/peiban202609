/* 宠物形象与互动表情单测（#11，纯函数层，无需浏览器）
 * 运行：node tools/pet-visual-test.mjs
 * ------------------------------------------------------------
 * 为什么值得测：lottiePet.js 生成的 JSON 直接交给 lottie-web 播放，
 * 形状/关键帧坏了只会「白屏或不动」，错误只发生在运行时 —— 这里钉住：
 *  1. 五物种 × 六变体（idle/sleep + happy/play/clean/eat）都能生成合法 Lottie 文档；
 *  2. 表情随 mood 正确切换（弯弯眼/张嘴/星星/双心/Zzz），idle 与 sleep 不被污染；
 *  3. 贴纸风描边、猫/水獭胡须、柴犬眉毛、曲线尾巴等造型件存在；
 *  4. petMood 信号与缓存/未知物种守卫；
 *  5. （轮 261）装扮佩戴锚点：不同物品锚在身体不同位置（帽冠头顶、围巾铃铛脖子、墨镜眼线），
 *     且渲染锚进「宠物框」而非舞台顶部（旧版 dy 从舞台顶起算，饰品全飘在天上）。
 */
import { petAnimation, hasPreset, LOTTIE_META } from "../src/utils/lottiePet.js";
import { petUi, petMood } from "../src/stores/petStore.js";
import { ACCESSORIES } from "../src/data/extras.js";
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => {
  if (c) pass++;
  else { fail++; console.log("FAIL  " + n + (extra ? "  " + extra : "")); }
};
const SPECIES = ["cat", "dog", "rabbit", "dino", "otter"];
const VARIANTS = ["idle", "sleep", "happy", "play", "clean", "eat"];
const namesOf = (d) => d.layers.map((l) => l.nm);
const layerOk = (l) => l.ks && l.ks.o && l.ks.r && l.ks.p && l.ks.s && Array.isArray(l.shapes) && l.shapes.length;
const fillOk = (d) => d.layers.every((l) => l.shapes.every((g) => g.it.every((it) =>
  it.ty !== "fl" || (Array.isArray(it.c.k) && it.c.k.every((x) => x >= 0 && x <= 1)))));

/* 1) 每个物种×变体都是合法 Lottie 文档 */
for (const sp of SPECIES) {
  for (const v of VARIANTS) {
    const d = petAnimation(sp, v);
    ok(`${sp}/${v} 生成`, !!d && Array.isArray(d.layers) && d.layers.length > 0);
    if (!d) continue;
    ok(`${sp}/${v} 文档字段`, d.fr === LOTTIE_META.FPS && d.w === LOTTIE_META.W && d.h === LOTTIE_META.H && d.op === d.layers[0].op);
    ok(`${sp}/${v} 图层形状完整`, d.layers.every(layerOk));
    ok(`${sp}/${v} 填充色合法 RGB(0~1)`, fillOk(d));
  }
}

/* 2) 表情随 mood 切换（五物种一致） */
for (const sp of SPECIES) {
  const idle = petAnimation(sp, "idle");
  const sleep = petAnimation(sp, "sleep");
  const happy = petAnimation(sp, "happy");
  const eat = petAnimation(sp, "eat");
  const clean = petAnimation(sp, "clean");
  const play = petAnimation(sp, "play");
  const n = namesOf(idle);
  ok(`${sp} idle：圆点眼+微笑+一颗心`, n.includes("eyeL") && n.includes("smile") && n.filter((x) => x === "heart").length === 1);
  const ns = namesOf(sleep);
  ok(`${sp} sleep：闭眼+微笑+Zzz+无心`, ns.includes("eyeL") && ns.includes("smile") && ns.includes("zzz6") && !ns.includes("heart"));
  ok(`${sp} sleep：眼睛压成缝（Y=9）`, sleep.layers.find((l) => l.nm === "eyeL").ks.s.k[0].s[1] === 9);
  const nh = namesOf(happy);
  ok(`${sp} happy：弯弯眼+张嘴+双心`, nh.includes("eyeArcL") && nh.includes("mouthO") && nh.filter((x) => x === "heart").length === 2);
  const ne = namesOf(eat);
  ok(`${sp} eat：张嘴+小心心+圆点眼`, ne.includes("mouthO") && ne.includes("eyeL") && ne.filter((x) => x === "heart").length === 1);
  const nc = namesOf(clean);
  ok(`${sp} clean：弯弯眼+星星+保留微笑`, nc.includes("eyeArcL") && nc.includes("sparkle0") && nc.includes("smile"));
  const np = namesOf(play);
  ok(`${sp} play：星星+张嘴`, np.includes("sparkle6") && np.includes("mouthO"));
}

/* 3) 造型件：描边 / 胡须 / 眉毛 / 曲线尾 */
ok("五物种 body 都有描边", SPECIES.every((sp) =>
  petAnimation(sp, "idle").layers.some((l) => l.nm === "body" && l.shapes[0].it.some((it) => it.ty === "st"))));
{
  const whiskers = (sp) => ["wsk1", "wsk2", "wsk3", "wsk4"].every((w) => namesOf(petAnimation(sp, "idle")).includes(w));
  ok("猫与水獭有胡须（各 4 根）", whiskers("cat") && whiskers("otter"));
  ok("柴犬有眉毛", ["browL", "browR"].every((b) => namesOf(petAnimation("dog", "idle")).includes(b)));
  const cat = petAnimation("cat", "idle");
  ok("猫尾是曲线描边 + 奶色尾尖", cat.layers.some((l) => l.nm === "tail" && l.shapes[0].it.some((it) => it.ty === "sh"))
    && namesOf(cat).includes("tailTip"));
}

/* 4) petMood 信号 */
petMood("happy");
ok("petMood 更新 mood 并递增 tick", petUi.mood === "happy" && petUi.moodTick === 1);
petMood("eat");
ok("再次触发递增 tick", petUi.mood === "eat" && petUi.moodTick === 2);

/* 5) 缓存与守卫 */
ok("同参数返回同一份（缓存）", petAnimation("cat", "idle") === petAnimation("cat", "idle"));
ok("未知物种返回 null（自定义立绘走 <img>）", petAnimation("custom", "idle") === null && hasPreset("cat") && !hasPreset("custom"));

/* 6) 轮 261：装扮佩戴锚点 —— 每件饰品锚在身体的正确部位 */
const pct = (s) => parseFloat(s);
const accOf = (k) => ACCESSORIES.find((a) => a.key === k);
ok("每件饰品都有 pos 锚点（top/left 百分比 + size 字号），无 dy 残留",
  ACCESSORIES.length >= 8 && ACCESSORIES.every((a) =>
    a.pos && /^\d+(\.\d+)?%$/.test(a.pos.top) && /^\d+(\.\d+)?%$/.test(a.pos.left)
    && Number.isFinite(a.pos.size) && a.pos.size > 0 && !("dy" in a)));
ok("帽/冠/花/叶/结锚在头顶（top ≤ 30%，画布头顶 ≈30%）",
  ["cap", "crown", "daisy", "leaf", "ribbon"].every((k) => pct(accOf(k).pos.top) <= 30));
ok("墨镜锚在眼线（40%~60%，眼线 ≈52%）",
  pct(accOf("shades").pos.top) >= 40 && pct(accOf("shades").pos.top) <= 60);
ok("围巾/铃铛锚在脖子（top ≥ 60%，脖子 ≈67%）",
  ["scarf", "bell"].every((k) => pct(accOf(k).pos.top) >= 60));
ok("各件锚点互不相同（不再全叠在同一个点上）",
  new Set(ACCESSORIES.map((a) => a.pos.top + "|" + a.pos.left)).size === ACCESSORIES.length);
ok("小蓝帽名实一致（🧢 是蓝色帽子，防「小红帽」这种名实不符复活）",
  accOf("cap").name.zh === "小蓝帽" && accOf("cap").ico === "\u{1F9E2}");
{
  /* 兔子耳朵长在头顶中央、水獭/恐龙没有耳朵 → 侧边饰品必须给这三种备覆盖锚点（否则悬空） */
  const side = ["daisy", "leaf", "ribbon"].map(accOf);
  const EARLESS = ["rabbit", "dino", "otter"];
  ok("侧边饰品给兔子/水獭/恐龙备了覆盖锚点（它们没有猫狗那样的耳位可接）",
    side.every((a) => EARLESS.every((sp) => a.posBy && a.posBy[sp]
      && /^\d+(\.\d+)?%$/.test(a.posBy[sp].top) && /^\d+(\.\d+)?%$/.test(a.posBy[sp].left))));
  ok("覆盖锚点都在头侧带（25%~45%，头顶 30% 与脖子 67% 之间）",
    side.every((a) => EARLESS.every((sp) => pct(a.posBy[sp].top) >= 25 && pct(a.posBy[sp].top) <= 45)));
  ok("覆盖锚点不与默认锚点相同（否则等于没覆盖）",
    side.every((a) => EARLESS.every((sp) => a.posBy[sp].top + "|" + a.posBy[sp].left !== a.pos.top + "|" + a.pos.left)));
}

/* 7) 渲染链路：锚点挂进宠物框（随宠物跳动），不是舞台顶部 */
const petMotionSrc = readFileSync(new URL("../src/components/PetMotion.vue", import.meta.url), "utf8");
const petViewSrc = readFileSync(new URL("../src/views/PetView.vue", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");
ok("PetMotion 有 acc prop，按物种解析锚点（posBy 覆盖 pos）并在宠物框内渲染 .acc-wear",
  /acc:\s*\{\s*type:\s*Object/.test(petMotionSrc) && petMotionSrc.includes('class="acc-wear"')
  && petMotionSrc.includes("posBy") && petMotionSrc.includes("accPos.top") && petMotionSrc.includes("accPos.left")
  && petMotionSrc.includes("position: relative"));
ok("PetView 传 :acc=\"wornAcc\" 给 PetMotion，自己不再渲染舞台级 .acc-wear/旧 dy",
  petViewSrc.includes(':acc="wornAcc"') && !petViewSrc.includes('class="acc-wear"')
  && !petViewSrc.includes("wornAcc.dy"));
{
  const accCss = css.slice(css.indexOf(".acc-wear {"), css.indexOf("@keyframes accBob"));
  ok("acc-wear 样式按锚点居中 translate(-50%,-50%)，不含舞台级 left:50%",
    accCss.includes("position: absolute") && accCss.includes("translate(-50%, -50%)")
    && !accCss.includes("left: 50%"));
  ok("accBob 关键帧同步居中变换（否则 bob 第一帧会跳位）",
    css.slice(css.indexOf("@keyframes accBob")).includes("translate(-50%, -50%)"));
}

console.log(`\nTOTAL ${pass + fail}  PASS ${pass}  FAIL ${fail}`);
process.exit(fail ? 1 : 0);