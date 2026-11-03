## 0.10.2 — 2026-11-04

### 新用户上手不用猜
- README 顶部新增「装好之后先做这 30 秒」：一句话让 AI 自检，附失败时怎么处理、怎么把报告贴出来。
- 第一次真正动手时，屏幕右下角提示一次「已就绪 · 按 Esc 可随时叫停」，之后不再打扰；删掉 `%LOCALAPPDATA%\dsh-sidecarirstrun.json` 可以再看一次。

## 0.10.1 — 2026-11-04

### 更快、也更少惊动安全软件
- 控件树读一次缓 0.9 秒：同一步操作里连着看同一个窗口不再重复启动 PowerShell（实测同一窗口第二次读取 1760ms → 0ms）。
- 记住「这个窗口的控件树天生就稀疏」（Edge/Chromium、Qt 自绘），下次不再为了等懒加载白等 0.9 秒；窗口树恢复丰富时自动忘掉这条记忆。
- 点击/写值之后立刻清缓存，不会拿到动作前的旧结果。

## 0.10.0 — 2026-11-04

这一版解决「在别人的电脑上」才会出现的问题：环境不一样、安全软件拦、多屏缩放、慢、费钱。

### 会先量一遍这台机器（自适应）
- 新增 `lib/env.mjs`：探测系统版本/架构、缩放比例、每块屏幕的尺寸与 DPI、OCR 有没有中文语言包、PowerShell 版本与权限，结果缓存一天。
- 按探测结果自动调参：高分屏降低 OCR 放大倍数、没有中文 OCR 时少切几刀并把重点放回控件树、PowerShell 不可用时干脆不走控件树、用久了按实测耗时调整等待时间。
- 这些都是「安全参数」：只影响等多久、读几带、试几次，不改变任何用户可见的行为。

### 出问题会说人话，还会告诉你该做什么
- 新增 `lib/humanize.mjs`：把内部错误码翻译成「发生了什么 / 为什么 / 你现在该做什么」，需要你动手会写成说明书（12 条规则：你在用鼠标、点不到、最小化、锁屏、PowerShell 被拦、找不到程序、权限不足……）。
- 失败结果里多一个 `explain: {title, what, why, todo, needFromUser}`，右下角状态条同时显示一句短提示。

### 一条命令出体检报告
- `desktop_doctor{report:true}` 直接生成一段可以复制发给别人的文本：系统版本、缩放、OCR 语言、权限、每项检查、最近失败记录。以后有人报「用不了」，一轮就能定位。

### 抗住环境问题
- PowerShell 加了熔断：连续 3 次硬失败就停 60 秒，期间所有读控件树的调用立刻返回人话，不再每次重试都起一次进程（安全软件反复拦截的场景下尤其明显）。截图、点击、打字不受影响。
- 体检新增 `uia` 与 `elevation` 两项：能看出控件树这条路是否被挡、以及当前有没有管理员权限的窗口（对它们发按键会被系统拒绝）。
- 每块屏幕带上自己的 DPI 与缩放比例，多屏不同缩放时换算不再只按主屏算。

## 0.9.0 — 2026-11-04

这一版只有一个主题：**让你看得见它有没有在尊重你、有没有在骗你。**

### 不打断，现在看得见
- 你在动鼠标/键盘时，它不会硬上；屏幕右下角状态条会写明「你在用鼠标/键盘，我先等」，你停手它继续。
- 真正等过你的工具结果里会多一个 `yielded: {waitedMs}`，能看出这次等了多久才动手。

### 判断可核查
- 每个结果多一个 `evidence: {channel, how, trusted}`：这次是靠控件文字（UIA）、截图识字（OCR）、还是看图定坐标得出结论的。
- `trusted: low` 基本只出现在「抓的是屏幕像素」这种情况——提醒你窗口被挡住时可能看错。

### 指挥台不再闪
- 新增 `lib/panel.mjs`：开合判断变成纯函数，服务端 `/dsh-sidecar/active` 统一给出 `open/keep/close`。
- 三条防闪规则：刚开 12 秒内不关、空闲没超过 20 秒算「两次操作之间的空档」不关、连续 3 次读不到活跃才关。
- 客户端轮询从 1.2 秒缩到 0.9 秒，只负责上报状态，不再自己决定去留。

### 输入核对更诚实
- 打字会读回控件文字核对；读回来是空的、或者读到的是别的控件，**不再判定“失败”**，而是标记 `verified:false` + `warn`（字发出去了，但读不回来）。
- 只有「真的读到了、里面确实没有这段字」才判定失败；失败后自动用剪贴板重打一次（粘贴一次落地，不会像逐字敲那样丢开头），用完把剪贴板还回去。

### 体检不再误报
- `desktop_doctor` 的前台检查：后台程序抢前台被 Windows 拒绝属于正常现象，不再整份体检标红。

### 测试
- 单元 24 项、工具冒烟 21 个、端到端 23 项；端到端连跑 3 轮全绿（把两处自己偶发失败的用例改稳了）。
- `verify-clean.mjs` 全绿。

## 0.8.4 — 2026-11-04

这一版针对「怎么让 AI 真的看准屏幕」，做了三件事。

### 看图优先
- `desktop_look` 在控件树稀疏（自绘界面、Chromium/Electron）时**默认附截图**，并带 `vision` 换算说明（图上像素 → 窗口坐标 → 屏幕坐标），模型可以直接按图点。
- `desktop_look` 的截图改成窗口自绘（PrintWindow），被别的窗口盖住时截到的也是它自己，不再截成“盖在上面的那个窗口”。

### 结果核对更硬
- `expect` 支持 `expectRegion`：只读关心的那一块，别让整屏别人的字干扰判断。
- 核对改成两档放大（4 条×2.6 / 8 条×3.2）各读一次，先比完整串、再比字命中率，并把屏幕原文回传。
- 打字后**读回控件文字核对**：发现开头被系统吞掉时，等焦点就位后逐字符补发，缺什么补什么；补不回来就老实报 `ok:false`，不再假成功。

### 按键不再打到别的窗口
- `desktop_key` 发键前先确认前台与键盘焦点就位（实测这一步能修掉「ctrl+a 清空没生效、越打越长」）。

### 测试
- 新增 `tests/e2e.mjs`：23 条断言，全部是“动作之后去屏幕上核对”，含负控（期望不存在的字必须失败）、区域校验、最小化拒绝、参数边界、指挥台通道、网页通道。
- `npm run test:all` 一条命令跑 unit(18) + smoke(21 工具) + e2e(23)。

## 0.8.3 — 2026-11-04

这一版全是"用起来更顺"的修复，针对真实使用里看到的三个毛病：乱点、分不清谁在最上面、启动白等。

### 不再乱点
- 点击不再一上来就抢前台：先截图算落点、确认没被挡住，才把窗口抬起来；抬高之后再复验一次落点，仍被别人盖住就报 `POINT_COVERED` 并说明是谁盖的，绝不点别的窗口。
- 每次点击最多 2 下（系统对话框 3 下），每次重试前都确认"这一下还是落在目标窗口上"，落点一飘就停手。
- 只有"盖住落点的是置顶窗口（播放器小窗、录屏提示、公告浮层）"才拒绝；普通窗口之间的遮挡属于正常切窗口，抬上来就点。

### 分得清谁在最上面
- `desktop_windows` 每个窗口带 `z`（0 = 最上层）和 `foreground`；`desktop_click` 的结果带 `windowZ` / `wasForeground`，一眼看出刚才操作的是不是前台窗口。
- 句柄失效时按"标题 + 进程"自动找回同一个窗口（返回 `recoveredFrom`），不用整轮重来。

### 不再白等
- 启动名靠猜变成按机器真实情况找：`where.exe` → 开始菜单/常见安装目录浅扫（预算 1.2 秒），找不到立刻返回候选，不再等 20 秒才失败。
- 打开网址/文档最多等 3~4 秒就去现有浏览器里找刚打开的那个标签页（按网址/文件名匹配，再按"新出现或标题变了"兜底），不再白等满 15 秒。
- `.html` 之类没有默认程序的文件，直接用浏览器打开，绕开系统「选择一个应用」对话框。
- 按文字点击优先走无障碍名字（命中就直接点），OCR 只做兜底，倍率顺序改为 2 → 1.5 → 2.5（实测 2 最稳）。

### 其它
- `desktop_type` 的焦点守卫只拦明确不能输入的角色（按钮/列表项/菜单项/复选框/标签页），微信这类整窗自绘的应用不再被误拒。
- `desktop_tree` 深度钳制在 1~8，并给每个元素标 `action`（click/fill/toggle/select/expand/scroll）。
- 按键组合出错时保证释放修饰键，不会把 Ctrl 粘住。
- `desktop_drag` 拒绝屏幕外的坐标；`desktop_web` 打开前校验协议。

## 0.8.2 — 2026-11-03

- 代码与 0.8.1 完全相同（`apply()` 走 `ctx.inject`、`engines.dsh`、README Requirements）。这一版只是为了把 npm 的 `latest` 重新指向一个已经同步完成的包：npm 11 的 staged 发布在批准之后要过几分钟安装包才可下载，0.8.1 批准后那几分钟里 `latest` 指向了一个还下不下来的 tarball。

## 0.8.1 — 2026-11-03

用 [dsh-plugin-toolkit](https://github.com/WJDdidi-1/dsh-plugin-toolkit) 体检后修的几处：

- **`apply()` 不再直接读 `ctx.tools`**：宿主在工具服务还没挂载时读到未声明的服务会让整行挂掉（`cannot get property "tools" without inject`），插件管理器里就是一个红点、工具全没了。现在优先用已经挂好的服务注册，没挂好就走 `ctx.inject(['tools','attachments'], …)` 等它。
- `engines.dsh` 补上（`>=0.2.0`），插件市场索引才能标出可用的宿主版本。
- README 增加 `## Requirements（运行要求）` 小节：系统、宿主、Node、PowerShell 要求，以及明确「不依赖 Python / 驱动 / 后台服务」。

## 0.8.0 — 2026-11-03

### 新增
- **侧边栏「指挥台」：操作过程中随时打字指挥你。** 右侧栏多一个 `🎯 指挥台` 标签页，输入框里打一句话、点发送（或 Ctrl+Enter），下一次工具调用就会读到它。它和 `desktop_steer` 是同一条通道（`steer.txt`），只是现在不用开记事本了。
- **自动开合。** 我开始操作你的电脑时，指挥台自动展开；停手 1.5 秒后自动收起。判断依据是我真的在动鼠标键盘（每次动作都记时间戳），不是猜的。

### 改进
- `desktop_tree` 每个控件多一个 `action` 字段（click / fill / toggle / select / expand / scroll），告诉你“这个控件能对它做什么”，不用再去猜 patterns。
- `desktop_key` 的组合键改成“按下去就要放回来”：中途出错也会释放修饰键，不会留一个粘住的 Ctrl 让你后面打字全变快捷键。
- `desktop_drag` 的起止点必须在屏幕内，越界直接拒绝（以前会真的把鼠标拽到屏幕外）。
- `desktop_web` 先校验地址再问“用哪种浏览器”，`javascript:` 这类地址直接拒绝。

### 修
- 面板注册改用 `ctx.get('sidebarRightTabs')`，之前写法拿不到服务、又被 try/catch 吞掉，导致标签页静默不出现。
- 安装包缺文件（`idle.mjs`）时整插件加载失败的问题：同步脚本改为全量覆盖 `lib/`。

## 0.7.5 — 2026-11-03

### 新增
- **`desktop_steer`：你随时可以中途指挥我。** 它开一个普通文本文件（`%LOCALAPPDATA%\dsh-sidecar\steer.txt`），你在里面打字、Ctrl+S；`desktop_sequence` / `desktop_course` 会在每一步之间读它，看到新指令立刻停下并返回 `interrupted:true` + `steer.command`，我按你的话改完再继续。写完停手 0.7 秒算定稿，不会把你打到一半的字当指令。
- **不抢你的鼠标键盘。** 所有会动鼠标键盘的工具（click/type/key/scroll/drag/invoke/sequence/course）动手前先看系统“最后一次输入”有多久：你正在操作就等你停手（默认 0.7 秒安静、最多等 5 秒），等不到就返回 `blocked:"user-active"` 并说明“我什么都没做”。参数 `yieldToUser`（默认 true）/ `quietMs` / `maxWaitMs` 可调。

### 说明
- 插件自己的动作会打标记，不会被误当成“用户还在操作”。
- 这套检测用的是 `GetLastInputInfo`，不安装任何驱动、不挂钩子。

## 0.7.4 — 2026-11-03

- **`desktop_type` 点完之后再确认一次焦点**：用 `x/y/fx/fy`、`ref`、`name` 或按文字点击去定位输入框时，点完会问系统“键盘焦点现在落在哪个控件上”，落在按钮/列表/空白处就**直接停下并说明**（返回 `blocked:"focus"`，带上那个控件的名字），不再把字符发到空气里还报成功。

## 0.7.3 — 2026-11-03

修两条真实反馈：「sidecar 的 UI 自动化脚本报 PowerShell 语法错误，读不到控件树」和「网页搜索框里打字，框里的内容没变」。

### 修
- **控件树读不到（PowerShell 语法错误）**：`lib/uia.ps1` / `lib/ocr.ps1` 之前是“UTF-8 无 BOM”，Windows PowerShell 5.1 会按本机代码页解码，脚本里的中文注释被读成乱码后整份脚本解析失败，于是所有依赖它的功能（控件树、按名字点击、写入值、焦点检查）全挂。两个脚本已改为 **UTF-8 with BOM**。
- **新增自检**：`lib/uia.mjs` 增加 `uiaParseCheck()`，脚本解析不了时报错直接给出行号和原因（不再是含混的 `empty output`）；`desktop_doctor` 增加 `uia-script` 一项，装完先体检就能发现这个问题。
- **网页里打字不进去要说明白**：浏览器窗口里打完字会读回页面文字确认真的落到网页里，落到地址栏/别处时返回 `blocked:"focus"` 并告诉你怎么做，不再报 `ok:true`。
- **打字前先把光标点进输入框**：`desktop_type` 新增 `x/y/fx/fy`（先点一下再输入），并会记住你上一步 `desktop_click{text}` 点过的位置，紧接着打字时在那个点再点一次；都不行才用无障碍“第一个可编辑控件”，且现在会优先挑页面里的输入框而不是顶上的地址栏。

## 0.7.2 — 2026-11-03

这一版只做一件事：**不再动你的窗口，也不再悄悄丢字**。来自两条用户反馈和一轮对比调研（CursorTouch/Windows-MCP）。

### 修
- **绝不改窗口状态**：`focusWindow` / `focusWindowForce` / `ensureForeground` 里所有 `ShowWindow(SW_RESTORE)`、`SWP_SHOWWINDOW` 全删。你最大化的不还原、最小化的不弹出、全屏的不退全屏。要动只能显式要求（`restoreWindow:true` 或 `desktop_window{action:"restore"}`）。
- **最小化的窗口直接说清楚**：点击/打字/按键遇到最小化窗口返回 `minimized:true` + 去问用户的提示，而不是自己把它弹出来。
- **抢前台用三重 AttachThreadInput**（当前线程 + 前台线程 + 目标线程）并把结果验证到真的变前台为止（最多等 1 秒）。以前会出现“窗口到前面了、键盘焦点还在上一个窗口”，字就打进了别处。
- **长文本改走剪贴板**：≥20 字直接粘贴（一次落地，不丢字），结束后把你的剪贴板还回去；短文本仍走真按键，不碰剪贴板。
- **网址启动不再假失败**：浏览器已开着时，链接只是变成新标签页；以前等不到新窗口就报 `no new window appeared`，现在返回 `ok:true, reused:true` 并说明真相。
- **按窗口名找窗口更稳**：进程名匹配优先于标题包含。`window:"DeepSeek Harness"` 以前可能点到浏览器里标题含这句话的标签页，现在先认进程名，再认前台。
- `desktop_capture` 返回值补 `displays`（多屏的虚拟桌面矩形）并在 note 里写清缩放换算规则。

# 更新日志

## 0.7.1 — 2026-11-03

### 修：不再改用户窗口的“形状”（使用反馈之一）

- **点击/输入前不再把最大化、全屏的窗口还原**：`ensureForeground()` 原来对任何窗口都发 `SW_RESTORE`，对最大化窗口等于“取消最大化”，全屏窗口也会被打断。现在只有窗口**最小化**时才恢复；`focusWindow` / `focusWindowForce` / `desktop_window{action:"restore"}` 同样只处理最小化的窗口（对最大化窗口调 restore 什么都不做）。
- 实测：浏览器最大化后连续点击，窗口保持 `-8,-8,1936,1048`；F11 全屏后点击，保持 `0,0,1920,1080`；最小化状态点一下仍会先还原再点。

### 修：在屏幕上的浏览器里打不进字（使用反馈之二）

- `desktop_type` 新增 `ref` / `name` / `role`：先把输入框点进去（控件矩形中心 → 等焦点就位）再输入。浏览器里这是唯一稳的路子，实测用 `name:"地址和搜索栏"` 输入并回车，页面真的跳到了搜索结果。
- 浏览器里**没指定输入框**时不再盲打字：先查当前键盘焦点（新增 `uia.ps1 -FocusInfo`，返回 `role/name/rect/editable/inside`），焦点不在输入框上就返回 `blocked:"focus"` 并说明怎么办——不再回 `ok:true` 让人以为写进去了。
- 浏览器里也不再“点窗口中心”自我修复：在网页上点中心等于点正文，可能点开链接、关掉弹窗。
- Chromium/Edge 的无障碍树是懒加载的：第一次读只有窗口框架。`uiaTree` 现在会在“明显太空”时自动补读一次（约 0.9 秒），地址栏、工具条、标签栏都能读到（实测 12 → 37 个元素）。
- `desktop_web` 的 `evaluate` 在还没连上浏览器时自动连接，不再抛 `Cannot read properties of null`。

## 0.7.0 — 2026-11-02

### 新增：网页通道 `desktop_web`

- 新增工具 `desktop_web`（第 20 个）：CDP 驱动插件内置的 Edge/Chrome，不抢鼠标、不动前台；提供 `snapshot`（标题/地址/正文 + 编号元素）、`click`、`type`、`fill`、`press`、`scroll`、`back/forward/reload`、`wait`、`screenshot`、`reset`。
- **网页任务开始前先问用户**：`open` 不带 `mode` 时返回 `needChoice:true` 与两个选项（`internal` 内置浏览器 / `screen` 屏幕上的浏览器），不替用户做主。
- **默认记住登录**：profile 落在 `%LOCALAPPDATA%\dsh-sidecar\web-profile`，关掉浏览器或重启 DSH 后 cookie / localStorage 都还在（关闭时先让浏览器优雅退出，避免 cookie 没落盘）；`profile:"temp"` 改回一次性，`action:"reset"` 清空。
- 上次的浏览器若还开着，直接接管它的调试端口并复用标签页，不会重复开一堆。
- 只接受 http/https；`file:`、`javascript:` 等一律拒绝并说明原因。
- `press` 补齐 `code`/`keyCode`/`text`（必应这类监听 keyCode 的搜索框现在能真正回车提交）。

### 本轮同时修掉的

- **启动程序时不再把浮层当新窗口**：`desktop_launch` 等窗口时会把 NVIDIA Overlay 这类全屏浮层（`enabled:false`、覆盖层、输入法/系统壳进程）排除，打开文件时优先按文件名匹配标题，避免“窗口等到了、却是错的窗口”，后续输入打偏。
- **新版记事本（标签页）读不到字**：`uia.ps1` 读文本时如果文档元素只给空串，会继续往下找真正有字的控件（`text-descendant`），不再直接退回 OCR；实测能准确读出文件内容。
- 技能文档补充：向用户提问时必须把两种浏览器的优缺点（`good`/`bad`/`bestFor`）都摆出来，让用户自己选。

## 0.6.2 — 2026-11-01

一轮自查（自查发现的都是「会不会误伤用户」的问题）：

- **受保护窗口的判定太激进**：上一版把所有「靠网格扫描才找到」的窗口都当成受保护对话框，连桌面本身（`Program Manager`）也被标成「系统对话框」，`desktop_click` 可能因此把正常窗口当成点不动的。现在只有**标题读不出来**的才算，桌面等正常窗口不会再被误标。
- **每次操作都多花 50ms**：窗口解析以前无条件做一次网格扫描（`WindowFromPoint` 扫全屏），每个工具调用都白付这笔钱。现在先走普通枚举（2~3ms），**只有找不到目标窗口时才扫一次**。
- **键盘兜底改成显式开关**：上一版对点不动的系统对话框会自动连按 `Tab` 甚至 `Enter`，等于替你动了对话框的焦点。现在默认不动，需要时传 `keyboard:true` 才尝试。
- 顺手修掉窗口解析里重复的一行兜底判断。

## 0.6.1 — 2026-10-31

修 issue #5 反馈的四个问题：

- **锁屏误判（最影响使用）**：系统已经解锁，但会话里残留一个没有主窗口的 `LockApp.exe`，原来会被判成「锁屏」并拒绝所有输入。现在判定顺序改成：输入桌面不是 `Default`（UAC/切换用户）⇒ 锁定；有 `LogonUI` ⇒ 锁定；桌面是 `Default` ⇒ 不锁（残留 LockApp 只记一笔 `source:"desktop+orphan-lockapp"`）。读不到桌面名时仍按原来的保守逻辑。
- **Windows 绝对路径被当成网址协议**：`C:\Users\...\a.txt` 报 `unknown URL scheme`。原因是「有没有盘符」的正则只认正斜杠。现在盘符 + 反斜杠、`\\server\share` 这类 UNC 路径都按路径处理，`file:///...` 照旧可用。
- **`desktop_launch` 默认不再复用已经打开的窗口**：以前启动一个已在运行的程序会直接挂到现有窗口（可能是你正在编辑的文档），后续输入就打进了那份文件。现在默认拒绝并列出已有的窗口，要么显式 `reuse:true`，要么在下一步用 `window:"标题"` 点名。
- **`desktop_text` 对新版记事本（标签页）读到空**：UIA 文档只回报 1 个字符时自动退回 OCR，返回 `source:"ocr"` 和 `uiaLength`，让调用方知道这次是 OCR；UIA 明确是空文档时才回「真的空」。
- **新增安全钉**：`desktop_type` / `desktop_click` 支持 `expectTitle` / `expectPid`——窗口标题或进程号不符合就直接拒绝，避免「窗口换人了还往下写」。

系统「打开方式」这类对话框：
- **能看见、能读懂了**：这类窗口（`OpenWith.exe` 的「选择一个应用以打开此文件」）既不在常规窗口枚举里，无障碍接口也读不到，以前插件完全不知道它存在。现在窗口枚举会补一层粗网格扫描（`WindowFromPoint`），把这类「受保护窗口」找出来并标记 `protected:true`，标题显示为「系统对话框」，`desktop_read` 可以直接 OCR 读出里面有哪些应用和按钮。
- **点不动就直说，不再假装点到了**：实测 Windows 不允许非系统程序往这类对话框送模拟鼠标（悬停都不亮），所以 `desktop_click` 打不中时会返回 `blocked:"protected-window"`，并说明改用键盘：`Tab` / `↓` 移动焦点、`Enter` 确认、`Esc` 取消（取消已实测有效）。以前这种情况会回 `ok:true`，模型以为点到了就继续往下错。
- **点击更耐揉**：点完没变化时会带几组小偏移重试（OCR 框中心常偏几像素），鼠标事件也从废弃的 `mouse_event` 换成 `SendInput`，并在按下/抬起之间留出间隔——一些自定义控件只认这种节奏。
## 0.6.0 — 2026-10-30

- **新工具 `desktop_look`**：一次调用返回「前台窗口 + 窗口列表 + 可点控件（带编号、名字、位置、可用动作）+ 可选 OCR 文字 + 可选带编号的截图」。以前要连着调 `desktop_windows` + `desktop_tree`(+`desktop_read`)，现在一步到位；截图上的编号是给模型引用的短标记（配 5x7 点阵自己画的，不依赖字体）。
- **新工具 `desktop_launch`**：启动程序 / 打开网址或文件，并等它的窗口真的出现再返回 hwnd（少一次「等它起来」的猜测）。
- **新工具 `desktop_wait`**：等到条件成立再继续——`window`（窗口出现/消失）、`text`（文字出现）、`change`（画面变化）、`idle`（界面安静下来）。之前只能靠固定 sleep 猜。
- **新工具 `desktop_text`**：用无障碍文本直接读窗口/输入框的真实文字（`TextPattern` → `ValuePattern`），读不到才退回 OCR；返回值带 `source`，让模型知道该不该信。
- **截图带编号**（set-of-marks）：`desktop_look{image:true}` 会把可点控件的编号画在截图上，小框互相压住时标签自动往上叠。
- **`desktop_invoke` 参数更宽容**：`text` 与 `name` 互为别名，控件名误写进 `match` 也能认；报错会说清楚「要用 text 传控件名」。
- **`desktop_type` 不再动用户的剪贴板**：粘贴前记住原来的剪贴板，输入完再恢复（长文本跳过）。
- **读剪贴板**：新增 `win32.getClipboardText()`，`OpenClipboard` 被别的程序短暂占用时会重试。
- **新工具 `desktop_scroll` / `desktop_drag` / `desktop_window`**：滚轮（含横向，返回 `changed` 判断是否到底）、按下-拖动-松开、窗口激活/最小化/最大化/还原/移动/关闭。此前这几件事只能靠坐标点击硬凑。
- **免重读的点击**：`desktop_look` 给每个控件一个短引用 `ref`（如 `e7`），`desktop_click{ref:'e7'}` 直接点，省掉一次控件树读取，也不会因为树变了而点到别处。
- **点前挡住检查**：`desktop_click` 点击前用 `WindowFromPoint` 确认落点没被别的程序盖住（通知、弹窗最常干这事），挡住就返回 `blocked:'POINT_COVERED'` 并说明是谁挡的；同一进程的菜单/弹框放行，`force:true` 可跳过。
- **点完把电脑还给你**：默认点完把鼠标移回原处、把前台还给原来的窗口（`restore:false` 关掉），返回值带 `restored`。
- **同一时间只做一件事**：所有会动键鼠的工具共用一把忙锁，另一路调用直接返回 `blocked:'busy'`，不会两条对话同时抢鼠标。
- **`desktop_type` 直接写值**：输入框支持 `ValuePattern` 时直接写（后台、不动剪贴板、不等光标），写完回读校验；不支持才退回「聚焦 + 粘贴」。
- **浏览器优先提示**：`desktop_windows` / `desktop_look` 发现浏览器窗口时会提示「网页任务优先用内置浏览器工具」，避免用像素点击去操作网页。
- **稀疏树提示**：控件树几乎是空的时候（Chromium/Electron 常见）直接给出三条替代路线：内置浏览器工具 / `desktop_text` 读字 / 截图 OCR 点击。
- **精简模式**：环境变量 `DSH_SIDECAR_TOOLS=lite` 只暴露 11 个常用工具，给上下文吃紧的场景。
- **状态条移到右下角**：不再挡在屏幕中间。
- **不再往临时目录堆截图**：`desktop_capture` 以前每次都会写一个 png 到 `%TEMP%\dsh-sidecar`，用久了会占几百 MB。现在只有传 `path` 或 `saveFile:true` 才落盘，其余情况图片只作为附件返回。
- **同名窗口不再悄悄点错**：一个标题命中多个窗口时，仍然用最靠前的那个，但返回值会带 `windowAmbiguous` + `windowUsed` + 一句提示（只统计真正看得见的窗口，后台隐形窗不参与）。
- **中文叫法兜底**：窗口名支持常见中文别名（记事本→Notepad、计算器→Calculator、浏览器→Edge/Chrome…），不用先查一次英文标题。
- **窗口列表更干净**：过滤掉 DWM 隐形窗、没有任务栏入口的工具窗、无标题栏的弹出层、各硬件驱动的辅助窗口，以及本插件自己的状态条。以前 `desktop_windows` 会把这些一起吐出来（能有几十行噪音）。
- **`desktop_launch` 返回真正的应用 pid（`appPid`）**：以前给的是启动器的 pid（`start notepad` 时是 cmd 的 pid），拿它去结束进程会杀错。
- **`desktop_launch` 等控件树补齐**：窗口出现 ≠ 能操作。现在会再等 0.2~1.6 秒让控件树稳定下来，并带回 `controlCount` / `treeReady`，避免紧接着 `desktop_look` 只看到半棵树。带空格的文档路径也补了引号，不会被 `cmd start` 拆开。
- **`desktop_wait kind=text` 先读无障碍文字**：能在 UIA 里找到就直接返回（快、准、不怕窗口被挡），找不到才 OCR；返回里带 `via`。
- **点不到就明说**：控件滚出可视区（坐标为负或落在窗口外）时 `desktop_click` 直接拒绝并说明，不会点到旁边去。
- **动作不支持时给下一步**：`desktop_invoke` 命中的控件没有该动作时，报错会说明它支持哪些动作（例如「支持 Toggle、ScrollItem」），而不是只说一句 no pattern。
- **`desktop_sequence` 支持 `ref`**：步骤里可以直接 `{action:'click', ref:'e7'}`；dryRun 的计划文本也不再输出 `fxundefined`。
- **`desktop_type` 打完把前台还给你**：抢了别人的前台之后会还回去。
- **测试**：新增 `tests/unit.mjs`（纯逻辑：按键解析、锁屏判断、文字定位、PNG 编码）与 `tests/smoke.mjs`（假 host 启动 + 19 个工具的 schema/渲染检查），`npm test` 一条命令跑完。


## 0.5.5 — 2026-10-28

- **锁屏判断更稳**：不再单靠 `WTSQuerySessionInformation` 的标志位（微软文档写 0=锁定、1=未锁，但个别机器实测相反）。现在把「WTS 标志」和「LogonUI / LockApp 进程快照」两个信号互相印证才判定锁定，任一方向误判的概率都更低：标志说锁定但没有任何锁屏进程、且能读到进程表时，不再拦截。

## 0.5.4 — 2026-10-28

让它做的事看得见、停得下、查得到。

### 新增

- **屏幕状态条**：真正操作时屏幕底部出现「DSH 正在操作这台电脑」。进程内 GDI 自绘（koffi 直调 user32/gdi32 + layered window），不装任何依赖、不抢焦点、鼠标穿透、1.4 秒无动作自动收起；创建失败不影响功能，只是没有屏幕提示。
- **`desktop_log` 工具**：每次点击 / 输入 / 按键 / 序列执行都记一条（时间、工具、窗口、坐标、结果、是否重试），`{"limit":30}` 回看，`{"clear":true}` 归档成 `actions.jsonl.1` 后清空。文件 `%TEMP%/dsh-sidecar/actions.jsonl`，最多 500 行。
- **技能说明** `skills/desktop-sidecar/SKILL.md`：把「先看后动、能用 UIA 就别用坐标、多步走 desktop_sequence」写成给模型的固定套路。

### 改进

- **Esc 中止**：`desktop_sequence` / `desktop_course` 同时把状态条捕获的 Esc 边沿和 `GetAsyncKeyState` 当取消信号，当前步骤做完即停（`cancelled:true` / `stoppedByUser:true`）。
- **点空了自动重新定位**：`desktop_click{text}` 点完像素没变时，会重新 OCR 一次，位置真变了就按新坐标再点，返回 `relocated:true`。
- **安全桌面拦截**：锁屏 / UAC 提权确认 / 切换用户界面一律拒绝模拟输入，返回 `refused: secure desktop`。
  三条信号互证：`WTSQuerySessionInformation` 的会话锁定标志、`LogonUI.exe` / `LockApp.exe` 进程快照、输入桌面名是否为 Default。
  覆盖 `desktop_click` / `desktop_type` / `desktop_key` / `desktop_invoke` / `desktop_sequence` / `desktop_course`（**不带 window 参数时同样拦截**）。
- **`desktop_doctor` 锁屏感知**：锁屏时把 OCR / 前台锁两项标为「跳过」而不是失败，`secure-desktop` 一项直接说明当前状态，避免误报机器坏了。
- **状态条进度**：`desktop_sequence` 显示「第 N 步 · click」与 `n/total`；`desktop_course` 显示「盯课 n/总数」。
- **`desktop_doctor`** 增加 `hud` / `action-log` / `secure-desktop` 三项自检。

### 文档

- README 增加状态条、发微信、读网课三张图，补「操作时的屏幕提示与日志」一节与英文小节。

## 0.5.3 — 2026-10-28

修社区反馈的两个问题（issue #3 / #4）。

### 修：`desktop_invoke` 可能点到「另一个名字相似的控件」（#3）

以前按子串匹配、取第一个命中，于是 `text:"内存"` 有可能命中父容器 `内存添加`：界面上什么都没发生、`done` 却可能是 true。

现在：

- 名字**完全一致**的控件优先；
- 子串命中多个时**一个都不点**，返回 `ambiguous:true` 和 `candidates`（名字 / 角色 / 矩形 / 能力），让你改用精确名字或加 `role`；
- 新增 `match: auto | exact | substring` 与 `role` 参数；
- 唯一可执行的情况下才动作，并在返回里带 `matchKind`（exact / substring）与 `rect`，方便事后核对点到的是谁。

### 新增：按名字点击 `desktop_click{name, role}`（#3）

`control:N` 的编号会随界面变化失效。现在可以直接写控件名，点击那一刻才定位：

```
desktop_click { window: "记事本", name: "保存", role: "Button" }
```

`desktop_sequence` 的 click 步骤同样支持 `{name, role, match}`。

### 修：`+` 键无法按（#4）

`desktop_key{"key":"+"}` 以前抛 `unknown key: +`，因为按 `+` 拆分组合键时把加号本身拆没了。现在：

- `"+"`、`"-"`、`"ctrl++"`、`"ctrl+shift++"` 都能正确解析；
- `+` 会自动补 Shift（美式/中文键位上 `+` 是 Shift+`=`），打出的是 `+` 而不是 `=`；
- 顺带支持 `f1`~`f24`、`plus` / `minus` / `comma` 等别名。

### 修：`desktop_doctor` 的 DPI 误报（#4）

以前只看 setter 的返回值。宿主进程如果已经设过 DPI 感知，再调 setter 会返回 false / E_ACCESSDENIED，于是被误判成「未启用 DPI 感知」。

现在改为查询进程真实级别（`GetProcessDpiAwareness`，回退 `GetThreadDpiAwarenessContext`），返回 `level: 0/1/2`；setter 失败但进程本身已感知时会在 detail 里注明，不再算失败。

### 文档

- `desktop_capture` 的 `x/y/width/height` 明确为「仅区域截图生效」，给了 `window` 就按整窗截。
- **`desktop_course` 不再猜窗口**：它会在页面上真的点「播放 / 下一节」，所以现在必须点名窗口；只有 `dryRun:true`（只观察）才允许顺手取前台的浏览器。不点名时直接拒绝并说明，不会再对着聊天窗口盯 20 秒。
- **`desktop_type` 不再接受空文本**：以前 `text` 缺失时会把字符串 "undefined" 真打进当前焦点窗口。现在空文本直接报错。
- **`desktop_wait` 先校验 kind**：`kind` 写错时直接说「只能是 window | text | change | idle」，而不是先抱怨缺 window。
- **屏幕外坐标说清楚**：`desktop_click{x:99999}` 现在报「这个点不在屏幕里（屏幕 1920x1080）」，不再说成控件滚出可视区。
- **未知协议不再当成路径**：`desktop_launch{target:'bad://x'}` 报「不认识的协议，什么都没启动」，而不是 "not found"。
- **`maxSteps` 小于 1 直接报错**：以前 `maxSteps:0` 会被当成默认 24 继续跑。
