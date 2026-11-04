/* 管理中心举报队列的纯逻辑（轮 368）
 * 只做「分类 / 批量动作 / 选中」的确定性映射，方便 Node 单测；
 * 网络、DOM、i18n 都留在 AdminView.vue。
 */

export const REPORT_KINDS = ["post", "comment"];

/** 云端只允许 post/comment；未知值按帖子处理，避免筛选时整行消失。 */
export function reportKindOf(item) {
  return item && item.target_type === "comment" ? "comment" : "post";
}

/** 批量动作 → admin_report_handle 的 action；未知类型返回空串，调用方跳过。 */
export function reportBatchAction(targetType, mode) {
  if (mode === "dismiss") return "dismiss";
  if (mode !== "takeDown") return "";
  if (targetType === "post") return "remove_post";
  if (targetType === "comment") return "delete_comment";
  return "";
}

/** 服务端 counts 是 {post_pending, post_handled, comment_pending, comment_handled}。
 *  缺失/脏值返回 null，页面不显示括号数字，而不是伪造 0。 */
export function reportKindCount(counts, kind, status) {
  if (!counts || typeof counts !== "object") return null;
  const n = Number(counts[`${kind}_${status}`]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** 全选只收当前页 pending 行；已处理历史不参与批量。 */
export function reportSelectableIds(items) {
  return (Array.isArray(items) ? items : [])
    .filter((x) => x && x.status === "pending" && x.id != null)
    .map((x) => x.id);
}

/** 单选/取消单选，返回新数组（不原地改 ref 里的数组）。 */
export function reportToggleSelection(selected, id) {
  const set = new Set(Array.isArray(selected) ? selected : []);
  if (set.has(id)) set.delete(id);
  else set.add(id);
  return [...set];
}

/** 历史行的 action 是 SQL 的下划线值；i18n 键是 camelCase。 */
export function reportActionKey(action) {
  return ({
    dismiss: "dismiss",
    remove_post: "removePost",
    restore_post: "restorePost",
    delete_comment: "deleteComment",
    unhide_comment: "unhideComment",
  })[action] || "dismiss";
}
