/* 内容语言偏好：排序即补位（轮 439）
 *   node tools/content-lang-test.mjs
 *
 * 这个文件的重点不是「能不能过滤」，而是**排序必须天然补位**：
 * 库里 99% 是中文，一旦做成过滤，西语用户打开就是白屏。所以断言集中在
 * 「本语言在前、其余在后、一条都不许少」。
 */
import { messages } from "../src/i18n.js";
import { i18n } from "../src/i18n.js";
import {
  contentPref, setPrefMode, preferredLang, uiLang,
  langRank, sortByLang, langBadge, langName, detectContentLang,
} from "../src/utils/contentLang.js";
import { appendPage } from "../src/utils/storyRules.js";

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => {
  if (c) { pass++; console.log("PASS  " + n + (extra ? "  " + extra : "")); }
  else { fail++; console.log("FAIL  " + n + (extra ? "  " + extra : "")); }
};
const setLocale = (l) => { i18n.locale = l; };
const seq = (list, langOf) => sortByLang(list, langOf).map(langOf).join(",");

/* ── ① all 模式：一点都不能动 ── */
setLocale("es");
setPrefMode("all");
{
  const list = [{ l: "zh" }, { l: "es" }, { l: "und" }, { l: "en" }];
  ok("A1 all 模式下原样返回（同一个数组引用）", sortByLang(list, (x) => x.l) === list);
  ok("A2 all 模式下不发角标", langBadge("zh") === "" && langBadge("en") === "");
  ok("A3 all 模式下 preferredLang 为 null", preferredLang() === null);
}

/* ── ② prefer 模式：本语言前置，其余接在后面，一条不少 ── */
setPrefMode("prefer");
{
  const list = [{ l: "zh" }, { l: "en" }, { l: "es" }, { l: "fr" }, { l: "und" }];
  ok("B1 西语界面：es 在首位", seq(list, (x) => x.l) === "es,zh,en,fr,und", seq(list, (x) => x.l));
  ok("B2 排序不丢任何一条（补位而非过滤）", sortByLang(list, (x) => x.l).length === list.length);

  setLocale("zh");
  /* 非本语言之间是权重相同 → 保持原序（en 在 es 前，别指望它按字母排） */
  ok("C1 中文界面：zh 在首位", seq(list, (x) => x.l) === "zh,en,es,fr,und", seq(list, (x) => x.l));

  setLocale("en");
  ok("C2 英文界面：en 在首位", seq(list, (x) => x.l) === "en,zh,es,fr,und", seq(list, (x) => x.l));
}

/* ── ③ 权重：本语言 0 / 其他 1 / 判不出 2 ── */
setLocale("es");
setPrefMode("prefer");
ok("D1 本语言权重 0", langRank("es") === 0);
ok("D2 其他语言权重 1", langRank("zh") === 1 && langRank("en") === 1);
ok("D3 und 权重 2（排最后）", langRank("und") === 2);
ok("D4 缺字段（老库无 lang 列）也当 und", langRank(undefined) === 2 && langRank(null) === 2);

/* ── ④ 稳定性：同权重内部保持原有相对顺序（分页/时间序不能被排序打乱） ── */
{
  const list = [
    { id: 1, l: "zh", t: 100 }, { id: 2, l: "und", t: 99 }, { id: 3, l: "zh", t: 98 },
    { id: 4, l: "es", t: 97 }, { id: 5, l: "en", t: 96 }, { id: 6, l: "es", t: 95 },
  ];
  const out = sortByLang(list, (x) => x.l).map((x) => x.id).join(",");
  ok("E1 同权重保持原序（es 内部 4 在 6 前，zh 内部 1 在 3 前）", out === "4,6,1,3,5,2", out);
}

/* ── ⑤ 角标：只标「非本语言」且「语言已知」 ── */
setLocale("es");
ok("F1 非本语言显示大写角标", langBadge("zh") === "ZH" && langBadge("en") === "EN");
ok("F2 本语言不标", langBadge("es") === "");
ok("F3 判不出不标", langBadge("und") === "" && langBadge(undefined) === "");
ok("F4 ja/ko 也能标（检测器认得，只是产品没开界面）", langBadge("ja") === "JA");

/* ── ⑥ 界面语言脏值归一 ── */
setLocale("es-419");
ok("G1 es-419 归一到 es", uiLang() === "es" && preferredLang() === "es");
setLocale("zh-CN");
ok("G2 zh-CN 归一到 zh", uiLang() === "zh" && preferredLang() === "zh");

/* ── ⑦ 界面语言没有对应内容语言时，不乱排也不乱标 ── */
setLocale("de-DE");
{
  const list = [{ l: "zh" }, { l: "en" }];
  ok("H1 de 界面：preferredLang 为 null", preferredLang() === null);
  ok("H2 de 界面：不重排", seq(list, (x) => x.l) === "zh,en", seq(list, (x) => x.l));
  ok("H3 de 界面：不打角标", langBadge("zh") === "");
}

/* ── ⑧ 落地检测入口与检测器一致 ── */
ok("I1 中文帖标 zh", detectContentLang("今天有点累，但看到他笑了就好了") === "zh");
ok("I2 英文帖标 en", detectContentLang("I miss my cat so much tonight") === "en");
ok("I3 西语帖标 es", detectContentLang("quiero mucho a mi perro") === "es");
ok("I4 空正文（纯图片帖）标 und", detectContentLang("") === "und");

/* ── ⑨ 各语言文案齐备（开关文案不能是裸 key） ── */
for (const l of ["en", "zh", "es", "pt", "fr"]) {
  const p = messages[l].settings || {};
  ok(`J ${l} 偏好开关文案齐备`, !!p.preferLang && !!p.preferLangHint, `${p.preferLang} | ${p.preferLangHint}`);
}
for (const l of ["en", "zh", "es", "pt", "fr"]) {
  ok(`K ${l} 漂流瓶跨语言提示文案`, !!messages[l].bottle?.otherLang, messages[l].bottle?.otherLang);
}

/* ── ⑩ 语言名的本地化写法（用在「这封信是 X 写的」这种句子里） ── */
setLocale("zh");
ok("L1 zh 下 langName(en) 是中文名", langName("en") === "英语", langName("en"));
setLocale("fr");
ok("L2 fr 下 langName(pt) 用法语名", langName("pt") === "portugais", langName("pt"));
setLocale("pt");
ok("L3 pt 下 langName(zh) 用葡语名", langName("zh") === "chinês", langName("zh"));
setLocale("es");
ok("L4 es 下 langName(fr) 用西语名", langName("fr") === "francés", langName("fr"));
ok("L5 词典里没有的语言退回大写代码", langName("is") === "IS", langName("is"));
ok("L6 und 与空值返回空串（不显示提示）", langName("und") === "" && langName("") === "");

/* ── ⑪ 翻页合并：页内排序、页与页之间只追加（轮 458 用户实测回归） ──
 * 现场：库里 14 篇 = 首页 12 条（6 英 6 中）+ 第二页 2 条中文。
 * 旧写法在 computed 里对**累加后的整表**重排 → 第二页那 2 篇中文被提到首页 6 篇英文之上，
 * 用户看到的就是「加载更多不是出现在最下面」。这里钉死新口径。 */
setLocale("zh");
setPrefMode("prefer");
{
  const byLang = (list) => sortByLang(list, (x) => x.lang);
  const page1 = [
    ...Array.from({ length: 6 }, (_, i) => ({ id: i + 1, lang: "en" })),      /* 服务端 latest：新的在前 */
    ...Array.from({ length: 6 }, (_, i) => ({ id: i + 7, lang: "zh" })),
  ];
  const page2 = [{ id: 13, lang: "zh" }, { id: 14, lang: "zh" }];

  const after1 = appendPage([], page1, byLang);
  const after2 = appendPage(after1, page2, byLang);

  ok("M1 第一页内部：本语言（zh）排在前面",
    after1.slice(0, 6).every((x) => x.lang === "zh") && after1.slice(6).every((x) => x.lang === "en"),
    after1.map((x) => x.id).join(","));
  ok("M2 加载更多不动已有 12 条的位置（下标逐条相同）",
    after1.every((x, i) => after2[i] && after2[i].id === x.id),
    after2.map((x) => x.id).join(","));
  ok("M3 第二页整页接在最下面（13、14 是最后两条）",
    after2.slice(-2).map((x) => x.id).join(",") === "13,14",
    after2.map((x) => x.id).join(","));
  ok("M4 翻页不丢不重（14 条、id 唯一）",
    after2.length === 14 && new Set(after2.map((x) => x.id)).size === 14);
  /* 反例守卫：整表重排会把 13/14 插到 6 篇英文前面 —— 这条就是那个 bug 的形状 */
  const wholeTableSorted = byLang(after2).map((x) => x.id).join(",");
  ok("M5 回归形状自检：整表重排确实会把新页提到中间（说明 M3 不是永远成立的空断言）",
    wholeTableSorted !== after2.map((x) => x.id).join(",") && wholeTableSorted.indexOf("13,14") < wholeTableSorted.indexOf("1,2"),
    wholeTableSorted);

  setPrefMode("all");
  ok("M6 关掉开关后不排序，页序原样拼接",
    appendPage([], page1, byLang).map((x) => x.id).join(",") === page1.map((x) => x.id).join(","));
  setPrefMode("prefer");
  ok("M7 脏参数不炸（null / 非数组 / 无 sortFn）",
    appendPage(null, null, null).length === 0
    && appendPage([{ id: 1, lang: "zh" }], "oops", byLang).length === 1);
  ok("M8 不改入参数组（纯函数，不就地 sort 调用方的页数据）",
    page1[0].id === 1 && page1[0].lang === "en" && page2[0].id === 13);
}

/* ── 收尾：把模式恢复成默认，免得后续跑别的测试时被这份状态影响 ── */
setPrefMode("all");
setLocale("zh");

console.log(`\nTOTAL ${pass + fail}  PASS ${pass}  FAIL ${fail}`);
if (fail > 0) process.exitCode = 1;
