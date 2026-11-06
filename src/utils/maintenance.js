/* ═══ 轮 444 · 维护/升级模式的客户端状态 ═══
 *
 * 目标：维护期间对用户干扰最小。具体做法见三条红线：
 *  ① **不改页面结构、不弹全屏遮罩**：状态只喂给顶部一条细横幅（MaintenanceBar），
 *     用户正在读的文章、正在聊的私信不会被中断；
 *  ② **不提前禁用按钮**：按钮照常亮着，点了才给「正在升级，稍后就好」——
 *     「满屏灰色按钮」比「点一下被温柔拦下」挫败感更强；
 *  ③ **不要求刷新**：Realtime 推送状态变化，横幅自己出现/消失；断线时 60s 轮询兜底，
 *     再断就靠 localStorage 缓存，冷启动也不会闪一下正常态再变维护。
 *
 * 三档语义（与 SQL 的 maintenance_active() 完全一致）：
 *   off  正常
 *   read 只读维护：浏览/历史/榜单照常，只有创作类写入被拦
 *   full 完全停机：连浏览也不放行，界面整页柔占位
 *
 * 管理员豁免：站主在维护期照样能写（服务端 maintenance_blocks_write 也豁免），
 * 但可以打开「用户视角」预览，看到的就是普通用户看到的样子。
 */
import { reactive } from "vue";
import { getClient } from "./supabase.js";
import { getItem, setItem } from "./storage.js";

const CACHE = "wp-maint-v1";
const POLL_MS = 60000;

export const maint = reactive({
  mode: "off",        /* off | read | full —— 服务端原始值（未算到期） */
  note: "",           /* 管理员自定义说明；空 = 用 i18n 默认文案 */
  until: null,        /* ISO 时间串或 null */
  startedAt: null,
  admin: false,       /* 我是不是管理员（决定是否豁免） */
  preview: false,     /* 管理员「以用户视角预览」：自己也受管 */
  loaded: false,      /* 是否拿到过真实状态（false 时界面不要急着下结论） */
  hint: 0,            /* 被拦一次 +1；横幅据此轻抖一下，告诉用户「是这里不让写」 */
});

/* ── 缓存：冷启动先按上次状态渲染，避免「先正常 0.5 秒再变维护」的闪跳 ── */
function readCache() {
  try {
    const raw = getItem(CACHE);
    if (!raw) return;
    const o = JSON.parse(raw);
    if (!o || typeof o !== "object") return;
    if (["off", "read", "full"].includes(o.mode)) maint.mode = o.mode;
    maint.note = typeof o.note === "string" ? o.note : "";
    maint.until = typeof o.until === "string" ? o.until : null;
    maint.startedAt = typeof o.startedAt === "string" ? o.startedAt : null;
  } catch (e) { /* 脏缓存当没有 */ }
}
readCache();

function writeCache() {
  try {
    setItem(CACHE, JSON.stringify({ mode: maint.mode, note: maint.note, until: maint.until, startedAt: maint.startedAt }));
  } catch (e) { /* 存不下就只影响冷启动体验 */ }
}

/** 把服务端一行灌进状态（db.maintenanceState 的返回、或 Realtime 的 payload.new） */
export function applyState(row) {
  if (!row || typeof row !== "object") return;
  const m = row.maintenance_mode;
  maint.mode = ["off", "read", "full"].includes(m) ? m : "off";
  maint.note = typeof row.maintenance_note === "string" ? row.maintenance_note : "";
  maint.until = row.maintenance_until || null;
  maint.startedAt = row.maintenance_started_at || null;
  maint.loaded = true;
  writeCache();
}

/** 当前实际生效档位。
 *  until 到点即视为 off —— 服务端 maintenance_active() 同样这么算，
 *  这里再算一遍是为了「管理员设了 20 分钟但人走了」时，客户端不用等下次轮询才恢复。 */
export function activeMode() {
  if (maint.mode === "off") return "off";
  if (maint.until) {
    const t = Date.parse(maint.until);
    if (Number.isFinite(t) && t <= Date.now()) return "off";
  }
  return maint.mode;
}

/** 管理员默认豁免；打开「用户视角」后不再豁免 */
export function selfExempt() {
  return maint.admin && !maint.preview;
}

/** 我是否处于被维护影响的状态（read/full 都算） */
export function isBlocked() {
  return activeMode() !== "off" && !selfExempt();
}

/** 只读档：能看不能写 */
export function isReadOnly() {
  return isBlocked() && activeMode() === "read";
}

/** 完全停机档：连看都别发请求（避免整页报错刷屏） */
export function isFullStop() {
  return isBlocked() && activeMode() === "full";
}

/** 写入口统一守卫：被拦返回 false，并让横幅轻抖一下作为「就是这儿不让写」的反馈。
 *  刻意不抛异常 —— 调用方按「没做成」处理即可，不用改各自的错误处理链。 */
export function guardWrite() {
  if (!isBlocked()) return true;
  maint.hint += 1;
  return false;
}

/** 服务端兜底抛出来的错误（触发器 errcode PT503 / message 'maintenance-mode'） */
export function isMaintenanceError(e) {
  const s = String((e && (e.message || e.error_description || e.details)) || e || "");
  return /maintenance-mode|PT503/i.test(s) || (e && e.code === "PT503");
}

/* ── 拉取 / 订阅 / 轮询 ───────────────────────────────────────── */

let channel = null;
let pollTimer = 0;
let startedUid = "";

/** 主动拉一次（公开可读，未登录也能拿） */
export async function refreshMaintenance(db) {
  try {
    const row = await db.maintenanceState();
    if (row) applyState(row);
    else if (!maint.loaded) maint.loaded = true;   /* 表在但没行：当作正常，别一直算「未知」 */
  } catch (e) {
    /* 表还没建（迁移没跑）/ 网络断 —— 保持缓存值，绝不当成「正常」去覆盖已知的维护态 */
    if (!maint.loaded) maint.loaded = true;
  }
}

/** App 启动时调用一次；uid 变化（登录/登出）不影响订阅（app_state 是公开表） */
export function startMaintenanceWatch(db) {
  if (typeof window === "undefined") return false;
  if (channel) return true;
  let sb = null;
  try { sb = getClient(); } catch (e) { sb = null; }
  if (!sb) return false;

  const tick = () => { refreshMaintenance(db); };
  tick();
  /* 断线兜底：Realtime 只做「更快」，不做「唯一」，60s 一定能收敛 */
  if (!pollTimer) {
    pollTimer = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      tick();
    }, POLL_MS);
  }

  try {
    channel = sb
      .channel("app-state:global")
      .on("postgres_changes",
        { event: "UPDATE", schema: "public", table: "app_state" },
        (payload) => applyState(payload && payload.new))
      .subscribe();
    startedUid = "global";
    return true;
  } catch (e) {
    channel = null;
    return false;   /* 建通道失败 = 只靠轮询，功能不残 */
  }
}

export function stopMaintenanceWatch() {
  try {
    const sb = getClient();
    if (sb && channel) sb.removeChannel(channel);
  } catch (e) { /* 忽略 */ }
  channel = null;
  startedUid = "";
  if (pollTimer) { clearInterval(pollTimer); pollTimer = 0; }
}

/** 设置页/后台的「预览用户视角」开关（只有管理员会看到这个开关） */
export function setPreview(v) {
  maint.preview = !!v;
}
