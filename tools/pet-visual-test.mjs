/* 宠物形象与互动表情单测（#11，纯函数层，无需浏览器）
 * 运行：node tools/pet-visual-test.mjs
 * ------------------------------------------------------------
 * 为什么值得测：lottiePet.js 生成的 JSON 直接交给 lottie-web 播放，
 * 形状/关键帧坏了只会「白屏或不动」，错误只发生在运行时 —— 这里钉住：
 *  1. 五物种 × 六变体（idle/sleep + happy/play/clean/eat）都能生成合法 Lottie 文档；
 *  2. 表情随 mood 正确切换（弯弯眼/张嘴/星星/双心/Zzz），idle 与 sleep 不被污染；
 *  3. 贴纸风描边、猫/水獭胡须、柴犬眉毛、曲线尾巴等造型件存在；
 *  4. petMood 信号与缓存/未知物种守卫。
 */
import { petAnimation, hasPreset, LOTTIE_META } from "../src/utils/lottiePet.js";
import { petUi, petMood } from "../src/stores/petStore.js";

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

console.log(`\nTOTAL ${pass + fail}  PASS ${pass}  FAIL ${fail}`);
process.exit(fail ? 1 : 0);