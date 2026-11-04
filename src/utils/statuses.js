/* 陪你大厅状态（#4 状态上云）—— HomeView 与 WallerView 共用的常量与小工具
 * ------------------------------------------------------------
 * 状态是四个固定 key，云端 profiles.status 只存 key（不存文案）；
 * 展示时用 i18n 的 home.companions.<key> 翻译，emoji 就写在文案里
 * （与心情打卡等区块一致：模板只排版，不再自己拼 emoji，避免「工作中 💻」变「💻 工作中 💻」）。
 * status_at 是更新时间，
 * 超过 STATUS_WINDOW_MS 视为过期（大厅与主页都不再显示，无需手动清）。
 */
export const STATUS_KEYS = ["working", "studying", "sleepless", "chilling"];

/** 状态新鲜窗口：超过这个时长就当作「没设状态」 */
export const STATUS_WINDOW_MS = 24 * 60 * 60 * 1000;

/** status_at 是否在新鲜窗口内（大厅 / 主页徽章共用） */
export function statusFresh(iso) {
  if (!iso) return false;
  const ts = Date.parse(iso);
  return !Number.isNaN(ts) && Date.now() - ts <= STATUS_WINDOW_MS;
}

/** 轮 366：大厅计数刷新能否落地。
 *  连点状态时，只有「请求发出后没再点」且「最后一笔 PATCH 已落库」的服务端快照才算数；
 *  否则它是旧快照，落下去会把本地预扣打回去（选中新状态、下面还是旧数字）。
 *  @param {number} seqAtStart 请求发出时的 statusWriteSeq
 *  @param {number} writeSeq 当前最后一次点击序号
 *  @param {number} appliedSeq 当前已落库的最后一次 PATCH 序号
 */
export function statusCountsCanApply(seqAtStart, writeSeq, appliedSeq) {
  return seqAtStart === writeSeq && appliedSeq === writeSeq;
}

/** 轮 367：大厅计数改「稳定快照」——进入/回到页面拉一次，不轮询。
 *  同一页面 30s 内不重复拉，避免切标签/点窗口把数字刷得一直跳。 */
export const STATUS_COUNTS_MIN_INTERVAL_MS = 30 * 1000;

export function statusCountsDue(lastFetchAt, now = Date.now(), minIntervalMs = STATUS_COUNTS_MIN_INTERVAL_MS) {
  if (!lastFetchAt) return true;
  return now - lastFetchAt >= minIntervalMs;
}
