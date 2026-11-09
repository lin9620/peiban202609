/* ═══ 轮 478 · 表情数据预热 ═══
 * 用户：「现在点击表情，加载出来的很慢，显得很卡顿」。
 *
 * 实测（无头 Edge + 线上产物，393×852）：
 *   · 首次点开（库的 IndexedDB 还是空的）→ 面板空白 500~800ms；
 *     时间全花在 emoji-picker-element 自己的初始化上：
 *       下载 /emoji/data.json（430KB，br 后约 75KB）→ JSON.parse → 写 1923 条进 IndexedDB。
 *   · 同一页面里再点开 → 34ms（数据已在库里，只查一次）。
 * 所以慢的不是渲染，是「第一次把表填进 IndexedDB」。而这段时间面板是一块**空的**，
 * 用户看到的就是「点了没反应，然后突然蹦出来」。
 *
 * 修法：把这一步从「点击时」挪到「空闲时」。
 *   `new Database()` 与库内部用的是同一个 IndexedDB（库按 `emoji-picker-element-${locale}`
 *   命名，默认 locale = en；vue-advanced-chat 与 WpComposer 都没改 locale，故共用一份），
 *   这里先建实例跑完 ready()，之后真正的 <emoji-picker> 打开时库发现表里已有数据，
 *   直接走「查 IndexedDB」的快路径（更新检查是后台跑的，不等它）。实测 800ms → 76ms。
 *
 * 单独一个文件的理由：emojiPanel.js 只碰 DOM 小工具，能在 Node 里直接跑单测；
 * 这个文件一 import 库就会拉进整套 shadow DOM 代码，Node 里跑不起来（requestAnimationFrame
 * 未定义），所以不能混在一起。
 */
import { Database } from "emoji-picker-element";

const EMOJI_DATA = "/emoji/data.json";
let db = null;
let warming = null;
let scheduled = false;

export function emojiDatabase() {
  if (!db) db = new Database({ dataSource: EMOJI_DATA });
  return db;
}

/** 预热表情数据；返回 Promise<boolean>（失败不抛，面板自己还会再拉一次） */
export function warmEmojiData() {
  if (warming) return warming;
  warming = (async () => {
    try {
      await emojiDatabase().ready();
      return true;
    } catch (e) {
      return false;
    }
  })();
  return warming;
}

/** 空闲时预热一次（幂等）。省流/2G 不预热 —— 不替用户悄悄花流量。 */
export function scheduleEmojiWarm() {
  if (scheduled || typeof window === "undefined") return;
  scheduled = true;
  try {
    const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (c && (c.saveData || /(^|-)(2g|slow-2g)$/.test(String(c.effectiveType || "")))) return;
  } catch (e) { /* 拿不到网络信息就按正常处理 */ }
  const run = () => { warmEmojiData(); };
  if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(run, { timeout: 2500 });
  else setTimeout(run, 1200);
}
