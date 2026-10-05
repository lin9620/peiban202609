/* 表情面板几何单测（轮 179）
 *   node tools/emoji-sheet-test.mjs
 * ------------------------------------------------------------
 * 用户原话：「消息-会话，先点击输入，再点击表情，还是很长的表情，暖心墙帖子的评论也是这样。
 *            前面没有改好啊。把 app 端所有的表情展开都纳入输入框下面啊。」
 * 坏法很隐蔽：代码里每条单看都对，只有「键盘弹起时开面板 → 键盘收起」这个时序会炸
 * （旧实现 top + bottom:"0"：视口一长回去，bottom 跟着长 → 面板被拉成半屏多，还反过来盖住输入行）。
 * 无头 Edge 取证：tools/_r179-sheet-probe.mjs（一次性，验完即删）——修前 197→507 & coversInput，
 * 修后 208/208 & belowInputRow。这里把那次的结论钉成离线回归。
 */
import fs from "node:fs";
import {
  emojiSheetMode, sheetLayout, keyboardHeight, isEmojiHit, EMOJI_SHEET_H, EMOJI_SHEET_MIN_H,
  MIN_KEYBOARD_H, MAX_KEYBOARD_RATIO, EMO_HIT_SEL,
} from "../src/utils/emojiSheetRules.js";

let pass = 0;
const fails = [];
const ok = (n, c, extra = "") => { c ? pass++ : fails.push(n + (extra ? " —— " + extra : "")); };
const read = (p) => fs.readFileSync(new URL("../" + p, import.meta.url), "utf8");

/* ───────── ① 形态判定：App 一律 sheet；网页同旧口径；桌面零变化 ───────── */
ok("App（原生壳）一律走贴屏底 sheet，与窗口宽度无关", emojiSheetMode({ isApp: true, innerWidth: 1280 }) === true);
ok("网页窄屏（<640）走 sheet（与旧口径一致）", emojiSheetMode({ isApp: false, innerWidth: 393 }) === true);
ok("桌面宽屏仍是按钮上方小弹层（零变化）", emojiSheetMode({ isApp: false, innerWidth: 1280 }) === false);

/* ───────── ② 高度是固定 px：不随视口变（旧实现高度 = 行到屏底那一整段） ───────── */
const tall = sheetLayout({ viewportH: 780, rowBottomNatural: 746, anchored: true });
const kbd = sheetLayout({ viewportH: 470, rowBottomNatural: 436, anchored: true });
ok("面板高度与视口无关：780 与 470 算出来同高，且等于常量",
  tall.height === kbd.height && tall.height === EMOJI_SHEET_H, `${tall.height}/${kbd.height}`);
ok("视口翻倍也不长（不是 34vh 那种比例高度）",
  sheetLayout({ viewportH: 1560, rowBottomNatural: 1490, anchored: true }).height === EMOJI_SHEET_H);
ok("不变式：任何视口下 top + height === 视口底（面板钉死贴底，结构上不可能被拉长）",
  [300, 470, 780, 1200].every((vh) => {
    const L = sheetLayout({ viewportH: vh, rowBottomNatural: vh - 34, anchored: true });
    return L.top + L.height === L.bottom && L.bottom === vh;
  }));

/* ───────── ③ 「先点输入 → 再点表情」时序：键盘占位那刻算一次，收起后重算 ───────── */
{
  const kb = { viewportH: 470, rowBottomNatural: 436, anchored: true };
  const rest = { viewportH: 780, rowBottomNatural: 746, anchored: true };
  const open1 = sheetLayout(kb);
  const open2 = sheetLayout(rest);
  ok("键盘收起重排后面板高度不变（旧实现同一时序 197 → 507）",
    open1.height === open2.height, `${open1.height} → ${open2.height}`);
  ok("键盘收起重排后仍钉在屏底", open2.top + open2.height === 780 && open2.bottom === 780);
  ok("顶开量 = 面板高（贴底行恒被完整顶到面板头上；轮 182 起不再按「行下方现有空间」倒推）",
    open2.shift === EMOJI_SHEET_H, String(open2.shift));
  ok("面板顶 === 输入行被顶开后的底（面板就在输入框下面）",
    rest.viewportH - open2.shift === open2.top,
    `行底 ${rest.viewportH - open2.shift} vs 面板顶 ${open2.top}`);
  ok("行本来就在屏底：顶开量正好等于面板高（行被完整推到面板头上）",
    sheetLayout({ viewportH: 780, rowBottomNatural: 780, anchored: true }).shift === EMOJI_SHEET_H);
  /* 那次 bug 的数字（无头 Edge 取证）：旧规则 top 固定 273 + bottom:"0"，视口回到 780 后
     面板高 507、上缘 273 远高于顶开后的行底 572 → 反过来盖住输入行。 */
  const OLD_TOP = 273, SHIFTED_ROW_BOTTOM = 746 - 174;
  ok("旧写法在视口变高后必然被拉长并盖住输入行（取证值复刻，锁住回归语义）",
    (780 - OLD_TOP) > 300 && OLD_TOP < SHIFTED_ROW_BOTTOM);
}

/* ───────── ④ 页内（不贴底）输入行：不动页面布局，面板挂在它下面 ───────── */
{
  const inline = sheetLayout({ viewportH: 780, rowBottomNatural: 300, anchored: false });
  ok("页内行不被顶开（shift/margin 都是 0，页面布局零变化）", inline.shift === 0 && inline.margin === 0);
  ok("页内行：面板顶 = 行底（展开在输入框下面）", inline.top === 300);
  ok("页内行贴近屏底时面板自动上收、不越出屏幕",
    sheetLayout({ viewportH: 780, rowBottomNatural: 700, anchored: false }).top === 780 - EMOJI_SHEET_H);
}

/* ───────── ⑤ 边界：极矮视口、外部 margin 不丢、脏输入不炸 ───────── */
ok("极矮视口（300/200）仍有保底高度且面板顶不为负",
  [300, 200].every((vh) => {
    const L = sheetLayout({ viewportH: vh, rowBottomNatural: vh, anchored: true });
    return L.height >= EMOJI_SHEET_MIN_H && L.top >= 0;
  }));
ok("外部 margin-bottom 保留（base + shift）",
  sheetLayout({ viewportH: 780, rowBottomNatural: 746, anchored: true, baseMargin: 8 }).margin === 8 + EMOJI_SHEET_H);
ok("脏输入不炸（空对象 → 全是有穷数字）",
  (() => { const L = sheetLayout({}); return Number.isFinite(L.height) && Number.isFinite(L.top) && Number.isFinite(L.margin); })());

/* ───────── ⑥ 组件接线：几何走纯函数、写显式 px、视口变化要重排 ───────── */
{
  const picker = read("src/components/EmojiPicker.vue");
  ok("几何算在 emojiSheetRules（纯函数层，可测）",
    picker.includes('from "../utils/emojiSheetRules.js"')
    && picker.includes("sheetLayout(") && picker.includes("emojiSheetMode("));
  ok("面板写显式 height + top，且**绝不写 bottom:\"0\"**（旧 bug 的原话写法必须绝迹）",
    picker.includes('height: Math.round(L.height) + "px"')
    && picker.includes('bottom: "auto"') && !picker.includes('bottom: "0"'));
  ok("键盘弹起/收起会重排（window.resize + visualViewport.resize）",
    picker.includes('window[fn]("resize", onViewportChange)') && picker.includes("window.visualViewport[fn]"));
  ok("打开后补排两次（个别内核收键盘不发 resize 的安全网）", picker.includes("settleTimers = [80, 260]"));
  ok("重排用「未被顶开」的坐标（+ appliedShift），多次重排不会越算越挤",
    picker.includes("getBoundingClientRect().bottom + appliedShift") && picker.includes("appliedShift = L.shift"));
  ok("贴底行判定：只有 .dm-compose / .cmt-main-bar 里的行才被顶开",
    picker.includes('closest(".dm-compose, .cmt-main-bar")'));
  ok("面板带 .emo-sheet 类（CSS 与 JS 同源，不再靠媒体查询各写一套）",
    picker.includes("'emo-sheet': sheetOn"));
  ok("样式块里有 .emo-panel.emo-sheet（贴屏底圆角 + 放开 max-height）",
    picker.includes(".emo-panel.emo-sheet") && picker.includes("max-height: none;"));
  ok("收起/卸载清干净（margin 复位 + 摘监听 + 停补排）",
    picker.includes('rowEl.style.marginBottom = ""')
    && picker.includes("listenViewport(false)") && picker.includes("clearSettle()"));
  const rCount = (picker.match(/const r = root\.value\.getBoundingClientRect\(\);/g) || []).length;
  ok("桌面分支自己量按钮 rect（旧实现复用手机分支块内 const r → 桌面点表情 ReferenceError、面板打不开）",
    rCount === 1);
  const css = read("src/style.css");
  ok("全局样式表里没有「手机面板」的第二套高度真相（旧 @media(max-width:640px) .emo-panel{max-height:none} 已撤）",
    css.includes(".emo-panel::-webkit-scrollbar") && !/@media \(max-width: 640px\) \{\s*\.emo-panel \{/.test(css));
}

/* ───────── ⑦ 轮 182：面板高度 == 键盘高度（用户：「表情包高度跟输入法输入框高度不一致」） ───────── */
{
  /* 键盘高实测：键盘弹着时视口矮，收起时高，差值就是键盘真高 */
  ok("实测键盘高：视口 780 → 470（键盘 310）",
    keyboardHeight({ innerH: 470, restH: 780 }) === 780 - 470);
  ok("没有键盘（视口未变）→ 0，回落默认高度",
    keyboardHeight({ innerH: 780, restH: 780 }) === 0);
  ok("视口小抖动（<120px）不算键盘",
    keyboardHeight({ innerH: 780 - (MIN_KEYBOARD_H - 1), restH: 780 }) === 0);
  ok("视口整体剧变（>55%，折叠屏/分屏/旋屏）不当成键盘",
    keyboardHeight({ innerH: 780 * 0.2, restH: 780 }) === 0);
  ok("脏输入不炸（undefined / NaN → 0）",
    keyboardHeight({}) === 0 && keyboardHeight({ innerH: NaN, restH: 780 }) === 0);
  ok("刚过下限的键盘能测出",
    keyboardHeight({ innerH: 780 - MIN_KEYBOARD_H, restH: 780 }) === MIN_KEYBOARD_H);

  /* 面板高度取实测键盘高 —— 与键盘同高互换 */
  const KB = 310, REST = 780;
  const openKb = sheetLayout({ viewportH: REST - KB, rowBottomNatural: REST - KB, anchored: true, sheetH: KB, restH: REST });
  const afterKb = sheetLayout({ viewportH: REST, rowBottomNatural: REST, anchored: true, sheetH: KB, restH: REST });
  ok("面板高度 == 实测键盘高（不再是写死的 208）",
    openKb.height === KB && afterKb.height === KB, `${openKb.height}/${afterKb.height}`);
  ok("面板高度不随视口被键盘压矮而变（锁死的同一高度）", openKb.height === afterKb.height);
  /* 轮 184 更正：面板钉在**当前布局视口**底（adjustResize 下视觉底==布局底），不是 restH。
   * 键盘弹着时视口 470 → 面板顶 160（470-310），绝不能是 470（那会把面板画到屏幕外）。 */
  ok("键盘弹着时面板落在当前（已压矮）视口内，绝不画到屏幕外",
    openKb.top === REST - KB - KB && openKb.top + openKb.height === REST - KB,
    `${openKb.top}..${openKb.top + openKb.height} vs 视口底 ${REST - KB}`);
  ok("键盘收起后面板落回真实屏底",
    afterKb.top === REST - KB && afterKb.bottom === REST);
  /* 关键手感（两态各自成立）：输入行底恒等于面板顶 —— 面板永远紧贴输入框下方 */
  ok("输入行底恒等于面板顶（键盘弹/收两态都严丝合缝）",
    (REST - KB) - openKb.shift === openKb.top && REST - afterKb.shift === afterKb.top,
    `open ${(REST - KB) - openKb.shift}/${openKb.top} · after ${REST - afterKb.shift}/${afterKb.top}`);
  ok("两态的面板高度一致（同高互换），落点各随视口（都在可见区内）",
    openKb.height === afterKb.height
      && openKb.top !== afterKb.top
      && openKb.top >= 0 && afterKb.top >= 0);
  ok("顶开量恰好等于面板高（把输入行完整顶到面板头上）",
    openKb.shift === KB && afterKb.shift === KB, `${openKb.shift}/${afterKb.shift}`);
  ok("面板底 == 当前布局视口底（adjustResize：视觉底就是布局底）",
    openKb.bottom === REST - KB && afterKb.bottom === REST);
  /* 回归锁：把 restH 改回定位基准（轮 183 那个真 bug），这两条立刻会失败 */
  ok("restH 不参与面板定位（只夹高度上限）—— 防「面板掉到屏幕外」复发",
    openKb.bottom === REST - KB && sheetLayout({ viewportH: REST - KB, rowBottomNatural: REST - KB, anchored: true, sheetH: KB, restH: REST + 500 }).bottom === REST - KB);
  ok("任意视口下：面板底==视口底 且 顶开量==面板高",
    [0, 120, 310, 400].every((kb) => {
      const L = sheetLayout({ viewportH: REST - kb, rowBottomNatural: REST - kb, anchored: true, sheetH: KB, restH: REST });
      return L.shift === L.height && L.top === (REST - kb) - L.height && L.bottom === REST - kb && L.top >= 0;
    }));
  /* 页内（不贴底）输入行仍按实测坐标挂在其下，且不被顶开 */
  const inline2 = sheetLayout({ viewportH: REST, rowBottomNatural: 300, anchored: false, sheetH: KB, restH: REST });
  ok("页内行仍不顶开、面板仍挂在它下面（贴底改造没波及页内行）",
    inline2.shift === 0 && inline2.margin === 0 && inline2.top === 300 && inline2.height === KB);

  /* 不传 sheetH 时保持旧行为（兜底默认高度，桌面/无键盘场景零变化） */
  ok("不传 sheetH → 回落默认高度（老行为不变）",
    sheetLayout({ viewportH: REST, rowBottomNatural: REST, anchored: true, restH: REST }).height === EMOJI_SHEET_H);
  /* 面板不能高到把输入行挤没：至少留 132 给上方内容 */
  const huge = sheetLayout({ viewportH: REST, rowBottomNatural: REST, anchored: true, sheetH: REST - 10, restH: REST });
  ok("键盘异常高（撑满屏）时收进视口，不至于把输入行挤没",
    huge.height <= REST - 132 && huge.height >= EMOJI_SHEET_MIN_H, String(huge.height));

  /* ───────── ⑧ 轮 182：表情按钮是切换键，收起时把焦点还给输入框 ───────── */
  const picker2 = read("src/components/EmojiPicker.vue");
  ok("表情按钮 mousedown.prevent（格子已随 emoji-picker-element 移除，轮 188）",
    (picker2.match(/@mousedown\.prevent/g) || []).length === 1
    && /class="emo-btn"[\s\S]{0,200}@mousedown\.prevent/.test(picker2)
    && !picker2.includes("class=\"emo-cell\""));
  /* 轮 198：自研光标体系（trackCaret/caretMem/applyCaret/三重定时器）整体退役，换原生
   * setRangeText。真机实锤两类脏数据：①失焦元素实时选区（输入法选词/旧值残留）当插入位置
   * →「前面输入全删了只剩一个表情」；②失焦期间 selectionchange 喂 caretMem → v-model 清零
   * 被记成当前位置 →「表情跳到第一个前面」。新体系：唯一读点=openSheet 焦点内一次；
   * 插入=setRangeText 范围夹紧；恢复=focus+setSelectionRange 夹紧，无监听器无定时器。 */
  /* 轮 198 回归锁（去注释后判定——文档注释里允许提旧名说明史） */
  const pickerCode = picker2.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  ok("旧光标体系删干净（trackCaret/caretMem/applyCaret/rememberCaret 不得残留）",
    !pickerCode.includes("trackCaret") && !pickerCode.includes("caretMem")
    && !pickerCode.includes("applyCaret") && !pickerCode.includes("rememberCaret")
    && !pickerCode.includes("untrackCaret"));
  ok("插入走原生 setRangeText（范围替换+浏览器落光标）+ 手动补 input 事件同步 v-model（轮 200：不补 = 重渲染表情消失）",
    picker2.includes("el.setRangeText(uni, lo, hi, \"end\")")
    && /setRangeText[\s\S]{0,400}dispatchEvent\(new Event\("input", \{ bubbles: true \}\)\)/.test(picker2));
  ok("插入范围两端夹紧到当前长度（脏选区删不掉内容）",
    /lo = Math\.max\(0, Math\.min\(lo, len\)\)/.test(picker2)
    && /hi = Math\.max\(lo, Math\.min\(hi, len\)\)/.test(picker2));
  ok("失焦时不用实时选区，用 caretAt（打开面板那一次记录）",
    /document\.activeElement === el [\s\S]{0,80}selectionStart[\s\S]{0,120}else[\s\S]{0,60}caretAt/.test(picker2));
  ok("唯一读光标点：openSheet 内、收键盘之前（输入框尚在焦点；轮 199 起 App 收键盘走 Keyboard.hide 不 blur）",
    /const ie = inputEl\(\);[\s\S]{0,240}caretAt = ie\.selectionStart;[\s\S]{0,700}(?:\.blur\(\)|kb\(\)\.hide\(\))/.test(picker2));
  ok("连选递推：插入后 caretAt 推进到插入之后（下一枚跟上一枚）",
    picker2.includes("caretAt = typeof el.selectionStart === \"number\" ? el.selectionStart : lo + uni.length;"));
  ok("面板高度=OS 上报的真实键盘高优先（轮 200：估算值只做回退）",
    picker2.includes("const osH = lastKbH > 0 && lastKbH < restH * 0.7 ? lastKbH : 0;")
    && picker2.includes("sheetH = osH || keyboardHeight({ innerH: window.innerHeight, restH }) || 0;")
    && pickerCode.includes("keyboardDidShow") && pickerCode.includes("keyboardWillHide"));
  ok("轮 200 定案：App 路径 focusin 永不收面板（假 focusin 不再误杀，让位只归 keyboardWillShow）",
    /if \(!sheetMode\(\)\) return;[\s\S]{0,200}if \(kb\(\)\) return;/.test(pickerCode));
  ok("面板定位传当前视口+实测高度（restH 只作高度上限传参）",
    picker2.includes("sheetH,") && picker2.includes("restH,"));
  ok("restH 只增不减（仅作高度上限的基准）",
    picker2.includes("if (h > restH) restH = h;"));
  ok("恢复光标夹紧到当前长度（旧值/短文本不越界）",
    /Math\.min\(caretAt, el\.value\.length\)/.test(picker2));
  ok("轮 199：App 内收键盘不 blur 输入框（Keyboard.hide——抄原生 App，光标钉在原地）",
    pickerCode.includes("kb().hide()") && pickerCode.includes("kb().show()")
    && /keyboardWillShow[\s\S]{0,120}closeSheet\(false\)/.test(picker2));
  ok("收起面板有统一入口 closeSheet(restoreFocus)", picker2.includes("function closeSheet(restoreFocus)"));
  ok("再点表情按钮 → 收起并把焦点还给输入框（用户不必重新点输入框）",
    picker2.includes("if (open.value) { closeSheet(true); return; }")
    && picker2.includes("el.focus({ preventScroll: true })"));
  ok("还焦点前先把 margin 复位（closeSheet 里先 clearRowShift 再还焦点）",
    /function closeSheet\(restoreFocus\)[\s\S]*?clearRowShift\(\);[\s\S]*?el\.focus\(\{ preventScroll: true \}\)/.test(picker2));
  ok("面板开着时点回输入框要打字 → 收起面板让位给键盘（focusin 兜底）",
    picker2.includes('document.addEventListener("focusin", onFocusIn, true)')
    && picker2.includes("removeEventListener(\"focusin\", onFocusIn, true)")
    && /function onFocusIn\(e\)[\s\S]*?closeSheet\(false\)/.test(picker2));
  ok("点面板外收起不还焦点（不抢用户焦点）",
    /function onDoc\(e\)[\s\S]*?closeSheet\(false\)/.test(picker2));
  ok("挂载时先记一次收起态视口（restH 有初值）",
    /onMounted\(\(\) => \{\s*rememberRest\(\);/.test(picker2));
  ok("插入表情与还焦点共用同一个取输入框函数（不再各写一份querySelector）",
    picker2.includes("function inputEl()")
    && (picker2.match(/= inputEl\(\)/g) || []).length >= 3);
/* ───────── ⑨ 轮 184：点表情不许收起评论条（真机 CDP 实测「点表情 → 输入框消失」） ───────── */
{
  /* 判定只认**静态类名**，不认「面板此刻在不在 DOM」——
   * 面板是 v-if + 微任务渲染，click 冒泡那一刻必然还查不到。 */
  /* 仿 closest：任一选择器命中即返回自身（与浏览器一致） */
  const mk = (classes) => ({ closest: (sel) => (sel.split(", ").some((s) => classes.includes(s)) ? {} : null) });
  ok("表情按钮命中", isEmojiHit(mk([".emo-btn", ".emo-root"])));
  ok("面板内格子命中（面板 teleport 到 body，不在评论条内）", isEmojiHit(mk([".emo-panel"])));
  ok("面板里更深层的子元素也命中",
    isEmojiHit(mk([".emo-panel", ".emo-grid", ".emo-cell", "svg"])));
  ok("评论条其它地方（输入框/发送键）不命中", !isEmojiHit(mk([".cmt-main-bar", "textarea"])));
  ok("页面空白处不命中", !isEmojiHit(mk(["div", ".feed"])));
  ok("脏目标不炸（null / undefined / 无 closest 一律 false）",
    !isEmojiHit(null) && !isEmojiHit(undefined) && !isEmojiHit({}));
  ok("closest 抛异常也不炸", !isEmojiHit({ closest() { throw new Error("x"); } }));
  ok("选择器同时覆盖按钮与面板两处标记",
    EMO_HIT_SEL.includes(".emo-btn") && EMO_HIT_SEL.includes(".emo-panel") && EMO_HIT_SEL.includes(".emo-root"));

  /* 回归锁：绝不能再出现「同一击里现查 .emo-panel」的写法——那是本bug 的唯一真因。
   * 注释里可以提这句话（说明真因用），所以只看真正的代码行。 */
  const codeOf = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, "")     /* 块注释 */
    .replace(/^[ \t]*\/\/.*$/gm, "");     /* 行注释 */
  const views = ["src/views/CommunityView.vue", "src/views/PostDetailView.vue"];
  for (const v of views) {
    const s = codeOf(read(v));
    const nm = v.split("/").pop();
    ok(`${nm}：代码里不再用 querySelector('.emo-panel') 当收起保险`,
      !/querySelector\(\s*["'`](\.emo-panel|["'`]\.emo-panel)/.test(s));
    ok(`${nm}：点外收起改走 isEmojiHit() 静态标记`, s.includes("isEmojiHit(tgt)"));
    ok(`${nm}：已 import isEmojiHit`, /import \{ isEmojiHit \} from/.test(s));
    ok(`${nm}：没有残留的 mainBarDocClose2 补丁层`,
      !s.includes("mainBarDocClose2") && !s.includes("EMO_HIT ="));
  }
}
  ok("桌面零变化：小弹层分支仍在（连选=caretAt 随每次插入推进，轮 198）",
    picker2.includes("const bottom = Math.max(8, window.innerHeight - r.top + 8) + \"px\";")
    && picker2.includes("el.setRangeText(uni, lo, hi, \"end\")"));
  ok("贴底行几何不依赖实测坐标（键盘收那一帧不会把顶开量算两遍）",
    /const rowBottomRest = anchored \? rest : rowB;/.test(read("src/utils/emojiSheetRules.js")));
}

console.log(`emoji-sheet-test: ${pass} pass, ${fails.length} fail`);
for (const f of fails) console.log("FAIL  " + f);
if (fails.length) process.exit(1);
