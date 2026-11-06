/**
 * 轮448 · 作者撤回 / 隐藏自己投的信 —— 列表页共用的一份操作层
 *
 * 背景：轮446 只在 /bottle 页的记录卡上做了撤回/隐藏，另外两个列表漏了：
 *   - 手机「消息 → 漂流瓶」段 = BottleRecords
 *   - 桌面「消息 → 漂流瓶」左列 = BottleChatList
 * 三处判据必须与数据库 bottle_letter_delete / _hide 的 where 逐条对应，
 * 所以统一走 utils/bottle.js 的 canWithdrawLetter / canHideLetter（纯函数、有单测），
 * 这里只负责「确认框 → 调 RPC → 从列表摘掉 → 一句轻提示」这套动作。
 *
 * 一句话口径：还在海里的能收回；已经进了别人手里的，只能自己眼不见为净。
 * 撤回**不退还**今日投信次数 —— 投递是动作成本，退还等于可以无限试写。
 */
import { ref } from "vue";
import { useDialog } from "naive-ui";
import { t } from "../i18n.js";
import { bottleErrKey, bottleWithdraw, bottleHide } from "./bottle.js";

/**
 * @param {object} opts
 * @param {(id: any) => void} opts.onDone   成功后把这一行从本地列表摘掉
 * @param {(key: string) => void} [opts.onError]  失败时把错误 key 交给调用方的提示区
 */
export function useLetterOps({ onDone, onError } = {}) {
  const dialog = useDialog();
  const opBusy = ref("");   /* 正在撤回/隐藏的那条 id —— 防连点，同时禁用另一颗 */
  const flash = ref("");    /* 成功后的轻提示（3s 自动消失） */
  let flashTimer = 0;

  function say(tk) {
    flash.value = t(tk);
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { flash.value = ""; }, 3000);
  }
  const busyFor = (row) => opBusy.value === String(row && row.id);
  const fail = (e) => { if (onError) onError(bottleErrKey(e)); };

  /* naive-ui 的 dialog 包成 Promise：确认 = true；取消/关闭/点遮罩都算否 */
  function askConfirm(title, desc) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      dialog.warning({
        title, content: desc,
        positiveText: t("common.confirm"),
        negativeText: t("common.cancel"),
        onPositiveClick: () => done(true),
        onNegativeClick: () => done(false),
        onClose: () => done(false),
      });
    });
  }

  async function withdraw(row) {
    if (!row || opBusy.value) return false;
    if (!(await askConfirm(t("bottle.withdrawTitle"), t("bottle.withdrawDesc")))) return false;
    opBusy.value = String(row.id);
    try {
      const ok = await bottleWithdraw(row.id);
      if (!ok) throw new Error("bottle-not-owner");
      if (onDone) onDone(row.id);
      say("bottle.withdrawn");
      return true;
    } catch (e) {
      fail(e);
      /* 并发：点撤回的同一瞬间被人捞走 → 就地改状态，按钮换成「隐藏」，别让人反复点 */
      if (/bottle-already-picked/.test(String((e && e.message) || ""))) row.status = "held";
      return false;
    } finally { opBusy.value = ""; }
  }

  async function hide(row) {
    if (!row || opBusy.value) return false;
    if (!(await askConfirm(t("bottle.hideTitle"), t("bottle.hideDesc")))) return false;
    opBusy.value = String(row.id);
    try {
      const ok = await bottleHide(row.id);
      if (!ok) throw new Error("bottle-not-owner");
      if (onDone) onDone(row.id);
      say("bottle.hidden");
      return true;
    } catch (e) {
      fail(e);
      return false;
    } finally { opBusy.value = ""; }
  }

  return { opBusy, flash, busyFor, withdraw, hide };
}
