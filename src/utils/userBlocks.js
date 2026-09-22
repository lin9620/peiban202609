/* ═══════════ 全站拉黑（轮 33）：内容过滤层 ═══════════
 * 口径（用户拍板）：一个「拉黑」= 全站生效 —— 复用私信拉黑名单 dm_blocks，
 * 私信拦截在 dm_send RPC 里已有；这里补「内容侧」：我拉黑的人，TA 的帖子/评论
 * 在我这边渲染前被剔除（列表 + 详情 + 评论），对方不知情、无任何通知。
 *
 * 数据：名单来自 dm_blocks RPC（[{user_id, nickname, created_at}]），登录后拉一次；
 * 另存一份按账号域的本地快照（userScope），刷新页面先渲染快照、后台校准 ——
 * 避免登录用户每次刷新都闪现已拉黑用户的内容。
 * 过滤是「显示层」的：数据仍在缓存里，取消拉黑后刷新即可复原，不做任何云端删除。
 */
import { reactive } from "vue";
import { cloud } from "./supabase.js";
import * as dmApi from "./dm.js";
import { onScopeSwitch, registerScopeBases, scopeGet, scopeSet } from "./userScope.js";

const SNAP_BASE = "warm-paws-user-blocks-v1";
registerScopeBases([SNAP_BASE]);

export const blockState = reactive({
  ids: scopeGet(SNAP_BASE, []) || [],   // 启动先用快照（登录用户的快照在登录域，恢复会话后 refresh 校准）
  loaded: false,
  loading: false,
});

/** 某用户是否被我拉黑 */
export function isBlocked(userId) {
  return !!userId && blockState.ids.includes(userId);
}

/** 过滤列表：按对象的 userId 字段剔除我拉黑的人（帖子/评论行都带 userId） */
export function filterBlocked(list) {
  if (!Array.isArray(list) || !blockState.ids.length) return list;
  return list.filter((x) => x && !isBlocked(x.userId));
}

/** 拉黑名单就绪（登录后拉一次；失败静默，快照兜底） */
export async function refreshBlocks() {
  if (blockState.loading) return blockState.ids;
  if (!(cloud.ready && cloud.user)) return blockState.ids;
  blockState.loading = true;
  try {
    const rows = await dmApi.blocks();
    blockState.ids = (Array.isArray(rows) ? rows : []).map((r) => r && r.user_id).filter(Boolean);
    blockState.loaded = true;
    scopeSet(SNAP_BASE, blockState.ids);
  } catch (e) { /* 网络问题用快照撑着，不阻塞渲染 */ }
  blockState.loading = false;
  return blockState.ids;
}

/** 拉黑（dm RPC 拦私信 + 本地名单即时更新，UI 立刻生效） */
export async function blockUser(userId) {
  if (!userId) return false;
  await dmApi.block(userId);
  if (!blockState.ids.includes(userId)) blockState.ids.unshift(userId);
  scopeSet(SNAP_BASE, blockState.ids);
  return true;
}

/** 取消拉黑 */
export async function unblockUser(userId) {
  if (!userId) return false;
  await dmApi.unblock(userId);
  blockState.ids = blockState.ids.filter((id) => id !== userId);
  scopeSet(SNAP_BASE, blockState.ids);
  return true;
}

/* 换号 = 换域：读新域的快照并重置「已拉取」标记（登录后会重新 refreshBlocks 校准） */
onScopeSwitch({
  reload() {
    blockState.ids = scopeGet(SNAP_BASE, []) || [];
    blockState.loaded = false;
    blockState.loading = false;
  },
});
