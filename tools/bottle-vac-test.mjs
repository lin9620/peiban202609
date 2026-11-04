/* 轮 339 · 漂流瓶聊天框与会话聊天框「一个组件」单测
 * ------------------------------------------------------------
 * 用户原话：「你这漂流瓶的聊天框要改就一起改啊，保持一致性啊。」
 * 改法：BottleChat 的「已建会话」分支整体交给 DmVacChat（与会话段同一套组件：
 *       消息流 / 输入区 / 表情 / 失败红「!」重发 / 键盘保持 / 上滑加载）。
 *       头部仍用旧那条（头像 + 昵称 + 「温暖漂流瓶」胶囊 + 父级注入的 ⋯ 菜单），
 *       组件的头用 hide-header 藏掉 —— 两段头部/输入区现在完全一致。
 *       数据层一行没换：乐观上屏 / 失败行 / 本地库秒开 / mergeTail / 撤回 / 5s 轮询都在。
 * 运行：node tools/bottle-vac-test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const BC = fs.readFileSync("src/components/BottleChat.vue", "utf8");
const VAC = fs.readFileSync("src/components/DmVacChat.vue", "utf8");
const MV = fs.readFileSync("src/views/MessagesView.vue", "utf8");

let pass = 0;
const fails = [];
const t = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { fails.push(name + " —— " + e.message); }
};
const has = (src, re, msg) => { if (!re.test(src)) throw new Error(msg); };
const no = (src, re, msg) => { if (re.test(src)) throw new Error(msg); };

/* ── ① 复用组件 ── */
t("B1 已建会话分支整个交给 DmVacChat", () => {
  has(BC, /import DmVacChat from "\.\/DmVacChat\.vue"/, "没 import 组件");
  has(BC, /<DmVacChat[\s\S]{0,600}hide-header/, "没用 hide-header（会画出两个头）");
  has(BC, /:messages="msgs"/, "msgs 没喂给组件");
  has(BC, /:room-id="convId"/, "room-id 没喂");
  has(BC, /:me-id="meId"/, "me-id 没喂");
  has(BC, /:peer-name="peerName"/, "peer-name 没喂");
  has(BC, /:loading-messages="loadingMsgs"/, "loading-messages 没喂");
  has(BC, /:placeholder="t\('dm\.placeholder'\)"/, "占位文案没给（与会话段一致）");
  has(BC, /:peer="vacPeer"/, "合成 room 的对方信息没给");
});

t("B2 事件四件套：发送 / 撤回 / 上滑加载 / 失败重发", () => {
  has(BC, /@send="sendText"/, "发送没接");
  has(BC, /@recall="recallById"/, "撤回没接");
  has(BC, /@load-more="loadMore"/, "加载更早没接");
  has(BC, /@resend="resend"/, "失败重发没接");
});

t("B3 旧的自绘消息流/输入区全退场（不许两套并存）", () => {
  no(BC, /van-field/, "还在用旧输入框");
  no(BC, /dm-compose/, "还在用旧输入区样式");
  no(BC, /dm-send-btn/, "还在画旧发送按钮");
  no(BC, /holdCompose|releaseCompose|taOf/, "高度钉子代码还在（组件自己的键盘逻辑才是对的）");
  no(BC, /requestAnimationFrame\(chase\)|listRevealed|entryReady/, "滚动/揭示状态机还在（组件自己管滚动）");
  no(BC, /dm-scroll(?! bchat-letter)/, "旧消息容器还在（留给原信卡的 bchat-letter 除外）");
});

/* ── ② 数据层没被换掉（只换画法） ── */
t("B4 发送链：乐观上屏 + msg_id 就地落位 + 失败行留痕", () => {
  has(BC, /async function sendText\(raw\)/, "sendText 没了");
  has(BC, /id: nextTempId\(\)/, "乐观行 id 不走生成器");
  has(BC, /r\.msg_id/, "确认回写没做");
  has(BC, /const rest = msgs\.value\.filter\(\(m\) => String\(m\.id\) !== String\(temp\.id\)\)/, "确认回写没去重");
  has(BC, /failed: true/, "失败行没标");
  has(BC, /msgs\.value\.concat\(\[failedRow\]\)/, "失败行没留在列表里");
  const bcSend = (() => {
    const i = BC.indexOf("async function sendText(raw)");
    return BC.slice(i, BC.indexOf("\n}", i));
  })();
  assert.ok(bcSend.length > 200, "sendText 体被掏空了");
});

t("B5 本地库秒开 / 合并 / 撤回落盘 / 轮询合并一个没少", () => {
  has(BC, /dmStoreLoad\(props\.meId, id\)/, "本地库没读");
  has(BC, /dmStoreUpsert\((?:props\.meId|owner), id, temp\)/, "乐观行没立刻落本地库");
  has(BC, /dmStoreSave\(props\.meId, id, msgs\.value, hasMore\.value\)/, "本地库没写");
  has(BC, /idbMerge\(id, msgs\.value\)/, "IndexedDB 镜像没做");
  has(BC, /mergeTail\(msgs\.value, asc\)/, "尾部增量合并没做");
  has(BC, /const pend = msgs\.value\.filter\(\(m\) => m\.id < 0 && !localIds\.has\(String\(m\.id\)\)\);/, "整窗替换没保乐观行");
  has(BC, /const extra = local\.msgs\.filter\(\(m\) => m\.id > 0 && !have\.has\(String\(m\.id\)\)\)/, "同会话本地库刷新会整窗替换/倒灌旧正文");
  has(BC, /dmApi\.markRead\((?:convId\.value|id)\)/, "已读没抬");
  has(BC, /setInterval\(tick, 5000\)/, "5s 轮询没了");
  /* 轮 376：切信后旧请求不得改当前 msgs / 写错本地库 */
  has(BC, /let msgSeq = 0/, "没有切信序号");
  has(BC, /const stale = \(\) => (!alive \|\| )?mySeq !== msgSeq \|\| String\(convId\.value\) !== String\(id\)[\s\S]{0,80}?\(!!owner && props\.meId !== owner\)/, "loadMessages 没有切信/换号双校验");
  has(BC, /if \(stale\(\)\) return;/, "await 后没有丢弃过期响应");
  has(BC, /if \((!alive \|\| )?seq !== msgSeq \|\| String\(convId\.value\) !== String\(id\) \|\| msgsConv !== id \|\| props\.meId !== owner\) return;/, "轮询 await 后没有丢弃旧信/旧账号数据");
  has(BC, /persistInactive\(id, rowSrv, \{ allowCreate: true, replaceId: temp\.id, removeId: temp\.id \}\)/, "发送切走后确认行没落到原会话库/没摘掉乐观行");
});

t("B5b 切信/异常网关/IDB 等待期间的发送竞态", () => {
  has(BC, /if \(props\.meId === owner && String\(convId\.value\) === String\(id\) && msgsConv === id\) \{[\s\S]{0,140}?oldestId\.value = oldestServerId\(msgs\.value\);/, "等 IDB 期间切信后仍会改新信的分页锚点");
  has(BC, /persistInactive\(id, failedRow, \{ allowCreate: true \}\)/, "切信后失败的第一句草稿没落库");
  has(BC, /msgs\.value\.some\(\(m\) => String\(m\.id\) === String\(temp\.id\)\)\s*\?[\s\S]{0,180}?failedRow[\s\S]{0,180}?: msgs\.value\.concat\(\[failedRow\]\)/, "异常网关没回 msg_id / 乐观行已被清屏摘掉时不会补失败行");
  has(BC, /if \(rec && Array\.isArray\(rec\.msgs\) && \(rec\.msgs\.length \|\| allowCreate\)\) await idbMerge\(id, \[row\]\);/, "新会话的第一条确认/失败行没镜像进 IDB");
});

t("B5c 本地库只有失败草稿时，也要从 IndexedDB 顶出完整历史", () => {
  has(BC, /if \(!msgs\.value\.some\(\(m\) => Number\(m\.id\) > 0\) \|\| thinLocal\) \{[\s\S]{0,260}?const rec = await idbLoad\(id\);/, "首屏没从 IDB 补历史");
  has(BC, /msgs\.value = dropEchoedDrafts\(snap\.concat\(keep\), snap\)/, "IDB 历史没有和当前失败草稿合并");
});

t("B5d 首屏网络失败后仍认领当前信，5s 轮询能继续救回", () => {
  has(BC, /if \(!stale\(\) && before == null && msgsConv !== id\) \{ msgs\.value = \[\]; msgsConv = id; \}/, "失败后清空 msgsConv，tick 不再重试");
});

t("B6 组件的 hideHeader：有开关、有注入样式、有开关回滚", () => {
  has(VAC, /hideHeader: \{ type: Boolean, default: false \}/, "hideHeader prop 没了");
  has(VAC, /style\[data-wp-hidehead\]/, "注入的样式没有自己的标记");
  has(VAC, /\.vac-room-header\{display:none !important;\}/, "藏头样式丢了");
  has(VAC, /if \(!props\.hideHeader\) \{ if \(old\) old\.remove\(\); return; \}/, "关掉时不会摘样式");
  has(VAC, /injectTheme\(\); injectBack\(\); injectHead\(\);/, "挂载时没注入");
  has(VAC, /watch\(\(\) => props\.hideHeader/, "prop 变化时没跟随");
});

/* ── ③ 没被换掉的部分（用户要的是「一起改」，不是把漂流瓶功能改没） ── */
t("B7 旧聊天头 + 胶囊 + ⋯ 菜单槽都还在", () => {
  has(BC, /class="dm-thread-head"/, "旧头没了");
  has(BC, /class="bchat-tag"/, "「温暖漂流瓶」胶囊没了");
  has(BC, /<slot name="headtools">/, "父级 ⋯ 菜单槽没了");
  has(BC, /@click="goUser\(peerId\)"/, "点头像/昵称进主页没了");
});

t("B8 待决定/其它状态的原信卡 + 同意拒绝不受影响", () => {
  has(BC, /bchat-card/, "原信卡没了");
  has(BC, /bottle\.chatAccept/, "同意按钮没了");
  has(BC, /async function decide\(accept\)/, "decide 没了");
  has(BC, /emit\("accepted", result\.conv_id\)/, "同意后建会话的回传没了");
  has(BC, /state === 'choose'/, "待决定分支没了");
});

t("B9 输入区口径与会话段一致（组件的输入框 + 键盘保持走同一套）", () => {
  /* 会话段与漂流瓶段都只喂一个 placeholder，键盘/表情/重发全在 DmVacChat 里 */
  has(VAC, /keepKeyboardOpen|preventKeyboardFromClosing/, "组件的键盘保持被删了？（本轮不碰，只确认在）");
  has(BC, /:convs="vacConvs"/, "convs 没传（组件要 room 才画输入区）");
});

t("B8b 切信后旧 decide 不能锁住新信，也不能把旧错误写到新信", () => {
  const i = BC.indexOf("async function decide(accept)");
  const b = BC.slice(i, i + 1500);
  has(b, /const seq = \+\+decideSeq;/, "decide 没有请求序号");
  has(b, /if \((!alive \|\| )?seq !== decideSeq\) \{ emit\("decided", result\.decision\); return; \}/, "旧 decide 回来没作废");
  has(b, /if \(seq === decideSeq\) busyDecide\.value = false;/, "旧 finally 会误解锁新请求");
  const j = BC.indexOf("async function onLetter()");
  has(BC.slice(j, j + 300), /decideSeq\+\+/, "切信时没作废旧 decide");
});

t("B8c 漂流瓶整窗/IDB 首帧也要认领重启前的失败草稿", () => {
  has(BC, /const snap = dropEchoedPending\(latest\);/, "IDB 首帧没先清同快照 pending 重复");
  has(BC, /dropEchoedDrafts\(snap\.concat\(keep\), snap\)/, "IDB 首帧没走认领");
  has(BC, /const snap = dropEchoedPending\(asc\);/, "整窗替换没先清同快照 pending 重复");
  has(BC, /dropEchoedDrafts\(keep\.length \? snap\.concat\(keep\) : snap, snap\)/, "整窗替换没走认领");
});

t("B8d 漂流瓶本地库首帧也不能同时显示失败草稿和已发送行", () => {
  has(BC, /const claimed = claimPendingEcho\(msgs\.value, extra\);/, "同会话补行没先认领 pending");
  has(BC, /dropEchoedDrafts\(add\.length \? claimed\.rows\.concat\(add\) : claimed\.rows, local\.msgs\)/, "同会话补行没认领回显");
  has(BC, /const claimed = claimPendingEcho\(pend, localRows\);/, "首次落屏没先认领 pending");
  has(BC, /const localSnap = dropEchoedPending\(addPend\.length \? localRows\.concat\(addPend\) : localRows\);/, "首次落屏没清同快照 pending 重复");
  has(BC, /dropEchoedDrafts\(localSnap, localRows\)/, "首次落屏没认领回显");
});

t("B8e 漂流瓶全量库首帧也只上最近 400 条", () => {
  has(BC, /const latest = idbRows\.slice\(-400\)/, "全量库首帧没有截到最近 400 条");
  has(BC, /!rec\.serverDone \|\| idbRows\.length > latest\.length/, "截断后没保留“还有更早”");
});

t("B9 漂流瓶上滑先吃 IndexedDB，断网也能翻更早", () => {
  has(BC, /idbOlderThan/, "loadMore 没接 IndexedDB 上一页");
  has(BC, /msgs\.value = add\.concat\(msgs\.value\)/, "本地上一页没插到列表顶部");
  has(BC, /hasMore\.value = true/, "本地翻页后没保留继续上滑");
  has(BC, /let loadingOlder = false;/, "上滑没有并发闸门");
  has(BC, /if \(loadingOlder \|\|/, "上滑并发闸门没接进 loadMore");
});

t("B10 漂流瓶发送后切信/换号，旧信不能永远停在发送中", () => {
  has(BC, /const stillSame = props\.meId === owner && String\(convId\.value\) === String\(id\) && msgsConv === id;/, "发送回包没定住旧信");
  has(BC, /else if \(!stillSame\) \{[\s\S]{0,180}dmStoreUpsert\(owner, id, failedRow\)/, "切走后没把旧信降级成失败草稿");
});

t("B11 漂流瓶本地只剩一两条已发送时，也要从 IndexedDB 补历史", () => {
  has(BC, /const thinLocal = msgs\.value\.length > 0 && msgs\.value\.length < 5;/, "缺“本地只有几条”判定");
  has(BC, /!msgs\.value\.some\(\(m\) => Number\(m\.id\) > 0\) \|\| thinLocal/, "IDB 首帧没覆盖薄本地库");
});

t("B12 漂流瓶聊天草稿切分段/换信不丢", () => {
  has(BC, /drafts: \{ type: Object, default: \(\) => \(\{\}\) \}/, "BottleChat 没接父级草稿表");
  has(BC, /:drafts="drafts"/, "草稿表没传给 DmVacChat");
  has(BC, /@draft="\(e\) => emit\('draft', e\)"/, "DmVacChat 的 draft 事件没转发给父页");
  has(MV, /:drafts="vacDrafts"/, "消息页没把草稿表传给漂流瓶聊天");
  has(MV, /@draft="onVacDraft"/, "消息页没接漂流瓶聊天的 draft 事件");
});

t("B14 漂流瓶卸载后，在途 load/tick/decide 不能再写库、抬已读或 emit accepted", () => {
  has(BC, /let alive = true;/, "没有卸载存活标记");
  has(BC, /const stale = \(\) => !alive \|\|/, "loadMessages 没把卸载算过期");
  has(BC, /if \(!alive \|\| String\(convId\.value\) !== String\(id\)/, "onLetter 回来没挡卸载");
  has(BC, /if \(!alive \|\| seq !== decideSeq\)/, "decide 回来没挡卸载");
  has(BC, /onBeforeUnmount\(\(\) => \{[\s\S]{0,240}?alive = false;[\s\S]{0,120}?msgSeq\+\+;[\s\S]{0,120}?decideSeq\+\+;[\s\S]{0,120}?clearInterval\(timer\);/, "卸载时没有作废在途请求");
});

t("B13 本地只剩 1~4 条更早历史也要先上屏", () => {
  has(BC, /if \(idbRows\.length > 0\) \{/, "漂流瓶上滑又退回 >=5 才用本地页");
  has(MV, /if \(idbRows\.length > 0\) \{/, "会话段上滑又退回 >=5 才用本地页");
});

t("B15 漂流瓶快速 A→B→A：确认/失败行不能写进空窗口或覆盖原信历史", () => {
  has(BC, /const sameWindow = \(\) => onSame\(\) && String\(msgsConv\) === String\(id\);/, "发送回包缺少“当前窗口仍是这封信”校验");
  has(BC, /else if \(sameWindow\(\)\) \{[\s\S]{0,420}?rest\.concat\(\[rowSrv\]\)/, "确认行仍用 onSame 直接改当前列表");
  has(BC, /sameAccount && sameWindow\(\) \? findSentEcho/, "失败/超时仍可能拿别的信的回显来认领");
  has(BC, /else if \(sameWindow\(\)\) \{[\s\S]{0,220}?msgs\.value\.concat\(\[failedRow\]\)/, "失败行仍用 onSame 直接改当前列表");
  has(BC, /if \(onSame\(\)\) \{[\s\S]{0,180}?sendErr\.value = t\(sendErrKey\(e\)\);[\s\S]{0,120}?\}\s*await persistInactive\(id, failedRow/, "切回 A 但窗口未装回时，失败行没落 A 的库/错误没提示");
});

t("B16 漂流瓶网络历史页全是已上屏行时，不能卡在同一页", () => {
  has(BC, /const add = asc\.filter\(\(m\) => !seen\.has\(String\(m\.id\)\)\);/, "网络页没先算新增行");
  has(BC, /hasMore\.value = rows\.length === 30 && add\.length > 0;/, "整页重复时仍保留 hasMore，用户会反复拉同一页");
  has(BC, /if \(!alive \|\| !owner \|\| props\.meId !== owner \|\| String\(convId\.value\) !== String\(id\) \|\| msgsConv !== id\) return;/, "loadMore 等待 IDB 后没挡卸载");
});

t("B17c 首屏加载期间轮询不能把最新 20 条当整段历史落库", () => {
  const i = BC.indexOf("async function tick()");
  const b = BC.slice(i, i + 260);
  has(b, /if \(loadingMsgs\.value\) return;/, "tick 没等 loadMessages 落定，可能先整窗写 20 条");
});

t("B17b 清屏时必须清掉窗口归属，A→B→A 不能拿一条确认行覆盖历史", () => {
  const i = BC.indexOf("async function loadMessages(");
  const b = BC.slice(i, i + 900);
  has(b, /if \(msgsConv !== id\) \{[\s\S]{0,260}?msgsConv = "";/, "清屏后仍保留上一封信的窗口归属");
  has(BC, /else if \(sameWindow\(\)\) \{[\s\S]{0,420}?dmStoreSave\(props\.meId, id, msgs\.value/, "同窗口仍整窗落库");
  has(BC, /if \(onSame\(\)\) msgs\.value = msgs\.value\.filter\(\(m\) => String\(m\.id\) !== String\(temp\.id\)\);/, "回到旧信但窗口没装回时，乐观行没从错误列表摘掉");
});

t("B17d 消息页被缓存到后台时，漂流瓶轮询/已读要一起停", () => {
  has(BC, /pageActive: \{ type: Boolean, default: true \}/, "没接父页 pageActive");
  has(BC, /const canClearRead = \(id\) =>[\s\S]{0,180}?props\.pageActive[\s\S]{0,180}?document\.hidden\)/, "后台仍可能替漂流瓶清红点");
  has(BC, /if \(!alive \|\| !props\.pageActive\) return;/, "父页后台时轮询没停");
  has(BC, /watch\(\(\) => props\.pageActive,[\s\S]{0,160}?onBottleVisible\(\);[\s\S]{0,80}?tick\(\);/, "回到消息页没补已读/尾部");
  has(MV, /:page-active="!wasDeactivated"/, "父页没把后台状态传给漂流瓶聊天");
});

t("B17 漂流瓶在后台收到消息不能替用户清红点，回前台要补一次", () => {
  has(BC, /const canClearRead = \(id\) =>[\s\S]{0,180}?document\.hidden\)/, "清已读没判断前台/当前信");
  has(BC, /function markBottleRead\(id\)[\s\S]{0,140}?refreshBadge\(\{ after: dmApi\.markRead\(id\)/, "清已读没统一入口");
  has(BC, /if \(added\) markBottleRead\(id\);/, "轮询新增仍无条件 markRead");
  has(BC, /addEventListener\("visibilitychange", onBottleVisible\)/, "回前台没补已读");
  has(BC, /removeEventListener\("visibilitychange", onBottleVisible\)/, "卸载没解绑 visibilitychange");
});

console.log(`bottle-vac-test: ${pass} pass, ${fails.length} fail`);
if (fails.length) { for (const f of fails) console.log("  FAIL " + f); process.exit(1); }
