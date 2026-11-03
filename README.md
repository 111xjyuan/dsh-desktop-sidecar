# dsh-desktop-sidecar

给 DeepSeek Harness 加一双「手」：让 AI 在 Windows 上真正操作你的电脑——看屏幕、读文字、点按钮、打字、按快捷键，包括微信、Office、浏览器、网课播放器这些没有自动化接口的软件。

装一个 npm 包就能用，不需要另外装 Python、驱动或中间服务。

操作时屏幕右下角会出现一条状态条（深色圆角小卡片，左边一个青色呼吸点，右边显示进度，比如 `3/7`；整条不抢焦点、鼠标能穿过它），按 Esc 可以随时叫停。

## 写在前面

我不是专业做这个的，能力和精力都有限，肯定还有没考虑周全的地方。你如果在用的时候遇到 bug、或者觉得哪里别扭，欢迎来提 [Issue](https://github.com/111xjyuan/dsh-desktop-sidecar/issues)——你的反馈是它变好的主要来源。功能建议也欢迎，我不一定都能做，但会认真看。

**现在它能做的：**

- 列出当前有哪些窗口，找到你要操作的那个
- 读出窗口里的文字（Windows 自带离线 OCR，中文优先）和控件结构
- 点按钮、点文字、点坐标——点完会截图比对，界面没变就重试或告诉你原因
- 输入文字（中文也行：能直接写进输入框就写值，否则发真按键，都不占你的剪贴板）、按任意组合键
- 一次调用跑完一串步骤，中途可以按 Esc 停下
- 网课自动播放：判断是否在播、自动切下一节
- 每次操作都有屏幕提示 + 操作日志，随时能查它到底点了哪儿
- 锁屏、UAC 提权确认这类系统安全界面一律拒绝，不会乱按

## 工具一览

```
desktop_look     → 一次调用看清当前局面：前台窗口 + 窗口列表 + 可点控件 +（可选）OCR 文字 +（可选）编号截图
desktop_windows  → 现在有哪些窗口
desktop_launch   → 启动程序 / 打开网址或文件，并等它的窗口出现
desktop_tree     → 这个窗口有哪些控件（UIA 控件树，带编号索引，可直接点）
desktop_invoke   → 直接触发控件（不移动鼠标、不需要窗口在前台）
desktop_text     → 精确读窗口或输入框里的文字（UIA 文本，不是 OCR 猜的；读不到才退回 OCR）
desktop_read     → 窗口里写了什么（离线 OCR，带坐标）
desktop_capture  → 截图：直接作为图片返回，带坐标尺 + 缩放契约，画面没变就不重复发
desktop_click    → 点控件（ref / 名字 / 编号）/ 点文字 / 点坐标（点前查遮挡、点后像素+控件树双校验、点完把鼠标和前台还给你）
desktop_sequence → 批量：一次调用跑多步（dryRun / stopOnError / Esc 中止）
desktop_type     → 输入文字（能用 ValuePattern 就直接写值；否则真按键（Unicode），都不占你的剪贴板）
desktop_key      → 按键 / 组合键
desktop_wait     → 等到条件成立再继续（窗口出现/消失、文字出现、画面变化、界面安静下来）
desktop_scroll   → 滚动（含横向；返回 changed 判断是否滚到底）
desktop_drag     → 拖动（按下 → 分步移动 → 松开）
desktop_window   → 窗口激活 / 最小化 / 最大化 / 还原 / 移动 / 关闭
desktop_course   → 网课自动播放（帧差判播放 + 自动下一节；必须点名窗口，dryRun 才允许自动取前台）
desktop_web      → 网页通道：插件内置浏览器（后台跑、不动你的鼠标）或你屏幕上的浏览器，开始前会先问你用哪种
desktop_log      → 操作日志：每次点击/输入/按键都记了一条，可回看可清空
desktop_doctor   → 环境自检（平台 / DPI / 多屏 / OCR / 前台锁 / 输入控件 / 状态条 / 安全桌面）
```

## 推荐的用法顺序（给模型看的）

```
1. desktop_look  {image:true}          ← 先看一眼：前台是谁、有哪些控件（带编号）、可选截图
2. 有控件名就用 desktop_invoke / desktop_click{ref}（ref 就是 look 里的 e7 这种短号）
   没有控件（微信/Electron/Qt）就用 desktop_click{text} 或 desktop_capture 看坐标
   网页任务：先 desktop_web{action:"open"}（不带 mode）→ 它会给你一道选择题问用户用哪种浏览器，
             再用 snapshot 拿编号元素、click/type/fill 按编号操作；要用户盯着看才用 mode:"screen"
3. desktop_text  读结果 / desktop_wait 等结果      ← 别用固定 sleep 猜
4. desktop_launch 启动新程序（会自动等窗口出现）
```

一条经验：**先把「等」和「看一眼」做进工具里，比让模型自己多跑几轮更准也更快。**

## 它是怎么做的

同一件事，Windows 上通常有两条路，插件会自动选：

| 应用类型 | 识别方式 | 说明 |
|---|---|---|
| 记事本、Office、资源管理器、设置、WinUI 应用 | **UIA 控件树** | `desktop_tree` 拿到按钮/菜单的名字与能力，`desktop_invoke` 直接触发——不移动鼠标、不需要前台，最稳也最省 token；要点击就先 `desktop_click{name,role}`（按名字，不会过期） |
| 微信、VS Code、Discord、Electron/Qt 自绘界面 | **OCR + 坐标点击** | 这些应用不实现 UIA，`desktop_tree` 会返回空并自动附一段 OCR 摘要；用 `desktop_read` 找字、`desktop_click` 的 `text` 参数按字点击 |

经验法则：**能用 `desktop_invoke` 就别用 `desktop_click`；能按文字点就别按坐标点。**

截图会作为图片返回给支持看图的模型，但每条能力都留了纯文本路径（控件树 / 离线 OCR / 坐标），所以纯文本模型也能跑完整流程。

真实场景里它是这样干活的——发微信（`desktop_click` 按文字定位 → `desktop_type` 粘贴 → `desktop_key` 回车，点完会比对像素确认界面真的变了）：

（这里原本放了截图，考虑到截图里带着我自己电脑上的聊天列表和课程页面，已经撤掉——不想把个人内容放进公开仓库。）

遇到没有接口的网课页，用离线 OCR 读出题目和选项，再按坐标点：

### 操作时的屏幕提示与日志

- **状态条**：只要它真的要动鼠标键盘，屏幕底部就会出现「DSH 正在操作这台电脑」，第二行是当前动作，右下角是批量任务的进度；1.4 秒没有新动作自动收起。它不抢焦点、鼠标可以穿透。
- **Esc 中止**：批量任务、盯课过程中按住 Esc，当前这一步做完就停，返回 `cancelled:true`。
- **操作日志**：每次点击/输入/按键都会记一条（时间、工具、窗口、坐标、结果、是否重试），用 `desktop_log` 回看：`{"limit": 30}`，`{"clear": true}` 归档并清空。文件在 `%TEMP%/dsh-sidecar/actions.jsonl`。
- **安全桌面拦截**：锁屏、UAC 提权确认、切换用户这些系统安全界面，所有模拟输入都会被拒绝并返回 `refused: secure desktop`——不会去按「是」，也不会往锁屏密码框里打字。

### 0.10.1（少等、少启动进程）
- 控件树读一次缓 0.9 秒，同一步里连着看同一窗口不再重复启动 PowerShell（1760ms → 0ms）。
- 记住天生稀疏的窗口（Edge/Chromium、Qt 自绘），不再为懒加载白等 0.9 秒。
- 点击/写值后立即清缓存，避免读到动作前的旧树。

## 更新记录

### 0.10.0（会量你的电脑，出问题说人话）
- 自动量环境并按机器调参（缩放、OCR 语言包、PowerShell 版本、权限），结果缓存一天。
- 报错改成「发生了什么 / 为什么 / 你现在该做什么」，需要你动手时写成说明书。
- `desktop_doctor{report:true}` 一条命令生成可直接发出来的体检报告。
- PowerShell 加了熔断，安全软件拦截时不再反复重试；多屏各自带 DPI。



### 0.9.0（不打断看得见 / 判断可核查 / 指挥台不再闪）
- 你在动鼠标键盘时，状态条会写「你先忙，我等」，你停手它才动手；结果里有 `yielded` 说明等过多久。
- 每一步的结果都带 `evidence`：这次是靠控件文字、截图识字、还是看图定坐标判断的，`trusted` 告诉你该多信。
- 指挥台不再一闪一收：刚开 12 秒不关、两次操作之间的空档不关、连续 3 次没动作才关。
- 打字会读回核对；读不回来就老实说「发出去了但没法确认」，不再谎报成功，也不再冤枉自己是失败。
- 体检里的「抢前台」不再误报（后台程序被系统拒绝是正常的）。

### 0.8.3（乱点、分不清最上层、白等，都修了）
- 点击前先确认落点没被挡住，抢前台后再复验；被置顶浮层盖住就明说，不去点别人的窗口。
- 每次点击最多 2 下（系统对话框 3 下），点偏就停手，不会连点一通。
- `desktop_windows` 带 `z`/`foreground`，`desktop_click` 回带 `windowZ`/`wasForeground`，一眼看出在操作谁。
- 启动程序按本机真实路径找（`where` + 浅扫），找不到立刻给候选；打开链接/文档最多等 3~4 秒就去找刚开的标签页。
- `.html` 直接用浏览器打开，绕开「选择一个应用」对话框。
- 按文字点击优先用无障碍名字，OCR 做兜底；`desktop_tree` 每个元素标 `action`。

完整的逐条记录见 [CHANGELOG.md](CHANGELOG.md)，这里只挑每个版本最值得知道的几点。

### 0.8.0（侧边栏指挥台 / 自动开合）

- **右侧栏多一个「🎯 指挥台」**：我操作电脑时想纠偏，直接在里面打一句、回车即可，下一次动作前就会读到，不用开记事本。
- **自动开合**：我开始动鼠标键盘时它自己展开，停手 1.5 秒后自己收起。
- `desktop_tree` 每个控件多一个 `action` 字段（click / fill / toggle / select / expand / scroll），不用猜能对它做什么。
- 组合键半路出错也会把修饰键松开，不会留一个粘住的 Ctrl。拖拽越界、`javascript:` 地址都会被直接拒绝。

### 0.7.5（能中途指挥 / 不抢鼠标键盘）

- 新增 `desktop_steer`：开一个文本文件给你写指令，长操作每一步之间会读它，读到就停下等你改完再继续。
- 动鼠标键盘前先看你忙不忙：你在操作就等，等不到就明确说“我没有动手”（`blocked:"user-active"`）。

### 0.7.4（点完先确认焦点）

- `desktop_type` 用坐标/ref/name/文字定位输入框后，会再问一次系统“焦点落在哪个控件”，不是输入框就停下说明（`blocked:"focus"`），不把字打进空气里。

### 0.7.3（脚本编码导致的“读不到控件”，网页里打字）

- 修一个会让控件树整块失效的坑：两个 PowerShell 脚本改成 UTF-8 with BOM（5.1 会按本机编码解码，中文注释乱码后整份脚本语法错误）。
- `desktop_doctor` 新增 `uia-script` 检查，装完先跑一次体检就知道。
- 浏览器里打完字会读回页面确认；没落到网页就明确告诉你（`blocked:"focus"`），不再假装成功。
- `desktop_type` 支持 `x/y/fx/fy` 先点再打，也会复用上一步按文字点击的位置。

### 0.7.2（不动你的窗口 + 长文本不丢字）

- 最大化的不还原、最小化的不弹出、全屏的不退全屏；要用最小化的窗口得明说（`restoreWindow:true`）。
- 长文本（≥20 字）改成剪贴板粘贴，一次落地不丢字，用完把你的剪贴板还回去。
- 网址启动在浏览器已打开时不再报“没等到窗口”，而是 `reused:true` 说明变成新标签页了。
- 抢前台改成三重线程输入附加 + 结果验证，减少“窗口在前面、字打到别处”。

### 0.7.1（两条使用反馈）

- **不再动你的窗口**：以前每次点击/输入前都会把窗口“恢复”一下，最大化的会变回普通大小、F11 全屏会被取消。现在只有最小化的窗口才会被叫回来。
- **在浏览器里能打字了**：`desktop_type` 支持 `ref` / `name`（先点输入框再输入）；没点输入框就直接打字时会明确告诉你「先点输入框」，不会假装写成功了。
- 浏览器的无障碍信息是慢热型的，第一次读只有窗口框架，现在会自动补读一次（地址栏、工具条都能读到）。

### 0.7.0（新增网页通道 desktop_web）

- **新增 `desktop_web`：网页也能交给它，而且先问你**。第一次打开网页时不给 `mode`，它会返回一道选择题：用**插件内置浏览器**（后台独立窗口，不抢鼠标、不动你正在看的画面，适合登录/填表/抓信息）还是**你屏幕上的浏览器**（看得见、随时接管）。你选了它才动手。
- **内置通道走 CDP 直连，读的是网页真实文字**：返回结构化文字快照 + 元素编号（ref），纯文本模型也能用；点击/输入按编号操作，页面跳转后重新快照即可；只接受 http/https。
- **会记住登录**：cookie / localStorage 存在 `%LOCALAPPDATA%\dsh-sidecar\web-profile`，关掉再开、甚至重启 DSH，登录状态都还在；想用完即弃加 `profile:"temp"`，想全部清空用 `action:"reset"`。
- 用的是独立配置目录，不动你日常浏览器的登录状态和书签。

### 0.6.2（自查修的几处）

- **不会再把正常窗口误当成「点不动的系统对话框」**：只有标题真正读不出来的窗口才算受保护。
- **窗口解析不再每次都扫全屏**：先走普通枚举（2~3ms），找不到才扫一次，常用操作不再多等 50ms。
- **键盘兜底默认关闭**：需要时给 `desktop_click` 传 `keyboard:true`，否则不会替你按 `Tab` / `Enter`。

### 0.6.1（修 issue #5 的四个问题）

- **不再把「已解锁」误判成锁屏**：会话里残留一个没有主窗口的 `LockApp.exe` 时，以前会拒绝所有输入。现在只有输入桌面不是 `Default`、或真的存在 `LogonUI` 才算锁屏。
- **Windows 路径不再被当成网址**：`C:\Users\...\a.txt` 这种绝对路径可以直接打开（以前报 `unknown URL scheme`）。
- **`desktop_launch` 默认不复用已打开的窗口**：避免把输入打进你正在编辑的那份文件；确实要复用时传 `reuse:true`。
- **新版记事本的文字能读到了**：UIA 只给 1 个字符时自动退回 OCR，并标明 `source:"ocr"`。
- **可以钉死目标**：`desktop_type` / `desktop_click` 支持 `expectTitle` / `expectPid`，窗口不对就直接拒绝。
- **系统「打开方式」弹窗现在能被看到、读出来**：这类窗口既不在窗口枚举里也读不到无障碍信息，以前插件完全不知道它存在；现在会显示成「系统对话框」，`desktop_read` 能 OCR 出里面有哪些应用。
- **点不动的窗口不再假装点到了**：这类系统弹窗 Windows 不允许程序送模拟鼠标，`desktop_click` 现在会回 `blocked:"protected-window"` 并提示改用 `Tab` / `↓` / `Enter` / `Esc`。

### 0.6.0（19 个工具 + 一批安全边界）

- **一次调用看清局面**：新增 `desktop_look`（前台窗口 + 窗口列表 + 可点控件 + 可选文字 + 可选编号截图），省掉以前连着调三四个工具。
- **新工具**：`desktop_launch`（启动程序并等窗口出现）、`desktop_wait`（等窗口/文字/画面/安静）、`desktop_text`（无障碍方式读真实文字，不是 OCR 猜）、`desktop_scroll`、`desktop_drag`、`desktop_window`。
- **输入不再占你的剪贴板**：能直接写输入框就写值，否则发真正的 Unicode 按键，都不动剪贴板；失败才退回粘贴。
- **状态条移到右下角**，不再挡在屏幕中间；长文案自动省略。
- **点击更可靠**：点前查落点有没有被别的窗口盖住，点后同时比对像素与控件树，点完把鼠标和前台还给你。
- **`desktop_course` 不再猜窗口**：它会在页面上真点「播放/下一节」，所以必须点名窗口；只有 `dryRun`（只观察）才允许自动取前台的浏览器。
- **空输入不再乱打**：`desktop_type` 没给文字时直接报错，不会把字符串 `undefined` 打进当前窗口。
- **报错更像人话**：屏幕外坐标、未知协议、`maxSteps` 非正数、`kind` 拼错，都会直接说清哪里不对、下一步怎么办。
- **跨机器更稳**：PowerShell 路径自适应（系统不在 C 盘也能用）、多显示器负坐标截图、最小化窗口也能列出并还原。

### 0.5.5（锁屏判断更稳）

- 锁屏状态不再单看系统标志位（个别机器上它是反的），改为「系统标志 + LogonUI / LockApp 进程」两个信号互相印证，减少误判：既不会在锁屏时误操作，也不至于把正常桌面当成锁屏。

### 0.5.4（让你看得见它在做什么）

- **屏幕状态条**：真正操作时屏幕底部出现提示条（进程内 GDI 自绘，不装任何东西、不抢焦点、鼠标穿透），空闲 1.4 秒自动收起。
- **Esc 随时中止**：`desktop_sequence` / `desktop_course` 跑长任务时按 Esc 就地停下，返回 `cancelled:true`。
- **操作日志 + `desktop_log`**：每次点击/输入/按键都记一条，可回看最近 N 条、可归档清空。出了「它到底点了哪儿」这种问题，先看这里。
- **安全桌面拦截**：锁屏 / UAC / 切换用户界面一律拒绝操作（`refused: secure desktop`）。
- **点空了会自动重新定位**：按文字点击后界面没变时，重新 OCR 找一次再点，而不是对着老坐标傻点。
- **新增技能说明** `skills/desktop-sidecar/SKILL.md`：告诉模型先看后动、能用控件就别用坐标。
- `desktop_doctor` 增加状态条、操作日志、安全桌面三项自检。

### 0.5.3（修 issue #3 #4）

- **`desktop_invoke` 不再猜**：名字完全相同的控件优先；同名或子串命中多个时**一个都不点**，返回 `ambiguous:true` + `candidates` 列表，让你改用精确名字或加 `role`。新增 `match: auto|exact|substring` 与 `role` 参数。
- **`desktop_click` 支持按名字点**：`{name:"按钮文字", role:"Button"}`，点击时才定位控件，不像 `control:N` 那样会因界面变化而失效。
- **`+` 键终于能按了**：`desktop_key{"key":"+"}` / `"ctrl++"` 以前报 unknown key，现在按 Shift+ 正确打出加号。
- **`desktop_doctor` 的 DPI 不再误报**：改为查询进程真实 DPI 感知级别（`GetProcessDpiAwareness`）。宿主已预设时 Setter 返回 false 属正常，不再判失败。
- **`desktop_capture` 参数说明**：`x/y/width/height` 只在区域截图时生效，给了 `window` 就按整窗。

### 0.5.0（补齐自检与批量）

- **DPI 感知**：启动即声明 per-monitor v2，并在 `desktop_doctor` 里体检——125%/150% 缩放下坐标不再偏。
- **截图直接给模型看**：`desktop_capture` 返回 image block，图上叠了坐标尺（顶部 x、左侧 y，单位是客户区像素）。
- **帧去重**：同一窗口画面没变时返回 `unchanged:true` 且不重复附图，省 token。
- **批量**：`desktop_sequence` 一次调用跑多步，支持 `dryRun`、`stopOnError`、步骤上限 24，按住 **Esc** 可随时中止。
- **控件索引点击 + 身份校验**：`desktop_tree` 返回编号，`desktop_click{control:N, expect:{role,name}}` 会重读控件树核对身份，控件挪位就拒点而不是点错。
- **控件过滤**：`meaningfulOnly`（默认开）把装饰性容器滤掉并给出 `controlTotal / filteredOut`，几百个元素降到几十个。

## 3 分钟上手

1. 安装，任选一种：

   ```
   # A. npm（推荐）
   plugin_manager install_bundle dsh-desktop-sidecar

   # B. 插件市场：搜 desktop-sidecar

   # C. 本地源码（开发用）
   plugin_manager install_bundle file:<本目录绝对路径>
   ```

2. **先自检**，有异常会直接给修复建议：

   > 调用 `desktop_doctor`

   期望 `ok: true`。它会检查十项：`platform / powershell / dpi / monitors / ocr / foreground / editable-child / hud / action-log / secure-desktop`，任何一项失败都会直接附上修复建议。

3. 让它干一件事，例如：

   > 打开记事本，写一句“你好，世界”

   模型会依次走 `desktop_windows` → `desktop_type` → `desktop_read` 验证。

## 常见问题

**OCR 返回 0 行？**
系统缺「中文(简体)」OCR 语言包。设置 → 时间和语言 → 语言 → 添加中文(简体) → 可选功能勾选「光学字符识别」。`desktop_doctor` 会直接指出这条。

**点了没反应？**
看返回里的 `changed` 和 `hint`。`changed:false` 且 `inClient:true` 多半是点在了纯文本区（光标移动也算成功）；按钮/菜单请改 `desktop_invoke` 或 `desktop_key`。

**截图拍到了别的窗口？**
工具会先把目标窗口抬到最上层再截；仍不对就先把它切前台（`desktop_invoke` + `focus`，或手动点一下）。

**中文变成乱码？**
`desktop_type` 用剪贴板 + 真 Ctrl+V，正常不会乱；若目标应用禁用粘贴，改用 `desktop_key` 逐键发送。

**系统的「打开方式」/「选择一个应用」这种弹窗点不动？**
这类窗口 Windows 只让系统自己收鼠标：模拟的鼠标移上去连悬停高亮都不会出现，点击也就落不到按钮上。插件现在能做三件事——`desktop_windows` 里会把它显示成「系统对话框」（`protected:true`），`desktop_read` 能 OCR 读出里面有哪些应用，`desktop_click` 打不中时直接回 `blocked:"protected-window"` 而不是假装点到了。真要选，用键盘：`Tab` / `↓` 挪焦点、`Enter` 确认、`Esc` 关掉（已实测有效）。

**在浏览器里打字没反应 / 说输入焦点不对？**
浏览器（Edge/Chrome）的键盘焦点默认停在窗口框架上，盲发按键会被吞掉。现在有两条路：① 指定目标再输入——`desktop_type{window:"…", name:"地址和搜索栏", text:"…"}`，或先用 `desktop_look` 拿 `ref` 再 `desktop_type{ref:"e3"}`；② 直接走 `desktop_web`（内置浏览器，按元素写值，不靠键盘）。没指定输入框又打不进去时，工具会明说 `blocked:"focus"`，不会假装成功。

**为什么它老是动我的窗口大小 / 取消我的全屏？**
0.7.1 之前，每次点击前都会对目标窗口发一次“恢复”，最大化的会缩回普通大小、F11 全屏会掉。现在只有最小化的窗口才会被恢复，最大化和全屏都原样保留。

**管理员窗口点不动？**
Windows UIPI 限制：非提权进程不能向提权窗口发送输入。用管理员身份启动 DSH。

**装完直接报错 / 工具没出现？**
先看两件事：① 系统是不是 Windows 10 1809+ x64/arm64（`desktop_doctor` 的 `platform` 项会写清）；② `desktop_doctor` 的 `powershell` 项是否 `ok`——本插件的读控件、OCR 都靠系统自带的 PowerShell 5.1，被杀软或组策略禁掉就会全盘失效。

**多显示器 / 缩放 125% 会不会点偏？**
不会。插件启动时自己声明 per-monitor-v2 DPI 感知，所有坐标都是物理像素；截图超出虚拟屏的部分会留黑而不是整张失败，负坐标（副屏在主屏左边）也能正常截。`desktop_doctor` 的 `dpi` / `monitors` 两项会显示实际值。

**会占我的剪贴板吗？**
默认不会。`desktop_type` 现在用真实的 Unicode 按键输入，中文、日文、emoji 都能打，`clipboardTouched:false`；只有极少数忽略注入按键的程序（部分游戏、远程桌面）才自动退回 Ctrl+V 方案。

**截了图会一直堆在硬盘里吗？**
不会。只有你显式传 `path` 或 `saveFile:true` 才写文件，其余图片只回给你看；`%TEMP%\dsh-sidecar` 里超过 1 小时的历史文件也会被自动清掉。

**报了什么奇怪的错，想反馈？**
跑一次 `desktop_doctor`，把返回的 `checks` 一起贴到 issue——里面有平台、Node 版本、PowerShell 版本、DPI 级别、显示器数量、OCR 语言，基本能定位八成问题。

## 权限与安全

- 一切操作都在**你本机的桌面会话内**，只能做你自己能做的操作。
- 不上传屏幕内容或文字；OCR 用 Windows 本地引擎，**完全离线**。
- 截图临时文件在 `%TEMP%\dsh-sidecar`，**超过 1 小时自动清理**。
- 前台锁、UIPI、锁屏/安全桌面这类系统限制**不会被绕过**——这是设计选择，不是缺陷。

## Requirements（运行要求）

- **操作系统**：Windows 10 1809+ / Windows 11（x64 或 arm64）。macOS / Linux 不支持。
- **DeepSeek Harness**：`>= 0.2.0`（peer：`@deepseek-ai/dsh-tools >= 0.1.5-rc.1`）。
- **Node.js**：`>= 18`（DSH 自带，一般无需单独安装）。
- **PowerShell 5.1**：系统自带即可（读控件树、OCR 都靠它）；被组策略或杀软禁用时插件会失效，`desktop_doctor` 的 `powershell` 项会指出。
- **不依赖**：Python、任何驱动、任何后台服务；原生调用用 `koffi`（随包安装）。

## 平台

Windows 10 1809+ / Windows 11，x64 与 arm64。

macOS / Linux 未实现（需要完全不同的辅助功能 API，暂不在计划内）。

## 开发

```bash
# 开发期把它同步进 DSH profile 的 node_modules，避免每次重装
powershell -NoProfile -File scripts/sync.ps1
```

改完 `lib/` 后在 DSH 插件面板「禁用 → 启用」即可热重载，无需重启。

测试（不需要真的去点桌面，也不会抢你的前台窗口）：

```bash
npm test          # unit（纯逻辑）+ smoke（假 host 启动、20 个工具的 schema 和渲染）
npm run test:unit # 只跑纯逻辑：按键解析、锁屏判断、文字定位、PNG 编码
```

依赖：`koffi`（原生 FFI）；peer `@deepseek-ai/dsh-tools >= 0.1.5-rc.1`。

## English

**dsh-desktop-sidecar** gives DeepSeek Harness a pair of hands on Windows: it lists windows, reads text with the built-in offline OCR, presses UIA controls by name, clicks by text or coordinates (with pixel-diff verification), types Chinese through the clipboard, and runs multi-step sequences — including apps with no automation API such as WeChat, Office and course players.

- Native Win32 via `koffi`: no Python, no drivers, no helper service.
- Every mutating action shows a small "DSH is controlling this computer" bar on screen; hold `Esc` to abort a sequence.
- Every action is logged (`desktop_log`), so you can always see what it did.
- Secure desktop (lock screen / UAC) is refused, never automated.
- `desktop_doctor` self-checks platform, DPI awareness, monitors, OCR, foreground lock and more.

```
dsh plugin add dsh-desktop-sidecar
```

Requires Windows 10/11. Feedback and bug reports are very welcome — see [Issues](https://github.com/111xjyuan/dsh-desktop-sidecar/issues).

## 许可

MIT
