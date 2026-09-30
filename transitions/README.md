# transitions/ — 动效选型库（轮 122）

> 来源：[transitions.dev](https://transitions.dev) 免费款全量 32 份，官方 CLI 拉取（`npx transitions-dev add --free`，2026-09-29）。
> 作者 Jakub Antalik，MIT 意向的开源配方集（见其 GitHub 仓库 Jakubantalik/transitions.dev）；Pro 付费款未包含。
> **用法约定：以后全站做动画，先从这个文件夹里选配方**——把对应 .md 里的 CSS 搬进目标组件/全局样式，
> 调它的可调变量（每份配方自带变量表），命名带 `t-` 前缀保持与站点样式隔离；
> 必须尊重 `prefers-reduced-motion`（配方自带 media 块，改动时别删）。

## 索引（32 份）

| 配方 | 动效 | 暖爪候选落点 |
| --- | --- | --- |
| `accordion.md` | 手风琴展开/收起（grid-rows 高度 + 箭头形变） | 评论区展开收起 |
| `avatar-group-hover.md` | 头像组悬浮（距离衰减抬升） | — |
| `banner-stacking.md` | 横幅堆叠（三层叠成 toast 塔式） | 多条提示堆叠 |
| `card-resize.md` | 卡片平滑改变尺寸 | — |
| `card-tilt.md` | 3D 指针倾斜 + 光泽 | 分享卡 3D 预览候选 |
| `checkbox-check.md` | 勾选打勾（描边路径绘制） | 设置页勾选 |
| `error-state-shake.md` | 错误抖动（cubic-bezier shake） | 登录/评论发送失败 |
| `icon-swap.md` | 图标切换（缩放+模糊） | 收藏/模式切换图标 |
| `input-clear-dissolve.md` | 输入清空（逐词溶解） | 搜索清空 |
| `learn-more-hover.md` | Learn more 箭头位移展开 | — |
| `like-button.md` | 点赞心形（填充+弹性+八粒粒子迸发） | 评论 ❤️/💔 回应 |
| `matrix-loader.md` | 16 点矩阵加载器（四模式脉冲） | — |
| `menu-dropdown.md` | 菜单下拉（感知开启原点的开合） | ＋钮菜单 |
| `modal.md` | 弹窗开合（缩放转场） | 举报/捞信弹窗 |
| `notification-badge.md` | 红点徽标（对角滑入弹簧） | 消息红点 |
| `number-pop-in.md` | 数字弹入（翻牌+模糊+错峰） | 金币/浏览数变化 |
| `page-side-by-side.md` | 页面并排前进/后退转场 | — |
| `panel-reveal.md` | 面板开合转场 | — |
| `plus-menu-morph.md` | ＋钮液态裂变成扇形菜单 | ＋钮升级候选 |
| `reasoning-stream.md` | 推理流（两行滚动轮替） | — |
| `shimmer-text.md` | 文字微光扫过（遮罩渐变） | — |
| `skeleton-reveal.md` | 骨架屏脉冲→内容交叉淡入 | 暖心墙「载入中」 |
| `spinning-counter.md` | 数字滚轮计数 | 金币变化 |
| `streaming-text.md` | 流式文字（软模糊逐词浮现） | AI/长文渐进展示候选 |
| `success-check.md` | 成功打勾（模糊+旋转） | 领金币/打卡成功 |
| `tabs-sliding.md` | Tabs 胶囊指示条滑动跟随 | 详情页排序「默认/最新」、TabBar |
| `text-states-swap.md` | 文字状态互换（模糊换字） | 「已刷新✓/换一批」提示 |
| `texts-reveal.md` | 两行文字错峰升起入场 | 帖子文字入场 |
| `thinking-states.md` | 思考状态行（微光轮替） | 加载文案轮替候选 |
| `toast.md` | Toast 入场（上升+淡入+缩放） | 评论失败/已拷贝等提示条 |
| `toggle.md` | 开关（滑块双回弹） | 设置页开关 |
| `tooltip.md` | Tooltip（延迟进、位移跟、瞬时出） | 悬停提示 |

## 选型三原则（对齐 DESIGN.md）

1. 动效为「状态变化」服务（开/关、进/出、成功/失败），不做纯装饰动画。
2. 一处一个主转场；列表入场用错峰（stagger），单元素用 spring。
3. 时长落在配方的默认区间（150–600ms），改数值先改配方里的变量而不是散改样式。
