/* ═══ 用户头像池（轮 238）═══
 * public/avatars/01.svg … 30.svg —— tools/gen-avatars.mjs 生成的治愈系萌宠。
 * 「注册后随机给一个」的实现口径：uid → FNV-1a 哈希 → 稳定映射到 1..30。
 *   · 注册即自动有头像，老用户也自动有 —— 不写库、不需要迁移；
 *   · 同一 uid 在任何设备/重登后都是同一只（稳定，不是每次刷新随机的假随机）；
 *   · uid 均匀散列 ≈ 均匀分配（tools/avatar-test.mjs 抽样验证）。
 * 渲染约定（NAvatar）：:src 传 url；图片加载失败走 #fallback 插槽（NAvatar 的
 * 失败兜底不读默认插槽），无 uid（游客/匿名行）传 undefined 回退首字母头像。
 */

export const AVATAR_COUNT = 30;

/** uid → 1..30（0 = 无 uid，调用方应回退首字母头像） */
export function avatarIndexFor(id) {
  const s = String(id || "");
  if (!s) return 0;
  let h = 2166136261;               /* FNV-1a 32 位 */
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % AVATAR_COUNT) + 1;
}

/** uid → "/avatars/NN.svg"（无 uid 返回 ""，调用方传 undefined 给 NAvatar） */
export function avatarUrlFor(id) {
  const n = avatarIndexFor(id);
  return n ? "/avatars/" + String(n).padStart(2, "0") + ".svg" : "";
}
