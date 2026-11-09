/* 表情面板公用小工具（轮 348）
 * ------------------------------------------------------------
 * 用户：「app端把表情包里面的搜索框去掉」。
 * emoji-picker-element 没有暴露 `::part()`（1.29 的 shadow DOM 里只有普通 class），
 * 所以只能往它自己的 shadowRoot 里塞一条 style。库每次打开面板都会重建
 * <emoji-picker> 元素（vue-advanced-chat 的 v-if，WpComposer 的 v-if 同理），
 * 所以调用点要「拿到元素就调一次」；函数自己按 data 标记幂等，重复调不叠加。
 *
 * 轮 478 的表情数据预热在 emojiWarm.js —— 那个文件会 import 库里整套 DOM 代码，
 * 而本文件要能在 Node 里直接跑单测，两者不能混。
 */
export function hideEmojiSearch(picker) {
  const sr = picker && picker.shadowRoot;
  if (!sr) return false;
  if (sr.querySelector("style[data-wp-nosearch]")) return true;
  const st = document.createElement("style");
  st.setAttribute("data-wp-nosearch", "1");
  /* 搜索框整行（输入框 + 右侧清除键）一起收；库自己的样式只碰 padding/height，
     不碰 display，所以这条一定赢。 */
  st.textContent = ".search-row{display:none !important;}";
  sr.appendChild(st);
  return true;
}

/** 在一个（组件）shadowRoot 里把所有 emoji-picker 的搜索框都收掉；返回处理了几个 */
export function hideEmojiSearchIn(root) {
  if (!root || typeof root.querySelectorAll !== "function") return 0;
  let n = 0;
  for (const p of root.querySelectorAll("emoji-picker")) {
    if (hideEmojiSearch(p)) n++;
  }
  return n;
}
