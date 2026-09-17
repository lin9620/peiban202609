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
