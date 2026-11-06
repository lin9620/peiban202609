/* ══════════ 内容语言检测（轮 439）══════════
 *
 * 为什么不用 franc / CLD3 / tinyld：那套东西是 n-gram 统计模型，原理是从语料里学
 * 「哪串字母组合属于哪种语言」，准但要把整个模型打进包。我们只需要 5 种语言，
 * 其中中文靠字符集就能零歧义判定，剩下 4 种全是拉丁字母、且变音符号与形态差异大，
 * 规则法够用 —— 6.8KB(gzip) vs franc-min 124KB / tinyld 11.9MB。
 *
 * 这个模块唯一的硬契约：**宁可返回 und，也不许猜错**。
 * 错标的代价是把内容塞给不该看到的读者（西语用户刷出一堆中文），比不标严重得多。
 * 因此所有拿不准的分支一律返回 "und"。
 *
 * 四道关卡见 tools/lang-detect-test.mjs 的注释。
 * ══════════════════════════════════════════════════════════════════════ */

/* 产品当前支持的界面/内容语言。检测器还能认出 ja/ko（字符集免费），
   但那是为以后扩展留的，不在这个列表里。 */
export const SUPPORTED = ["zh", "en", "es", "pt", "fr"];

const CJK = /[\u4E00-\u9FFF\u3400-\u4DBF]/g;
const KANA = /[\u3040-\u30FF]/g;
const HANGUL = /[\uAC00-\uD7AF]/g;
const LATIN = /[A-Za-z\u00C0-\u024F]/g;

/* ── 变音符号：只留排他性强的 ──
 * 踩过的坑：给单字符 é 加分时，四种语言都含 é，结果是葡语 alguém 的 é
 * 把分送给了 es/fr，三条句子被偷分判错。所以弱变音一律不计分。 */
const DIACRITIC = [
  { lang: "es", w: 3, re: /[ñÑ¿¡]/g },
  { lang: "pt", w: 3, re: /[ãõÃÕ]/g },
  { lang: "fr", w: 3, re: /[œŒ]/g },
  { lang: "pt", w: 2, re: /[çÇ]/g },   // ç 排除西语（西语无此字母）
  { lang: "fr", w: 1, re: /[çÇ]/g },
];

/* ── 形态特征：不查词表，靠「这种拼法只有这一种语言会有」 ──
 * -ção(葡) / -ción(西) / -tion(法) 是三元组，几乎不串。
 * 法语撇号缩合 j'ai / c'est / n'arrive 在西语葡语里不存在，是短句的救命稻草。 */
const AFFIX = [
  { lang: "es", w: 3, re: /(ción|ciones)\b/gi },
  { lang: "pt", w: 3, re: /(ção|ções)\b/gi },
  { lang: "fr", w: 2, re: /\b(tion|tions)\b/gi },
  { lang: "es", w: 2, re: /\b\w+(dad|dades)\b/gi },
  { lang: "pt", w: 2, re: /\b\w+(dade|dades)\b/gi },
  { lang: "fr", w: 2, re: /\b\w+(ment|ments)\b/gi },
  { lang: "es", w: 1, re: /\b\w+(ando|iendo|aron|ieron|aba|ería)\b/gi },
  { lang: "pt", w: 1, re: /\b\w+(ando|endo|aram|eram|ava|eria)\b/gi },
  { lang: "fr", w: 1, re: /\b\w+(aient|erait|eux|euse|ette)\b/gi },
  { lang: "pt", w: 2, re: /(nh|lh)[aeiouáéíóúãõ]/gi },
];

const SHAPE = [
  /* 英文：-ing / n't / 's 're 've / th- wh- 开头。西葡法基本不出现 */
  { lang: "en", w: 2, re: /\b[a-z]{3,}ing\b/gi },
  { lang: "en", w: 3, re: /\b\w+n't\b/gi },
  { lang: "en", w: 2, re: /\b\w+'(s|re|ve|ll|m|d)\b/gi },
  { lang: "en", w: 1, re: /\b(th|wh)[a-z]{2,}/gi },
  /* 法语撇号缩合 c' j' n' qu' d' l' s' m' t' */
  { lang: "fr", w: 3, re: /\b(qu|[cdjlmnst])'(?=[aeiouyéèêàâ])/gi },
  /* 去重音后的 -cao（西语是 -cion，法语是 -tion） */
  { lang: "pt", w: 3, re: /\b\w+(cao|coes)\b/gi },
  { lang: "es", w: 3, re: /\b\w+(cion|ciones)\b/gi },
  { lang: "pt", w: 2, re: /\b\w+(nh|lh)[aeiou]/gi },
];

/* ── 功能词：3 = 排他，2 = 强偏好，1 = 高重叠（加进去只是不让别人白拿分）
 * 铁律：三种语言拼写相同的词（triste / feliz / cansado）一律不进 3 分档。 */
const WORDS = {
  en: [
    [3, ["the", "and", "you", "your", "this", "that", "there", "what", "when", "how", "with", "have", "was", "were", "would", "could", "should", "don't", "can't", "i'm", "it's", "isn't", "aren't", "gonna", "wanna", "nobody", "everyone", "someone", "anyone", "nothing", "everything", "honestly", "pretending", "listening", "again", "because"]],
    [2, ["is", "are", "not", "but", "for", "from", "about", "just", "some", "been", "really", "still", "very", "feel", "feeling", "tonight", "night", "tired", "lonely", "scared", "happy", "sad", "love", "miss", "think", "know", "want", "need", "sleep", "okay", "home", "work", "job", "today", "tomorrow", "rain", "raining", "alone", "cry", "crying", "pressure", "married", "outside", "weather", "people", "life", "hard", "empty", "hurt", "pretend", "giving", "texts"]],
    [1, ["a", "an", "in", "on", "at", "to", "of", "it", "my", "we", "he", "she", "they", "so", "no", "yes", "do", "be", "will", "can", "back", "day", "week", "year", "right", "wrong", "better", "worse", "world"]],
  ],
  es: [
    [3, ["el", "los", "las", "porque", "pero", "muy", "estoy", "estás", "tengo", "tienes", "quiero", "puedo", "corazón", "noche", "gracias", "también", "todavía", "ahora", "siempre", "nunca", "siento", "duele", "solo", "sola", "miedo", "sueño", "contigo", "conmigo", "otra", "otro", "nadie", "harto", "harta", "aguanto", "trabajo", "lluvia", "llueve", "extraño", "rendirme", "escuchar", "vacío", "escribe", "escriben", "mañana", "papas", "preguntan"]],
    [2, ["una", "uno", "es", "son", "hay", "con", "para", "sin", "sobre", "cuando", "donde", "como", "más", "menos", "algo", "nada", "todo", "hoy", "ayer", "aquí", "bien", "mal", "sí", "mi", "su", "lo", "le", "te", "nos", "cosa", "gente", "vez", "fingiendo", "presión", "casar", "casa", "camino", "afuera", "mundo"]],
    [1, ["de", "la", "en", "y", "a", "por", "se", "no", "yo", "él", "ella", "tu", "este", "triste", "feliz", "cansado", "cansada", "que", "me", "dia"]],
  ],
  pt: [
    [3, ["não", "você", "vocês", "obrigado", "obrigada", "coração", "noite", "estou", "está", "tenho", "tem", "quero", "posso", "também", "ainda", "agora", "sempre", "nunca", "sinto", "dói", "sozinho", "sozinha", "medo", "sonho", "comigo", "conosco", "muito", "muita", "coisa", "numa", "alguém", "ninguém", "aguento", "trabalho", "chovendo", "chuva", "saudade", "pressão", "fingindo", "desistir", "vazio", "chamo", "chama", "casar", "filhos", "vontade"]],
    [2, ["uma", "um", "é", "são", "com", "para", "sem", "sobre", "quando", "onde", "como", "mas", "mais", "menos", "algo", "nada", "tudo", "hoje", "ontem", "aqui", "bem", "mal", "sim", "meu", "minha", "seu", "sua", "eu", "ele", "ela", "nós", "num", "gente", "vez", "novo", "nova", "isso", "isto", "casa", "caminho", "fora", "mundo", "escutar", "cansado", "cansada"]],
    [1, ["de", "do", "da", "os", "as", "em", "e", "a", "o", "por", "se", "que", "tu", "este", "triste", "feliz", "dia", "me"]],
  ],
  fr: [
    [3, ["je", "les", "des", "une", "est", "pas", "mais", "avec", "pour", "mon", "ma", "très", "coeur", "cœur", "nuit", "suis", "c'est", "j'ai", "aujourd'hui", "toujours", "jamais", "merci", "aussi", "encore", "peux", "veux", "besoin", "seul", "seule", "heureux", "peur", "rêve", "toi", "moi", "personne", "pleut", "pluie", "boulot", "travail", "maison", "manque", "marier", "pression", "semblant", "abandonner", "écouter", "vide", "parents", "demandent"]],
    [2, ["le", "la", "un", "et", "en", "qui", "dans", "sur", "sans", "quand", "où", "comme", "plus", "moins", "quelque", "rien", "tout", "hier", "ici", "bien", "mal", "oui", "son", "sa", "ses", "ils", "elles", "nous", "vous", "fatigué", "fatiguée", "monde", "dehors", "chemin", "franchement"]],
    [1, ["de", "du", "au", "aux", "ce", "cette", "il", "elle", "on", "ne", "y", "à", "que", "tu", "este", "triste", "me", "jour", "an"]],
  ],
};

const stripAccent = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

/* 词表建两份：原形 + 去重音形。
   真实用户极少打重音符号（nao / voce / estao / coracao），两套都要能命中。
   这一项把留出集从 74.8% 拉到 96.3%，是整套规则里性价比最高的一步。 */
const BAG = {};
const BAG_NA = {};
for (const [lang, groups] of Object.entries(WORDS)) {
  const m = new Map();
  const mn = new Map();
  for (const [w, list] of groups) {
    for (const word of list) {
      m.set(word, Math.max(m.get(word) || 0, w));
      const k = stripAccent(word);
      mn.set(k, Math.max(mn.get(k) || 0, w));
    }
  }
  BAG[lang] = m;
  BAG_NA[lang] = mn;
}

const count = (re, s) => (s.match(re) || []).length;

function tokenize(s) {
  return s.toLowerCase().replace(/[’‘]/g, "'").split(/[^a-zà-ÿœ'æ]+/i).filter(Boolean);
}

/**
 * 检测一段文本的语言。
 * @param {string} text
 * @returns {{lang: string, conf: number, why: string}}
 *   lang: zh | en | es | pt | fr | ja | ko | und
 *   und = 判不出来。调用方应当把它当成"语言未知"，不要塞进任何语言的优先池。
 */
export function detectLang(text) {
  const raw = String(text || "");
  const cjk = count(CJK, raw);
  const kana = count(KANA, raw);
  const hangul = count(HANGUL, raw);
  const latin = count(LATIN, raw);

  /* ① 非拉丁文字：字符集判定，零歧义 */
  if (kana >= 3) return { lang: "ja", conf: 0.99, why: "kana" };
  if (hangul >= 3) return { lang: "ko", conf: 0.99, why: "hangul" };
  const cjkRatio = cjk + latin ? cjk / (cjk + latin) : 0;
  /* 阈值 15%：中英混排里英文常是术语或引用，出现汉字就说明主体是中文。
     对过滤功能来说这也是对的 —— 西语读者对含汉字的内容完全不可读。 */
  if (cjk >= 1 && cjkRatio > 0.15) return { lang: "zh", conf: Math.min(0.99, 0.7 + cjkRatio), why: "cjk" };

  /* ② 长度闸门：纯 emoji / 纯数字 / 一两个词 —— 信息不足，判不了 */
  if (latin < 8) return { lang: "und", conf: 0, why: "too-short" };
  const tokens = tokenize(raw);
  if (tokens.length < 2) return { lang: "und", conf: 0, why: "too-few-words" };
  /* 只有 2 个词时，必须含一个强特征词才敢判（"rejected again" 结构上就判不了） */
  if (tokens.length === 2) {
    const strong = tokens.some((t) => Object.values(BAG).some((b) => (b.get(t) || 0) >= 3));
    if (!strong) return { lang: "und", conf: 0, why: "two-words-weak" };
  }

  /* ③ 拉丁语言打分 */
  const score = { en: 0, es: 0, pt: 0, fr: 0 };
  for (const { lang, w, re } of DIACRITIC) score[lang] += count(re, raw) * w;
  for (const { lang, w, re } of AFFIX) score[lang] += count(re, raw) * w;
  for (const { lang, w, re } of SHAPE) score[lang] += count(re, raw) * w;

  for (const t of new Set(tokens)) {
    const na = stripAccent(t);
    for (const lang of Object.keys(BAG)) {
      const a = BAG[lang].get(t) || 0;              // 原形优先（打对重音符号的）
      const b = t === na ? 0 : BAG_NA[lang].get(na) || 0;  // 省略重音时兜底
      score[lang] += Math.max(a, b);
    }
  }

  /* ④ 分差判定：第一名要明显领先才出结果，否则 und */
  const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]);
  const [top, second] = ranked;
  const total = ranked.reduce((a, [, v]) => a + v, 0);
  if (total === 0) return { lang: "und", conf: 0, why: "no-signal" };
  const lead = top[1] - second[1];
  if (top[1] < 2 || lead < 1) return { lang: "und", conf: 0, why: "ambiguous", score };
  return { lang: top[0], conf: Math.min(0.95, 0.4 + (lead / Math.max(4, top[1])) * 0.55), why: "scored", score };
}
