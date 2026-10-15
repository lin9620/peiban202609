/* 迁移自检 —— 纯检查逻辑（轮 301）
 * ------------------------------------------------------------
 * 背景：迁移越堆越多（comment_delete / wall_feed_page 修后版 / comment_counts_301），
 *   用户在 SQL Editor 跑没跑、跑成没，全靠口头确认 —— 轮 295 的坏 RPC 就是这么漏过去的
 *   （生产 400 / 22023，靠线上探针才发现）。
 * 这里只做「纯函数 + 单次探测调用」的形状定义：输入是各探测的 { ok, code, ms }，
 * 输出是给管理员看的一行结论。真正的探测调用由 AdminView 发起（db 适配层已有方法，
 *   不新增接口），本文件不碰网络、不依赖 Vue —— Node 单测直接锁口径。
 * 另一会话正在改 AdminView.vue / i18n.js：本轮只加本文件 + 单测，不碰那两文件，
 *   页签接线等对方合完再做（见 jiaojie 轮 301 待办）。
 */

/**
 * 单项迁移探测结果 → 行结论。
 * @param {object} probe { key, ok, code, ms, hint }
 *   key = 迁移键（如 comment_delete）；ok = 是否已生效；
 *   code = 探测到的错误码/状态（如 PGRST202/42883/200）；ms = 耗时；
 *   hint = 给管理员的操作提示（SQL 文件名）。
 */
export function probeRow({ key, ok, code = "", ms = null, hint = "" } = {}) {
  const n = Number(ms);
  return {
    key: String(key || ""),
    ok: ok === true,
    code: String(code || ""),
    ms: ms == null || ms === "" ? null : (Number.isFinite(n) && n >= 0 ? Math.floor(n) : null),
    hint: String(hint || ""),
  };
}

/**
 * 多项探测结果 → 汇总：全部通过才算 ALL PASS。
 * 脏输入（非数组/缺字段）一律按未通过计 —— 自检绝不能把「没测到」说成「通过了」。
 */
export function probeSummary(rows) {
  const arr = Array.isArray(rows) ? rows : [];
  const items = arr.map(probeRow);
  const pass = items.filter((r) => r.ok).length;
  return { all: items.length > 0 && pass === items.length, pass, total: items.length, items };
}

/**
 * 轮 301 三项迁移的探测定义（给 AdminView 用，不在这里执行）：
 * 每一项说明「怎么测」—— AdminView 按这个定义发一次真实调用即可。
 */
export const MIGRATION_PROBES_301 = [
  {
    key: "comment_delete",
    sql: "MIGRATION_comment_delete.sql",
    how: "调 wall_comment_delete 传不存在的 id：PGRST202/42883 = 没跑；false/true = 跑了",
  },
  {
    key: "wall_feed_page_295",
    sql: "MIGRATION_wall_feed_page.sql（修后版）",
    how: "调 wall_feed_page(p_limit=1)：400/22023 = 坏版；200 = 修后版",
  },
  {
    key: "comment_counts_301",
    sql: "MIGRATION_comment_counts_301.sql",
    how: "软删一条评论后看标题数：标题跟着减 = 跑了；标题不动 = 没跑",
  },
];
