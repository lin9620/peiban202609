# 本地 fork：vue-advanced-chat 2.1.2-warmpaws.1

上游：[vue-advanced-chat@2.1.2](https://github.com/advanced-chat/vue-advanced-chat)（MIT）
文件：`dist/vue-advanced-chat.es.js`（上游发布的打包产物，**未压缩**，35523 行，可读可改）

## 为什么要 fork

会话页的界面在这个库里，而库把整套 DOM 塞进 `shadowRoot`。宿主的 CSS 进不去、事件拿不到，
只能运行时注入 + 内联 `!important` 去抢优先级。抢不过的部分就是我们反复出问题的地方：

- `.vac-emoji-wrapper` 自带 `position: relative` ⇒ 面板 `width: 100%` = 按钮宽（约 40px），
  面板缩成贴着右边的一条竖线（用户截图）
- 手机端 JS 直接往面板上写内联几何：`height = innerHeight − 200`、`top = 100`、
  `right = innerWidth/2 − 150`。内联值只能用 `!important` 压，而且 `height` 跟着窗口变
  ⇒「高度变来变去」
- 压实了又跟 `--kbb`（让位量）打架：内联把 `bottom` 钉成 0，iOS 上面板就沉到工具栏下面 81px

fork 之后这些改成「源码里本来就对」，宿主不再需要内联钉。

## 五处改动

改的都是 `dist/vue-advanced-chat.es.js`，每处都在下文给了可 grep 的锚点。

### 1. wrapper 不再做定位宿主

```
.vac-emoji-wrapper{position:relative;display:flex}   →   {position:static;display:flex}
```

面板因此不再以「按钮那个小盒子」为包含块。

### 2. 手机端面板 = 贴屏底的整宽 sheet

在 `.vac-emoji-wrapper .vac-emoji-picker emoji-picker{` 之前插入：

```css
@media (max-width:899px){
  .vac-emoji-wrapper .vac-emoji-picker:not(.vac-picker-reaction){
    position:fixed!important; left:0!important; right:0!important; bottom:var(--kbb,0px)!important;
    top:auto!important; width:100%!important; height:var(--kb-panel-h,320px)!important;
    padding-top:0; border-radius:0; overflow-x:hidden; overflow-y:auto; z-index:170;
  }
}
```

- `--kbb` = 面板底离布局视口底的距离（iOS 无键盘时 = 底部工具栏 81px）
- `--kb-panel-h` = 本会话见过的最大键盘高（面板与键盘同高）
- 两个变量都由宿主 `src/utils/viewportVars.js` 写入，`--kbb` 另有 `bottomPin.js` 闭环校正
- **为什么这里用 `!important`**：Vue 会把 prop 值写进元素的内联 style，内联普通声明
  优先级高于作者样式表。这是**作者样式表内部的** `!important`（不是宿主在外面跟库抢），
  它压的是库自己写的内联值 —— 位置在同一个文件里，一眼能核对，不会再出现
  「宿主注入的 !important 把 --kbb 也一起压掉」那种事故。

### 3. 手机端不写内联几何

`setEmojiPickerPosition()` 的 `mobileSize` 分支：普通输入框（`!emojiReaction`）直接
`return`，不写 `height/top/right`。长按消息的 reaction 表情**保持上游行为不动**。

### 4. `height = 0` 表示「交给 CSS」

渲染处 `height: \`${emojiPickerHeight}px\`` 改成 `emojiPickerHeight > 0 ? ... : void 0`（0 时不输出）。

### 5. `top = 0` 同上

`top: … : \`${emojiPickerTop}px\`` 改成 `emojiPickerTop > 0 ? ... : void 0`。

### 6. `positionTop` 为真但 height=0 时不许写 top

```diff
- top: $props.positionTop ? $data.emojiPickerHeight : (...)
+ top: $props.positionTop && $data.emojiPickerHeight > 0 ? $data.emojiPickerHeight : (...)
```

**这一条是工装抓出来的真 bug**：`positionTop` 是布尔 prop，web component 传进来的可能是
字符串 `"false"`（truthy）；配合改动 3 的 `height = 0`，渲染结果就是 `top: 0px`——
面板被顶到**屏幕顶部**（工装实测 rect `0..320`，本该 `532..852`）。整宽和高度都对，
只有位置错，肉眼就是「面板跑到上面去了」。

## 怎么核对改动还在

```bash
node tools/vendor-check.mjs     # 依赖接线 + 六处改动是否都在
node tools/vac-sheet-drive.mjs  # 真渲染量面板：整宽 / 贴屏底 / 让开 --kbb / 高度吃 --kb-panel-h
```

`vac-sheet-drive` 实测（393×852）：

```
open           0..393 × 532..852  h=320     贴屏底
open-kbb81     0..393 × 451..771  h=320     让开 iOS 工具栏 81px
open-panel300  0..393 × 471..771  h=300     高度跟着 --kb-panel-h
桌面 1280×800  966..1266 × 262..582 w=300   上游浮层行为未被改坏
```

## 从上游重新同步（升级时）

1. `npm pack vue-advanced-chat@<新版本>`，取 `dist/vue-advanced-chat.es.js`
2. 覆盖 `vendor/vue-advanced-chat/dist/vue-advanced-chat.es.js`
3. 按本文件五处改动重新应用（锚点都能 grep 到；若上游改了结构，锚点会 MISS —— 这是设计，
   宁可停下来人看，也不静默漏改）
4. 跑 `node tools/vendor-check.mjs` + `node tools/emoji-panel-test.mjs` + `node tools/kb-matrix.mjs`

**不要**把依赖改回 `^2.1.2` —— 那样 `npm install` 会装回上游包，五处改动全部消失，
而测试里 fork 相关断言会立刻红（`vendor-check` / `emoji-panel` E18）。
