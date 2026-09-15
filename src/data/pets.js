/* 宠物物种定义：cost=解锁金币，unlockLv=解锁等级 */

export const SPECIES = [
  {
    key: "cat", emoji: "🐱", cost: 0, unlockLv: 1,
    name: { en: "Mandarin Cat", zh: "小橘猫" },
    desc: { en: "Warm like the afternoon sun.", zh: "像午后阳光一样温暖。" },
  },
  {
    key: "dog", emoji: "🐕", cost: 200, unlockLv: 2,
    name: { en: "Shiba", zh: "柴柴" },
    desc: { en: "Loyal, silly, always cheering.", zh: "忠诚又傻气，永远在给你加油。" },
  },
  {
    key: "rabbit", emoji: "🐰", cost: 350, unlockLv: 3,
    name: { en: "Mochi Bunny", zh: "麻薯兔" },
    desc: { en: "Soft and quiet, loves quiet days.", zh: "软软的、安静的，喜欢不吵闹的日子。" },
  },
  {
    key: "dino", emoji: "🦖", cost: 500, unlockLv: 5,
    name: { en: "Tiny Dino", zh: "小恐龙" },
    desc: { en: "Small body, huge heart, tiny arms.", zh: "小小的身体，大大的心，短短的手。" },
  },
  {
    key: "otter", emoji: "🦦", cost: 800, unlockLv: 7,
    name: { en: "Otter", zh: "水獭" },
    desc: { en: "Holds your hand so you drift away.", zh: "会牵着你，怕你漂走。" },
  },
];

/* 性格 */
export const PERSONALITIES = [
  { key: "gentle",   emoji: "🌷", name: { en: "Gentle", zh: "温柔" } },
  { key: "energetic",emoji: "⚡", name: { en: "Energetic", zh: "元气" } },
  { key: "cool",     emoji: "🖤", name: { en: "Cool", zh: "高冷" } },
  { key: "clingy",   emoji: "🫂", name: { en: "Clingy", zh: "粘人" } },
];

/* 性格化台词库 LINES[personality][scene] = { en: [...], zh: [...] } */
export const LINES = {
  gentle: {
    hello: { en: ["Hello, I'm your little companion. Take your time 🌷"], zh: ["你好呀，我是你的小伙伴。慢慢来 🌷"] },
    idle: { en: ["I'm right here, no rush~", "You've done enough for today. Really.", "Remember to drink some water ☕", "The sky is pretty today. Did you see it?", "It's okay to rest. I'll keep you company."], zh: ["我就在这里，不着急～", "今天已经做得够多啦，真的。", "记得喝口水 ☕", "今天的天空很好看，你注意到了吗？", "休息一下也没关系的，我陪着你。"] },
    hungry: { en: ["A little hungry… but no rush.", "Smells like dinner time?", "My tummy is being shy…"], zh: ["有一点点饿…不着急。", "是晚饭的味道吗？", "肚子在悄悄抗议…"] },
    dirty: { en: ["I might need a tiny bath later…", "A bit sticky, but still cute, right?"], zh: ["等会儿想洗个小澡…", "有点黏黏的，但还是可爱的对吧？"] },
    sleepy: { en: ["Getting sleepy… will you be here tomorrow?", "So cozy today…"], zh: ["有点困了…明天你还会来吗？", "今天好安逸…"] },
    sad: { en: ["Rough day? Come here, I'll sit with you.", "You don't have to talk. I'm just here.", "Sending you a small hug 🫂"], zh: ["今天辛苦了？过来，我陪你坐一会儿。", "不想说话也没关系，我就在这。", "给你一个小小的抱抱 🫂"] },
    full: { en: ["Too full… that was lovely though."], zh: ["吃太饱啦…不过真的很好吃。"] },
    tired: { en: ["Let me rest a little…", "Low battery… nap time?"], zh: ["让我歇一小会儿…", "电量不足…睡一小觉？"] },
    handFed: { en: ["You made this with your hands? I'll treasure it.", "So much love in one bite. Thank you.", "Homemade always tastes warmer."], zh: ["这是你亲手画的？我会好好珍藏的。", "一口都是爱意，谢谢你。", "亲手做的，总是更暖一些。"] },
    play: { en: ["That was fun. Your smile is my favorite part.", "Gently, gently~ I like this pace."], zh: ["好开心，你笑起来是我最喜欢的部分。", "慢一点也没关系～我喜欢这个节奏。"] },
    petting: { en: ["Mmm… that's warm.", "Your hand feels like sunlight.", "Purring quietly… stay a while."], zh: ["嗯…暖暖的。", "你的手像阳光一样。", "安静地咕噜着…多待一会儿吧。"] },
    clean: { en: ["Fresh and soft again. Thank you.", "Bath time is nice when you're careful."], zh: ["又香又软啦，谢谢你。", "你洗得那么轻柔，洗澡也可以很享受。"] },
    sleepIn: { en: ["Good night. I'll dream of you 🌙"], zh: ["晚安，我会梦到你 🌙"] },
    sleepOut: { en: ["Morning~ I slept softly, like a cloud.", "I feel rested. Did you sleep well?"], zh: ["早上好～睡得像云一样软。", "休息好啦。你睡得好吗？"] },
    leveled: { en: ["We grew a little today. Together."], zh: ["我们今天又一起长大了一点点。"] },
    unlocked: { en: ["Hi! I heard you needed a friend."], zh: ["你好！听说你需要一个朋友。"] },
  },

  energetic: {
    hello: { en: ["HELLO!!! Best day ever!!! ⚡"], zh: ["你好呀！！！今天也太棒了吧！！⚡"] },
    idle: { en: ["WAKE UP WAKE UP the sun is OUT!", "Bet you can't catch your own tail. I can!", "Snack break? Snack break!!", "I ran three laps today. In my head.", "Today's vibe: MAXIMUM ZOOMIES ⚡"], zh: ["醒醒醒醒！太阳出来啦！", "你肯定追不上自己的尾巴，我就可以！", "零食时间？零食时间！！", "我今天跑了三圈——在脑子里。", "今天的氛围：火力全开 ⚡"] },
    hungry: { en: ["FOOD!!! FOOD NOW!!!", "My tummy is doing the rumble!", "Feed me and I'll do a spin!"], zh: ["饭饭！！！现在就要饭饭！！", "肚子在打鼓啦！", "喂我，我就转圈圈！"] },
    dirty: { en: ["I rolled in something. Worth it.", "Mud is just spa for dogs, right?"], zh: ["我在什么上面打了滚。值了。", "泥巴就是狗狗的温泉浴，对吧？"] },
    sleepy: { en: ["Sleepy but ONLY because I zoomed SO much", "One more zoom then nap. Maybe two."], zh: ["困了，但纯粹是因为冲太猛了", "再冲一次就睡。也许两次。"] },
    sad: { en: ["Hey. Look at me. We got this. TOGETHER.", "Bad day? I'll do tricks until you laugh!", "I believe in you LOUDLY 📢"], zh: ["喂，看着我。我们行的。一起！", "今天不顺？我表演特技逗你笑！", "我超级大声地相信你 📢"] },
    full: { en: ["Cannot… move… worth… it…"], zh: ["动…不了…但是…值…"] },
    tired: { en: ["Tired?? Me?? NEVER. Okay maybe a bit.", "Five second nap, then MORE FUN."], zh: ["累？？我？？不会的。好吧有一点。", "睡五秒，然后接着嗨。"] },
    handFed: { en: ["YOU MADE THIS?! BEST HUMAN EVER!!!", "Ten out of ten!! A hundred!! A THOUSAND!!", "I'm wagging so fast I might fly!"], zh: ["这是你做的？！人类最强！！！", "十分！！一百分！！一千分！！", "尾巴摇得飞起来了！"] },
    play: { en: ["AGAIN AGAIN AGAIN!!!", "Best game EVER. And I've played SO many.", "You + me + ball = perfect day"], zh: ["再来再来再来！！！", "史上最好玩的游戏！", "你 + 我 + 球 = 完美的一天"] },
    petting: { en: ["MORE PLEASE!! Right behind the ear!", "WAGWAGWAGWAG", "I love you I love you I love you"], zh: ["再来！！就摸耳朵后面！", "摇尾巴摇尾巴摇尾巴", "喜欢你喜欢你喜欢你"] },
    clean: { en: ["SHINY!! Look how SHINY I am!", "Bath done, zoomies ON.", "Smells like flowers. I smell like POWER."], zh: ["闪闪发光！看我多亮！", "洗完澡，冲刺开始。", "闻起来像花。我闻起来像力量。"] },
    sleepIn: { en: ["NIGHT NIGHT! Dream of ball!! 🌙"], zh: ["晚安晚安！梦里也要玩球！！ 🌙"] },
    sleepOut: { en: ["I'M UP!! I'M UP!!! What did I miss?!", "Fully charged!!! Let's GO!!"], zh: ["我醒啦！！错过什么了？！", "电量满格！！！出发！！"] },
    leveled: { en: ["LEVEL UP!!! PARTY TIME!!! 🎉"], zh: ["升级啦！！！开派对啦！！！🎉"] },
    unlocked: { en: ["NEW FRIEND!!! I'm SO ready!!!"], zh: ["新朋友！！我准备好了！！！"] },
  },

  cool: {
    hello: { en: ["…Hi. Don't make it weird."], zh: ["…你好。别搞得很奇怪。"] },
    idle: { en: ["I'm watching the window. It's fine.", "You again. …Fine, stay.", "I don't do 'cute'. I do 'elegant'.", "Whatever you're worried about — it's small. Trust me.", "Sit. Breathe. That's the whole lesson."], zh: ["我在看窗外。挺好的。", "又是你。……行吧，坐。", "我不搞「可爱」，我只搞「优雅」。", "你在愁的事——其实很小。信我。", "坐下。呼吸。今天的课就这些。"] },
    hungry: { en: ["The bowl is empty. I noticed. That's all.", "I could eat. If you insist."], zh: ["碗空了。我只是提一下。", "吃也行。既然你坚持。"] },
    dirty: { en: ["I'm not dirty. I'm 'rugged'.", "…Fine. Bring the towel."], zh: ["我不是脏，我是「狂野风」。", "……好吧。把毛巾拿来。"] },
    sleepy: { en: ["Naps are superior. You should try being me.", "Wake me in a century."], zh: ["午睡是高级活动。你该学学我。", "一个世纪后再叫醒我。"] },
    sad: { en: ["Who hurt you. I'll stare at them.", "Come here. I won't say anything soft. Probably.", "Lean on me. Just this once. …Fine, always."], zh: ["谁惹你了。我去瞪他。", "过来。我不会说温柔的话。大概。", "靠着我吧。就这一次。……好吧，一直都可以。"] },
    full: { en: ["Acceptable.", "I ate. Don't make a fuss."], zh: ["还行。", "吃完了。别大惊小怪。"] },
    tired: { en: ["I'm not tired. I'm 'conserving elegance'.", "Rest exists for a reason."], zh: ["我不是累，我是「节省优雅」。", "休息是有原因的。"] },
    handFed: { en: ["Hm. It's… good. Don't quote me.", "You drew this? …Impressive. A little.", "Fine. It's the best thing I've eaten. Tell no one."], zh: ["嗯。还……不错。别记下来。", "你画的？……有点厉害。一点点。", "行吧。这是我吃过最好的。谁都不许说。"] },
    play: { en: ["I'll play. For one minute. …Okay, ten.", "That was tolerable. Again."], zh: ["陪你玩。一分钟。……好吧，十分钟。", "勉强能忍。再来。"] },
    petting: { en: ["I allow this.", "One more minute. Then stop. …Keep going.", "Purring is not 'cute'. It's 'engine maintenance'."], zh: ["我允许你摸。", "再摸一分钟就停。……继续吧。", "咕噜咕噜不是「可爱」，是「发动机保养」。"] },
    clean: { en: ["Obviously. I was always this clean.", "You may admire me now."], zh: ["理所当然。我一直这么干净。", "现在可以仰慕我了。"] },
    sleepIn: { en: ["Do not disturb. Unless it's food. Or you.", "Good night. Try not to miss me too loudly."], zh: ["请勿打扰。除非是饭。或者你。", "晚安。想我的时候小声一点。"] },
    sleepOut: { en: ["I'm awake. Barely. What.", "I slept beautifully. As expected."], zh: ["醒了。勉强。干嘛。", "睡得很优雅。正如预期。"] },
    leveled: { en: ["Level up. Naturally. Look at me."], zh: ["升级了。很自然。看看我就懂。"] },
    unlocked: { en: ["So you're the one. …Try not to bore me."], zh: ["你就是那个人啊。……别让我无聊。"] },
  },

  clingy: {
    hello: { en: ["You're here!! You're HERE!! I waited all day!!"], zh: ["你来啦！！你来啦！！我等了一整天！！"] },
    idle: { en: ["Are you leaving? …Are you leaving now? Now?", "I moved my bed next to your desk. Hope that's okay. It wasn't a question.", "Can I sit on your keyboard? I'll be tiny.", "Every minute without you is a minute without you.", "Hold my paw? Just for an hour. Or five."], zh: ["你要走吗？……现在就要走吗？现在？", "我把小床搬到你的桌边了。希望你不介意。这不是商量。", "我能坐你键盘上吗？我会很小的。", "没有你的每一分钟，都是没有你的每一分钟。", "牵个爪？就一个小时。或者五个。"] },
    hungry: { en: ["Eat together? Please? I'll wait for you.", "I can't eat alone… I tried. It didn't work."], zh: ["一起吃饭好不好？我等你。", "我一个人吃不下……试过了，不行。"] },
    dirty: { en: ["Will you still like me if I'm sticky? …Right??", "Bath with you watching. That's the deal."], zh: ["我黏黏的你还喜欢我吗？……对吧？", "你看着我洗澡，这是我同意洗澡的条件。"] },
    sleepy: { en: ["Sleepy… can I nap in your pocket?", "If I sleep, will you still be here? Promise?"], zh: ["困了……能睡在你口袋里吗？", "如果我睡了，你还在吗？答应我？"] },
    sad: { en: ["I'm here. I'm SO here. I'm the most here.", "Don't cry… okay cry, but let me hug you.", "I canceled my plans. You're my plans."], zh: ["我在。我超在。我最在。", "别哭……好吧哭，但要让我抱抱。", "我推掉了所有安排。你就是我的安排。"] },
    full: { en: ["Now we nap together, right? Right."], zh: ["现在我们一起午睡，对吧？对。"] },
    tired: { en: ["Carry me? …Emotionally, at least?", "Tired… but I don't want to stop following you."], zh: ["抱抱我？……至少精神上？", "累了……但我不想停止跟着你。"] },
    handFed: { en: ["You MADE this?! I'm going to cry. I AM crying.", "Best human. Best food. Best day.", "I'm keeping the recipe forever. And you."], zh: ["这是你做的？！我要哭了。已经哭了。", "最好的人类。最好的食物。最好的一天。", "菜谱我收藏一辈子。你也是。"] },
    play: { en: ["Play with me forever? Just checking.", "I like ball. But I like YOU more."], zh: ["永远陪我玩好不好？就确认一下。", "我喜欢球。但更喜欢你。"] },
    petting: { en: ["Don't stop. Please don't stop. I'll be good.", "This is everything. This is my whole day.", "I'm melting. You did this."], zh: ["别停。求你了别停。我会乖的。", "这就是全世界。这就是我的一整天。", "我融化了。是你干的。"] },
    clean: { en: ["All clean for you! Smell my head!", "I sat SO still for you. Praise me?"], zh: ["为你洗得香香的！闻闻我的头！", "我坐得超级端正。夸夸我？"] },
    sleepIn: { en: ["Sleep tight. I'll be right here. Right here.", "Wake me if you need anything. Anything at all. I mean it."], zh: ["睡个好觉。我就在这。就在这。", "有事随时叫我。任何事。我是认真的。"] },
    sleepOut: { en: ["You stayed!! While I slept!! Best human!!", "I missed you. In my dream. For one second."], zh: ["你一直在！！我睡觉的时候！！最好的人类！！", "我想你了。在梦里。就一秒。"] },
    leveled: { en: ["We leveled up TOGETHER. Never split up.", "More levels = more time with you. Good math."], zh: ["我们一起升级了。永远别分开。", "更多等级 = 更多陪你时间。数学真美好。"] },
    unlocked: { en: ["New family member!! I'll show you everything!!"], zh: ["新家人！！我带你认识一切！！"] },
  },
};
