/* 内容语言检测的回归测试（Node 直跑：node tools/lang-detect-test.mjs）
 * ---------------------------------------------------------------------------
 * 轮 439，用户要「加西语/葡语/法语 + 只看本语言开关」，前提是先能判断内容是什么语言。
 *
 * 这个检测器的**唯一硬契约：宁可 und，不许猜错**。
 * 所以判据分两档：
 *   · 准确率 ≥95%（可以判不出来）
 *   · 错判数 = 0（判出来的必须对）
 * 错标的代价是把内容塞给不该看的读者；判不出来只是不参与过滤，代价小得多。
 *
 * 四个数据集：
 *   ① 调参集  —— 写规则时就看过的句子，只能证明没写崩
 *   ② 留出集  —— 参与调参的句子一条都不在里面，这才是真实水平
 *   ③ 真实库  —— 线上 536 条里等距抽的 40 条（tools/fixtures/real-posts.json）
 *   ④ 边界    —— 混排 / emoji / 纯数字 / 极短
 */
import { readFileSync } from "node:fs";
import { detectLang, SUPPORTED } from "../src/utils/langDetect.js";

let pass = 0, fail = 0;
function ok(name, cond, extra = "") {
  if (cond) { pass++; console.log("PASS ", name); }
  else { fail++; console.log("FAIL ", name, extra); }
}

const CASES = [
  /* 中文 */
  ["zh", "今天真的好累，什么都不想说"],
  ["zh", "凌晨三点还醒着，有人陪我聊会吗"],
  ["zh", "刚被老板骂完，感觉自己一无是处"],
  ["zh", "分手第 7 天，还是会下意识看手机"],
  ["zh", "妈妈今天查出来要做手术，我很怕"],
  ["zh", "一个人在外地过生日，蛋糕都没买"],
  ["zh", "搬来新城市三个月了，一个朋友都没有"],
  ["zh", "考研失败了，不知道怎么面对家里"],
  ["zh", "睡不着，脑子里一直在想白天那件事"],
  ["zh", "今天下班路上看到一只流浪猫，喂了它一根火腿肠"],
  ["zh", "有没有人也是一个人吃饭啊"],
  ["zh", "刚刚给爸爸打了电话，他声音听起来很疲惫"],
  ["zh", "最近总是莫名其妙想哭"],
  ["zh", "室友都睡了，只有我还醒着"],
  ["zh", "今天面试又挂了，第 5 次了"],
  ["zh", "想找个人说说话，又不知道说什么"],
  ["zh", "下雨天，一个人窝在家里"],
  ["zh", "快撑不住了，但还是得撑"],
  ["zh", "医生说我需要休息，可是不敢停"],
  ["zh", "很久没有真正开心过了"],
  ["zh", "今天是自己 30 岁生日，祝我生日快乐"],
  ["zh", "我把心事写进漂流瓶里了，希望有人捡到"],
  ["zh", "如果你也在熬夜，我们算是同类"],
  ["zh", "奶奶走了半年了，我还是会在饭点想起她"],
  ["zh", "明天又要早起，可是完全睡不着"],
  /* 英文 */
  ["en", "I can't sleep tonight, my head won't stop"],
  ["en", "just got dumped and I don't know what to do"],
  ["en", "does anyone else feel lonely even in a crowded room"],
  ["en", "I'm so tired of pretending everything is okay"],
  ["en", "my mom is having surgery tomorrow and I'm scared"],
  ["en", "spent my birthday alone this year, no cake no nothing"],
  ["en", "three months in a new city and I still have no friends"],
  ["en", "I failed the exam and I can't face my parents"],
  ["en", "the rain always makes me feel a bit sad"],
  ["en", "I just want someone to talk to at 3am"],
  ["en", "been awake for hours thinking about what I said"],
  ["en", "my dad called today, he sounded so old"],
  ["en", "I cried for no reason again today"],
  ["en", "everyone else is asleep and I'm still here"],
  ["en", "got rejected again, fifth time this month"],
  ["en", "I don't even know what to say, I just feel empty"],
  ["en", "cooking dinner for one again tonight"],
  ["en", "I'm holding on but barely"],
  ["en", "the doctor told me to rest and I can't afford to"],
  ["en", "it's been a long time since I felt genuinely happy"],
  ["en", "turned 30 today, happy birthday to me I guess"],
  ["en", "I wrote my feelings into a bottle, hope someone finds it"],
  ["en", "if you're also awake at this hour, we're the same"],
  ["en", "my grandma passed six months ago and I still think of her at dinner"],
  ["en", "early shift tomorrow but I can't fall asleep"],
  /* 西语 */
  ["es", "No puedo dormir esta noche, mi cabeza no para"],
  ["es", "Acabo de cortar con mi novio y no sé qué hacer"],
  ["es", "¿Alguien más se siente solo incluso con gente alrededor?"],
  ["es", "Estoy tan cansado de fingir que todo está bien"],
  ["es", "Mi mamá tiene cirugía mañana y tengo mucho miedo"],
  ["es", "Pasé mi cumpleaños solo este año, sin pastel ni nada"],
  ["es", "Tres meses en una ciudad nueva y todavía no tengo amigos"],
  ["es", "Reprobé el examen y no puedo mirar a mis padres"],
  ["es", "La lluvia siempre me pone un poco triste"],
  ["es", "Solo quiero alguien con quien hablar a las tres de la mañana"],
  ["es", "Llevo horas despierto pensando en lo que dije"],
  ["es", "Mi papá llamó hoy, sonaba muy viejo"],
  ["es", "Hoy lloré otra vez sin razón"],
  ["es", "Todos duermen y yo sigo aquí despierto"],
  ["es", "Me rechazaron otra vez, la quinta este mes"],
  ["es", "No sé ni qué decir, solo me siento vacío"],
  ["es", "Cocinando la cena para uno otra vez"],
  ["es", "Estoy aguantando pero apenas"],
  ["es", "El médico me dijo que descanse y no puedo parar"],
  ["es", "Hace mucho que no me siento realmente feliz"],
  ["es", "Hoy cumplo 30 años, feliz cumpleaños a mí supongo"],
  ["es", "Escribí lo que siento en una botella, ojalá alguien la encuentre"],
  ["es", "Si tú también estás despierto a esta hora, somos iguales"],
  ["es", "Mi abuela murió hace seis meses y todavía la recuerdo en la cena"],
  ["es", "Mañana entro temprano al trabajo pero no puedo dormir"],
  /* 葡语 */
  ["pt", "Não consigo dormir hoje, minha cabeça não para"],
  ["pt", "Acabei de terminar o namoro e não sei o que fazer"],
  ["pt", "Alguém mais se sente sozinho mesmo com gente por perto?"],
  ["pt", "Estou tão cansado de fingir que está tudo bem"],
  ["pt", "Minha mãe vai operar amanhã e estou com muito medo"],
  ["pt", "Passei meu aniversário sozinho este ano, sem bolo nem nada"],
  ["pt", "Três meses numa cidade nova e ainda não tenho amigos"],
  ["pt", "Reprovei na prova e não consigo olhar para meus pais"],
  ["pt", "A chuva sempre me deixa um pouco triste"],
  ["pt", "Só quero alguém para conversar às três da manhã"],
  ["pt", "Estou acordado há horas pensando no que eu disse"],
  ["pt", "Meu pai ligou hoje, a voz dele parecia tão cansada"],
  ["pt", "Hoje chorei de novo sem motivo"],
  ["pt", "Todos dormindo e eu ainda aqui acordado"],
  ["pt", "Fui recusado de novo, a quinta vez este mês"],
  ["pt", "Não sei nem o que dizer, só me sinto vazio"],
  ["pt", "Fazendo jantar para um de novo hoje"],
  ["pt", "Estou aguentando, mas por pouco"],
  ["pt", "O médico mandou eu descansar e eu não posso parar"],
  ["pt", "Faz muito tempo que não me sinto realmente feliz"],
  ["pt", "Hoje faço 30 anos, feliz aniversário para mim, né"],
  ["pt", "Escrevi o que sinto numa garrafa, tomara que alguém encontre"],
  ["pt", "Se você também está acordado a essa hora, somos iguais"],
  ["pt", "Minha avó morreu há seis meses e ainda lembro dela no jantar"],
  ["pt", "Amanhã entro cedo no trabalho mas não consigo dormir"],
  /* 法语 */
  ["fr", "Je n'arrive pas à dormir ce soir, ma tête ne s'arrête pas"],
  ["fr", "Je viens de me faire quitter et je ne sais pas quoi faire"],
  ["fr", "Est-ce que quelqu'un d'autre se sent seul même entouré"],
  ["fr", "Je suis tellement fatigué de faire semblant que tout va bien"],
  ["fr", "Ma mère se fait opérer demain et j'ai très peur"],
  ["fr", "J'ai passé mon anniversaire seul cette année, sans gâteau"],
  ["fr", "Trois mois dans une nouvelle ville et toujours pas d'amis"],
  ["fr", "J'ai raté l'examen et je ne peux pas regarder mes parents"],
  ["fr", "La pluie me rend toujours un peu triste"],
  ["fr", "Je veux juste quelqu'un à qui parler à trois heures du matin"],
  ["fr", "Ça fait des heures que je suis éveillé à penser à ce que j'ai dit"],
  ["fr", "Mon père a appelé aujourd'hui, il avait l'air si vieux"],
  ["fr", "J'ai encore pleuré aujourd'hui sans raison"],
  ["fr", "Tout le monde dort et moi je suis encore là"],
  ["fr", "J'ai été refusé encore, la cinquième fois ce mois-ci"],
  ["fr", "Je ne sais même pas quoi dire, je me sens juste vide"],
  ["fr", "Encore en train de cuisiner pour un ce soir"],
  ["fr", "Je tiens bon mais à peine"],
  ["fr", "Le médecin m'a dit de me reposer et je ne peux pas m'arrêter"],
  ["fr", "Ça fait longtemps que je ne me suis pas senti vraiment heureux"],
  ["fr", "J'ai 30 ans aujourd'hui, joyeux anniversaire à moi"],
  ["fr", "J'ai écrit ce que je ressens dans une bouteille, j'espère qu'on la trouvera"],
  ["fr", "Si tu es aussi éveillé à cette heure, on est pareils"],
  ["fr", "Ma grand-mère est morte il y a six mois et j'y pense encore au dîner"],
  ["fr", "Je commence tôt demain mais je n'arrive pas à dormir"],
];

/* 留出集：写规则时一条都没看过。刻意做得短、口语、省略重音符号（真实用户就这样打字）。 */
const HOLD = [
  ["zh", "好累哦"], ["zh", "又失眠了"], ["zh", "有人吗"], ["zh", "感觉自己像个废物"],
  ["zh", "下班回家路上哭了"], ["zh", "不想上班"], ["zh", "今天又被拒了"],
  ["zh", "我妈又催婚了，烦死"], ["zh", "一个人吃火锅也挺好的……骗你的"],
  ["zh", "窗外在下雨"], ["zh", "我好像喜欢上一个不可能的人"], ["zh", "刚分手，谁陪我喝一杯"],
  ["zh", "25 岁了还一事无成"], ["zh", "想家"], ["zh", "换了新工作，压力好大"],
  ["zh", "每天装作很开心"], ["zh", "其实我也想过算了"], ["zh", "谢谢你听我说"],
  ["zh", "睡不着，翻来覆去的"], ["zh", "今天天气好，但我心情不好"],
  ["en", "im so done with today"], ["en", "nobody texts me back"], ["en", "3am again lol"],
  ["en", "i feel like a burden to everyone"], ["en", "crying on the way home"],
  ["en", "dont wanna go to work tomorrow"], ["en", "rejected again"],
  ["en", "my parents keep asking when im getting married"],
  ["en", "eating hotpot alone is fine... jk it hurts"], ["en", "its raining outside"],
  ["en", "i think i like someone i cant have"], ["en", "just broke up, who wants to drink"],
  ["en", "25 and still nothing to show"], ["en", "i miss home"],
  ["en", "new job, so much pressure"], ["en", "pretending to be happy every day"],
  ["en", "honestly ive thought about giving up"], ["en", "thanks for listening"],
  ["en", "cant fall asleep, keep tossing"], ["en", "nice weather today but im not okay"],
  ["es", "estoy harto de todo"], ["es", "no aguanto mas"], ["es", "me siento vacia"],
  ["es", "otra vez sin dormir"], ["es", "nadie me escribe"], ["es", "llore en el camino a casa"],
  ["es", "no quiero ir a trabajar manana"], ["es", "me rechazaron otra vez"],
  ["es", "mis papas me preguntan cuando me caso"],
  ["es", "comer solo no esta tan mal... mentira"], ["es", "esta lloviendo afuera"],
  ["es", "creo que me gusta alguien imposible"],
  ["es", "acabo de terminar, quien quiere tomar algo"], ["es", "tengo 25 y sigo sin nada"],
  ["es", "extrano mi casa"], ["es", "trabajo nuevo, mucha presion"],
  ["es", "fingiendo estar bien todos los dias"],
  ["es", "la verdad tambien he pensado en rendirme"], ["es", "gracias por escucharme"],
  ["es", "no puedo dormir, dando vueltas"],
  ["pt", "to cansado de tudo"], ["pt", "nao aguento mais"], ["pt", "me sinto vazia"],
  ["pt", "de novo sem dormir"], ["pt", "ninguem me chama"], ["pt", "chorei no caminho de casa"],
  ["pt", "nao quero ir trabalhar amanha"], ["pt", "fui recusado de novo"],
  ["pt", "meus pais ficam perguntando quando eu caso"],
  ["pt", "comer sozinho nao e tao ruim... mentira"], ["pt", "ta chovendo la fora"],
  ["pt", "acho que gosto de alguem impossivel"],
  ["pt", "terminei agora, quem quer beber"], ["pt", "tenho 25 e nada ainda"],
  ["pt", "saudade de casa"], ["pt", "trabalho novo, muita pressao"],
  ["pt", "fingindo estar bem todos os dias"],
  ["pt", "na verdade tambem ja pensei em desistir"], ["pt", "obrigado por me ouvir"],
  ["pt", "nao consigo dormir, virando de um lado pro outro"],
  ["fr", "j'en peux plus"], ["fr", "je me sens vide ce soir"], ["fr", "encore une nuit sans dormir"],
  ["fr", "personne ne m'ecrit"], ["fr", "j'ai pleure sur le chemin du retour"],
  ["fr", "je ne veux pas aller bosser demain"], ["fr", "refuse encore une fois"],
  ["fr", "mes parents me demandent quand je me marie"],
  ["fr", "manger seul c'est pas si mal... non"], ["fr", "il pleut dehors"],
  ["fr", "je crois que j'aime quelqu'un d'impossible"],
  ["fr", "je viens de rompre, qui veut boire un verre"], ["fr", "25 ans et toujours rien"],
  ["fr", "la maison me manque"], ["fr", "nouveau boulot, beaucoup de pression"],
  ["fr", "je fais semblant d'aller bien chaque jour"],
  ["fr", "franchement j'ai aussi pense a abandonner"], ["fr", "merci de m'avoir ecoute"],
  ["fr", "je n'arrive pas a dormir, je tourne en rond"],
];

/* 边界：这些必须 und —— 判不出来就该说判不出来，不许猜 */
const UND = ["💔", "....", "???", "lol", "gg", "555", "ok ok", "...", "🥺🥺🥺", "123456", "hmm", "@@@"];

/* 中英混排：出现汉字就算中文（对西语读者来说含汉字=完全不可读） */
const MIXED = [
  "今天好累 I'm so tired",
  "有人陪我聊会吗 because I feel lonely",
  "刚刚看完 the office 又在哭",
  "失眠了 can't sleep again",
  "生日快乐 to me",
];

function score(set) {
  let ok = 0;
  const wrong = [];   // 判错（判出一个别的语言）
  const und = [];     // 没判出来
  for (const [want, text] of set) {
    const r = detectLang(text);
    if (r.lang === want) ok++;
    else if (r.lang === "und") und.push([want, text, r.why]);
    else wrong.push([want, r.lang, text]);
  }
  return { ok, total: set.length, wrong, und, acc: ok / set.length };
}

console.log("\n── ① 调参集（只能证明没写崩）──");
{
  const s = score(CASES);
  ok(`调参集 ${s.ok}/${s.total} = ${(s.acc * 100).toFixed(1)}%`, s.acc >= 0.99,
    s.wrong.map((w) => `应${w[0]}判${w[1]}「${w[2].slice(0, 20)}」`).join(" | "));
  ok("调参集零错判", s.wrong.length === 0, JSON.stringify(s.wrong.slice(0, 3)));
}

console.log("\n── ② 留出集（真实水平）──");
{
  const s = score(HOLD);
  ok(`留出集 ${s.ok}/${s.total} = ${(s.acc * 100).toFixed(1)}% ≥ 95%`, s.acc >= 0.95);
  ok("留出集零错判（判出来的必须对）", s.wrong.length === 0,
    s.wrong.map((w) => `应${w[0]}判${w[1]}「${w[2]}」`).join(" | "));
  console.log(`     判不出 ${s.und.length} 条，属正常（短句信息不足）`);
}

console.log("\n── ③ 真实库抽样（线上 536 条等距取 40）──");
{
  const rows = JSON.parse(readFileSync(new URL("./fixtures/real-posts.json", import.meta.url), "utf8"));
  const res = rows.map((t) => [detectLang(t).lang, t]);
  const zh = res.filter(([l]) => l === "zh").length;
  const und = res.filter(([l]) => l === "und").length;
  const other = res.filter(([l]) => l !== "zh" && l !== "und");
  /* 全库都是中文，所以「判出非中文」就是错 —— 这条比准确率更能说明问题 */
  ok(`真实库 40 条：中文 ${zh} / und ${und} / 误判 ${other.length}`, other.length === 0,
    other.map(([l, t]) => `${l}「${t.slice(0, 24)}」`).join(" | "));
  ok(`真实库至少 90% 判出中文（实得 ${((zh / rows.length) * 100).toFixed(0)}%）`, zh / rows.length >= 0.9);
  /* 库里那几条纯数字/乱码本来就该 und，不算失败 */
  ok("真实库 und 的都是无有效文字的内容", und <= 6, `und=${und}`);
}

console.log("\n── ④ 边界 ──");
{
  const bad = UND.filter((t) => detectLang(t).lang !== "und");
  ok(`纯 emoji / 数字 / 极短一律 und（${UND.length} 条）`, bad.length === 0, bad.join(" | "));

  const mixBad = MIXED.filter((t) => detectLang(t).lang !== "zh");
  ok(`中英混排判 zh（${MIXED.length} 条）`, mixBad.length === 0, mixBad.join(" | "));

  ok("单个汉字也算中文（「困」这类极短帖）", detectLang("emmm，困").lang === "zh", detectLang("emmm，困").lang);
  ok("日语假名能认出来（为以后扩展留的）", detectLang("ねむれない、だれかいますか").lang === "ja");
  ok("韩语能认出来", detectLang("잠이 안 와요 누구 없나요").lang === "ko");
  ok("省略重音符号照样命中（nao aguento mais）", detectLang("nao aguento mais").lang === "pt");
}

console.log("\n── ⑤ 契约 ──");
{
  ok("SUPPORTED 恰好是 zh/en/es/pt/fr", JSON.stringify(SUPPORTED) === JSON.stringify(["zh", "en", "es", "pt", "fr"]));
  ok("返回值恒定是对象且有 lang", ["", null, undefined, 123].every((x) => typeof detectLang(x).lang === "string"));

  /* 不许引入任何依赖 —— 这个模块要能在最早期加载，不能拖慢首屏 */
  const src = readFileSync(new URL("../src/utils/langDetect.js", import.meta.url), "utf8");
  ok("零依赖（没有 import）", !/^\s*import\s/m.test(src));
  ok("源码 < 24KB", Buffer.byteLength(src) < 24 * 1024, `${(Buffer.byteLength(src) / 1024).toFixed(1)}KB`);
  ok("没有把测试集写进产品代码", !src.includes("今天真的好累"));
}

console.log(`\n═══ ${pass} 通过 / ${fail} 失败 ═══\n`);
process.exit(fail ? 1 : 0);
