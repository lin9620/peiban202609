/* ═══════════ 暖心墙关注（轮447）：状态层 ═══════════
 * 口径（用户拍板 + docs/PLAN-wall-follow.md）：
 *   关注 = **我的阅读列表**，不是社交关系。
 *   · 单向、静默 —— 被关注者读不到（RLS：follower_id = auth.uid()），也不会有任何通知；
 *   · 不显示粉丝数、不做粉丝列表、不在作者主页显示 TA 的关注数；
 *   · 只影响暖心墙（「我的关注」筛选），漂流瓶 / 故事零改动。
 *
 * 为什么单独一个模块而不是塞进 wall.js：
 *   关注是「我的关系数据」，要跨页共享（信息流按钮 / 作者主页 / 详情页菜单 / 我的关注列表 /
 *   我的页面计数）。放在 wall.js 会让那个已经 1000+ 行的文件再多一层状态，且换号时要
 *   单独处理本地快照 —— userBlocks.js 已经把这条路走通了，这里照抄它的结构。
 *
 * 本地快照按账号域存（userScope）：刷新页面先渲染上次的关注状态，
 * 不会出现「按钮先显示『关注』、200ms 后跳成『已关注』」的闪烁。
 */
import { computed, reactive } from "vue";
import { cloud } from "./supabase.js";
import { db } from "./api/db.js";
import { onScopeSwitch, registerScopeBases, scopeGet, scopeSet } from "./userScope.js";

/* 关注上限。服务端 BEFORE INSERT 触发器（wall_follows_limit）是硬拦，
 * 这里只是提前给一句准确提示，省一次必然失败的往返。两处必须保持一致。 */
export const FOLLOW_LIMIT = 200;

const IDS_BASE = "warm-paws-follow-ids-v1";
const ROWS_BASE = "warm-paws-follow-rows-v1";
registerScopeBases([IDS_BASE, ROWS_BASE]);

function cachedIds() {
  const v = scopeGet(IDS_BASE, []);
  return Array.isArray(v) ? v.filter(Boolean).map(String) : [];
}
function cachedRows() {
  const v = scopeGet(ROWS_BASE, []);
  return Array.isArray(v) ? v.filter((r) => r && r.user_id) : [];
}

export const followState = reactive({
  ids: cachedIds(),      // 我关注的人（uuid 字符串）—— 按钮判据、关注流取数都靠它
  rows: cachedRows(),    // [{ user_id, nickname, followed_at, post_count, last_post_at }]
  loaded: false,
  loading: false,
  error: false,          // 拉取失败（网络/端点缺失）→ 列表页显示「加载失败」而不是「没有关注」
});

/* 每次渲染每张卡片都要问一次 isFollowing，200 人时用 includes 会变成 O(n²)。
 * computed 把 Set 缓存住，ids 一变自动重建。 */
const idSet = computed(() => new Set(followState.ids));
export const followingCount = computed(() => followState.ids.length);

/** 我是否关注了某人（uid 空 / 非字符串 → false，不会因为脏数据误判） */
export function isFollowing(userId) {
  if (!userId) return false;
  return idSet.value.has(String(userId));
}

function persist() {
  scopeSet(IDS_BASE, followState.ids);
  scopeSet(ROWS_BASE, followState.rows);
}

/* ── 近期操作合并：刚关注、服务端响应还没带上的行，不能被一次早到的 refresh 刷掉 ── */
const RECENT_MS = 60000;
const recentOps = new Map();   // uid -> { kind: "follow"|"unfollow", at, row }
function markRecent(id, kind, row = null) { recentOps.set(id, { kind, at: Date.now(), row }); }
function clearRecent(id) { recentOps.delete(id); }
function recentKind(id) {
  const op = recentOps.get(id);
  if (!op) return "";
  if (Date.now() - op.at > RECENT_MS) { recentOps.delete(id); return ""; }
  return op.kind;
}

/* ── 连点保护：关注→取关→关注，迟到的失败不能回滚掉后一次的结果 ── */
let opSeq = 0;
const opTokens = new Map();
function beginOp(id) { const t = ++opSeq; opTokens.set(id, t); return t; }
function isOpCurrent(id, token) { return opTokens.get(id) === token; }

/** 错误 → i18n 键。已关注（23505）不算错，返回空串。
 *  ⚠ 必须**先看 code 再看 message** —— Supabase 有时只给 code（message 是空或泛化文案），
 *    只匹配 message 会让「没跑迁移」显示成笼统的「操作失败」。 */
export function followErrKey(e) {
  const m = String((e && e.message) || e || "");
  const code = e && e.code;
  if (code === "P0001" || /wall-follow-limit|follow-limit/.test(m)) return "follow.limit";
  if (/wall_follows_no_self|wall-follow-self|follow-self/.test(m)) return "follow.self";
  if (code === "23505" || /duplicate key/.test(m)) return "";
  if (code === "42P01" || code === "42883" || code === "PGRST202"
    || /42P01|42883|PGRST202|does not exist|not found/i.test(m)) return "follow.offline";
  return "follow.fail";
}

/** 关注 / 取关是否「功能未开通」（没跑迁移 / 网关没端点）—— 用来把错误提示换成口径说明 */
export function isFollowUnavailable(e) {
  const m = String((e && e.message) || e || "");
  const code = e && e.code;
  return /42P01|42883|PGRST202|404/.test(m) || code === "42P01" || code === "42883";
}

/* 在途请求（轮 459）：原来 loading 期间直接 `return followState.ids`，那时 ids 可能还是**空的**
 * ——启动期预热（warmFollowFeed）与暖心墙挂载几乎同时调它，后到的那个拿到空数组，于是
 * 「卡片上人人都是未关注」「进关注流直接显示 0 人」。并发的调用一律等同一个在途 Promise，
 * 谁先来谁发起，其他人拿同一份结果。 */
let inflight = null;

/** 拉「我的关注」清单（RPC 一次拿人 + 昵称 + 帖子数 + 最近发帖） */
export function refreshFollows(force = false) {
  if (!(cloud.ready && cloud.user)) return Promise.resolve(followState.ids);
  if (inflight) return inflight;
  if (followState.loaded && !force) return Promise.resolve(followState.ids);
  followState.loading = true;
  followState.error = false;
  inflight = (async () => {
    let timer = 0;
    try {
      const rows = await Promise.race([
        db.following(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("follow-timeout")), 10000);
        }),
      ]);
      const fresh = (Array.isArray(rows) ? rows : [])
        .filter((r) => r && r.user_id)
        .map((r) => ({
          user_id: String(r.user_id),
          nickname: String(r.nickname || ""),
          followed_at: r.followed_at || "",
          post_count: Number(r.post_count) || 0,
          last_post_at: r.last_post_at || null,
        }));

      /* 刚点关注、服务端还没带上的人：保住本地行，别让它「刚点完就在列表里消失」 */
      const freshIds = new Set(fresh.map((r) => r.user_id));
      const add = [];
      for (const [id, op] of recentOps) {
        if (recentKind(id) !== "follow" || freshIds.has(id)) continue;
        add.push(op.row || followState.rows.find((r) => r.user_id === id)
          || { user_id: id, nickname: "", followed_at: new Date(op.at).toISOString(), post_count: 0, last_post_at: null });
      }
      /* 刚取关、服务端响应仍是旧名单的人：先摘掉 */
      const merged = add.concat(fresh.filter((r) => recentKind(r.user_id) !== "unfollow"));

      followState.rows = merged;
      followState.ids = merged.map((r) => r.user_id);
      followState.loaded = true;
      persist();
    } catch (e) {
      /* 网络 / 网关端点缺失：保留快照，标记失败 —— 列表页据此显示「加载失败」
         而不是「你还没关注任何人」（后者是骗人）。 */
      followState.error = true;
    } finally {
      if (timer) clearTimeout(timer);
      followState.loading = false;
      inflight = null;
    }
    return followState.ids;
  })();
  return inflight;
}

/** 关注某人：乐观先行（按钮立刻变「已关注」），失败回滚并抛错给调用方 */
export async function followUser(userId, nickname = "") {
  const id = String(userId || "");
  if (!id) return false;
  if (idSet.value.has(id)) return true;                       // 已关注 = 幂等
  if (cloud.user && String(cloud.user.id) === id) throw new Error("follow-self");
  if (followState.ids.length >= FOLLOW_LIMIT) throw new Error("wall-follow-limit");

  const token = beginOp(id);
  const row = {
    user_id: id,
    nickname: String(nickname || "").trim(),
    followed_at: new Date().toISOString(),
    post_count: null,      // 未知（本地行），列表页显示「—」而不是「0 篇」
    last_post_at: null,
  };
  followState.ids = [id].concat(followState.ids);
  followState.rows = [row].concat(followState.rows.filter((r) => r.user_id !== id));
  persist();
  markRecent(id, "follow", row);

  try {
    await db.followInsert(id);
  } catch (e) {
    if (isOpCurrent(id, token)) {
      followState.ids = followState.ids.filter((x) => x !== id);
      followState.rows = followState.rows.filter((r) => r.user_id !== id);
      persist();
      clearRecent(id);
    }
    throw e;
  }
  return true;
}

/** 取关：同样乐观先行 + 失败回滚 */
export async function unfollowUser(userId) {
  const id = String(userId || "");
  if (!id) return false;
  const existed = idSet.value.has(id);
  if (!existed) return true;                                  // 本来就没关注

  const prevIdIdx = followState.ids.indexOf(id);
  const prevRowIdx = followState.rows.findIndex((r) => r.user_id === id);
  const prevRow = prevRowIdx >= 0 ? followState.rows[prevRowIdx] : null;
  const token = beginOp(id);

  followState.ids = followState.ids.filter((x) => x !== id);
  followState.rows = followState.rows.filter((r) => r.user_id !== id);
  persist();
  markRecent(id, "unfollow");

  try {
    await db.followDelete(id);
  } catch (e) {
    if (isOpCurrent(id, token)) {
      if (!followState.ids.includes(id)) {
        const ids = followState.ids.slice();
        ids.splice(Math.min(prevIdIdx, ids.length), 0, id);
        followState.ids = ids;
      }
      if (prevRow) {
        const rows = followState.rows.filter((r) => r.user_id !== id);
        rows.splice(Math.min(prevRowIdx, rows.length), 0, prevRow);
        followState.rows = rows;
      }
      persist();
      clearRecent(id);
    }
    throw e;
  }
  return true;
}

/** 拉黑联动：尽力取关（失败忽略 —— 拉黑是主操作，取关只是清理副作用） */
export async function dropFollowQuietly(userId) {
  try { await unfollowUser(userId); } catch (e) { /* 忽略：渲染层还有 filterBlocked 兜底 */ }
}

/* 换号 = 换域：读新域的快照并重置「已拉取」标记（登录后会重新 refreshFollows 校准） */
onScopeSwitch({
  reload() {
    inflight = null;   /* 上一个人的名单请求不再复用（新域第一次调用要真的发出去） */
    followState.ids = cachedIds();
    followState.rows = cachedRows();
    followState.loaded = false;
    followState.loading = false;
    followState.error = false;
    recentOps.clear();
    opTokens.clear();
  },
});
