/* 心情打卡连续天数纯逻辑单测：node tools/mood-test.mjs
 * 回归重点：moodStreak() 曾用 todayKey() 逐日往前翻（key 不随 d 变化），
 * 今日一打卡就会永远命中同一个有值的 key → 无限循环 → 点击打卡后整页卡死。
 */
import { readFileSync } from "node:fs";
import { moodLog, moodStreak, checkInMood, MAX_STREAK_DAYS } from "../src/stores/petStore.js";
import { dateKey } from "../src/utils/daily.js";
import { mergeMoodLogs, normMoodLog, sameMoodLog } from "../src/utils/moodRules.js";

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("PASS ", n); } else { fail++; console.log("FAIL ", n); } };

/* 清空存档：moodLog 是 reactive 对象，直接删键还原「从未打卡」 */
function resetLog() {
  for (const k of Object.keys(moodLog)) delete moodLog[k];
}
/* 造 n 天连续打卡（offset 0 = 今天） */
function seedStreak(n, offset = 0) {
  for (let i = 0; i < n; i++) {
    const d = new Date();
    d.setDate(d.getDate() - (offset + i));
    moodLog[dateKey(d)] = 1;
  }
}
const ms = (fn) => { const t = Date.now(); const v = fn(); return { v, dt: Date.now() - t }; };

/* —— T1 未打卡 —— */
resetLog();
ok("T1 无存档时连续天数为 0", moodStreak() === 0);

/* —— T2 回归：今日打卡后必须立刻返回（旧实现此处死循环）—— */
resetLog();
const t2 = ms(() => { checkInMood(1); return moodStreak(); });
ok("T2 今日打卡后连续天数 = 1（不再卡死）", t2.v === 1);
ok("T2b 今日打卡调用在 300ms 内返回", t2.dt < 300);

/* —— T3 连续三天 —— */
resetLog();
seedStreak(3);
ok("T3 今天+昨天+前天 = 3", moodStreak() === 3);

/* —— T4 中间断档只数连续段 —— */
resetLog();
seedStreak(2);
moodLog[dateKey(new Date(Date.now() - 5 * 86400000))] = 1;   // 空出第 3、4 天
ok("T4 断档后只数到今天为止的连续段", moodStreak() === 2);

/* —— T5 只算到今天为止：未来日期不参与 —— */
resetLog();
seedStreak(1);
const future = new Date(); future.setDate(future.getDate() + 1);
moodLog[dateKey(future)] = 1;
ok("T5 明天不参与今天开始的连续统计", moodStreak() === 1);

/* —— T6 今天未打卡但昨天打过 = 0（连续段从今天起算）—— */
resetLog();
seedStreak(3, 1);
ok("T6 今日未打卡则为 0", moodStreak() === 0);

/* —— T7 异常存档不会失控：有硬上限 —— */
resetLog();
seedStreak(MAX_STREAK_DAYS + 500);
const t7 = ms(() => moodStreak());
ok("T7 超长存档被上限截断", t7.v === MAX_STREAK_DAYS && t7.dt < 3000);

/* —— T8 重复打卡不叠加 —— */
resetLog();
checkInMood(2);
const second = checkInMood(3);
ok("T8 同一天重复打卡返回 false", second === false && moodStreak() === 1);
ok("T8b 当天心情保留首次记录", moodLog[dateKey()] === 2);

/* —— T9 空档后重新打卡从 1 开始 —— */
resetLog();
seedStreak(5, 3);
checkInMood(0);
ok("T9 隔了几天再打卡则连续天数重置为 1", moodStreak() === 1);

/* —— T10 上限常量合理（一年内，且大于任何合理连续天数）—— */
ok("T10 上限常量 = 3660", MAX_STREAK_DAYS === 3660);

/* —— T11 跨设备同步：只接受合法日期 + 0~4 的整数 —— */
const dirty = normMoodLog({
  "2026-11-1": 0,
  "2026-11-2": "4",
  "2026-13-1": 2,      // 非法月份
  "2026-11-3": 5,      // 越界
  "2026-11-4": -1,     // 越界
  "2026-11-5": "x",    // 非数字
  bad: 2,
});
ok("T11 脏云档归一化：合法项保留、非法键/值丢弃",
  JSON.stringify(dirty) === JSON.stringify({ "2026-11-1": 0, "2026-11-2": 4 }));

/* —— T12 并集：不能因为整包覆盖丢掉另一台设备的日期 —— */
const localMoods = { "2026-11-1": 1, "2026-11-2": 2 };
const cloudMoods = { "2026-11-2": 3, "2026-11-3": 4 };
const mergedLocal = mergeMoodLogs(localMoods, cloudMoods, false);
ok("T12 合并取并集，同一天默认保留本地",
  JSON.stringify(mergedLocal) === JSON.stringify({ "2026-11-1": 1, "2026-11-2": 2, "2026-11-3": 4 }));
ok("T12b 云档较新时才让云端覆盖同一天",
  mergeMoodLogs(localMoods, cloudMoods, true)["2026-11-2"] === 3);
ok("T12c 合并不修改入参",
  localMoods["2026-11-2"] === 2 && cloudMoods["2026-11-2"] === 3);

/* —— T13 等价判断忽略键顺序，供「是否需要落盘」使用 —— */
ok("T13 sameMoodLog 忽略键顺序",
  sameMoodLog({ "2026-11-1": 1, "2026-11-2": 2 }, { "2026-11-2": 2, "2026-11-1": 1 }));
ok("T13b sameMoodLog 能识别值差异",
  !sameMoodLog({ "2026-11-1": 1 }, { "2026-11-1": 2 }));

/* —— T14 接线锁：云端存档带 moods；换号先撤队列、新域就位后再拉云 —— */
const storeSrc = readFileSync(new URL("../src/stores/petStore.js", import.meta.url), "utf8");
ok("T14 推云 state 含 moods", /moods:\s*normMoodLog\(moodLog\)/.test(storeSrc));
ok("T14b 拉云合并 moods（不是整包覆盖）",
  /mergeMoodLogs\(localMoods, cloudState && cloudState\.moods/.test(storeSrc));
ok("T14c 换号 reload 先撤云队列、再拉新域云档",
  /cancelCloudPush\(\);[\s\S]{0,800}pullCloudPet\(\);/.test(storeSrc));
ok("T14d 云推/拉带账号域守卫",
  /petScopeId\(\) !== String\(uid\)/.test(storeSrc));

/* —— T15 今日是否已打卡只看账号域 moodLog，不再看设备级 wp-mood-* —— */
const todaySrc = readFileSync(new URL("../src/components/TodayPane.vue", import.meta.url), "utf8");
const railsSrc = readFileSync(new URL("../src/components/SideRails.vue", import.meta.url), "utf8");
ok("T15 TodayPane 已打卡状态来自 moodLog",
  /const checkedToday = computed\(\(\) => moodPicked\.value !== undefined\)/.test(todaySrc)
    && !/getItem\("wp-mood-"/.test(todaySrc));
ok("T15b SideRails 已打卡状态来自 moodLog",
  /const checkedToday = computed\(\(\) => moodLog\[todayKey\(\)\] !== undefined\)/.test(railsSrc)
    && !/getItem\("wp-mood-"/.test(railsSrc));

console.log(`\nTOTAL ${pass + fail}  PASS ${pass}  FAIL ${fail}`);
process.exit(fail ? 1 : 0);