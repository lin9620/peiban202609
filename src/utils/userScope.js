/* ═══════════ 账号域（user scope）：个人数据的 localStorage 键按账号分档 ═══════════
 *
 * 用户报障：「宠物我一个新注册的号怎么就 3 级了，你这缓存怎么写的」。
 * 根因：宠物等级/金币/手绘食谱/心情打卡/每日任务/冒险/装扮这些键以前都是**全局单键**，
 *   同一台设备（或同一浏览器）换账号时直接读到上一个人的档 —— 新注册的号「继承」了
 *   别人的 3 级宠物和金币。同类的还有暖心墙的浏览去重/匿名 id/当日发帖记账/本地帖/回应。
 * 修法：这些个人数据的键统一带 `:<域>` 后缀，**域 = 当前登录 uid；未登录 = guest**。
 *   本模块是唯一实现（别再各写一份），其它模块只做三件事：
 *     ① registerScopeBases([...]) 声明「哪些键是个人数据」；
 *     ② initUserScope()            启动时调一次：把「升级前的无域老存档」搬进 guest 域，
 *                                  并登记「待认领」——老用户升级后不能丢档；
 *     ③ onScopeSwitch({flush,reload}) 注册换号前后的动作（flush 落盘旧账号、reload 重读新账号）。
 *   换号入口只有一个：App.vue 里 watch 登录 uid → setUserScope(uid)（登出传空 = guest）。
 *
 * 认领（claim）：升级后的**第一次登录**，把 guest 域里那份「搬过来的老档」复制给该账号
 *   —— 老用户升级后宠物还在；认领只发生一次（标记清掉就没了），之后各账号互不相干，
 *   所以「新注册的号」必然是全新 1 级宠物（50 金币、只送小雏菊）。
 *   guest 域里那份副本保留：登出回到游客档时看到的还是同一只宠物（个人数据不写进别人账号域）。
 */
import { getItem, setItem, removeItem } from "./storage.js";

export const GUEST_SCOPE = "guest";
/* 待认领清单（设备级，不分域）：升级时搬进 guest 的键名列表 */
const LEGACY_PENDING = "warm-paws-scope-legacy-pending-v1";

const bases = new Set();          // 所有「个人数据」键的基名（各模块注册）
const flushers = new Set();       // 换域前：把当前账号的改动落盘
const reloaders = new Set();      // 换域后：按新域重读响应式状态

let scope = GUEST_SCOPE;

/** 当前域（uid 或 guest）—— 展示/排查/测试用 */
export function scopeId() { return scope; }

/** 注册个人数据键基名（模块导入时调用一次即可，重复注册无副作用） */
export function registerScopeBases(list) {
  for (const b of list || []) if (typeof b === "string" && b) bases.add(b);
}

/** 带域的键名：base:uid / base:guest */
export function scopedKey(base, id = scope) { return base + ":" + id; }

/** 当前域的原始字符串读写（调用方自己 JSON 化） */
export function scopeGetRaw(base) { return getItem(scopedKey(base)); }
export function scopeSetRaw(base, raw) { setItem(scopedKey(base), raw); }
export function scopeRemove(base) { removeItem(scopedKey(base)); }

/** 当前域的 JSON 读写（解析失败/无值 → fallback） */
export function scopeGet(base, fallback = null) {
  const raw = scopeGetRaw(base);
  if (!raw) return fallback;
  try { const v = JSON.parse(raw); return v === null || v === undefined ? fallback : v; }
  catch (e) { return fallback; }
}
export function scopeSet(base, value) { scopeSetRaw(base, JSON.stringify(value)); }

/** 某个域里有没有这份档（认领判断用） */
export function scopeHas(base, id) { return getItem(base + ":" + id) !== null; }

/** 注册换号动作：flush（旧账号落盘）/ reload（新账号重读） */
export function onScopeSwitch({ flush, reload } = {}) {
  if (typeof flush === "function") flushers.add(flush);
  if (typeof reload === "function") reloaders.add(reload);
}

function safeRun(set, what) {
  for (const fn of set) {
    try { fn(); } catch (e) { console.warn("[userScope] " + what + " 失败：", e); }
  }
}

function pendingList() {
  try {
    const v = JSON.parse(getItem(LEGACY_PENDING));
    return Array.isArray(v) ? v : [];
  } catch (e) { return []; }
}
function setPending(list) {
  try {
    if (list && list.length) setItem(LEGACY_PENDING, JSON.stringify(list));
    else removeItem(LEGACY_PENDING);
  } catch (e) { /* 忽略 */ }
}

/**
 * 启动时调一次（挂载前）：把升级前的「无域老存档」搬进 guest 域，并登记待认领。
 * 只在 guest 域还没有该键时才搬 —— 搬过就不会再搬，老键也随即删掉（不留下第二份真相）。
 * 返回搬动的键数。
 */
export function initUserScope() {
  let moved = 0;
  const pend = new Set(pendingList());
  for (const base of bases) {
    const legacy = getItem(base);
    if (legacy === null) continue;
    if (!scopeHas(base, GUEST_SCOPE)) setItem(scopedKey(base, GUEST_SCOPE), legacy);
    removeItem(base);
    pend.add(base);
    moved++;
  }
  if (moved) {
    setPending([...pend]);
    /* 各模块的「模块级初始读档」跑在 import 时（早于 main.js 调这里），
       首次升级加载时 guest 域还是空的 → 搬完必须补一次 reload 才能把老档读回来。 */
    safeRun(reloaders, "reload(迁移后)");
  }
  return moved;
}

/**
 * 升级后的第一次登录：把 guest 域那份「搬过来的老档」认领给该账号（只认一次）。
 * 账号域已存在该键时（自己本来就有的档）不覆盖 —— 认领绝不能盖掉真档。
 */
export function claimForUser(uid) {
  const pend = pendingList();
  if (!uid || !pend.length) return 0;
  let claimed = 0;
  for (const base of pend) {
    if (!bases.has(base)) continue;
    const guestVal = getItem(scopedKey(base, GUEST_SCOPE));
    if (guestVal === null) continue;
    if (!scopeHas(base, uid)) { setItem(scopedKey(base, uid), guestVal); claimed++; }
  }
  setPending([]);   // 一次性：认领过就不再认领（下一个新账号不该拿到这份档）
  return claimed;
}

/** 待认领的键（排查/测试用） */
export function pendingClaimKeys() { return pendingList(); }

/**
 * 换域：登录/登出/切账号都走这里。
 * 顺序不能反：先 flush（旧账号的改动写进旧域）→ 切域 + 认领 → reload（新域重读）。
 * uid 为空/未登录 = guest 域。返回是否真的换了域。
 */
export function setUserScope(uid) {
  const next = uid ? String(uid) : GUEST_SCOPE;
  if (next === scope) return false;
  safeRun(flushers, "flush");
  scope = next;
  if (next !== GUEST_SCOPE) claimForUser(next);
  safeRun(reloaders, "reload");
  return true;
}
