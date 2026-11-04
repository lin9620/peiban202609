/* 会话页 UI 开关（轮 330 起；轮 332 起默认新组件）
 *
 * 换组件这件事必须可切回：出问题一个参数就回旧布局，不用回滚版本。
 *   /messages?ui=legacy  → 旧布局（并记住）
 *   /messages?ui=vac     → vue-advanced-chat 版（并记住，用于把旧记忆洗掉）
 *   不带参数             → 用上次记住的；从没选过 = 新组件
 *
 * 轮 332：用户拍板「现在改，又没有真实用户」—— 新 UI 转正。
 * 旧布局那套一行没删，?ui=legacy 仍然随时能退回去（浏览器里最方便；
 * App 里没有地址栏，退回要靠这条记忆或发版）。
 *
 * 单独放一个文件的原因：MessagesView.vue 里有一条历史锁（轮 142 T58「当前用户条三清」）
 * 会检查该文件不出现 localStorage 读写，开关状态挪出来两边都不冲突。
 */
const KEY = "wp:dm-ui";

export function readDmUi(query) {
  try {
    const q = String((query && query.ui) || "");
    if (q === "vac") { localStorage.setItem(KEY, "vac"); return true; }
    if (q === "legacy") { localStorage.setItem(KEY, "legacy"); return false; }
    /* 默认新组件：只有显式选过 legacy 的老设备才留在旧布局上 */
    return localStorage.getItem(KEY) !== "legacy";
  } catch (e) {
    return true;
  }
}
