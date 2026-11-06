# 内容语言方案（es / pt / fr + 「只看本语言」）

> 目标：加西班牙语、葡萄牙语、法语三种语言；在语言选择处加一个「只看本语言内容」开关（默认关）；
> 深度接入漂流瓶、暖心墙、故事三条内容线。
> 状态：**方案待拍板，未动代码。**

---

## 一、先把两件事分开

绝大多数「语言」相关的需求翻车，都是因为把这两件事当成一件事：

| | 界面语言（UI locale） | 内容语言（content language） |
|---|---|---|
| 是什么 | 按钮、标题、提示语 | 用户写出来的帖子 / 瓶子 / 故事 |
| 谁决定 | 用户自己选，立刻生效 | 作者写的时候定的，读者只能「过滤」或「翻译」 |
| 现状 | `src/i18n.js`，en/zh 两套，742 个 key | **完全没有这个概念**，三张表都没有语言字段 |

X 和 Reddit 都是分开做的，而且都明确说了「改显示语言不会改变时间线内容」（X 帮助中心原话）。
所以这个需求实际是：**新增内容语言维度 + 一个消费端偏好开关**，不是「把 UI 翻译成西语」——后者只是其中一半。

---

## 二、主流怎么做的（调研结论）

| 平台 | 做法 | 对我们的启示 |
|---|---|---|
| **X** | 显示语言 ≠ 内容语言。内容语言在「Recommendations」里是**多选列表**，由算法检测每条帖的 `tweet.lang`，无法判断时给 `und`。没有「只看某语言」的开关，只能靠推荐权重 | 检测要有 `und` 兜底；但 X 不做硬隐藏，导致用户仍被外语刷屏（所以民间做了浏览器插件按 `tweet.lang` 硬过滤） |
| **Reddit** | 每个社区有主语言；用户可设「内容语言」列表；不再自动翻译列表外语言；机器翻译 + 「看原文」 | 「内容语言是多选，不是单选」这个设定很关键 |
| **Threads / Instagram** | 不隐藏，只给「翻译」按钮 | 翻译是补位手段，前提是先有语言标记 |
| **Telegram / Discord** | 频道/服务器标语言，搜索可过滤；聊天流不过滤 | 硬过滤只适合「发现」场景，不适合「feed」 |

**三条可直接借用的结论**：

1. **内容语言是多选偏好，不是单选硬过滤。** 用户能读西语和英语时，只给他西语等于砍掉一半内容。
2. **检测必须有 `und`（未识别）兜底**，且 `und` 不能被隐藏——短句、纯 emoji、纯链接都判不出来。
3. **硬隐藏只在新内容足够多时才成立。** 我们库里现在 536 条几乎全是中文，一旦西语用户开「只看西语」，
   暖心墙就是白屏。这是我下面反对「纯硬过滤」的唯一理由，也是最重要的设计约束。

---

## 三、我的建议：**优先 + 补位**，而不是硬隐藏

用户要的是「只看本语言」。纯硬隐藏的体验是：

```
西语用户开启开关 → 暖心墙 0 条 → 空白页 → 以为 App 坏了
                 → 漂流瓶点「捞一个」→ bottle-empty-sea 报错 → 直接卸载
```

所以建议把开关做成「**优先**本语言」，语义写清楚：

> 开启后优先显示西班牙语内容；本语言内容不够时，会补充其他语言并标注。

具体到三条线的行为：

| 场景 | 开关关（默认） | 开关开 |
|---|---|---|
| 暖心墙 feed | 全语言混排 | 先取本语言一页（20 条）；**不足 8 条时**用其他语言补齐，补进来的卡片打语言标签 |
| 漂流瓶捞取 | `order by random()` | 先在「本语言 + 未识别」池里随机捞；**池空则退回全语言**（绝不报空海） |
| 故事列表/榜单 | 全语言 | 先本语言；不足一页则补位并标注 |

如果你坚持要**纯硬隐藏**，也可以做，但要接受三件事：① 新语言上线初期三条线基本都是空的；
② 漂流瓶必须允许「池空退回」，否则功能不可用；③ 需要先灌种子内容，否则开关等于自杀。
所以我建议开关直接给**两档语义**（优先 / 仅此语言），默认「优先」，让用户自己决定要不要更严格。

---

## 四、数据模型

三张表各加两列（命名、类型统一，便于以后做「全站内容语言统计」）：

```sql
alter table public.wall_posts     add column if not exists lang text;          -- 'en'|'zh'|'es'|'pt'|'fr'|null(=und)
alter table public.wall_posts     add column if not exists lang_src text not null default 'auto';  -- auto|user
alter table public.bottle_letters add column if not exists lang text;
alter table public.bottle_letters add column if not exists lang_src text not null default 'auto';
alter table public.stories        add column if not exists lang text;
alter table public.stories        add column if not exists lang_src text not null default 'auto';

create index if not exists wall_posts_lang_idx     on public.wall_posts (lang, created_at desc);
create index if not exists bottle_letters_lang_idx on public.bottle_letters (lang) where status = 'sea';
create index if not exists stories_lang_idx        on public.stories (lang, created_at desc);
```

- `null` 表示 und（判不出来），**不算「其他语言」**：开关开着时 und 内容始终展示。
- `lang_src = 'user'` 表示用户在发布时手动改过检测结果（自动检测错的时候有救）。
- 存量 536 条：跑一次离线回填脚本（同一套检测逻辑），`lang_src` 保持 `auto`。

### 漂流瓶 RPC 改动

```sql
create or replace function public.bottle_fish(p_lang text default null)
returns public.bottle_letters
...
  -- 先按语言捞
  select id into v_id from public.bottle_letters
    where status = 'sea' and user_id <> auth.uid()
      and (p_lang is null or lang = p_lang or lang is null)
    order by random() limit 1;
  -- 池空 → 退回全语言（绝不因语言把功能卡死）
  if v_id is null then
    select id into v_id from public.bottle_letters
      where status = 'sea' and user_id <> auth.uid()
      order by random() limit 1;
  end if;
```

`p_lang` 由客户端传当前 UI 语言；不传 = 旧行为（老客户端兼容）。

---

## 五、语言检测（客户端，不上服务端）

新增 `src/utils/langDetect.js`，纯函数、可单测：

1. **按字判书写系统**
   - 汉字占比 ≥ 20% → `zh`（本项目不做日文；出现假名 → `und`）
   - 西里尔 / 阿拉伯 / 天城文 → `und`（不在这五种语言里，但不该被当成「西语」）
2. **拉丁字母按词打分**（这是 es / pt / fr / en 的主战场）
   - 各语言 40–60 个高频停用词表：`de/la/que/y`（es）、`de/da/que/não`（pt）、`de/la/que/et`（fr）、`the/and/to/of`（en）
   - 变音符号加权：`ñ ¿ ¡` → es；`ã õ ç` → pt；`ç è ê œ` → fr；`é à` 共享，低权重
   - 词形后缀：`-ção/-ções`（pt）、`-ción/-ciones`（es）、`-tion`（fr/en）
3. **置信度 < 0.45 → `null`（und）**。宁可标 und（永远展示），也不要标错（被错误隐藏）。
4. 文本 < 8 个字符直接 `und`。

单测样例 ≥ 40 条（含中/英/西/葡/法真实句子、短句、emoji-only、中英混写）。

---

## 六、三条内容线怎么接

### 暖心墙（CommunityView）
- 取数：`listPosts` 加可选 `lang` 参数（REST 链 `.eq("lang", cur)`，与现有游标分页兼容）。
- 开关开：先查本语言（+und）一页；`rows.length < 8` 时再查一次不带条件补齐，补进来的标 `foreign: true`。
- 卡片右上角显示语言标签（`ES`/`FR`/`PT`），点击可看原文（现在就只是标签，翻译留到 P4）。
- **搜索、我的帖子、收藏、个人主页不过滤**（属于「找东西」和「我的」，过滤反而碍事），结果里给语言标签。

### 漂流瓶（BottlePageView）
- 发送时检测 + 落库；捞取调 `bottle_fish(p_lang)`。
- 开关关 → 不传 `p_lang`（保持现在的纯随机，体验最「漂流」）。
- 开关开 → 传当前语言，服务端优先同语言、空则回落。
- 「我的瓶子 / 收到的回信」不按语言过滤。

### 故事（StoryView / StoryRankView）
- `storyRank(mode, tag, period)` 加 `p_lang`，榜单先同语言；不足 10 条补位。
- 详情页、评论不按语言过滤（评论跟随主内容语境）。

---

## 七、UI

设置页「语言」这一行下面紧接一个开关（不是二级页面，少一次跳转）：

```
语言                        Español  ▾
只看西班牙语内容              ●——○    默认关
  开启后优先显示西班牙语内容；不够时会补充其他语言并标注。
```

- 切换语言时若开关是开的 → 内容查询按新语言重建（墙要回到顶部刷新）。
- 开关状态存 `wp-content-lang-only`（`utils/storage.js`，跟现有 `wp-lang` 同款）。
- 首次进西语/葡语/法语时，可以在墙上给一条可关闭的引导条：「用 Español 打字，也看得见别人的 Español」。

---

## 八、包体积（这次先说清楚）

742 个 key × 3 语言 ≈ **78K 字符 ≈ 230KB 未压缩 JS**。全塞进主包会让首屏下载明显变重
（刚踩过字体的坑，这次提前处理）：

- 主包只保留 en + zh（现状不变）
- es / pt / fr 拆成三个 chunk，用 `import()` 动态加载，切换语言时才拉，拉完缓存
- 回退策略：chunk 没到时先用 en 渲染，到了再切换（或 loading 200ms 内不闪）

预计：主包体积不变，每个语言 chunk ~70KB（gzip 后 ~20KB）。

---

## 九、分阶段与工作量

| 阶段 | 内容 | 交付物 |
|---|---|---|
| **P0** | 三种语言包（742 key × 3）+ 语言包动态加载 + 语言选择列表扩到 5 项 | 切语言能看到完整西/葡/法界面 |
| **P1** | DB 迁移（6 列 + 3 索引）+ `langDetect.js` + 发布时检测落库 + 存量回填脚本 | 新内容带语言，旧内容回填完 |
| **P2** | 暖心墙过滤 + 补位 + 语言标签 | 开关在墙上生效 |
| **P3** | 漂流瓶 RPC + 捞取传入语言 | 开关在瓶子上生效 |
| **P4** | 故事列表/榜单 + 开关文案与引导 | 全链路打通 |
| **P5**（可选） | 翻译按钮（点一下调 LLM 翻成当前语言）、后台语言分布统计 | — |

**必须先说清的两个成本**：

1. **翻译质量**：742 key × 3 = 2226 条。机器翻译能出 80%，但西/葡的性数一致、敬语（tú/usted、você）、
   法语省音（l'/d'）都得过一遍。我出初稿 + 术语表统一，你或母语者过一遍关键文案（注册、支付、隐私）。
2. **测试改造**：现有测试大量断言「zh/en 成对」（如 `story-test` 里 `=== 2`），加语言后要统一改成
   「每个语言块的 key 集合与 en 一致」。粗估 20+ 处断言要改，属于 P0 的一部分。

---

## 十、需要你拍板的三件事

1. **开关语义**：`优先（推荐，不够时补位）` 还是 `仅此语言（严格隐藏，可能白屏）`？
2. **上线顺序**：先把 5 种语言包一次做完（P0 一起上），还是先 es 一种跑通全链路再加 pt/fr？
3. **存量 536 条**：全部回填检测（推荐），还是只回填最近 30 天？
