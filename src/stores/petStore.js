import { reactive, computed } from "vue";
import { i18n, t } from "../i18n.js";
import { todayKey } from "../utils/daily.js";
import { LINES } from "../data/pets.js";
import { DESTS, SOUVENIRS, VISITORS, destByKey } from "../data/adventure.js";
import { ACCESSORIES, MAIL_REPLIES } from "../data/extras.js";
import { getItem, setItem } from "../utils/storage.js";
import { finalReward as snackReward } from "../utils/snackGame.js";

const SAVE_KEY = "warm-paws-multi-pet-v2";
const LEGACY_KEY = "warm-paws-pet-v1";
const BOOK_KEY = "warm-paws-cookbook-v1";
const MOOD_KEY = "warm-paws-mood-v1";

const RATE = {
  hunger: 0.55, mood: 0.40, clean: 0.25, energy: 0.30,
  sleepEnergy: 6,
};

/* ---------- 玩家钱包（全局共享） ---------- */
export const wallet = reactive({ coins: 50 });

function readSave() {
  try { return JSON.parse(getItem(SAVE_KEY)) || {}; }
  catch (e) { return {}; }
}

wallet.load = function () {
  try { wallet.coins = readSave().coins ?? 50; } catch (e) {}
};

wallet.save = function () {
  const raw = readSave();
  raw.coins = wallet.coins;
  setItem(SAVE_KEY, JSON.stringify(raw));
};

/* ---------- 宠物工厂 ---------- */
function uid() {
  return "p" + Date.now().toString(36) + Math.floor(Math.random() * 1000);
}

export function makePet(species, name, personality, custom = null) {
  return {
    id: uid(),
    species,                    // cat/dog/rabbit/dino/otter/custom
    name: name || "Buddy",
    personality: personality || "gentle",
    custom,                     // 自定义立绘: { img, lines: [] } 或 null
    wear: null,                 // 佩戴的装扮 key（accessories）
    hunger: 80, mood: 80, clean: 80, energy: 80,
    level: 1, exp: 0,
    sleeping: false,
    lastTick: Date.now(),
  };
}

/* ---------- 宠物栏 ---------- */
export const petStore = reactive({
  pets: [],
  activeId: null,

  load() {
    const raw = readSave();
    if (raw.pets && raw.pets.length) {
      this.pets = raw.pets;
      this.activeId = raw.activeId || raw.pets[0].id;
      wallet.coins = raw.coins ?? 50;
      return;
    }
    // 旧版单宠物存档迁移
    try {
      const legacy = JSON.parse(getItem(LEGACY_KEY));
      if (legacy) {
        const old = makePet("cat", "Mandarin", "gentle");
        Object.assign(old, {
          hunger: legacy.hunger ?? 80, mood: legacy.mood ?? 80,
          clean: legacy.clean ?? 80, energy: legacy.energy ?? 80,
          level: legacy.level ?? 1, exp: legacy.exp ?? 0,
        });
        this.pets = [old];
        this.activeId = old.id;
        return;
      }
    } catch (e) {}
    // 全新玩家：送一只小橘猫
    const first = makePet("cat", "Mandarin", "gentle");
    this.pets = [first];
    this.activeId = first.id;
    wallet.coins = 50;
  },

  save() {
    setItem(SAVE_KEY, JSON.stringify({
      coins: wallet.coins,
      pets: this.pets,
      activeId: this.activeId,
    }));
  },

  adopt(species, name, personality, custom = null) {
    const pet = makePet(species, name, personality, custom);
    this.pets.push(pet);
    this.activeId = pet.id;
    this.save();
    return pet;
  },

  switchTo(id) {
    if (this.pets.some((p) => p.id === id)) {
      this.activeId = id;
      this.save();
    }
  },
});

export const activePet = computed(
  () => petStore.pets.find((p) => p.id === petStore.activeId) || petStore.pets[0]
);

/* ---------- 台词 ---------- */
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function sceneLines(pet, scene) {
  const set = LINES[pet.personality] || LINES.gentle;
  const entry = set[scene];
  if (!entry) return [];
  // 自定义角色的专属台词混入 idle
  if (scene === "idle" && pet.custom && Array.isArray(pet.custom.lines)) {
    const extra = pet.custom.lines.filter(Boolean);
    return { en: [...entry.en, ...extra], zh: [...entry.zh, ...extra] };
  }
  return entry;
}

/* ---------- 气泡与动画信号 ---------- */
export const petUi = reactive({
  speech: "",
  happyTick: 0,
});

let sayTimer = null;
export function say(text, ms = 3200) {
  petUi.speech = text;
  clearTimeout(sayTimer);
  sayTimer = setTimeout(() => { petUi.speech = ""; }, ms);
}

export function jump() { petUi.happyTick++; }

function sayLine(pet, scene, ms = 3200) {
  const entry = sceneLines(pet, scene);
  const pool = i18n.locale === "zh" ? entry.zh : entry.en;
  if (pool && pool.length) say(pick(pool), ms);
}

export function talkByStatus(pet) {
  if (!pet) return;
  if (pet.sleeping) return say("呼…呼…💤 / Zzz…");
  if (pet.hunger < 30) return sayLine(pet, "hungry");
  if (pet.energy < 25) return sayLine(pet, "sleepy");
  if (pet.clean < 30) return sayLine(pet, "dirty");
  if (pet.mood < 30) return sayLine(pet, "sad");
  sayLine(pet, "idle");
}

/* ---------- 成长 ---------- */
export function expNeeded(level) { return level * 100; }

function gainExp(pet, amount) {
  pet.exp += amount;
  let leveled = false;
  while (pet.exp >= expNeeded(pet.level)) {
    pet.exp -= expNeeded(pet.level);
    pet.level += 1;
    wallet.coins += pet.level * 10;
    leveled = true;
  }
  if (leveled) {
    sayLine(pet, "leveled", 4000);
    jump();
  }
}

/* ---------- 工具 ---------- */
function clamp(v, min = 0, max = 100) { return Math.max(min, Math.min(max, v)); }
function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

/* ---------- 存档与离线结算 ---------- */
export function savePet() {
  petStore.pets.forEach((p) => { p.lastTick = Date.now(); });
  petStore.save();
}

function applyOffline(pet) {
  const mins = Math.min((Date.now() - pet.lastTick) / 60000, 720);
  if (mins < 3) return;
  pet.hunger = clamp(pet.hunger - RATE.hunger * mins);
  pet.clean = clamp(pet.clean - RATE.clean * mins);
  pet.energy = clamp(pet.sleeping ? pet.energy + RATE.sleepEnergy * mins : pet.energy - RATE.energy * mins);
  pet.mood = clamp(pet.mood - RATE.mood * mins - (pet.hunger < 30 ? 0.3 * mins : 0));
  pet.sleeping = false;
}

export function initPet() {
  wallet.load();
  petStore.load();
  petStore.pets.forEach(applyOffline);
  petStore.pets.forEach((p) => { if (p.wear === undefined) p.wear = null; });
  initAdventure();
  initMailbox();
  const first = activePet.value;
  if (first && petStore.pets.length === 1 && !getItem(LEGACY_KEY)) {
    setTimeout(() => sayLine(first, "hello", 4000), 600);
  }
}

export function tickPet() {
  petStore.pets.forEach((pet) => {
    if (pet.sleeping) {
      pet.energy = clamp(pet.energy + RATE.sleepEnergy / 60);
      if (pet.energy >= 100) {
        pet.sleeping = false;
        if (pet.id === petStore.activeId) { sayLine(pet, "sleepOut"); jump(); }
      }
    } else {
      // 非当前宠物衰减减半
      const off = pet.id === petStore.activeId ? 1 : 0.5;
      pet.hunger = clamp(pet.hunger - (RATE.hunger / 60) * off);
      pet.mood = clamp(pet.mood - (RATE.mood / 60) * off - (pet.hunger < 30 ? 0.3 / 60 : 0));
      pet.clean = clamp(pet.clean - (RATE.clean / 60) * off);
      pet.energy = clamp(pet.energy - (RATE.energy / 60) * off);
    }
  });
}

/* ---------- 互动（作用于当前宠物） ---------- */
function cur() { return activePet.value; }

export function doPlay() {
  const pet = cur();
  if (!pet || pet.sleeping) return;
  if (pet.energy < 15 || pet.hunger < 15) return sayLine(pet, "tired");
  pet.mood = clamp(pet.mood + rand(15, 25));
  pet.energy = clamp(pet.energy - 10);
  pet.hunger = clamp(pet.hunger - 6);
  wallet.coins += 2;
  gainExp(pet, 15);
  sayLine(pet, "play");
  jump();
  markTask("play");
  petStore.save();
}

export function doPetting() {
  const pet = cur();
  if (!pet || pet.sleeping) return;
  pet.mood = clamp(pet.mood + rand(8, 12));
  wallet.coins += pet.mood >= 60 ? 2 : 1;
  gainExp(pet, 5);
  sayLine(pet, "petting");
  jump();
  petStore.save();
}

export function doClean() {
  const pet = cur();
  if (!pet || pet.sleeping) return;
  if (pet.clean >= 95) return;
  pet.clean = 100;
  pet.energy = clamp(pet.energy - 5);
  gainExp(pet, 8);
  sayLine(pet, "clean");
  jump();
  petStore.save();
}

export function toggleSleep() {
  const pet = cur();
  if (!pet) return;
  if (pet.sleeping) {
    pet.sleeping = false;
    sayLine(pet, "sleepOut");
  } else {
    if (pet.energy >= 95) return;
    pet.sleeping = true;
    sayLine(pet, "sleepIn", 4000);
  }
  petStore.save();
}

/* ---------- 手绘食谱 ---------- */
function loadCookbook() {
  try { return JSON.parse(getItem(BOOK_KEY)) || []; }
  catch (e) { return []; }
}

export const cookbook = reactive(loadCookbook());

export function saveCookbook() {
  try { setItem(BOOK_KEY, JSON.stringify(cookbook)); } catch (e) { console.warn(e); }
}

export function addDish(dish) {
  cookbook.unshift(dish);
  if (cookbook.length > 24) cookbook.pop();
  saveCookbook();
  markTask("draw");
}

export function removeDish(id) {
  const i = cookbook.findIndex((d) => d.id === id);
  if (i >= 0) { cookbook.splice(i, 1); saveCookbook(); }
}

export function feedDish(dish) {
  const pet = cur();
  if (!pet || pet.sleeping) return;
  if (pet.hunger >= 98) return sayLine(pet, "full");
  const e = dish.effort || 40;
  pet.hunger = clamp(pet.hunger + 25 + Math.round(e * 0.25));
  pet.mood = clamp(pet.mood + 8 + Math.round(e * 0.15));
  wallet.coins += 1 + Math.round(e / 20);
  gainExp(pet, 12 + Math.round(e / 10));
  sayLine(pet, "handFed");
  jump();
  markTask("feed");
  petStore.save();
}

/* ---------- 零食雨结算：分数 → 四维/金币/经验 ---------- */
export function applySnackRain(score) {
  const pet = cur();
  if (!pet) return null;
  const r = snackReward(score);
  pet.hunger = clamp(pet.hunger + r.hunger);
  pet.mood = clamp(pet.mood + r.mood);
  wallet.coins += r.coins;
  gainExp(pet, r.exp);
  if (score >= 5) markTask("feed");
  sayLine(pet, "play");
  jump();
  petStore.save();
  return r;
}

/* ---------- 心情打卡 ---------- */
function loadMood() {
  try { return JSON.parse(getItem(MOOD_KEY)) || {}; }
  catch (e) { return {}; }
}

export const moodLog = reactive(loadMood());

export function saveMoodLog() {
  try { setItem(MOOD_KEY, JSON.stringify(moodLog)); } catch (e) { console.warn(e); }
}

export function checkInMood(index) {
  const key = todayKey();
  if (moodLog[key] !== undefined) return false;
  moodLog[key] = index;
  saveMoodLog();
  const pet = cur();
  if (pet) {
    pet.mood = clamp(pet.mood + 5 + (index <= 1 ? 3 : 0));
    gainExp(pet, 8);
  }
  wallet.coins += 3;
  markTask("mood");
  petStore.save();
  return true;
}

export function moodStreak() {
  let n = 0;
  const d = new Date();
  for (;;) {
    const key = todayKey();
    if (moodLog[key] === undefined) break;
    n++;
    d.setDate(d.getDate() - 1);
  }
  return n;
}

/* ---------- 每日任务 ---------- */
const TASK_KEY = "warm-paws-tasks-v1";
const TASK_DEFS = [
  { key: "feed", coin: 10, expPet: 10 },
  { key: "mood", coin: 8 },
  { key: "draw", coin: 12 },
  { key: "play", coin: 6 },
  { key: "adv", coin: 14, expPet: 12 },
];

export const TASK_LIST = TASK_DEFS;

export const dailyTasks = reactive(loadTasks());

function loadTasks() {
  try {
    const raw = JSON.parse(getItem(TASK_KEY));
    if (raw && raw.date === todayKey()) return raw;
  } catch (e) {}
  return { date: todayKey(), feed: false, mood: false, draw: false, play: false, adv: false, claimed: false };
}

function saveTasks() {
  try { setItem(TASK_KEY, JSON.stringify(dailyTasks)); } catch (e) {}
}

function markTask(key) {
  if (dailyTasks.date !== todayKey()) return;
  if (!dailyTasks[key]) { dailyTasks[key] = true; saveTasks(); }
}

export function claimTasks() {
  if (dailyTasks.claimed || dailyTasks.date !== todayKey()) return 0;
  let coins = 0;
  TASK_DEFS.forEach((t) => {
    if (dailyTasks[t.key]) {
      coins += t.coin;
      if (t.expPet) {
        const pet = cur();
        if (pet) gainExp(pet, t.expPet);
      }
    }
  });
  wallet.coins += coins;
  dailyTasks.claimed = true;
  saveTasks();
  petStore.save();
  return coins;
}

/* ═══════════ 旅行青蛙式冒险系统 ═══════════ */
const ADV_KEY = "warm-paws-adventure-v1";

function loadAdventure() {
  try { return JSON.parse(getItem(ADV_KEY)) || {}; } catch (e) { return {}; }
}

export const adventure = reactive((() => {
  const raw = loadAdventure();
  return {
    status: raw.status || "home",       // home | away
    petId: raw.petId || null,
    departedAt: raw.departedAt || 0,
    returnsAt: raw.returnsAt || 0,
    destKey: raw.destKey || "",
    dishName: raw.dishName || "",
    postcards: Array.isArray(raw.postcards) ? raw.postcards : [],
    souvenirs: Array.isArray(raw.souvenirs) ? raw.souvenirs : [],
    visitor: raw.visitor || null,
    clovers: raw.clovers ?? 3,
    lastCloverAt: raw.lastCloverAt || Date.now(),
    lastVisitorAt: raw.lastVisitorAt || Date.now(),
    friendship: raw.friendship || 0,    // 招待访客次数（下次旅行带回额外特产）
    trips: raw.trips || 0,
    welcome: null,                       // 会话内回乡通知 { coins, souvenirs, destKey }
  };
})());

export function saveAdventure() {
  try {
    setItem(ADV_KEY, JSON.stringify({
      status: adventure.status, petId: adventure.petId,
      departedAt: adventure.departedAt, returnsAt: adventure.returnsAt,
      destKey: adventure.destKey, dishName: adventure.dishName,
      postcards: adventure.postcards, souvenirs: adventure.souvenirs,
      visitor: adventure.visitor, clovers: adventure.clovers,
      lastCloverAt: adventure.lastCloverAt, lastVisitorAt: adventure.lastVisitorAt,
      friendship: adventure.friendship, trips: adventure.trips,
    }));
  } catch (e) { console.warn(e); }
}

/* 当前显示的宠物是否正在旅行 */
export const activePetAway = computed(
  () => adventure.status === "away" && activePet.value && adventure.petId === activePet.value.id
);

/* 出发：带上（可选）一份手绘料理 */
export function departAdventure(dish) {
  const pet = activePet.value;
  if (!pet || pet.sleeping || adventure.status === "away") return false;
  adventure.status = "away";
  adventure.petId = pet.id;
  adventure.departedAt = Date.now();
  const mins = adventure.trips === 0 ? 2 : 4 + Math.floor(Math.random() * 5); // 首次 2 分钟，之后 4-8 分钟
  adventure.returnsAt = adventure.departedAt + mins * 60000;
  adventure.destKey = DESTS[Math.floor(Math.random() * DESTS.length)].key;
  adventure.dishName = dish ? dish.name : "";
  adventure.welcome = null;
  saveAdventure();
  say(t("adventure.departed", { n: pet.name }), 5000);
  return true;
}

/* 旅行归来：生成明信片 + 特产 + 奖励 */
function completeAdventure() {
  const pet = petStore.pets.find((p) => p.id === adventure.petId) || activePet.value;
  const dest = destByKey(adventure.destKey);
  const pickDest = () => destByKey(DESTS[Math.floor(Math.random() * DESTS.length)].key);

  /* 明信片 1-3 张（带 food 更容易拍出更多照片） */
  const nCards = 1 + (Math.random() < .6 ? 1 : 0) + (adventure.dishName ? 1 : 0);
  const span = Math.max(1, adventure.returnsAt - adventure.departedAt);
  const cards = [];
  for (let i = 0; i < nCards; i++) {
    const d = i === 0 ? dest : pickDest();
    cards.push({
      destKey: d.key,
      ts: adventure.departedAt + Math.round(span * ((i + 1) / (nCards + 1))),
      petSpecies: pet ? pet.species : "cat",
    });
  }

  /* 特产 1-3 件（招待过访客会带回额外 1 件回礼） */
  let nSouv = 1 + (Math.random() < .35 ? 1 : 0);
  if (adventure.friendship > 0) { nSouv++; adventure.friendship--; }
  const gained = [];
  for (let i = 0; i < nSouv; i++) {
    const d = i === 0 ? dest : pickDest();
    const list = SOUVENIRS[d.key] || [];
    if (!list.length) continue;
    const key = d.key + ":" + Math.floor(Math.random() * list.length);
    const found = adventure.souvenirs.find((s) => s.key === key);
    if (found) found.n++;
    else adventure.souvenirs.push({ key, n: 1 });
    gained.push(key);
  }

  /* 奖励与状态 */
  const coins = 12 + Math.floor(Math.random() * 14) + (adventure.dishName ? 6 : 0);
  wallet.coins += coins;
  if (pet) {
    pet.mood = clamp(pet.mood + 12);
    pet.energy = clamp(pet.energy + 20);
    pet.hunger = clamp(pet.hunger - 18);
    pet.clean = clamp(pet.clean - 6);
    gainExp(pet, 20);
  }

  adventure.postcards.unshift(...cards);
  if (adventure.postcards.length > 30) adventure.postcards.length = 30;
  adventure.status = "home";
  adventure.trips++;
  adventure.welcome = { coins, souvenirs: gained, destKey: dest.key };
  markTask("adv");
  saveAdventure();
  petStore.save();
  say(t("adventure.welcomeBack", { n: pet ? pet.name : "?" }), 5000);
}

/* 每秒心跳：三叶草生长 / 访客到访 / 归期检查 */
export function tickAdventure() {
  const now = Date.now();
  if (adventure.clovers < 8 && now - adventure.lastCloverAt >= 75000) {
    adventure.clovers++;
    adventure.lastCloverAt = now;
    saveAdventure();
  }
  if (adventure.status === "home" && !adventure.visitor &&
      now - adventure.lastVisitorAt > 150000 && Math.random() < 0.02) {
    adventure.visitor = VISITORS[Math.floor(Math.random() * VISITORS.length)].key;
    adventure.lastVisitorAt = now;
    saveAdventure();
  }
  if (adventure.status === "away" && now >= adventure.returnsAt) completeAdventure();
}

function initAdventure() {
  if (adventure.status === "away" && Date.now() >= adventure.returnsAt) completeAdventure();
}

/* 收割三叶草 → 金币 */
export function harvestClover() {
  if (adventure.clovers <= 0) return 0;
  const n = adventure.clovers;
  wallet.coins += n * 2;
  adventure.clovers = 0;
  adventure.lastCloverAt = Date.now();
  saveAdventure();
  petStore.save();
  return n;
}

/* 招待访客（消耗一次好感，之后旅行带回回礼） */
export function feedVisitor() {
  if (!adventure.visitor || !cookbook.length) return false;
  wallet.coins += 6;
  adventure.friendship++;
  adventure.visitor = null;
  adventure.lastVisitorAt = Date.now();
  saveAdventure();
  petStore.save();
  say(t("adventure.fedVisitor"), 4000);
  return true;
}

/* ═══════════ 装扮系统 ═══════════ */
const WARDROBE_KEY = "warm-paws-wardrobe-v1";

function loadWardrobe() {
  try {
    const r = JSON.parse(getItem(WARDROBE_KEY));
    return Array.isArray(r) ? r : ["daisy"];  // 新玩家送小雏菊
  } catch (e) { return ["daisy"]; }
}

export const wardrobe = reactive({ owned: loadWardrobe() });

function saveWardrobe() {
  try { setItem(WARDROBE_KEY, JSON.stringify(wardrobe.owned)); } catch (e) {}
}

export const accByKey = (key) => ACCESSORIES.find((x) => x.key === key) || null;

/* 购买：成功后自动给当前宠物戴上 */
export function buyAccessory(key) {
  const a = accByKey(key);
  if (!a || wardrobe.owned.includes(key)) return false;
  if (wallet.coins < a.cost) return false;
  wallet.coins -= a.cost;
  wardrobe.owned.push(key);
  const pet = cur();
  if (pet) pet.wear = key;
  saveWardrobe();
  petStore.save();
  return true;
}

/* 佩戴 / 取下（切换） */
export function wearAccessory(key) {
  const pet = cur();
  if (!pet) return false;
  pet.wear = pet.wear === key ? null : key;
  petStore.save();
  return true;
}

/* ═══════════ 手绘上墙（画廊） ═══════════ */
export function toggleFramed(id) {
  const d = cookbook.find((x) => x.id === id);
  if (!d) return false;
  d.framed = !d.framed;
  saveCookbook();
  return d.framed;
}

/* ═══════════ 温暖信箱 ═══════════ */
const MAIL_KEY = "warm-paws-mail-v1";

function loadMail() {
  try {
    const r = JSON.parse(getItem(MAIL_KEY));
    return r && Array.isArray(r.letters) ? r : { letters: [] };
  } catch (e) { return { letters: [] }; }
}

export const mailbox = reactive(loadMail());

function saveMail() {
  try { setItem(MAIL_KEY, JSON.stringify(mailbox)); } catch (e) {}
}

/* 寄出烦恼：45-120 秒后收到宠物回信 */
export function sendLetter(text) {
  const body = (text || "").trim();
  if (!body) return null;
  const ts = Date.now();
  const letter = {
    id: ts, text: body.slice(0, 300),
    reply: "", replyAt: ts + 45000 + Math.floor(Math.random() * 75000),
    ts,
  };
  mailbox.letters.unshift(letter);
  if (mailbox.letters.length > 30) mailbox.letters.pop();
  saveMail();
  return letter;
}

/* 每秒心跳：检查是否到了回信时间 */
export function tickMailbox() {
  const now = Date.now();
  let changed = false;
  mailbox.letters.forEach((l) => {
    if (!l.reply && l.replyAt && now >= l.replyAt) {
      const r = MAIL_REPLIES[Math.floor(Math.random() * MAIL_REPLIES.length)];
      l.reply = i18n.locale === "zh" ? r.zh : r.en;
      changed = true;
    }
  });
  if (changed) {
    saveMail();
    const pet = cur();
    say(t("mail.replyArrived", { n: pet ? pet.name : "" }), 5000);
  }
}

function initMailbox() {
  tickMailbox();
}
